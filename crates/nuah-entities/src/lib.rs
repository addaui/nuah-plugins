// SPDX-License-Identifier: Apache-2.0
//! `@nuah/entities`: one index of everything a person can find or refer to ([ADR 0092]). It knows no product. A plugin
//! announces its Entities in the Events it already sends, and this plugin keeps one Entity entry per Entity and the
//! links between them. Search, `get` and Backlinks answer only with what the caller would receive the Events of: the
//! Audience of the announcing Event, resolved when the question is asked.
//!
//! An Event's `data` may hold
//!
//! ```json
//! {"entity": {"kind": "pages.page", "id": "p1", "title": "…", "text": "…", "aliases": [], "tags": [], "context": {}}}
//! {"entity": {"kind": "pages.page", "id": "p1", "removed": true}}
//! {"entities": [{"kind": "tasks.task", "id": "t1", "removed": true}, {"kind": "tasks.task", "id": "t2", "removed": true}]}
//! {"refs": {"from": {"type": "pages.page", "id": "p1"}, "title": "…", "to": [{"type": "tasks.task", "id": "t9"}]}}
//! ```
//!
//! A kind must be in the namespace of the Event (`pages.*` Events announce `pages.…` kinds). An announcement that is
//! not one is logged and skipped, so one bad Event never stops the index.
//!
//! [ADR 0092]: https://docs.addaui.com/nuah/adr/0092-one-index-of-entities-plugins-announce-them-in-their-events-the-data-port-searches-text-and-permissions-follow-the-events-audience/

use nuah_kernel::text::fold;
use nuah_kernel::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const ENTRIES: &str = "entities.entries";
pub const LINKS: &str = "entities.links";
/// The longest text an entry keeps, in characters.
pub const TEXT_MAX: usize = 20_000;
/// How many of the newest matches a search ranks.
const CANDIDATES: usize = 500;

fn key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

fn row_id(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))[..32].to_string()
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(|x| x.as_array()).into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect()
}

/// How well `title` and `body` match every word of `q` (all must appear), as people type: folded the way the index
/// folds. A hit in the title counts three, in the body one (at most five), a title that starts with the word two
/// more. With the score, 140 characters of the body around the first hit. `None` if a word is missing.
pub fn score(q: &str, title: &str, body: &str) -> Option<(f64, String)> {
    let words = nuah_kernel::text::words(q);
    if words.is_empty() {
        return None;
    }
    let (t, b) = (fold(title), fold(body));
    let mut s = 0.0;
    for w in &words {
        let (in_t, in_b) = (t.matches(w.as_str()).count(), b.matches(w.as_str()).count());
        if in_t + in_b == 0 {
            return None;
        }
        s += in_t as f64 * 3.0 + (in_b as f64).min(5.0);
        if t.starts_with(w.as_str()) {
            s += 2.0;
        }
    }
    Some((s, snippet(body, &words)))
}

/// 140 characters of `body` from 40 before the first hit of any word, cut on characters, never inside a letter.
fn snippet(body: &str, words: &[String]) -> String {
    let chars: Vec<char> = body.chars().collect();
    // the folded text, with the place in `body` each folded character came from
    let (mut folded, mut from): (Vec<char>, Vec<usize>) = (vec![], vec![]);
    for (i, c) in chars.iter().enumerate() {
        for f in fold(&c.to_string()).chars() {
            folded.push(f);
            from.push(i);
        }
    }
    let at = words.iter().find_map(|w| {
        let w: Vec<char> = w.chars().collect();
        folded.windows(w.len()).position(|x| x == w.as_slice()).map(|p| from[p])
    });
    at.map(|at| {
        let start = at.saturating_sub(40);
        chars[start..(start + 140).min(chars.len())].iter().collect::<String>().replace('\n', " ")
    })
    .unwrap_or_default()
}

/// The kind of an announcement, if it is in the Event's namespace.
fn own_kind<'a>(namespace: &str, kind: &'a str) -> std::result::Result<&'a str, String> {
    match kind.split_once('.') {
        Some((ns, rest)) if ns == namespace && !rest.is_empty() => Ok(kind),
        _ => Err(format!("the kind {kind:?} is not in the namespace {namespace} of the Event")),
    }
}

fn record_entity(tx: &mut Tx, namespace: &str, e: &Value, audience: &Value, at: Millis) -> std::result::Result<(), String> {
    let kind = own_kind(namespace, text(e, "kind"))?;
    let id = e.get("id").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).ok_or("an entity needs an id")?;
    let rid = row_id(&key(kind, id));
    if e.get("removed") == Some(&Value::Bool(true)) {
        tx.delete(ENTRIES, &rid).map_err(|e| e.message)?;
        // what is gone refers to nothing any more
        drop_links(tx, &key(kind, id))?;
        return Ok(());
    }
    let title = e.get("title").and_then(|x| x.as_str()).ok_or("an entity needs a title (text)")?;
    let body: String = text(e, "text").chars().take(TEXT_MAX).collect();
    let context = e.get("context").filter(|c| c.is_object()).cloned().unwrap_or_else(|| json!({}));
    tx.put(ENTRIES, &rid, json!({
        "kind": kind, "ref": id, "title": title, "text": body, "aliases": strings(e.get("aliases")), "tags": strings(e.get("tags")),
        "context": context, "audience": audience, "at": at
    }), Expect::Any)
    .map_err(|e| e.message)?;
    Ok(())
}

fn drop_links(tx: &mut Tx, from_key: &str) -> std::result::Result<(), String> {
    loop {
        let old = tx.query(LINKS, &Query::new().eq("from_key", from_key).limit(200)).map_err(|e| e.message)?;
        if old.items.is_empty() {
            return Ok(());
        }
        for o in old.items {
            tx.delete(LINKS, &o.id).map_err(|e| e.message)?;
        }
    }
}

/// Every link from one Entity goes, and those the announcement names are written: safe to repeat.
fn record_links(tx: &mut Tx, namespace: &str, r: &Value, audience: &Value) -> std::result::Result<(), String> {
    let from = &r["from"];
    let kind = own_kind(namespace, text(from, "type"))?;
    let id = text(from, "id");
    if id.is_empty() {
        return Err("a reference needs the id it is from".into());
    }
    let from_key = key(kind, id);
    drop_links(tx, &from_key)?;
    for t in r["to"].as_array().cloned().unwrap_or_default() {
        let (tk, ti) = (text(&t, "type"), text(&t, "id"));
        if tk.is_empty() || ti.is_empty() {
            continue;
        }
        let to_key = key(tk, ti);
        tx.put(LINKS, &row_id(&format!("{from_key}>{to_key}")), json!({
            "from": {"type": kind, "id": id}, "to": t, "from_key": from_key, "to_key": to_key, "title": text(r, "title"), "audience": audience
        }), Expect::Any)
        .map_err(|e| e.message)?;
    }
    Ok(())
}

/// May the caller see what was announced to this stored Audience? A value that is not an Audience holds no one.
fn sees(tx: &Tx, audience: &Value) -> Result<bool> {
    match serde_json::from_value::<Audience>(audience.clone()) {
        Ok(a) => tx.may_see(&a),
        Err(_) => Ok(false),
    }
}

fn search(tx: &mut Tx, i: &Value) -> Result<Value> {
    let limit = i.get("limit").and_then(|l| l.as_u64()).unwrap_or(20) as usize;
    let kinds = strings(i.get("kinds"));
    let conds: Vec<Cond> = if kinds.is_empty() { vec![] } else { vec![Cond { field: "kind".into(), op: Cmp::In, value: json!(kinds) }] };
    let tag = i.get("tag").and_then(|t| t.as_str()).map(fold);
    let q = match (&tag, i.get("q").and_then(|q| q.as_str())) {
        (Some(t), _) => t.clone(),
        (None, Some(q)) => q.to_string(),
        (None, None) => return Err(Error::invalid("q", "say what to look for: q, or tag")),
    };
    let mut items = vec![];
    for d in tx.search(ENTRIES, &q, &conds, CANDIDATES)? {
        let b = &d.body;
        if !sees(tx, &b["audience"])? {
            continue;
        }
        let tags = strings(b.get("tags"));
        let found = match &tag {
            Some(t) => tags.iter().any(|x| fold(x) == *t).then(|| (10.0, String::new())),
            None => {
                let title = std::iter::once(text(b, "title").to_string()).chain(strings(b.get("aliases"))).collect::<Vec<_>>().join(" ");
                score(&q, &title, &format!("{}\n{}", text(b, "text"), tags.join(" ")))
            }
        };
        if let Some((score, snippet)) = found {
            items.push(json!({"kind": b["kind"], "id": b["ref"], "title": b["title"], "snippet": snippet, "score": score, "tags": tags, "context": b["context"]}));
        }
    }
    items.sort_by(|a, b| {
        b["score"].as_f64().partial_cmp(&a["score"].as_f64()).unwrap_or(std::cmp::Ordering::Equal).then_with(|| text(a, "title").cmp(text(b, "title")))
    });
    items.truncate(limit);
    Ok(json!({"items": items}))
}

pub struct Entities;
impl Plugin for Entities {
    fn manifest(&self) -> Manifest {
        let kind = json!({"type": "string", "minLength": 3, "maxLength": 80});
        let id = json!({"type": "string", "minLength": 1, "maxLength": 200});
        serde_json::from_value(json!({
            "id": "@nuah/entities", "version": "0.1.0", "name": "Entities", "namespaces": ["entities"],
            "description": "One index of everything that can be found or referred to; plugins announce their entities in their events",
            "data": {"schema": serde_json::from_str::<Value>(include_str!("../schema/entities.json")).expect("the schema file is JSON")},
            "listeners": [{"id": "entities.record", "on": ["*"], "handler": "entities.record"}],
            "operations": {
                "entities.search": {"kind": "query", "description": "Find entities of any kind by words in their title or text, or by a tag: only what you can see, best match first",
                    "input": {"type": "object", "properties": {
                        "q": {"type": "string", "minLength": 2, "maxLength": 100}, "tag": {"type": "string", "minLength": 1, "maxLength": 60},
                        "kinds": {"type": "array", "items": kind, "maxItems": 20}, "limit": {"type": "integer", "minimum": 1, "maximum": 50}},
                        "additionalProperties": false},
                    "output": {"type": "object", "required": ["items"]}},
                "entities.get": {"kind": "query", "description": "What a reference points at: the entity, or that it is private or missing",
                    "input": {"type": "object", "required": ["kind", "id"], "properties": {"kind": kind, "id": id}, "additionalProperties": false},
                    "output": {"type": "object"}},
                "entities.backlinks": {"kind": "query", "description": "What refers to an entity, from what you can see",
                    "input": {"type": "object", "required": ["kind", "id"], "properties": {"kind": kind, "id": id}, "additionalProperties": false},
                    "output": {"type": "object", "required": ["links"]}}
            }
        }))
        .expect("a valid manifest")
    }
    fn bind(&self, b: &mut Bindings) {
        // At least once and in order; an announcement that cannot be taken is logged and skipped, never retried forever.
        b.listener("entities.record", |tx, d| {
            let namespace = d.event.kind.split('.').next().unwrap_or("").to_string();
            let audience = serde_json::to_value(&d.event.audience).unwrap_or(Value::Null);
            let one = d.event.data.get("entity").into_iter();
            let many = d.event.data.get("entities").and_then(|x| x.as_array()).into_iter().flatten();
            for e in one.chain(many) {
                if let Err(why) = record_entity(tx, &namespace, e, &audience, d.at) {
                    tx.log(Level::Warn, "entities.skipped", json!({"event": d.event.kind, "why": why}));
                }
            }
            if let Some(r) = d.event.data.get("refs").filter(|r| r.is_object()) {
                if let Err(why) = record_links(tx, &namespace, r, &audience) {
                    tx.log(Level::Warn, "entities.links_skipped", json!({"event": d.event.kind, "why": why}));
                }
            }
            Ok(())
        });
        b.op("entities.search", |tx, i| search(tx, &i));
        b.op("entities.get", |tx, i| {
            let Some(d) = tx.get(ENTRIES, &row_id(&key(text(&i, "kind"), text(&i, "id"))))? else { return Ok(json!({"missing": true})) };
            if !sees(tx, &d.body["audience"])? {
                return Ok(json!({"private": true}));
            }
            let b = &d.body;
            Ok(json!({"entity": {"kind": b["kind"], "id": b["ref"], "title": b["title"], "tags": b["tags"], "context": b["context"]}}))
        });
        b.op("entities.backlinks", |tx, i| {
            let to_key = key(text(&i, "kind"), text(&i, "id"));
            let mut links = vec![];
            let mut q = Query::new().eq("to_key", to_key.as_str()).limit(200);
            loop {
                let page = tx.query(LINKS, &q)?;
                for d in &page.items {
                    if sees(tx, &d.body["audience"])? {
                        links.push(json!({"from": d.body["from"], "title": d.body["title"]}));
                    }
                }
                match page.next {
                    Some(n) => q = q.offset(n),
                    None => break,
                }
            }
            Ok(json!({"links": links}))
        });
    }
}
