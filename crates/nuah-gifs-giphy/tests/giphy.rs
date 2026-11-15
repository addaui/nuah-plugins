// SPDX-License-Identifier: Apache-2.0
use nuah_adapters::*;
use nuah_gifs::{descriptor_problems, Gifs};
use nuah_gifs_giphy::GifsGiphy;
use nuah_kernel::*;
use serde_json::{json, Value};
use std::sync::Arc;

fn core(settings: Option<Value>) -> Core {
    let mut list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyAllowAll), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Gifs)];
    let mut enabled: Vec<String> = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-allow-all", "@nuah/clock-system", "@nuah/ids-random", "@nuah/gifs"].iter().map(|s| s.to_string()).collect();
    list.push(Arc::new(GifsGiphy)); enabled.push("@nuah/gifs-giphy".into());
    let mut profile = Profile { name: "t".into(), enabled, ..Default::default() };
    if let Some(s) = settings { profile.settings.insert("@nuah/gifs-giphy".into(), s); }
    Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile }).unwrap_or_else(|p| panic!("{p:#?}"))
}
fn provider(c: &Core) -> Value { c.call_as(&Identity::new("ann", "Ann", &[]), "gifs.provider", json!({}), None).unwrap().output }

#[test]
fn without_a_key_there_is_nothing_to_call() {
    assert_eq!(provider(&core(None ))["configured"], false);
    assert_eq!(provider(&core(Some(json!({"rating": "g"})) ))["configured"], false);
}

#[test]
fn the_gifs_plugin_alone_is_refused_for_want_of_a_provider() {
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyAllowAll), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Gifs)];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-allow-all", "@nuah/clock-system", "@nuah/ids-random", "@nuah/gifs"].iter().map(|s| s.to_string()).collect();
    let err = Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile: Profile { name: "t".into(), enabled, ..Default::default() } }).err().unwrap();
    assert!(err.iter().any(|p| p.code == "extension_point_unfilled"), "{err:?}");
}

#[test]
fn with_a_key_the_descriptor_describes_giphys_two_calls() {
    let d = provider(&core(Some(json!({"api_key": "abcdefgh12345678", "rating": "g"})) ));
    assert_eq!(descriptor_problems(&d), Vec::<String>::new());
    assert_eq!(d["search"]["url"], "https://api.giphy.com/v1/gifs/search");
    assert_eq!(d["search"]["query"]["rating"], "g");
    assert_eq!(d["search"]["query"]["q"], "{q}", "the Face fills the placeholders");
    assert_eq!(d["trending"]["url"], "https://api.giphy.com/v1/gifs/trending");
    assert_eq!(d["sticker_search"]["url"], "https://api.giphy.com/v1/stickers/search");
    assert_eq!(d["sticker_trending"]["query"]["rating"], "g");
    assert!(d["sticker_trending"]["query"]["q"].is_null(), "trending has no query");
    assert_eq!(d["attribution"]["text"], "Powered by GIPHY");
    assert_eq!(d["mode"], "client");
}

#[test]
fn a_bad_rating_falls_back_and_the_browser_is_asked_to_allow_only_giphy() {
    let d = provider(&core(Some(json!({"api_key": "abcdefgh12345678"})) ));
    assert_eq!(d["search"]["query"]["rating"], "pg");
    let m = GifsGiphy.manifest();
    assert_eq!(m.connect, Vec::<String>::new().into_iter().chain(["https://api.giphy.com".to_string()]).collect::<Vec<_>>());
}

#[test]
fn the_settings_are_annotated_and_the_key_is_a_secret() {
    let m = GifsGiphy.manifest();
    assert_eq!(setup::settings_annotation_problems(&m.settings_schema), Vec::<String>::new());
    assert_eq!(m.settings_schema["properties"]["api_key"]["x-secret"], true);
}
