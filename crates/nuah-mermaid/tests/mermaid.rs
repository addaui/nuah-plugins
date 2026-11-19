// SPDX-License-Identifier: Apache-2.0
use nuah_adapters::*;
use nuah_editor::Editor;
use nuah_kernel::*;
use nuah_mermaid::Mermaid;
use serde_json::json;
use std::sync::Arc;

#[test]
fn a_client_only_plugin_that_the_editor_lists() {
    let m = Mermaid.manifest();
    assert_eq!(m.runtime, Runtime::Data);
    assert_eq!(m.class().class, PluginClass::Feature, "{:?}", m.class().reasons);
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Editor), Arc::new(Mermaid)];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@nuah/editor", "@nuah/mermaid"].map(String::from).to_vec();
    let core = Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile: Profile { name: "t".into(), enabled, ..Default::default() } }).unwrap_or_else(|p| panic!("{p:#?}"));
    let out = core.call_as(&Identity::new("p", "p", &["member"]), "editor.elements", json!({}), None).unwrap().output;
    assert_eq!(out["kinds"][0]["kind"], "@nuah/mermaid/diagram");
    // every chunk the module may load is served
    assert!(core.browser_file("@nuah/mermaid", "index.js").is_some());
    assert!(Mermaid.browser_files().iter().filter(|(p, _)| p.starts_with("chunks/")).count() > 10);
}
