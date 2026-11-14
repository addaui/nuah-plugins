// SPDX-License-Identifier: Apache-2.0
//! The link analyzer in a Core with a fake `net` Adapter that answers from a table.

use nuah_adapters::*;
use nuah_kernel::*;
use nuah_link_analyzer::LinkAnalyzer;
use serde_json::{json, Value};
use std::sync::Arc;

struct Web;
impl Net for Web {
    fn name(&self) -> &str { "@test/net" }
    fn fetch(&self, r: &NetRequest) -> Result<NetResponse> {
        let page = |t: &str, body: &str| NetResponse { status: 200, url: r.url.clone(), headers: vec![("content-type".into(), t.into())], body: body.as_bytes().to_vec(), truncated: false };
        Ok(match r.url.as_str() {
            "https://a.test/cat.png" => NetResponse { headers: vec![("content-type".into(), "image/png".into()), ("content-length".into(), "8".into())], body: vec![137, 80, 78, 71, 13, 10, 26, 10], ..page("", "") },
            "https://a.test/big.png" => NetResponse { truncated: true, headers: vec![("content-type".into(), "image/png".into())], ..page("", "x") },
            "https://a.test/logo.svg" => page("image/svg+xml", "<svg/>"),
            "https://a.test/page" => page("text/html; charset=utf-8", "<title>Hello</title><meta property=\"og:description\" content=\"A page\">"),
            "https://a.test/missing" => NetResponse { status: 404, ..page("text/html", "") },
            "https://a.test/clip.mp4" => page("video/mp4", ""),
            "https://private.test/" => return Err(Error::reason(Category::Invalid, "net.refused", "That address cannot be reached")),
            _ => return Err(Error::reason(Category::NotFound, "net.failed", "down")),
        })
    }
}
struct WebPlugin;
impl Plugin for WebPlugin {
    fn manifest(&self) -> Manifest { serde_json::from_value(json!({"id": "@test/net", "version": "1", "fills": "net"})).unwrap() }
    fn fill(&self, _: &Value) -> Result<Option<PortImpl>> { Ok(Some(PortImpl::Net(Arc::new(Web)))) }
}

fn core() -> Core {
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyAllowAll), Arc::new(StdClock), Arc::new(StdIds), Arc::new(WebPlugin), Arc::new(LinkAnalyzer::default())];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-allow-all", "@nuah/clock-system", "@nuah/ids-random", "@test/net", "@nuah/link-analyzer"].iter().map(|s| s.to_string()).collect();
    let mut profile = Profile { name: "t".into(), enabled, ..Default::default() };
    profile.grants.insert("@nuah/link-analyzer".into(), vec!["net".into()]);
    Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile }).unwrap_or_else(|p| panic!("{p:#?}"))
}
fn call(c: &Core, op: &str, url: &str) -> Result<Value> {
    c.call_as(&Identity::new("ann", "Ann", &[]), op, json!({"url": url}), None).map(|r| r.output)
}

#[test]
fn it_says_what_an_address_is() {
    let c = core();
    let img = call(&c, "links.analyze", "https://a.test/cat.png").unwrap();
    assert_eq!((img["type"].as_str(), img["content_type"].as_str(), img["size"].as_u64(), img["title"].as_str()), (Some("image"), Some("image/png"), Some(8), Some("cat.png")));
    let page = call(&c, "links.analyze", "https://a.test/page").unwrap();
    assert_eq!((page["type"].as_str(), page["title"].as_str(), page["description"].as_str()), (Some("page"), Some("Hello"), Some("A page")));
    assert_eq!(call(&c, "links.analyze", "https://a.test/clip.mp4").unwrap()["type"], "video");
}

#[test]
fn it_refuses_what_is_not_a_public_web_address() {
    let c = core();
    assert_eq!(call(&c, "links.analyze", "ftp://a.test/x").unwrap_err().category, Category::Invalid);
    assert_eq!(call(&c, "links.analyze", "https://private.test/").unwrap_err().category, Category::Invalid, "the Adapter's refusal is the only rule about where");
    assert_eq!(call(&c, "links.analyze", "https://a.test/missing").unwrap_err().reason.as_deref(), Some("links.unavailable"));
    assert_eq!(call(&c, "links.analyze", "https://nowhere.test/").unwrap_err().reason.as_deref(), Some("links.unavailable"));
}

#[test]
fn it_hands_over_a_picture_and_only_a_picture() {
    let c = core();
    let out = call(&c, "links.fetch", "https://a.test/cat.png").unwrap();
    assert_eq!((out["content_type"].as_str(), out["name"].as_str(), out["size"].as_u64()), (Some("image/png"), Some("cat.png"), Some(8)));
    assert_eq!(out["data"], "iVBORw0KGgo=");
    assert_eq!(call(&c, "links.fetch", "https://a.test/page").unwrap_err().reason.as_deref(), Some("links.not_an_image"));
    assert_eq!(call(&c, "links.fetch", "https://a.test/logo.svg").unwrap_err().reason.as_deref(), Some("links.not_an_image"), "a picture that can carry script is not handed over");
    assert_eq!(call(&c, "links.fetch", "https://a.test/big.png").unwrap_err().reason.as_deref(), Some("links.too_big"));
}
