// SPDX-License-Identifier: Apache-2.0
//! `links`: what a web address is, and, for a picture, its bytes ([ADR 0068]).
//!
//! Two outbound Operations. They run outside any transaction and reach the web only through the `net` Port, so which addresses may be
//! reached is the Adapter's rule, not this plugin's. `links.analyze` says what an address is (a picture, a video, a page, a file) and, for
//! a page, how it describes itself; `links.fetch` returns a picture's bytes so a Face can keep its own copy. Enabling the plugin is the
//! switch: a distribution that does not want its server making outbound requests leaves it out.
//!
//! [ADR 0068]: https://docs.addaui.com/nuah/adr/0068-images-by-paste-drop-and-upload-a-link-analyzer-plugin-page-tags-and-insert-page

use base64::{engine::general_purpose::STANDARD, Engine};
use nuah_kernel::*;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How much of a page is read to find its title, summary and picture.
pub const MAX_PAGE: usize = 512 * 1024;
/// The largest picture `links.fetch` returns.
pub const MAX_IMAGE: usize = 4 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(24 * 3600);
const CACHE_MAX: usize = 2000;

fn clean(s: &str, max: usize) -> String {
    let mut plain = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => plain.push(c),
            _ => {}
        }
    }
    let plain = decode(&plain);
    let words: Vec<&str> = plain.split_whitespace().collect();
    let joined: String = words.join(" ").chars().filter(|c| !c.is_control()).collect();
    if joined.chars().count() > max { format!("{}…", joined.chars().take(max - 1).collect::<String>()) } else { joined }
}

fn decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.find(';').filter(|e| *e <= 10);
        let Some(e) = end else { out.push('&'); rest = &rest[1..]; continue };
        let ent = &rest[1..e];
        let ch = match ent {
            "amp" => Some('&'), "lt" => Some('<'), "gt" => Some('>'), "quot" => Some('"'), "apos" => Some('\''), "nbsp" => Some(' '),
            _ => ent.strip_prefix('#').and_then(|n| match n.strip_prefix(['x', 'X']) { Some(h) => u32::from_str_radix(h, 16).ok(), None => n.parse().ok() }).and_then(char::from_u32),
        };
        match ch {
            Some(c) => { out.push(c); rest = &rest[e + 1..]; }
            None => { out.push('&'); rest = &rest[1..]; }
        }
    }
    out.push_str(rest);
    out
}

/// Where a tag ends: the first `>` that is not inside quotes.
fn tag_end(s: &str) -> Option<usize> {
    let mut q: Option<char> = None;
    for (i, c) in s.char_indices() {
        match (q, c) {
            (None, '"' | '\'') => q = Some(c),
            (Some(o), c) if c == o => q = None,
            (None, '>') => return Some(i),
            _ => {}
        }
    }
    None
}

/// The attributes of one tag's text, lower-cased names.
fn attrs(tag: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    let b: Vec<char> = tag.chars().collect();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_whitespace() || b[i] == '/') { i += 1; }
        let s = i;
        while i < b.len() && !b[i].is_whitespace() && b[i] != '=' && b[i] != '/' { i += 1; }
        let name: String = b[s..i].iter().collect::<String>().to_lowercase();
        while i < b.len() && b[i].is_whitespace() { i += 1; }
        let mut val = String::new();
        if i < b.len() && b[i] == '=' {
            i += 1;
            while i < b.len() && b[i].is_whitespace() { i += 1; }
            if i < b.len() && (b[i] == '"' || b[i] == '\'') {
                let q = b[i];
                i += 1;
                let vs = i;
                while i < b.len() && b[i] != q { i += 1; }
                val = b[vs..i.min(b.len())].iter().collect();
                i += 1;
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_whitespace() { i += 1; }
                val = b[vs..i].iter().collect();
            }
        }
        if !name.is_empty() { m.entry(name).or_insert(val); }
    }
    m
}

/// What the page says about itself. Pure: no network, no markup survives.
pub fn parse(html: &str, base: &url::Url) -> Value {
    let lower = html.to_lowercase();
    let mut meta: HashMap<String, String> = HashMap::new();
    let mut from = 0;
    // `to_lowercase` can change byte lengths for odd characters; only use the lowered copy for finding tags
    // when it kept the length, otherwise search the original case-sensitively.
    let hay = if lower.len() == html.len() { lower.as_str() } else { html };
    while let Some(i) = hay[from..].find("<meta") {
        let start = from + i + 5;
        let Some(end) = tag_end(&html[start..]) else { break };
        let a = attrs(&html[start..start + end]);
        let key = a.get("property").or_else(|| a.get("name")).map(|s| s.to_lowercase());
        if let (Some(k), Some(c)) = (key, a.get("content")) {
            meta.entry(k).or_insert_with(|| c.clone());
        }
        from = start + end;
    }
    let title_tag = hay.find("<title").and_then(|i| {
        let s = html[i..].find('>')? + i + 1;
        let e = hay[s..].find("</title")? + s;
        Some(html[s..e].to_string())
    });
    let pick = |keys: &[&str]| keys.iter().find_map(|k| meta.get(*k).filter(|v| !v.trim().is_empty()).cloned());
    let title = pick(&["og:title", "twitter:title"]).or(title_tag).map(|t| clean(&t, 200)).filter(|t| !t.is_empty());
    let description = pick(&["og:description", "twitter:description", "description"]).map(|t| clean(&t, 300)).filter(|t| !t.is_empty());
    let site = pick(&["og:site_name"]).map(|t| clean(&t, 80)).filter(|t| !t.is_empty()).or_else(|| base.host_str().map(|h| h.trim_start_matches("www.").to_string()));
    let image = pick(&["og:image", "og:image:url", "twitter:image"])
        .and_then(|i| base.join(decode(i.trim()).as_str()).ok())
        .filter(|u| u.scheme() == "https" && u.as_str().len() <= 500 && u.username().is_empty())
        .map(|u| u.to_string());
    json!({"url": base.as_str(), "title": title.unwrap_or_else(|| base.host_str().unwrap_or("").to_string()), "description": description, "site": site, "image": image})
}


/// What an address is, from the content type it answered with.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Kind { Image, Video, Page, File, Unknown }

impl Kind {
    pub fn name(self) -> &'static str {
        match self { Kind::Image => "image", Kind::Video => "video", Kind::Page => "page", Kind::File => "file", Kind::Unknown => "unknown" }
    }
}

/// The type a content-type header names, without its parameters, in lower case.
pub fn media_type(header: &str) -> String {
    header.split(';').next().unwrap_or("").trim().to_lowercase()
}

pub fn classify(media: &str) -> Kind {
    match media {
        m if m.starts_with("image/") => Kind::Image,
        m if m.starts_with("video/") => Kind::Video,
        "text/html" | "application/xhtml+xml" => Kind::Page,
        "application/pdf" | "application/zip" | "application/octet-stream" | "text/plain" | "text/csv" => Kind::File,
        _ => Kind::Unknown,
    }
}

/// The pictures `links.fetch` will hand over: the ones every browser draws and that carry no script.
pub fn raster(media: &str) -> bool {
    matches!(media, "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif")
}

/// The last part of an address's path, for a name.
fn file_name(u: &url::Url) -> String {
    let n = u.path_segments().and_then(|mut s| s.next_back()).unwrap_or("");
    let n: String = n.chars().filter(|c| !c.is_control()).take(120).collect();
    if n.is_empty() { u.host_str().unwrap_or("image").to_string() } else { n }
}

fn unavailable() -> Error {
    Error::reason(Category::NotFound, "links.unavailable", "Nothing could be read from that address")
}

fn web_address(raw: &str) -> Result<url::Url> {
    url::Url::parse(raw.trim()).ok().filter(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some()).ok_or_else(|| Error::invalid("url", "is not a web address"))
}

fn reached(e: Error) -> Error {
    if e.reason.as_deref() == Some("net.refused") { Error::invalid("url", "is not a public web address") } else { unavailable() }
}

type Cache = Arc<Mutex<HashMap<String, (Instant, Value)>>>;

/// The plugin. It keeps the answers of `links.analyze` for a day.
#[derive(Default)]
pub struct LinkAnalyzer {
    cache: Cache,
}

impl Plugin for LinkAnalyzer {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": "@nuah/link-analyzer", "version": "0.1.0", "name": "Link analyzer", "namespaces": ["links"],
            "description": "Says what a web address is (a picture, a video, a page, a file) and, for a page, its title, summary and picture; hands over a picture's bytes. Makes outbound web requests through the net Port.",
            "requires": {"capabilities": ["net"]},
            "operations": {
                "links.analyze": {"kind": "outbound", "description": "What a public http/https address is: its type and content type, and for a page its title, summary, site and picture.",
                    "reasons": {"links.unavailable": "Nothing could be read from that address"},
                    "input": {"type":"object","required":["url"],"properties":{"url":{"type":"string","maxLength":2000}},"additionalProperties":false},
                    "output": {"type":"object","required":["url","type"],"properties":{"url":{"type":"string"},"type":{"type":"string","enum":["image","video","page","file","unknown"]},"content_type":{"type":"string"},"size":{"type":["integer","null"]},"title":{"type":["string","null"]},"description":{"type":["string","null"]},"site":{"type":["string","null"]},"image":{"type":["string","null"]}}}},
                "links.fetch": {"kind": "outbound", "description": "The bytes of a picture (PNG, JPEG, GIF, WebP or AVIF, at most 4 MiB) at a public address, base64.",
                    "reasons": {"links.unavailable": "Nothing could be read from that address", "links.not_an_image": "That address is not a picture this can hand over", "links.too_big": "That picture is larger than 4 MiB"},
                    "input": {"type":"object","required":["url"],"properties":{"url":{"type":"string","maxLength":2000}},"additionalProperties":false},
                    "output": {"type":"object","required":["data","content_type","name"],"properties":{"data":{"type":"string"},"content_type":{"type":"string"},"name":{"type":"string"},"size":{"type":"integer"}}}}
            }
        })).expect("link analyzer manifest")
    }

    fn bind(&self, b: &mut Bindings) {
        let cache = self.cache.clone();
        b.outbound("links.analyze", move |cx, i| {
            let url = web_address(i["url"].as_str().unwrap_or(""))?;
            let key = url.as_str().to_string();
            if let Some((at, v)) = cache.lock().get(&key) {
                if at.elapsed() < TTL {
                    return Ok(v.clone());
                }
            }
            let req = NetRequest { max_bytes: MAX_PAGE, ..NetRequest::get(&key) }.header("Accept", "text/html,application/xhtml+xml,image/*,*/*;q=0.5");
            let resp = cx.net()?.fetch(&req).map_err(reached)?;
            if !(200..300).contains(&resp.status) {
                return Err(unavailable());
            }
            let media = media_type(resp.header("content-type").unwrap_or(""));
            let kind = classify(&media);
            let base = url::Url::parse(&resp.url).unwrap_or(url);
            let size = resp.header("content-length").and_then(|n| n.parse::<u64>().ok());
            let mut out = json!({"url": base.as_str(), "type": kind.name(), "content_type": media, "size": size, "title": Value::Null, "description": Value::Null, "site": Value::Null, "image": Value::Null});
            if kind == Kind::Page {
                let page = parse(&String::from_utf8_lossy(&resp.body), &base);
                for k in ["title", "description", "site", "image"] {
                    out[k] = page[k].clone();
                }
            } else {
                out["title"] = json!(file_name(&base));
            }
            let mut c = cache.lock();
            if c.len() >= CACHE_MAX {
                c.retain(|_, (at, _)| at.elapsed() < TTL);
                if c.len() >= CACHE_MAX {
                    c.clear();
                }
            }
            c.insert(key, (Instant::now(), out.clone()));
            Ok(out)
        });
        b.outbound("links.fetch", |cx, i| {
            let url = web_address(i["url"].as_str().unwrap_or(""))?;
            let req = NetRequest { max_bytes: MAX_IMAGE, timeout_ms: 15_000, ..NetRequest::get(url.as_str()) }.header("Accept", "image/*");
            let resp = cx.net()?.fetch(&req).map_err(reached)?;
            if !(200..300).contains(&resp.status) {
                return Err(unavailable());
            }
            let media = media_type(resp.header("content-type").unwrap_or(""));
            if !raster(&media) {
                return Err(Error::reason(Category::Invalid, "links.not_an_image", "That address is not a picture this can hand over"));
            }
            if resp.truncated {
                return Err(Error::reason(Category::Invalid, "links.too_big", "That picture is larger than 4 MiB"));
            }
            let base = url::Url::parse(&resp.url).unwrap_or(url);
            Ok(json!({"data": STANDARD.encode(&resp.body), "content_type": media, "name": file_name(&base), "size": resp.body.len()}))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_content_type_says_what_an_address_is() {
        assert_eq!(classify(&media_type("Image/PNG; charset=binary")), Kind::Image);
        assert_eq!(classify("video/mp4"), Kind::Video);
        assert_eq!(classify("text/html"), Kind::Page);
        assert_eq!(classify("application/pdf"), Kind::File);
        assert_eq!(classify("application/x-weird"), Kind::Unknown);
        assert!(raster("image/webp") && !raster("image/svg+xml"), "a picture that can carry script is never handed over");
    }
}
