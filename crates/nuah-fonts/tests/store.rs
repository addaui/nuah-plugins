// SPDX-License-Identifier: Apache-2.0
//! The font store in a Core with a fake `net` Adapter that answers from a table, and the role policy (so the store's own permission can be refused).

use base64::{engine::general_purpose::STANDARD, Engine};
use nuah_adapters::*;
use nuah_fonts::{font_set_ids, font_sets, key_of, FontStore};
use nuah_kernel::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

/// Every address the fake web was asked for (tests run in parallel, so each asserts about its own addresses).
static ASKED: Mutex<Vec<String>> = Mutex::new(Vec::new());
fn asked(url: &str) -> usize { ASKED.lock().unwrap().iter().filter(|u| *u == url).count() }

struct Web;
impl Net for Web {
    fn name(&self) -> &str { "@test/net" }
    fn fetch(&self, r: &NetRequest) -> Result<NetResponse> {
        ASKED.lock().unwrap().push(r.url.clone());
        let ok = |body: Vec<u8>| NetResponse { status: 200, url: r.url.clone(), headers: vec![], body, truncated: false };
        Ok(if r.url.ends_with(".woff2") && !r.url.contains("html") { ok(b"wOF2\0\x01\0\0fake".to_vec()) } else { ok(b"<html>nope</html>".to_vec()) })
    }
}
struct WebPlugin;
impl Plugin for WebPlugin {
    fn manifest(&self) -> Manifest { serde_json::from_value(json!({"id": "@test/net", "version": "1", "fills": "net"})).unwrap() }
    fn fill(&self, _: &Value) -> Result<Option<PortImpl>> { Ok(Some(PortImpl::Net(Arc::new(Web)))) }
}

fn core() -> Core {
    let mut list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds), Arc::new(WebPlugin), Arc::new(FontStore)];
    for s in font_sets() { list.push(Arc::new(s)); }
    let mut enabled: Vec<String> = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@test/net", "@nuah/fonts"].iter().map(|s| s.to_string()).collect();
    enabled.extend(font_set_ids());
    let mut profile = Profile { name: "t".into(), enabled, ..Default::default() };
    profile.grants.insert("@nuah/fonts".into(), vec!["net".into(), "call".into()]);
    Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile }).unwrap_or_else(|p| panic!("{p:#?}"))
}
fn ann() -> Identity { Identity::new("ann", "Ann", &["member"]) }
fn call(c: &Core, op: &str, input: Value) -> Result<Value> { c.call_as(&ann(), op, input, None).map(|r| r.output) }
fn a_face_url(c: &Core) -> String {
    c.font_data().iter().flat_map(|d| d["families"].as_array().cloned().unwrap()).find(|f| f["id"] == "readex-pro").unwrap()["faces"][0]["url"].as_str().unwrap().to_string()
}

#[test]
fn a_listed_font_is_fetched_once_kept_and_served_to_anyone() {
    let c = core();
    let url = a_face_url(&c);
    let first = call(&c, "fonts.fetch", json!({"url": url})).unwrap();
    assert_eq!((first["key"].as_str(), first["cached"].as_bool()), (Some(key_of(&url).as_str()), Some(false)));
    let again = call(&c, "fonts.fetch", json!({"url": url})).unwrap();
    assert_eq!(again["cached"], true);
    assert_eq!(asked(&url), 1, "the host is contacted once");
    assert_eq!(call(&c, "fonts.status", json!({"urls": [&url, "https://other.example/x.woff2"]})).unwrap()["present"], json!([{"url": url, "key": key_of(&url)}]));
    let anon = Identity::new("anonymous", "anonymous", &[]);
    let got = c.call_as(&anon, "fonts.get", json!({"key": key_of(&url)}), None).unwrap().output;
    assert_eq!(STANDARD.decode(got["data"].as_str().unwrap()).unwrap(), b"wOF2\0\x01\0\0fake");
}

#[test]
fn only_addresses_a_font_plugin_names_are_fetched() {
    let c = core();
    for bad in ["https://evil.example.com/x.woff2", "http://169.254.169.254/latest", "https://cdn.jsdelivr.net/fontsource/fonts/readex-pro@5.3.0/other.woff2"] {
        assert_eq!(call(&c, "fonts.fetch", json!({"url": bad})).unwrap_err().reason.as_deref(), Some("fonts.not_listed"), "{bad}");
        assert_eq!(asked(bad), 0, "nothing was requested: {bad}");
    }
}

#[test]
fn nobody_but_the_store_can_put_a_file_in_it() {
    let c = core();
    let put = json!({"url": a_face_url(&c), "data": STANDARD.encode(b"wOF2evil")});
    assert_eq!(call(&c, "fonts.store", put.clone()).unwrap_err().category, Category::Denied, "a member cannot poison the key of a real font");
    let admin = Identity::new("root", "Root", &["admin", "member"]);
    assert_eq!(c.call_as(&admin, "fonts.store", put, None).unwrap_err().category, Category::Denied, "not even an admin");
}
