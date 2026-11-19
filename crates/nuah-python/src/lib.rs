// SPDX-License-Identifier: Apache-2.0
//! `@nuah/python` ([ADR 0096]): a Runner for Python in the browser. Code runs in a Web Worker with Pyodide, in the person's own
//! browser: nothing runs on the instance, so it needs no `run` grant. Its module, worker and Pyodide's core files are embedded
//! (`browser/files.rs`, written by the module's build); packages named in imports load from the Pyodide CDN, the one site it asks for.
//!
//! [ADR 0096]: https://docs.addaui.com/nuah/adr/0096-running-code-is-a-capability-with-a-replaceable-runner-in-the-browser-first-on-the-server-only-in-a-separate-sandboxed-process/

use nuah_kernel::*;
use serde_json::json;

const FILES: &[(&str, &[u8])] = include!("../browser/files.rs");

pub struct Python;
impl Plugin for Python {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": "@nuah/python", "version": "0.1.0", "name": "Python in the browser", "namespaces": ["python"], "runtime": "data",
            "description": "Runs the Python of code cells in the person's browser (Pyodide in a Web Worker); packages load from the Pyodide CDN",
            "requires": {"extension_points": ["editor.runner@^1"]},
            "provides": [{"extension_point": "editor.runner", "data": {"languages": ["python"]}}],
            "browser": {"editor.runner": "index.js"},
            "connect": ["https://cdn.jsdelivr.net"]
        }))
        .expect("the Python runner's manifest")
    }
    fn browser_files(&self) -> &'static [(&'static str, &'static [u8])] {
        FILES
    }
}
