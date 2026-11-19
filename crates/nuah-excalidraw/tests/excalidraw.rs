// SPDX-License-Identifier: Apache-2.0
use nuah_adapters::*;
use nuah_editor::Editor;
use nuah_excalidraw::Excalidraw;
use nuah_kernel::*;
use serde_json::json;
use std::sync::Arc;

#[test]
fn sketches_come_with_their_fonts_and_stylesheet() {
    let m = Excalidraw.manifest();
    assert_eq!(m.class().class, PluginClass::Feature, "{:?}", m.class().reasons);
    let files: Vec<&str> = Excalidraw.browser_files().iter().map(|(p, _)| *p).collect();
    assert!(files.contains(&"index.js") && files.contains(&"index.css"));
    assert!(files.iter().any(|f| f.starts_with("fonts/Excalifont/")));
    assert!(!files.iter().any(|f| f.contains("Xiaolai")));
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Editor), Arc::new(Excalidraw)];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@nuah/editor", "@nuah/excalidraw"].map(String::from).to_vec();
    let core = Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile: Profile { name: "t".into(), enabled, ..Default::default() } }).unwrap_or_else(|p| panic!("{p:#?}"));
    let out = core.call_as(&Identity::new("p", "p", &["member"]), "editor.elements", json!({}), None).unwrap().output;
    assert_eq!(out["kinds"][0]["kind"], "@nuah/excalidraw/sketch");
    assert_eq!(out["kinds"][0]["state"], "map");
}
