// SPDX-License-Identifier: Apache-2.0
use nuah_adapters::*;
use nuah_editor::Editor;
use nuah_kernel::*;
use nuah_notebook::Notebook;
use serde_json::json;
use std::sync::Arc;

#[test]
fn the_editor_lists_code_cells() {
    assert_eq!(Notebook.manifest().class().class, PluginClass::Feature);
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Editor), Arc::new(Notebook)];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@nuah/editor", "@nuah/notebook"].map(String::from).to_vec();
    let core = Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile: Profile { name: "t".into(), enabled, ..Default::default() } }).unwrap_or_else(|p| panic!("{p:#?}"));
    let out = core.call_as(&Identity::new("p", "p", &["member"]), "editor.elements", json!({}), None).unwrap().output;
    assert_eq!(out["kinds"][0]["kind"], "@nuah/notebook/cell");
}
