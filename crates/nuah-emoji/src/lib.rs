// SPDX-License-Identifier: Apache-2.0
//! `@nuah/emoji`: which picture set shows the emoji. Whoever offers a set answers the Extension point
//! `emoji.set`; the person picks one in the preferences (the `emoji.set` preference, in the appearance group).
//!
//! A set is one of two kinds:
//! - **font**: a family the device may have (`family`), such as Segoe UI Emoji for Microsoft's look or Apple Color
//!   Emoji for Apple's. An empty family means the device's own emoji. A Face draws only emoji code points with it.
//! - **font** with an `asset`: a font the plugin ships (Twemoji); a Face fetches it with `emoji.asset` and loads it.
//! - **images**: a URL template (`url`) with `{code}` in it, the emoji's code points in hex joined by `-` with the
//!   variation selector dropped, for a plugin that ships pictures.

use nuah_kernel::*;
use serde_json::{json, Value};
use std::sync::OnceLock;

/// The font the plugin ships (Twemoji, built as a COLR font; see CREDITS.md and THIRD_PARTY_NOTICES.md at the root of the repository).
const TWEMOJI: &[u8] = include_bytes!("../assets/twemoji.woff2");
/// Every emoji with its name, search words and group, in English (built by `tools/build-catalog.py` from Emojibase).
const CATALOG_EN: &str = include_str!("../assets/catalog.en.json");

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn font_base64() -> &'static str {
    static B: OnceLock<String> = OnceLock::new();
    B.get_or_init(|| base64(TWEMOJI))
}

fn catalog() -> &'static Value {
    static C: OnceLock<Value> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(CATALOG_EN).expect("the emoji catalog is JSON"))
}

fn manifest(v: Value) -> Manifest {
    serde_json::from_value(v).expect("emoji manifest")
}

/// Every set the plugins offer, in the order they answered, each id once.
fn all_sets(tx: &mut Tx) -> Result<Vec<Value>> {
    let mut out: Vec<Value> = vec![];
    for a in tx.extension_call("emoji.set", json!({}))?.as_array().cloned().unwrap_or_default() {
        if a["ok"] == true {
            for s in a["output"]["sets"].as_array().cloned().unwrap_or_default() {
                if s["id"].as_str().is_some_and(|id| !id.is_empty()) && !out.iter().any(|x| x["id"] == s["id"]) {
                    out.push(s);
                }
            }
        }
    }
    Ok(out)
}

pub struct Emoji;
impl Plugin for Emoji {
    fn manifest(&self) -> Manifest {
        manifest(json!({
            "id": "@nuah/emoji", "version": "0.1.0", "name": "Emoji", "namespaces": ["emoji"],
            "description": "Which picture set shows the emoji: the device's own, a look from a font, or a set a plugin ships",
            "requires": {"capabilities": ["call"], "extension_points": ["emoji.set"]},
            "defines": {"extension_points": {"emoji.set": {"policy": "many",
                "description": "A plugin answers with the emoji sets it offers: {sets: [{id, name: {en, ar?}, kind: \"font\"|\"images\", family?, url?}]}. A font set names a family the device may have; an images set gives a URL with {code} in it.",
                "input": {"type": "object"}}}},
            "provides": [{"extension_point": "emoji.set", "optional": true}, {"extension_point": "prefs.item", "optional": true}],
            "operations": {
                "emoji.sets": {"kind": "query", "description": "The emoji sets the plugins offer",
                    "input": {"type": "object", "properties": {}, "additionalProperties": false}, "output": {"type": "object", "required": ["sets"]}},
                "emoji.catalog": {"kind": "query", "description": "Every emoji with its name, search words and group (for a picker); {lang, groups: [{key, name}], items: [[emoji, name, words, group]]}",
                    "input": {"type": "object", "properties": {"lang": {"type": "string", "maxLength": 8}}, "additionalProperties": false}, "output": {"type": "object", "required": ["items"]}},
                "emoji.asset": {"kind": "query", "description": "A file a set ships (a font), as base64: {content_type, data}",
                    "input": {"type": "object", "required": ["id"], "properties": {"id": {"enum": ["twemoji.woff2"]}}, "additionalProperties": false}, "output": {"type": "object", "required": ["data"]}}
            }
        }))
    }
    fn bind(&self, b: &mut Bindings) {
        b.provide("emoji.set", |_tx, _i| {
            Ok(json!({"sets": [
                {"id": "system", "name": {"en": "This device", "ar": "هذا الجهاز"}, "kind": "font", "family": ""},
                {"id": "microsoft", "name": {"en": "Microsoft (Segoe UI Emoji)", "ar": "مايكروسوفت (Segoe UI Emoji)"}, "kind": "font", "family": "Segoe UI Emoji"},
                {"id": "apple", "name": {"en": "Apple (Apple Color Emoji)", "ar": "أبل (Apple Color Emoji)"}, "kind": "font", "family": "Apple Color Emoji"},
                {"id": "google", "name": {"en": "Google (Noto Color Emoji)", "ar": "جوجل (Noto Color Emoji)"}, "kind": "font", "family": "Noto Color Emoji"},
                {"id": "twemoji", "name": {"en": "Twemoji (included, same on every device)", "ar": "Twemoji (مضمّن، نفسه على كل جهاز)"}, "kind": "font", "family": "Twemoji", "asset": "twemoji.woff2"}
            ]}))
        });
        b.op("emoji.sets", |tx, _i| Ok(json!({"sets": all_sets(tx)?})));
        b.op("emoji.catalog", |_tx, _i| Ok(catalog().clone()));
        b.op("emoji.asset", |_tx, i| match i["id"].as_str() {
            Some("twemoji.woff2") => Ok(json!({"content_type": "font/woff2", "data": font_base64()})),
            _ => Err(Error::not_found("asset")),
        });
        // the choice in the preferences window; its options are whatever the enabled plugins offer
        b.provide("prefs.item", |tx, _i| {
            let choices: Vec<Value> = all_sets(tx)?.iter().map(|s| json!({"value": s["id"], "label": s["name"]})).collect();
            Ok(json!({"items": [{"key": "emoji.set", "group": "appearance", "type": "choice", "default": "system", "choices": choices,
                "label": {"en": "Emoji style", "ar": "شكل الإيموجي"}}]}))
        });
    }
}
