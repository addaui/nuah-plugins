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
