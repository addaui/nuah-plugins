// SPDX-License-Identifier: Apache-2.0
//! `@nuah/channel-inbox`: the app itself as a channel (ADR 0145). Messages are kept in the person's own list, with an unread count,
//! for the app's screen to show. It is how a future app channel (a push to an installed app) starts: another kind can fill the point
//! the same way.
use crate::{manifest, text};
use nuah_kernel::*;
use serde_json::{json, Value};

pub const ITEMS: &str = "inbox.items";
pub const CONNECTIONS: &str = "inbox.connections";
const KEEP: usize = 200;

pub struct Inbox;

impl Plugin for Inbox {
    fn manifest(&self) -> Manifest {
        let by_id = json!({"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}, "additionalProperties": false});
        manifest(json!({
            "id": "@nuah/channel-inbox", "version": "0.1.0", "name": "Inbox", "namespaces": ["inbox"],
            "description": "The app itself as a channel: messages kept in your own list, with an unread count",
            "requires": {"extension_points": ["channels.kind@^1"], "plugins": ["@nuah/channels"]},
            "provides": [{"extension_point": "channels.kind"}],
            "data": {"schema": {"version": 1, "collections": {
                "inbox.items": {"type": "object", "per_subject": true, "required": ["text"], "properties": {"title": {"type": "string", "maxLength": 200}, "text": {"type": "string", "maxLength": 3000}, "link": {"type": "string", "maxLength": 500}, "read": {"type": "boolean"}, "at": {"type": "integer", "index": true}}},
                "inbox.connections": {"type": "object", "per_subject": true, "required": ["label"], "properties": {"label": {"type": "string"}, "enabled": {"type": "boolean"}}}}}},
            "operations": {
                "inbox.add": {"kind": "command", "permission": "channels.use", "description": "Turn the inbox on as one of your channels", "input": {"type": "object", "properties": {"label": {"type": "string"}, "fields": {"type": "object"}}, "additionalProperties": false}},
                "inbox.update": {"kind": "command", "permission": "channels.use", "input": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}, "label": {"type": "string"}, "enabled": {"type": "boolean"}}, "additionalProperties": false}},
                "inbox.remove": {"kind": "command", "permission": "channels.use", "input": by_id},
                "inbox.send": {"kind": "command", "permission": "channels.use", "description": "Keep a message in your inbox", "input": {"type": "object", "required": ["id", "text"], "properties": {"id": {"type": "string"}, "title": {"type": ["string", "null"]}, "text": {"type": "string"}, "link": {"type": ["string", "null"]}}, "additionalProperties": false}},
                "inbox.list": {"kind": "query", "permission": "channels.use", "description": "Your messages, newest first, and how many are unread"},
                "inbox.read": {"kind": "command", "permission": "channels.use", "description": "Mark one message, or all of them, as read", "input": {"type": "object", "properties": {"id": {"type": "string"}}, "additionalProperties": false}},
                "inbox.delete": {"kind": "command", "permission": "channels.use", "description": "Delete one message, or all of them", "input": {"type": "object", "properties": {"id": {"type": "string"}}, "additionalProperties": false}}
            }
        }))
    }
    fn bind(&self, b: &mut Bindings) {
        b.provide("channels.kind", |tx, _| {
            let list: Vec<Value> = tx.query(CONNECTIONS, &Query::new().limit(10))?.items.iter().map(|d| json!({"id": d.id, "label": d.body["label"], "enabled": d.body["enabled"] != false})).collect();
            Ok(json!({"kind": "inbox", "title": "App inbox", "description": "Messages kept in this app, with an unread count", "fields": [], "single": true,
                "ops": {"add": "inbox.add", "update": "inbox.update", "remove": "inbox.remove", "send": "inbox.send"}, "connections": list}))
        });
        b.op("inbox.add", |tx, i| {
            if !tx.query(CONNECTIONS, &Query::new().limit(2))?.items.is_empty() {
                return Err(Error::invalid("label", "the inbox is already on").with_reason("inbox.too_many"));
            }
            let label = Some(text(&i, "label").trim()).filter(|l| !l.is_empty()).unwrap_or("Inbox");
            let d = tx.create(CONNECTIONS, json!({"label": label, "enabled": true}))?;
            Ok(json!({"id": d.id}))
        });
        b.op("inbox.update", |tx, i| {
            let mut d = tx.get(CONNECTIONS, text(&i, "id"))?.ok_or_else(|| Error::not_found("connection"))?;
            if let Some(e) = i.get("enabled").and_then(|e| e.as_bool()) {
                d.body["enabled"] = json!(e);
            }
            if let Some(l) = i.get("label").and_then(|l| l.as_str()).filter(|l| !l.trim().is_empty()) {
                d.body["label"] = json!(l.trim());
            }
            tx.put(CONNECTIONS, &d.id, d.body.clone(), Expect::Any)?;
            Ok(json!({"id": d.id}))
        });
        b.op("inbox.remove", |tx, i| {
            if !tx.delete(CONNECTIONS, text(&i, "id"))? {
                return Err(Error::not_found("connection"));
            }
            Ok(json!({"deleted": true}))
        });
        b.op("inbox.send", |tx, i| {
            tx.create(ITEMS, json!({"title": text(&i, "title"), "text": text(&i, "text"), "link": text(&i, "link"), "read": false, "at": tx.now()}))?;
            let mut all = tx.query(ITEMS, &Query::new().limit(1000))?.items;
            if all.len() > KEEP {
                all.sort_by_key(|d| d.body["at"].as_i64().unwrap_or(0));
                for old in all.iter().take(all.len() - KEEP) {
                    tx.delete(ITEMS, &old.id)?;
                }
            }
            Ok(json!({"ok": true}))
        });
        b.op("inbox.list", |tx, _| {
            let mut items = tx.query(ITEMS, &Query::new().limit(1000))?.items;
            items.sort_by_key(|d| std::cmp::Reverse(d.body["at"].as_i64().unwrap_or(0)));
            let unread = items.iter().filter(|d| d.body["read"] != true).count();
            Ok(json!({"unread": unread, "items": items.iter().map(|d| json!({"id": d.id, "title": d.body["title"], "text": d.body["text"], "link": d.body["link"], "read": d.body["read"] == true, "at": d.body["at"]})).collect::<Vec<_>>()}))
        });
        b.op("inbox.read", |tx, i| {
            let all = tx.query(ITEMS, &Query::new().limit(1000))?.items;
            for mut d in all.into_iter().filter(|d| i.get("id").and_then(|x| x.as_str()).is_none_or(|id| id == d.id)) {
                d.body["read"] = json!(true);
                tx.put(ITEMS, &d.id, d.body.clone(), Expect::Any)?;
            }
            Ok(json!({"ok": true}))
        });
        b.op("inbox.delete", |tx, i| {
            let all = tx.query(ITEMS, &Query::new().limit(1000))?.items;
            for d in all.into_iter().filter(|d| i.get("id").and_then(|x| x.as_str()).is_none_or(|id| id == d.id)) {
                tx.delete(ITEMS, &d.id)?;
            }
            Ok(json!({"ok": true}))
        });
    }
}
