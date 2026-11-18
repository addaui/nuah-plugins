// SPDX-License-Identifier: Apache-2.0
//! Fonts ([ADR 0090]): families described as data by font plugins, and a store that keeps each font file the instance fetched once.
//!
//! A *font plugin* (`runtime: data`, a `fonts` block of schema `fonts/1`) lists families: their scripts, weights, features, licence, source
//! and faces (one file per script, style and weight range, each with its `unicode-range`). The Core only stores and checks the data; the
//! Face draws. `@nuah/fonts` is the store. A web-hosted font is fetched from its declared address by the instance, once, through the `net`
//! Port, kept, and served at `/fonts/<key>.woff2`, so a viewer's browser never contacts the font's host ([ADR 0077] applied to fonts).
//! The store fetches only an address that a face of an enabled font plugin names, so it is not a general downloader.
//!
//! [ADR 0090]: https://docs.addaui.com/nuah/adr/0090-fonts-are-plugins-the-interface-has-one-font-per-language-pages-choose-from-a-short-curated-list-and-web-fonts-are-fetched-once-by-the-instance
//! [ADR 0077]: https://docs.addaui.com/nuah/adr/0077-a-viewers-browser-loads-only-from-the-instance-and-the-sites-a-plugin-declares-previews-and-pictures-are-fetched-once-and-stored

use base64::{engine::general_purpose::STANDARD, Engine};
use nuah_kernel::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The collection of stored font files, by key.
pub const FILES: &str = "fonts.files";
/// The largest font file the store keeps.
pub const MAX_FONT: usize = 2 * 1024 * 1024;
/// How many font files the store keeps at most.
pub const MAX_STORED: u64 = 1500;

const CATEGORIES: [&str; 5] = ["sans", "serif", "mono", "display", "handwriting"];
const SCRIPTS: [&str; 6] = ["latin", "arabic", "cyrillic", "greek", "hebrew", "devanagari"];

fn manifest(v: Value) -> Manifest {
    serde_json::from_value(v).expect("a valid manifest")
}

/// The key of a font file: the first 32 hex digits of the SHA-256 of its address. The browser can work it out before the file is fetched.
pub fn key_of(url: &str) -> String {
    Sha256::digest(url.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v[k].as_str().filter(|s| !s.is_empty())
}

fn range_ok(s: &str) -> bool {
    !s.is_empty() && s.len() < 4000 && s.split(',').all(|r| {
        let r = r.trim();
        r.strip_prefix("U+").is_some_and(|b| b.split('-').count() <= 2 && b.split('-').all(|h| !h.is_empty() && h.len() <= 6 && h.chars().all(|c| c.is_ascii_hexdigit() || c == '?')))
    })
}

fn weights_ok(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.len() == 2 && a.iter().all(|n| n.as_u64().is_some_and(|n| (1..=1000).contains(&n))) && a[0].as_u64() <= a[1].as_u64())
}

/// A face's address: an absolute `https` address (fetched once by the store) or a path on this instance (`/faces/...`, already served).
pub fn face_address_ok(u: &str) -> bool {
    (u.starts_with("https://") && u.len() < 1000 && !u.contains(char::is_whitespace) && u[8..].split('/').next().is_some_and(|h| h.contains('.') && !h.contains('@')))
        || (u.starts_with('/') && !u.starts_with("//") && !u.contains(".."))
}

/// Checks a `fonts/1` block: what the Face relies on is there and has the right shape. Returns the first problem.
pub fn validate(data: &Value) -> std::result::Result<(), String> {
    if data["schema"] != "fonts/1" {
        return Err("schema must be fonts/1".into());
    }
    let list = data["families"].as_array().ok_or("families must be a list")?;
    let mut seen = std::collections::BTreeSet::new();
    for f in list {
        let id = text(f, "id").ok_or("a family has no id")?;
        let at = |m: &str| format!("{id}: {m}");
        if !seen.insert(id.to_string()) {
            return Err(at("the id is used twice"));
        }
        if !id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
            return Err(at("the id is lower-case letters, digits and dashes"));
        }
        text(f, "name").ok_or_else(|| at("no name"))?;
        if !CATEGORIES.contains(&f["category"].as_str().unwrap_or("")) {
            return Err(at("category is not one of sans, serif, mono, display, handwriting"));
        }
        let scripts = f["scripts"].as_array().filter(|a| !a.is_empty()).ok_or_else(|| at("no scripts"))?;
        if !scripts.iter().all(|s| s.as_str().is_some_and(|s| SCRIPTS.contains(&s))) {
            return Err(at("an unknown script"));
        }
        if !weights_ok(&f["weights"]) {
            return Err(at("weights is [lowest, highest]"));
        }
        for t in f["features"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            if !t["tag"].as_str().is_some_and(|t| t.len() == 4 && t.is_ascii()) || text(t, "label").is_none() {
                return Err(at("a feature needs a four-letter tag and a label"));
            }
        }
        if text(&f["licence"], "spdx").is_none() {
            return Err(at("the licence must name its identifier (spdx)"));
        }
        if !f["source"]["url"].as_str().is_some_and(|u| u.starts_with("https://")) || text(&f["source"], "name").is_none() {
            return Err(at("the source needs a name and an https address"));
        }
        if !f["metrics"].is_null() {
            let m = &f["metrics"];
            let n = |k: &str| m[k].as_f64().filter(|v| v.is_finite() && *v >= 0.0);
            if !["upm", "ascent", "descent", "line_gap"].iter().all(|k| n(k).is_some()) || !n("width_ratio").is_some_and(|r| (0.5..=2.0).contains(&r)) || !matches!(m["fallback"].as_str(), Some("Arial" | "Times New Roman")) {
                return Err(at("metrics need upm, ascent, descent, line_gap, a width_ratio between 0.5 and 2 and a fallback of Arial or Times New Roman"));
            }
        }
        let faces = f["faces"].as_array().filter(|a| !a.is_empty()).ok_or_else(|| at("no faces"))?;
        for fc in faces {
            if !fc["script"].as_str().is_some_and(|s| scripts.iter().any(|x| x == s)) {
                return Err(at("a face's script is not one of the family's scripts"));
            }
            if !matches!(fc["style"].as_str(), Some("normal" | "italic")) || !weights_ok(&fc["weight"]) {
                return Err(at("a face needs a style (normal or italic) and a weight range"));
            }
            if !range_ok(fc["range"].as_str().unwrap_or("")) {
                return Err(at("a face's range is not a unicode-range"));
            }
            if !fc["url"].as_str().is_some_and(face_address_ok) {
                return Err(at("a face's address must be an https address or a path on this instance"));
            }
        }
    }
    Ok(())
}

/// The shipped catalogue: the short list of the most used fonts, Latin and Arabic, made by `tools/fonts/generate.py`.
pub fn catalogue() -> Value {
    serde_json::from_str(include_str!("../catalogue.json")).expect("catalogue.json is valid")
}

/// A font plugin: only data (id, name, description, the `fonts/1` block).
pub struct FontSet(pub String, pub String, pub String, pub Value);
impl Plugin for FontSet {
    fn manifest(&self) -> Manifest {
        manifest(json!({"id": &self.0, "version": "0.1.0", "name": &self.1, "runtime": "data", "requires": {"plugins": ["@nuah/fonts"]}, "fonts": &self.3, "description": &self.2}))
    }
}

/// The font plugins that ship: the open-licence families (`@nuah/fonts-google`) and Satoshi, whose licence (Fontshare's) does not let the files be
/// redistributed, so it is its own plugin an operator can leave out (`@nuah/fonts-fontshare`).
pub fn font_sets() -> Vec<FontSet> {
    let all = catalogue();
    let mut google = vec![];
    let mut shared = vec![];
    for f in all["families"].as_array().cloned().unwrap_or_default() {
        if f["licence"]["spdx"] == "ITF-FFL" { shared.push(f) } else { google.push(f) }
    }
    let set = |id: &str, name: &str, desc: &str, fams: Vec<Value>| FontSet(id.into(), name.into(), desc.into(), json!({"schema": "fonts/1", "families": fams}));
    vec![
        set("@nuah/fonts-google", "Popular fonts (open licence)", "The most used Latin and Arabic families from Google Fonts (SIL Open Font License), fetched once by the instance", google),
        set("@nuah/fonts-fontshare", "Satoshi (Fontshare)", "Satoshi by Indian Type Foundry, free for personal and commercial use; fetched by each instance from Fontshare and never bundled", shared),
    ]
}

/// Plugin ids of the shipped font plugins, for profiles.
pub fn font_set_ids() -> Vec<String> {
    font_sets().into_iter().map(|s| s.0).collect()
}

/// The faces of every enabled font plugin that the store may fetch: address -> true. A family that says `rehost: false` is left out.
fn fetchable(data: &[Value], url: &str) -> bool {
    data.iter().flat_map(|d| d["families"].as_array().cloned().unwrap_or_default()).any(|f| f["rehost"] != false && f["faces"].as_array().is_some_and(|fs| fs.iter().any(|fc| fc["url"] == url)))
}

fn unavailable() -> Error {
    Error::reason(Category::NotFound, "fonts.unavailable", "That font could not be fetched")
}

/// The store.
pub struct FontStore;
impl Plugin for FontStore {
    fn manifest(&self) -> Manifest {
        manifest(json!({
            "id": "@nuah/fonts", "version": "0.1.0", "name": "Font store", "namespaces": ["fonts"],
            "description": "Fetches a web-hosted font once, through the net Port, keeps it and serves it, so a viewer's browser contacts only this server (ADR 0090). It fetches only addresses that a font plugin names.",
            "requires": {"capabilities": ["net", "call"]},
            "data": {"schema": serde_json::from_str::<Value>(include_str!("../schema/fonts.json")).expect("the schema file is JSON")},
            "permissions": {"fonts.store": {"description": "Keep a font file (only the store itself, after it has fetched and checked it)", "default": ["plugin:@nuah/fonts"]}},
            "operations": {
                "fonts.fetch": {"kind": "outbound", "description": "Fetch a font file from an address a font plugin names, once, and keep it; says its key",
                    "reasons": {"fonts.unavailable": "That font could not be fetched", "fonts.not_listed": "That address is not a font of an enabled font plugin", "fonts.not_a_font": "That file is not a font this can keep"},
                    "input": {"type": "object", "required": ["url"], "properties": {"url": {"type": "string", "maxLength": 1000}}, "additionalProperties": false},
                    "output": {"type": "object", "required": ["key", "cached"], "properties": {"key": {"type": "string"}, "cached": {"type": "boolean"}, "size": {"type": "integer"}}}},
                "fonts.status": {"kind": "query", "description": "Which of these font addresses the store holds, with the key each is served under (/fonts/<key>.woff2)",
                    "input": {"type": "object", "required": ["urls"], "properties": {"urls": {"type": "array", "maxItems": 500, "items": {"type": "string", "maxLength": 1000}}}, "additionalProperties": false},
                    "output": {"type": "object", "required": ["present"], "properties": {"present": {"type": "array", "items": {"type": "object", "required": ["url", "key"], "properties": {"url": {"type": "string"}, "key": {"type": "string"}}}}}}},
                "fonts.families": {"kind": "query", "public": true, "description": "Families of the enabled font plugins by id, each face with the key it is served under when the store holds it: what a reader of a shared page needs to draw its font",
                    "input": {"type": "object", "required": ["ids"], "properties": {"ids": {"type": "array", "maxItems": 20, "items": {"type": "string", "maxLength": 60}}}, "additionalProperties": false},
                    "output": {"type": "object", "required": ["families"], "properties": {"families": {"type": "array", "items": {"type": "object"}}}}},
                "fonts.get": {"kind": "query", "public": true, "description": "The bytes of a stored font file, base64 (the Projection serves them at /fonts/<key>.woff2)",
                    "input": {"type": "object", "required": ["key"], "properties": {"key": {"type": "string", "maxLength": 64}}, "additionalProperties": false},
                    "output": {"type": "object", "required": ["data", "type"], "properties": {"data": {"type": "string"}, "type": {"type": "string"}}}},
                "fonts.store": {"kind": "command", "permission": "fonts.store", "description": "Keep a checked font file under the key of its address",
                    "input": {"type": "object", "required": ["url", "data"], "properties": {"url": {"type": "string", "maxLength": 1000}, "data": {"type": "string"}}, "additionalProperties": false},
                    "output": {"type": "object", "required": ["key"], "properties": {"key": {"type": "string"}}}}
            }
        }))
    }

    fn bind(&self, b: &mut Bindings) {
        b.op("fonts.status", |tx, i| {
            let mut present = vec![];
            for url in i["urls"].as_array().into_iter().flatten().filter_map(|u| u.as_str()) {
                let key = key_of(url);
                if tx.get(FILES, &key)?.is_some() {
                    present.push(json!({"url": url, "key": key}));
                }
            }
            Ok(json!({"present": present}))
        });
        b.op("fonts.families", |tx, i| {
            let want: Vec<&str> = i["ids"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).collect();
            let mut out = vec![];
            for d in tx.font_data() {
                for f in d["families"].as_array().cloned().unwrap_or_default() {
                    if !want.contains(&f["id"].as_str().unwrap_or("")) || out.iter().any(|o: &Value| o["id"] == f["id"]) {
                        continue;
                    }
                    let mut f = f;
                    for fc in f["faces"].as_array_mut().into_iter().flatten() {
                        let url = fc["url"].as_str().unwrap_or("").to_string();
                        // a face served from this instance's own storage carries its key, so a reader who cannot ask the store can still load it
                        if url.starts_with("https://") && tx.get(FILES, &key_of(&url))?.is_some() {
                            fc["key"] = json!(key_of(&url));
                        }
                    }
                    out.push(f);
                }
            }
            Ok(json!({"families": out}))
        });
        b.op("fonts.get", |tx, i| {
            let key = i["key"].as_str().unwrap_or("");
            let doc = tx.get(FILES, key)?.ok_or_else(|| Error::not_found("font"))?;
            Ok(json!({"data": doc.body["data"], "type": "font/woff2"}))
        });
        b.op("fonts.store", |tx, i| {
            let url = i["url"].as_str().unwrap_or("");
            let bytes = STANDARD.decode(i["data"].as_str().unwrap_or("")).map_err(|_| Error::invalid("data", "is not base64"))?;
            if bytes.len() > MAX_FONT || !bytes.starts_with(b"wOF2") {
                return Err(Error::reason(Category::Invalid, "fonts.not_a_font", "That file is not a font this can keep"));
            }
            let key = key_of(url);
            if tx.get(FILES, &key)?.is_none() && tx.count(FILES, &[])? >= MAX_STORED {
                return Err(Error::invalid("url", "the store is full"));
            }
            tx.put(FILES, &key, json!({"url": url, "size": bytes.len(), "data": STANDARD.encode(&bytes)}), Expect::Any)?;
            Ok(json!({"key": key}))
        });
        b.outbound("fonts.fetch", |cx, i| {
            let url = i["url"].as_str().unwrap_or("");
            if !fetchable(&cx.font_data(), url) {
                return Err(Error::reason(Category::Invalid, "fonts.not_listed", "That address is not a font of an enabled font plugin"));
            }
            let key = key_of(url);
            let held = cx.call("fonts.status", json!({"urls": [url]}))?;
            if held["present"].as_array().is_some_and(|p| !p.is_empty()) {
                return Ok(json!({"key": key, "cached": true}));
            }
            let req = NetRequest { max_bytes: MAX_FONT + 1, timeout_ms: 20_000, ..NetRequest::get(url) }.header("Accept", "font/woff2,*/*;q=0.5");
            let resp = cx.net()?.fetch(&req).map_err(|_| unavailable())?;
            if !(200..300).contains(&resp.status) {
                return Err(unavailable());
            }
            if resp.truncated || resp.body.len() > MAX_FONT || !resp.body.starts_with(b"wOF2") {
                return Err(Error::reason(Category::Invalid, "fonts.not_a_font", "That file is not a font this can keep"));
            }
            cx.call_as_self("fonts.store", json!({"url": url, "data": STANDARD.encode(&resp.body)}))?;
            Ok(json!({"key": key, "cached": false, "size": resp.body.len()}))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_is_valid_short_and_has_the_interface_fonts() {
        let c = catalogue();
        validate(&c).unwrap();
        let fams = c["families"].as_array().unwrap();
        assert!((30..=80).contains(&fams.len()), "a short list, not thousands: {}", fams.len());
        let ui = |lang: &str| fams.iter().find(|f| f["ui"] == lang).map(|f| f["id"].as_str().unwrap().to_string());
        assert_eq!(ui("en").as_deref(), Some("satoshi"));
        assert_eq!(ui("ar").as_deref(), Some("readex-pro"));
        assert!(fams.iter().any(|f| f["scripts"].as_array().unwrap().iter().any(|s| s == "arabic")) && fams.iter().any(|f| f["scripts"] == json!(["latin"])));
    }

    #[test]
    fn satoshi_is_its_own_plugin_and_never_bundled() {
        let sets = font_sets();
        assert_eq!(sets.len(), 2);
        let shared = sets.iter().find(|s| s.0 == "@nuah/fonts-fontshare").unwrap();
        assert_eq!(shared.3["families"][0]["id"], "satoshi");
        assert_eq!(shared.3["families"][0]["bundle"], false);
        assert!(sets.iter().filter(|s| s.0 != "@nuah/fonts-fontshare").all(|s| s.3["families"].as_array().unwrap().iter().all(|f| f["licence"]["spdx"] != "ITF-FFL")));
        for s in &sets {
            validate(&s.3).unwrap();
        }
    }

    #[test]
    fn a_bad_family_is_named() {
        let mut c = catalogue();
        c["families"][0]["faces"][0]["url"] = json!("http://insecure.example/x.woff2");
        assert!(validate(&c).unwrap_err().contains("address"));
        let mut c = catalogue();
        c["families"][1]["category"] = json!("fancy");
        assert!(validate(&c).unwrap_err().contains("category"));
        let mut c = catalogue();
        c["families"][2]["faces"][0]["range"] = json!("latin");
        assert!(validate(&c).unwrap_err().contains("unicode-range"));
        assert!(validate(&json!({"schema": "fonts/2", "families": []})).is_err());
        let mut c = catalogue();
        c["families"][0]["metrics"]["width_ratio"] = json!(9);
        assert!(validate(&c).unwrap_err().contains("metrics"));
    }

    #[test]
    fn a_key_is_stable_and_safe_in_a_path() {
        let k = key_of("https://cdn.example.com/a.woff2");
        assert_eq!(k, key_of("https://cdn.example.com/a.woff2"));
        assert_eq!(k.len(), 32);
        assert!(k.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(k, key_of("https://cdn.example.com/b.woff2"));
    }
}
