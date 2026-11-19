// SPDX-License-Identifier: Apache-2.0
//! `@nuah/mermaid` ([ADR 0094]): Mermaid diagrams as a card element. Client only: its kind is data (`browser/kinds.json`) and its
//! Browser module, with the chunks Mermaid loads on demand, is embedded (`browser/files.rs`, both written by the module's build).
//!
//! [ADR 0094]: https://docs.addaui.com/nuah/adr/0094-the-editor-is-a-host-that-knows-no-feature-plugins-bring-elements-with-their-own-data-views-options-and-capabilities-an-element-names-its-plugin-and-keeps-a-fallback-another-plugin-may-open-it/

use nuah_kernel::*;
use serde_json::{json, Value};

const FILES: &[(&str, &[u8])] = include!("../browser/files.rs");
const KINDS: &str = include_str!("../browser/kinds.json");

pub struct Mermaid;
impl Plugin for Mermaid {
    fn manifest(&self) -> Manifest {
        let kinds: Value = serde_json::from_str(KINDS).expect("kinds.json is JSON");
        serde_json::from_value(json!({
            "id": "@nuah/mermaid", "version": "0.1.0", "name": "Diagrams", "namespaces": ["mermaid"], "runtime": "data",
            "description": "Mermaid diagrams: the source is edited together and drawn as a picture",
            "requires": {"extension_points": ["editor.element@^1"]},
            "provides": [{"extension_point": "editor.element", "data": kinds}],
            "browser": {"editor.element": "index.js"}
        }))
        .expect("the Mermaid plugin's manifest")
    }
    fn browser_files(&self) -> &'static [(&'static str, &'static [u8])] {
        FILES
    }
}
