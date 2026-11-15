// SPDX-License-Identifier: Apache-2.0
//! `gifs`: where a Face finds GIFs ([ADR 0072]).
//!
//! This plugin only defines the Extension point `gifs.provider` and the Operation `gifs.provider`. A provider plugin (`@nuah/gifs-giphy`) answers with a
//! **descriptor**: how a browser calls that provider (the search and trending requests, where the results are in the answer, the attribution to show),
//! because a provider's terms may forbid a proxy through the server. The Face has one generic client that runs any descriptor, so a different provider
//! is a different plugin and no Face changes. Enabling this plugin needs a provider (the Core refuses to start without one). The sites the browser may call are the provider's own `connect` list in its manifest.
//!
//! [ADR 0072]: https://docs.addaui.com/nuah/adr/0072-gif-providers-are-plugins-the-browser-calls-the-provider-described-by-the-plugin-and-nuah-lets-plugins-ask-for-the-sites

use nuah_kernel::*;
use serde_json::{json, Value};

/// The shape every descriptor follows (documented once, here; a provider fills it).
pub const DESCRIPTOR_HELP: &str = "{configured, id, name, mode: \"client\", attribution: {text, url}, search: Request, trending: Request, sticker_search?: Request, sticker_trending?: Request, results: Map} where Request is {url, query: {name: value with {q}, {limit}, {offset}, {lang}}, max_limit, max_query} and Map names where things are in the answer: {list, total, id, title, preview, url, width, height, sent}; a field may be a path (\"images.fixed_width.url\") or a list of paths tried in order";

#[derive(Default)]
pub struct Gifs;

impl Plugin for Gifs {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": "@nuah/gifs", "version": "0.1.0", "name": "GIFs", "namespaces": ["gifs"],
            "description": "Where a Face finds GIFs: asks the enabled GIF provider plugin how to call it from the browser",
            "requires": {"extension_points": ["gifs.provider"]},
            "defines": {"extension_points": {"gifs.provider": {"policy": "single",
                "description": format!("Answers with the provider's descriptor: {DESCRIPTOR_HELP}. {{configured: false}} when it has no key yet."),
                "input": {"type": "object"}}}},
            "operations": {
                "gifs.provider": {"kind": "query", "description": "How a Face calls the GIF provider (a descriptor), or {configured: false} when there is none or it is not set up",
                    "output": {"type": "object", "required": ["configured"]}}
            }
        })).expect("gifs manifest")
    }

    fn bind(&self, b: &mut Bindings) {
        b.op("gifs.provider", |tx, _| {
            // the point takes one provider, so what comes back is its answer itself
            let d = tx.extension_call("gifs.provider", json!({}))?;
            Ok(if d.is_object() { d } else { json!({"configured": false}) })
        });
    }
}

/// Is this value a descriptor a Face can run? Used by providers' tests to keep their output honest.
pub fn descriptor_problems(d: &Value) -> Vec<String> {
    let mut out = vec![];
    if d["configured"] != true {
        return out;
    }
    for k in ["id", "name"] {
        if d[k].as_str().is_none_or(str::is_empty) {
            out.push(format!("{k} is missing"));
        }
    }
    if d["mode"] != "client" {
        out.push("mode must be client".into());
    }
    for r in ["search", "trending"] {
        if !d[r]["url"].as_str().is_some_and(|u| u.starts_with("https://")) {
            out.push(format!("{r}.url must be an https address"));
        }
    }
    for k in ["list", "id", "preview", "url"] {
        if d["results"][k].is_null() {
            out.push(format!("results.{k} is missing"));
        }
    }
    if d["attribution"]["text"].as_str().is_none_or(str::is_empty) {
        out.push("attribution.text is missing".into());
    }
    out
}
