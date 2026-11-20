// SPDX-License-Identifier: Apache-2.0
//! `@nuah/previews` (ADR 0099): its operation, its Browser module and the element kinds it declares to the editor.

use nuah_kernel::*;

#[test]
fn it_declares_its_operation_its_module_and_its_kinds_under_its_own_name() {
    let p = nuah_previews::Previews::default();
    let m = p.manifest();
    assert_eq!(m.id, "@nuah/previews");
    assert!(m.operations.contains_key("previews.get"));
    assert_eq!(m.browser.get("editor.element").map(String::as_str), Some("index.js"));
    let kinds = m.provides.iter().find(|x| x.extension_point == "editor.element").and_then(|x| x.data.clone()).expect("kinds");
    let names: Vec<&str> = kinds["kinds"].as_array().unwrap().iter().filter_map(|k| k["kind"].as_str()).collect();
    assert_eq!(names, ["@nuah/previews/link-card", "@nuah/previews/youtube"]);
    assert!(p.browser_files().iter().any(|(f, _)| *f == "index.js"), "the module ships with the plugin");
}
