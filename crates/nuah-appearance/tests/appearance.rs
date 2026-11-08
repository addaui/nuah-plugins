// SPDX-License-Identifier: Apache-2.0
//! The appearance, prefs and theme plugins running together in a Core that has no product around it.

use nuah_adapters::*;
use nuah_appearance::{theme_ids, themes, Appearance};
use nuah_kernel::*;
use nuah_prefs::Prefs;
use serde_json::json;
use std::sync::Arc;

fn catalog() -> Catalog {
    let mut list: Vec<Arc<dyn Plugin>> = vec![
        Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyAllowAll), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Prefs), Arc::new(Appearance),
    ];
    for t in themes() {
        list.push(Arc::new(t));
    }
    Catalog(list)
}

fn dist(extra: &[&str], with_themes: bool) -> Distribution {
    let mut enabled: Vec<String> = ["db-memory", "auth-local", "policy-allow-all", "clock-system", "ids-random"].iter().map(|s| s.to_string()).collect();
    enabled.extend(extra.iter().map(|s| s.to_string()));
    if with_themes {
        enabled.extend(theme_ids());
    }
    let mut profile = Profile { name: "t".into(), enabled, ..Default::default() };
    for id in ["prefs", "appearance"] {
        if extra.contains(&id) {
            profile.grants.insert(id.into(), vec!["emit".into()]);
        }
    }
    Distribution { name: "t".into(), catalog: catalog(), profile }
}

fn me() -> Identity {
    Identity::new("ann", "Ann", &[])
}

#[test]
fn a_person_changes_the_look_and_can_go_back() {
    let core = Core::start(&dist(&["appearance"], true)).unwrap_or_else(|p| panic!("{p:#?}"));
    let out = core.call_as(&me(), "appearance.save", json!({"overrides": {"r": 12, "material": "glass", "light:accent": "#336699"}}), None).unwrap().output;
    assert_eq!(out["overrides"]["r"], 12);
    assert_eq!(core.call_as(&me(), "appearance.get", json!({}), None).unwrap().output["overrides"]["material"], "glass");
    let bad = core.call_as(&me(), "appearance.save", json!({"overrides": {"r": 99}}), None).unwrap_err();
    assert_eq!(bad.category, Category::Invalid);
    core.call_as(&me(), "appearance.reset", json!({}), None).unwrap();
    assert_eq!(core.call_as(&me(), "appearance.get", json!({}), None).unwrap().output["overrides"], json!({}));
    let other = Identity::new("bo", "Bo", &[]);
    assert_eq!(core.call_as(&other, "appearance.get", json!({}), None).unwrap().output["overrides"], json!({}), "overrides are personal");
}

#[test]
fn the_preferences_window_lists_what_appearance_declares() {
    let core = Core::start(&dist(&["prefs", "appearance"], true)).unwrap_or_else(|p| panic!("{p:#?}"));
    let prefs = core.call_as(&me(), "prefs.get", json!({}), None).unwrap().output;
    assert_eq!(prefs["theme"], "phantom-onyx");
    assert_eq!(prefs["scheme"], "auto");
    assert_eq!(prefs["density"], "comfortable");
    assert_eq!(prefs["language"], "en", "prefs still declares its own");
    let set = core.call_as(&me(), "prefs.set", json!({"scheme": "dark"}), None).unwrap().output;
    assert_eq!(set["scheme"], "dark");
    assert_eq!(core.call_as(&me(), "prefs.set", json!({"scheme": "purple"}), None).unwrap_err().category, Category::Invalid);
    assert_eq!(core.call_as(&me(), "prefs.set", json!({"nope": 1}), None).unwrap_err().category, Category::Invalid);
}

#[test]
fn prefs_runs_without_appearance_and_appearance_without_prefs() {
    let only_prefs = Core::start(&dist(&["prefs"], false)).unwrap_or_else(|p| panic!("{p:#?}"));
    let prefs = only_prefs.call_as(&me(), "prefs.get", json!({}), None).unwrap().output;
    assert!(prefs.get("theme").is_none() && prefs["language"] == "en");
    assert!(Core::start(&dist(&["appearance"], false)).is_ok());
}

#[test]
fn a_theme_needs_appearance() {
    let problems = Core::check(&dist(&[], true));
    assert!(problems.iter().any(|p| p.code == "missing_dependency" && p.plugins.iter().any(|id| id.starts_with("theme-"))), "{problems:#?}");
    assert!(Core::check(&dist(&["appearance"], true)).is_empty());
}

#[test]
fn every_preset_is_complete_and_the_default_comes_first() {
    let all = themes();
    assert!(all.len() >= 9);
    assert_eq!(all[0].0, "theme-phantom-onyx");
    let ids = theme_ids();
    assert_eq!(ids.len(), all.len());
}
