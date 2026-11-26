// SPDX-License-Identifier: Apache-2.0
//! `@nuah/channels` ([ADR 0145]): the connections a person has to be reached outside an app, and one operation, `channels.notify`,
//! for a product to tell the person something. Each kind of channel (Telegram, WhatsApp, Slack, Discord, SMS, a web address, the
//! app's own inbox) is a plugin of its own that fills the point `channels.kind`; a custom kind is any plugin that does the same.
//! A product lists what it can tell a person about by filling `channels.topic`.
//!
//! [ADR 0145]: https://madar.addaui.com/#/p/c732d1c1f2a8405da02ddc3cf964557c?tab=knowledge&page=019c1e2dc7714c8f969d13686678351a

use nuah_kernel::*;
use serde_json::{json, Value};
use std::sync::Arc;

mod inbox;
mod kinds;
pub use inbox::Inbox;
pub use kinds::{poll_all, Field, Kind, Msg, Req, Spec, SPECS};

pub const ROUTES: &str = "channels.routes";
pub const HISTORY: &str = "channels.history";
/// The most deliveries a person's history keeps, and the most a person is sent in an hour (a runaway loop must not become spam).
const KEEP: usize = 100;
const PER_HOUR: usize = 60;

pub(crate) fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}
pub(crate) fn manifest(v: Value) -> Manifest {
    serde_json::from_value(v).expect("an embedded manifest is valid")
}

/// Every kind of channel this crate ships, as plugins: the six services and the inbox.
pub fn kind_plugins() -> Vec<Arc<dyn Plugin>> {
    let mut v: Vec<Arc<dyn Plugin>> = SPECS.iter().map(|s| Arc::new(Kind(s)) as Arc<dyn Plugin>).collect();
    v.push(Arc::new(Inbox));
    v
}

#[derive(Default)]
pub struct Channels;

/// The answers of everything that fills a point, from the plugins that answered well.
fn answers(tx: &mut Tx, point: &str, key: &str) -> Vec<Value> {
    let Ok(all) = tx.extension_call(point, json!({})) else { return vec![] };
    let mut out = vec![];
    for a in all.as_array().into_iter().flatten().filter(|a| a["ok"] == true) {
        match a["output"].get(key) {
            Some(Value::Array(list)) => out.extend(list.iter().cloned()),
            Some(v) if v.is_object() || v.is_string() => out.push(v.clone()),
            _ => {
                if a["output"].is_object() && key == "kind" {
                    out.push(a["output"].clone());
                }
            }
        }
    }
    out
}

fn kinds_of(tx: &mut Tx) -> Vec<Value> {
    // a kind answers itself, as an object
    let Ok(all) = tx.extension_call("channels.kind", json!({})) else { return vec![] };
    all.as_array().into_iter().flatten().filter(|a| a["ok"] == true && a["output"]["kind"].is_string()).map(|a| a["output"].clone()).collect()
}

impl Plugin for Channels {
    fn manifest(&self) -> Manifest {
        let kind_in = json!({"type": "object", "required": ["kind", "id"], "properties": {"kind": {"type": "string"}, "id": {"type": "string"}}, "additionalProperties": false});
        manifest(json!({
            "id": "@nuah/channels", "version": "0.1.0", "name": "Channels", "namespaces": ["channels"],
            "description": "The ways a person is reached outside the app (a bot, a messenger, a web address, the app's own inbox) and one operation for a product to tell them something",
            "requires": {"capabilities": ["call"], "extension_points": ["channels.kind@^1", "channels.topic@^1", "channels.inbound@^1"]},
            "defines": {"extension_points": {
                "channels.kind": {"policy": "many", "version": "1.0.0", "input": {"type": "object"},
                    "description": "A kind of channel. Input {}; each provider answers {kind, title, description, fields: [{name, label, secret, required, help}], ops: {add, update, remove, send}, connections: [{id, label, enabled}]}. Its send operation takes {id, title, text, link} and sends to that connection"},
                "channels.inbound": {"policy": "many", "version": "1.0.0", "input": {"type": "object"},
                    "description": "What a product does with words a person wrote on one of their connections (ADR 0148). Input {}; each provider answers {op}, an operation taking {kind, id, label, text} and answering {handled, reply}. The first that says handled wins and its reply goes back on the same connection"},
                "channels.topic": {"policy": "many", "version": "1.0.0", "input": {"type": "object"},
                    "description": "What a product can tell a person about. Input {}; each provider answers {topics: [{topic, title, description, default}]}"}}},
            "permissions": {"channels.use": {"description": "Manage your own channels and be notified through them", "default": ["admin", "member"]}},
            "data": {"schema": {"version": 1, "collections": {
                "channels.routes": {"type": "object", "per_subject": true, "properties": {"enabled": {"type": "boolean"}, "connections": {"type": "array", "items": {"type": "string"}, "maxItems": 50}}},
                "channels.history": {"type": "object", "per_subject": true, "required": ["topic", "ok"], "properties": {
                    "topic": {"type": "string"}, "kind": {"type": "string"}, "label": {"type": "string"}, "ok": {"type": "boolean"}, "error": {"type": "string", "maxLength": 300}, "title": {"type": "string", "maxLength": 200}, "at": {"type": "integer", "index": true}}}}}},
            "operations": {
                "channels.kinds": {"kind": "query", "permission": "channels.use", "description": "The kinds of channel installed, with their fields and your connections"},
                "channels.topics": {"kind": "query", "permission": "channels.use", "description": "What you can be told about, and whether and where each goes"},
                "channels.route.set": {"kind": "command", "permission": "channels.use", "description": "Switch a topic on or off, or choose the connections it goes to (none chosen means all)",
                    "input": {"type": "object", "required": ["topic"], "properties": {"topic": {"type": "string", "maxLength": 80}, "enabled": {"type": "boolean"}, "connections": {"type": "array", "items": {"type": "string"}, "maxItems": 50}}, "additionalProperties": false}},
                "channels.history": {"kind": "query", "permission": "channels.use", "description": "Your latest deliveries, newest first"},
                "channels.plan": {"kind": "query", "permission": "channels.use", "description": "Where a topic goes now (used by channels.notify)",
                    "input": {"type": "object", "required": ["topic"], "properties": {"topic": {"type": "string"}}, "additionalProperties": false}},
                "channels.record": {"kind": "command", "permission": "channels.use", "description": "Note a delivery (used by channels.notify)",
                    "input": {"type": "object", "required": ["topic", "ok"], "properties": {"topic": {"type": "string"}, "kind": {"type": "string"}, "label": {"type": "string"}, "ok": {"type": "boolean"}, "error": {"type": "string"}, "title": {"type": "string"}}, "additionalProperties": false}},
                "channels.notify": {"kind": "outbound", "permission": "channels.use", "description": "Tell the person something on the channels they chose for the topic; a failing channel never fails the caller",
                    "input": {"type": "object", "required": ["topic", "text"], "properties": {"topic": {"type": "string", "maxLength": 80}, "title": {"type": "string", "maxLength": 200}, "text": {"type": "string", "maxLength": 3000}, "link": {"type": "string", "maxLength": 500}, "reply_hint": {"type": "string", "maxLength": 300}}, "additionalProperties": false}},
                "channels.handlers": {"kind": "query", "permission": "channels.use", "description": "The operations that handle what a person writes (used by channels.receive)"},
                "channels.receive": {"kind": "outbound", "permission": "channels.use", "description": "Words a person wrote on one of their connections: a product's handler decides what they mean and the reply goes back on that connection",
                    "input": {"type": "object", "required": ["kind", "id", "text"], "properties": {"kind": {"type": "string"}, "id": {"type": "string"}, "text": {"type": "string", "maxLength": 1000}}, "additionalProperties": false}},
                "channels.test": {"kind": "outbound", "permission": "channels.use", "description": "Send a test message to one of your connections",
                    "input": kind_in}
            }
        }))
    }
    fn bind(&self, b: &mut Bindings) {
        b.op("channels.kinds", |tx, _| Ok(json!({"kinds": kinds_of(tx)})));
        b.op("channels.topics", |tx, _| {
            let mut out = vec![];
            for t in answers(tx, "channels.topic", "topics") {
                let route = tx.get(ROUTES, text(&t, "topic"))?.map(|d| d.body);
                let default = t["default"] != false;
                out.push(json!({"topic": t["topic"], "title": t["title"], "description": t["description"],
                    "enabled": route.as_ref().and_then(|r| r["enabled"].as_bool()).unwrap_or(default), "connections": route.as_ref().map(|r| r["connections"].clone()).unwrap_or(json!([]))}));
            }
            Ok(json!({"topics": out}))
        });
        b.op("channels.route.set", |tx, i| {
            let topic = text(&i, "topic").to_string();
            let mut body = tx.get(ROUTES, &topic)?.map(|d| d.body).unwrap_or(json!({}));
            if let Some(e) = i.get("enabled").and_then(|e| e.as_bool()) {
                body["enabled"] = json!(e);
            }
            if let Some(c) = i.get("connections").filter(|c| c.is_array()) {
                body["connections"] = c.clone();
            }
            tx.put(ROUTES, &topic, body.clone(), Expect::Any)?;
            Ok(body)
        });
        b.op("channels.history", |tx, _| {
            let mut items = tx.query(HISTORY, &Query::new().limit(500))?.items;
            items.sort_by_key(|d| std::cmp::Reverse(d.body["at"].as_i64().unwrap_or(0)));
            Ok(json!({"history": items.iter().map(|d| d.body.clone()).collect::<Vec<_>>()}))
        });
        b.op("channels.plan", |tx, i| {
            let topic = text(&i, "topic").to_string();
            let default = answers(tx, "channels.topic", "topics").iter().find(|t| t["topic"] == topic.as_str()).map(|t| t["default"] != false).unwrap_or(true);
            let route = tx.get(ROUTES, &topic)?.map(|d| d.body).unwrap_or(json!({}));
            if !route["enabled"].as_bool().unwrap_or(default) {
                return Ok(json!({"targets": []}));
            }
            let since = tx.now() - 3_600_000;
            if tx.query(HISTORY, &Query::new().limit(500))?.items.iter().filter(|d| d.body["at"].as_i64().unwrap_or(0) >= since).count() >= PER_HOUR {
                return Ok(json!({"targets": [], "limited": true}));
            }
            let chosen: Option<Vec<String>> = route["connections"].as_array().filter(|c| !c.is_empty()).map(|c| c.iter().filter_map(|x| x.as_str().map(String::from)).collect());
            let mut targets = vec![];
            for k in kinds_of(tx) {
                for c in k["connections"].as_array().into_iter().flatten().filter(|c| c["enabled"] != false) {
                    if chosen.as_ref().is_none_or(|ch| ch.iter().any(|x| x == text(c, "id"))) {
                        targets.push(json!({"kind": k["kind"], "id": c["id"], "label": c["label"], "send_op": k["ops"]["send"], "inbound": k["inbound"] == true}));
                    }
                }
            }
            Ok(json!({"targets": targets}))
        });
        b.op("channels.record", |tx, i| {
            let mut body = i.clone();
            body["at"] = json!(tx.now());
            tx.create(HISTORY, body)?;
            let mut all = tx.query(HISTORY, &Query::new().limit(1000))?.items;
            if all.len() > KEEP {
                all.sort_by_key(|d| d.body["at"].as_i64().unwrap_or(0));
                for old in all.iter().take(all.len() - KEEP) {
                    tx.delete(HISTORY, &old.id)?;
                }
            }
            Ok(json!({"ok": true}))
        });
        b.outbound("channels.notify", |cx, i| {
            let topic = text(&i, "topic").to_string();
            let plan = cx.call("channels.plan", json!({"topic": topic}))?;
            let (mut sent, mut failed) = (0, 0);
            for t in plan["targets"].as_array().into_iter().flatten() {
                // a hint on how to answer goes only where an answer can come back
                let said = match text(&i, "reply_hint") {
                    h if t["inbound"] == true && !h.is_empty() => format!("{}\n{h}", text(&i, "text")),
                    _ => text(&i, "text").to_string(),
                };
                let r = cx.call(text(t, "send_op"), json!({"id": t["id"], "title": i["title"], "text": said, "link": i["link"]}));
                let (ok, error) = match &r {
                    Ok(_) => (true, String::new()),
                    Err(e) => (false, e.message.chars().take(300).collect()),
                };
                if ok { sent += 1 } else { failed += 1 }
                let _ = cx.call("channels.record", json!({"topic": topic, "kind": text(t, "kind"), "label": text(t, "label"), "ok": ok, "error": error, "title": text(&i, "title")}));
            }
            Ok(json!({"sent": sent, "failed": failed, "limited": plan["limited"] == true}))
        });
        b.op("channels.handlers", |tx, _| {
            let ops: Vec<Value> = answers(tx, "channels.inbound", "op").into_iter().filter(|o| o.is_string()).collect();
            Ok(json!({"ops": ops}))
        });
        b.outbound("channels.receive", |cx, i| {
            let kinds = cx.call("channels.kinds", json!({}))?;
            let k = kinds["kinds"].as_array().into_iter().flatten().find(|k| k["kind"] == i["kind"]).ok_or_else(|| Error::not_found("channel kind"))?;
            let label = k["connections"].as_array().and_then(|c| c.iter().find(|c| c["id"] == i["id"])).map(|c| text(c, "label").to_string()).ok_or_else(|| Error::not_found("connection"))?;
            let handlers = cx.call("channels.handlers", json!({}))?;
            for op in handlers["ops"].as_array().into_iter().flatten().filter_map(|o| o.as_str()) {
                // a handler that fails is passed over, so one broken product plugin cannot silence the others
                let Ok(r) = cx.call(op, json!({"kind": i["kind"], "id": i["id"], "label": label, "text": i["text"]})) else { continue };
                if r["handled"] != true {
                    continue;
                }
                let reply = text(&r, "reply");
                let replied = !reply.is_empty() && cx.call(text(&k["ops"], "send"), json!({"id": i["id"], "text": reply})).is_ok();
                return Ok(json!({"handled": true, "replied": replied}));
            }
            Ok(json!({"handled": false, "replied": false}))
        });
        b.outbound("channels.test", |cx, i| {
            let kinds = cx.call("channels.kinds", json!({}))?;
            let k = kinds["kinds"].as_array().into_iter().flatten().find(|k| k["kind"] == i["kind"]).ok_or_else(|| Error::not_found("channel kind"))?;
            if !k["connections"].as_array().is_some_and(|c| c.iter().any(|c| c["id"] == i["id"])) {
                return Err(Error::not_found("connection"));
            }
            let r = cx.call(text(&k["ops"], "send"), json!({"id": i["id"], "title": "Test", "text": "This is a test message. If you can read it, this channel works."}));
            let (ok, error) = match &r {
                Ok(_) => (true, String::new()),
                Err(e) => (false, e.message.chars().take(300).collect()),
            };
            let _ = cx.call("channels.record", json!({"topic": "test", "kind": i["kind"], "label": k["connections"].as_array().and_then(|c| c.iter().find(|c| c["id"] == i["id"])).map(|c| text(c, "label")).unwrap_or(""), "ok": ok, "error": error, "title": "Test"}));
            r.map(|_| json!({"ok": true}))
        });
    }
}
