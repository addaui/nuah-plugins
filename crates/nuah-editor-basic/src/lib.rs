// SPDX-License-Identifier: Apache-2.0
//! `@nuah/editor-basic` ([ADR 0094]): the basic elements (paragraphs, headings, lists, checklists, quotes, dividers, code,
//! callouts, toggles, line breaks and the text marks) as an element plugin like any other. No server code: its kinds are data
//! (`browser/kinds.json`, written by the module's build from the same list the module uses) and its Browser module is embedded.
//!
//! [ADR 0094]: https://docs.addaui.com/nuah/adr/0094-the-editor-is-a-host-that-knows-no-feature-plugins-bring-elements-with-their-own-data-views-options-and-capabilities-an-element-names-its-plugin-and-keeps-a-fallback-another-plugin-may-open-it/

use nuah_kernel::*;
use serde_json::{json, Value};

const MODULE: &[u8] = include_bytes!("../browser/index.js");
const KINDS: &str = include_str!("../browser/kinds.json");

pub struct EditorBasic;
impl Plugin for EditorBasic {
    fn manifest(&self) -> Manifest {
        let kinds: Value = serde_json::from_str(KINDS).expect("kinds.json is JSON");
        serde_json::from_value(json!({
            "id": "@nuah/editor-basic", "version": "0.1.0", "name": "Basic elements", "namespaces": ["editorbasic"], "runtime": "data",
            "description": "Paragraphs, headings, lists, checklists, quotes, dividers, code, callouts, toggles and the text marks",
            "requires": {"extension_points": ["editor.element@^1"]},
            "provides": [{"extension_point": "editor.element", "data": kinds}],
            "browser": {"editor.element": "index.js"}
        }))
        .expect("the basic elements' manifest")
    }
    fn browser_files(&self) -> &'static [(&'static str, &'static [u8])] {
        &[("index.js", MODULE)]
    }
}
