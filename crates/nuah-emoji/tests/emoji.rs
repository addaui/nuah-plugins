// SPDX-License-Identifier: Apache-2.0
//! The emoji plugin with prefs, in a Core that has no product around it, and a second plugin that offers a set.

use nuah_adapters::*;
use nuah_emoji::Emoji;
use nuah_kernel::*;
use nuah_prefs::Prefs;
use serde_json::{json, Value};
use std::sync::Arc;

/// A plugin that ships pictures: it offers one images set.
struct Pictures;
impl Plugin for Pictures {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": "@test/pictures", "version": "0.1.0", "name": "Pictures", "namespaces": ["pictures"],
            "description": "Offers an images emoji set", "requires": {"capabilities": []},
            "provides": [{"extension_point": "emoji.set", "optional": true}]
        })).expect("manifest")
    }
    fn bind(&self, b: &mut Bindings) {
        b.provide("emoji.set", |_tx, _i| Ok(json!({"sets": [{"id": "pictures", "name": {"en": "Pictures"}, "kind": "images", "url": "/e/{code}.svg"},
            {"id": "system", "name": {"en": "A duplicate id is ignored"}, "kind": "font", "family": ""}]})));
    }
}

fn core(with_pictures: bool) -> Core {
    let mut list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyAllowAll), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Prefs), Arc::new(Emoji), Arc::new(Pictures)];
    let mut enabled: Vec<String> = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-allow-all", "@nuah/clock-system", "@nuah/ids-random", "@nuah/prefs", "@nuah/emoji"].iter().map(|s| s.to_string()).collect();
    if with_pictures {
        enabled.push("@test/pictures".into());
    }
    let mut profile = Profile { name: "t".into(), enabled, ..Default::default() };
    profile.grants.insert("@nuah/prefs".into(), vec!["emit".into()]);
    profile.grants.insert("@nuah/emoji".into(), vec!["call".into()]);
    Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile }).unwrap_or_else(|p| panic!("{p:#?}"))
}

fn me() -> Identity {
    Identity::new("ann", "Ann", &[])
}

fn ids(v: &Value) -> Vec<String> {
    v["sets"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn the_plugin_offers_the_device_and_font_sets_and_the_choice_is_a_preference() {
    let c = core(false);
    assert_eq!(ids(&c.call_as(&me(), "emoji.sets", json!({}), None).unwrap().output), ["system", "microsoft", "apple", "google", "twemoji"]);
    let schema = c.call_as(&me(), "prefs.schema", json!({}), None).unwrap().output;
    let item = schema["items"].as_array().unwrap().iter().find(|i| i["key"] == "emoji.set").expect("in the settings");
    assert_eq!(item["group"], "appearance");
    assert_eq!(item["choices"].as_array().unwrap().len(), 5);
    assert_eq!(c.call_as(&me(), "prefs.get", json!({}), None).unwrap().output["emoji.set"], "system");
    c.call_as(&me(), "prefs.set", json!({"emoji.set": "microsoft"}), None).unwrap();
    assert_eq!(c.call_as(&me(), "prefs.get", json!({}), None).unwrap().output["emoji.set"], "microsoft");
    assert_eq!(c.call_as(&me(), "prefs.set", json!({"emoji.set": "nonsense"}), None).unwrap_err().category, Category::Invalid, "only a set a plugin offers");
}

#[test]
fn another_plugin_adds_a_set_and_it_becomes_a_choice() {
    let c = core(true);
    let sets = c.call_as(&me(), "emoji.sets", json!({}), None).unwrap().output;
    assert_eq!(ids(&sets), ["system", "microsoft", "apple", "google", "twemoji", "pictures"], "each id once");
    c.call_as(&me(), "prefs.set", json!({"emoji.set": "pictures"}), None).unwrap();
    assert_eq!(sets["sets"][5]["url"], "/e/{code}.svg");
}

#[test]
fn the_plugin_ships_a_font_and_a_catalog_for_a_picker() {
    let c = core(false);
    let font = c.call_as(&me(), "emoji.asset", json!({"id": "twemoji.woff2"}), None).unwrap().output;
    assert_eq!(font["content_type"], "font/woff2");
    assert!(font["data"].as_str().unwrap().starts_with("d09GMg"), "a woff2 file starts with wOF2");
    assert_eq!(c.call_as(&me(), "emoji.asset", json!({"id": "../etc/passwd"}), None).unwrap_err().category, Category::Invalid, "only the files it ships");
    let cat = c.call_as(&me(), "emoji.catalog", json!({}), None).unwrap().output;
    assert_eq!(cat["lang"], "en");
    assert_eq!(cat["groups"].as_array().unwrap().len(), 9);
    let grin = cat["items"].as_array().unwrap().iter().find(|i| i[0] == "😀").expect("grinning face");
    assert_eq!(grin[1], "grinning face");
    assert!(grin[2].as_str().unwrap().contains("smile"));
}

#[test]
fn base64_matches_the_standard_alphabet() {
    // "Man" is the classic example; padding for one and two leftover bytes
    let c = core(false);
    let out = c.call_as(&me(), "emoji.asset", json!({"id": "twemoji.woff2"}), None).unwrap().output;
    let data = out["data"].as_str().unwrap();
    assert_eq!(data.len() % 4, 0);
    assert!(data.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '='));
}
