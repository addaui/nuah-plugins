// SPDX-License-Identifier: Apache-2.0
//! `@nuah/gifs-giphy`: GIPHY as the GIF provider ([ADR 0072]).
//!
//! GIPHY's developer documentation asks that search and trending are called from the browser and forbids a proxy or a copy, so this plugin makes no
//! request itself: it answers `gifs.provider` with the descriptor of GIPHY's two endpoints and asks, in its manifest (`connect`), that the browser may
//! call `https://api.giphy.com`. The API key is a setting (a key is public by GIPHY's design, but it is kept out of the Profile as a secret reference).
//!
//! [ADR 0072]: https://docs.addaui.com/nuah/adr/0072-gif-providers-are-plugins-the-browser-calls-the-provider-described-by-the-plugin-and-nuah-lets-plugins-ask-for-the-sites

use nuah_kernel::*;
use serde_json::{json, Value};

const API: &str = "https://api.giphy.com/v1";

#[derive(Default)]
pub struct GifsGiphy;

fn request(path: &str, key: &str, rating: &str, search: bool) -> Value {
    let mut query = json!({"api_key": key, "limit": "{limit}", "offset": "{offset}", "rating": rating});
    if search {
        query["q"] = json!("{q}");
        query["lang"] = json!("{lang}");
    }
    json!({"url": format!("{API}/{path}"), "max_limit": 50, "max_query": 50, "query": query})
}

/// The descriptor for a key and a content rating, or `{configured: false}` without a key.
pub fn descriptor(settings: &Value) -> Value {
    let key = settings["api_key"].as_str().unwrap_or("").trim();
    if key.is_empty() {
        return json!({"configured": false, "id": "giphy", "name": "GIPHY"});
    }
    let rating = match settings["rating"].as_str() { Some(r @ ("g" | "pg" | "pg-13" | "r")) => r, _ => "pg" };
    json!({
        "configured": true, "id": "giphy", "name": "GIPHY", "mode": "client",
        "attribution": {"text": "Powered by GIPHY", "url": "https://giphy.com"},
        "search": request("gifs/search", key, rating, true),
        "trending": request("gifs/trending", key, rating, false),
        // GIPHY Stickers (transparent GIFs): the same answer, other addresses
        "sticker_search": request("stickers/search", key, rating, true),
        "sticker_trending": request("stickers/trending", key, rating, false),
        "results": {"list": "data", "total": "pagination.total_count", "id": "id", "title": "title",
            "preview": ["images.fixed_width.url"], "url": ["images.downsized_medium.url", "images.original.url"],
            "width": ["images.fixed_width.width"], "height": ["images.fixed_width.height"], "sent": "analytics.onsent.url"}
    })
}

impl Plugin for GifsGiphy {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": "@nuah/gifs-giphy", "version": "0.1.0", "name": "GIPHY", "namespaces": ["gifs-giphy"],
            "description": "GIPHY as the GIF source. The browser calls GIPHY itself, as GIPHY's rules ask; this plugin only describes the calls and allows the site.",
            "requires": {"plugins": ["@nuah/gifs"]},
            "provides": [{"extension_point": "gifs.provider"}],
            "connect": ["https://api.giphy.com"],
            "images": ["https://media.giphy.com", "https://media0.giphy.com", "https://media1.giphy.com", "https://media2.giphy.com", "https://media3.giphy.com", "https://media4.giphy.com", "https://i.giphy.com"],
            "settings_schema": {"type": "object", "additionalProperties": false, "properties": {
                "api_key": {"type": "string", "minLength": 8, "maxLength": 100, "title": "GIPHY API key", "x-secret": true, "x-tier": "operator", "x-apply": "live",
                    "description": "From developers.giphy.com (a beta key allows 100 calls an hour). Without it people see only the GIFs they uploaded."},
                "rating": {"type": "string", "enum": ["g", "pg", "pg-13", "r"], "default": "pg", "title": "Content rating", "x-tier": "operator", "x-apply": "live",
                    "description": "The most mature rating shown."}
            }}
        })).expect("giphy manifest")
    }

    fn bind(&self, b: &mut Bindings) {
        b.provide("gifs.provider", |tx, _| Ok(descriptor(&tx.settings())));
    }
}
