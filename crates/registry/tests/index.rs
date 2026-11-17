// SPDX-License-Identifier: Apache-2.0
//! `registry.json` is what `registry::index()` says, and every plugin in it passes the checks a plugin must.

use nuah_kernel::setup::settings_annotation_problems;

#[test]
fn the_checked_in_index_is_current() {
    let have: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../registry.json")).expect("registry.json exists")).expect("it is JSON");
    assert_eq!(have, registry::index(), "run `cargo run -p registry > registry.json`");
}

#[test]
fn ids_are_unique_and_settings_are_annotated() {
    let all = registry::plugins();
    let mut ids: Vec<String> = all.iter().map(|(_, p)| p.manifest().id).collect();
    ids.sort();
    let n = ids.len();
    ids.dedup();
    assert_eq!(ids.len(), n, "a plugin id appears twice");
    for (_, p) in &all {
        let m = p.manifest();
        let problems = settings_annotation_problems(&m.settings_schema);
        assert!(problems.is_empty(), "{}: {problems:?}", m.id);
    }
}

/// The class of every plugin here (ADR 0080), written down. The Core works it out from the Manifest; this table fails when a change
/// to a plugin (a new capability, a Port, a setting for the operator) moves it to the other side without anyone meaning it.
#[test]
fn the_class_of_every_plugin_is_the_one_written_down() {
    use nuah_kernel::PluginClass::{Feature, Platform};
    let expected = [
        ("@nuah/prefs", Feature),
        ("@nuah/appearance", Feature),
        ("@nuah/emoji", Feature),
        ("@nuah/fonts", Platform),
        ("@nuah/gifs", Feature),
        ("@nuah/gifs-giphy", Feature),
        ("@nuah/link-analyzer", Platform),
        ("@nuah/metric-prometheus", Platform),
    ];
    let mut seen = vec![];
    for (_, p) in registry::plugins() {
        let m = p.manifest();
        let c = m.class();
        // every theme and every font set is data: a feature, so they are not listed one by one
        let want = if m.id.starts_with("@nuah/theme-") || m.id.starts_with("@nuah/fonts-") { Feature } else { expected.iter().find(|(id, _)| *id == m.id).unwrap_or_else(|| panic!("{} has no entry in the class table", m.id)).1 };
        assert_eq!(c.class, want, "{}: {:?}", m.id, c.reasons);
        seen.push(m.id);
    }
    for (id, _) in expected {
        assert!(seen.iter().any(|s| s == id), "{id} is in the class table but not in the registry");
    }
}
