// SPDX-License-Identifier: Apache-2.0
//! `@nuah/excalidraw` ([ADR 0094]): Sketches as a card element, with Excalidraw full size. Client only: its kind is data (`browser/kinds.json`) and its
//! Browser module, with its chunks, stylesheet and fonts, is embedded (`browser/files.rs`, both written by the module's build).
//!
//! [ADR 0094]: https://docs.addaui.com/nuah/adr/0094-the-editor-is-a-host-that-knows-no-feature-plugins-bring-elements-with-their-own-data-views-options-and-capabilities-an-element-names-its-plugin-and-keeps-a-fallback-another-plugin-may-open-it/

use nuah_kernel::*;
use serde_json::{json, Value};

const FILES: &[(&str, &[u8])] = include!("../browser/files.rs");
const KINDS: &str = include_str!("../browser/kinds.json");

pub struct Excalidraw;
impl Plugin for Excalidraw {
    fn manifest(&self) -> Manifest {
        let kinds: Value = serde_json::from_str(KINDS).expect("kinds.json is JSON");
        serde_json::from_value(json!({
            "id": "@nuah/excalidraw", "version": "0.1.0", "name": "Sketches", "namespaces": ["excalidraw"], "runtime": "data",
            "description": "Sketches drawn with Excalidraw, together, shape by shape",
            "requires": {"extension_points": ["editor.element@^1"]},
            "provides": [{"extension_point": "editor.element", "data": kinds}],
            "browser": {"editor.element": "index.js"}
        }))
        .expect("the Excalidraw plugin's manifest")
    }
    fn browser_files(&self) -> &'static [(&'static str, &'static [u8])] {
        FILES
    }
}
