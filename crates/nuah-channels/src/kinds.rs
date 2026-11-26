// SPDX-License-Identifier: Apache-2.0
//! The kinds of channel that send by one web request to a service: Telegram, WhatsApp, Slack, Discord, SMS (Twilio) and a plain
//! web address. Each is its own plugin made from a `Spec` (ADR 0145): what a person fills in, how one message becomes the
//! service's request, and what counts as accepted. The plugin keeps the person's connections of its kind; what is secret (a bot
//! token, a webhook address) is kept as a per-person secret and never shown again.
use crate::{manifest, text};
use nuah_kernel::*;
use serde_json::{json, Map, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// Who to poll for: one entry for each enabled connection of a kind that receives (Telegram), with the person to act as.
const WATCH: &str = "telegram.watch";

/// Poll every connection that receives, each as its owner. Answers how many were polled. A person whose account is disabled is skipped.
pub fn poll_all(core: &Core) -> usize {
    let system = Identity::new("channels", "Channels", &["admin"]);
    let Ok(list) = core.call_as(&system, "telegram.watching", json!({}), None) else { return 0 };
    let accounts = core.call_as(&system, "auth.account.list", json!({}), None).ok().map(|r| r.output["accounts"].as_array().cloned().unwrap_or_default());
    let mut n = 0;
    for w in list.output["watch"].as_array().cloned().unwrap_or_default() {
        let Ok(mut who) = serde_json::from_value::<Identity>(w["who"].clone()) else { continue };
        if let Some(acc) = &accounts {
            match acc.iter().find(|a| a["subject"] == who.subject.as_str() && a["disabled"] != true) {
                Some(a) => who.roles = a["roles"].as_array().map(|r| r.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or(who.roles),
                None => continue,
            }
        }
        if core.call_as(&who, "telegram.poll", json!({"id": w["id"]}), None).is_ok() {
            n += 1;
        }
    }
    n
}

struct Poller {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}
impl Service for Poller {
    fn stop(mut self: Box<Self>) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

pub struct Field {
    pub name: &'static str,
    pub label: &'static str,
    pub secret: bool,
    pub required: bool,
    pub help: &'static str,
}
/// What is sent: a title (may be empty), the text and a link (may be empty).
pub struct Msg {
    pub title: String,
    pub text: String,
    pub link: String,
}
impl Msg {
    /// The message as one plain text: the title on its own line, the text, then the link.
    pub fn plain(&self) -> String {
        let mut s = String::new();
        if !self.title.is_empty() {
            s.push_str(&self.title);
            s.push('\n');
        }
        s.push_str(&self.text);
        if !self.link.is_empty() {
            s.push('\n');
            s.push_str(&self.link);
        }
        s
    }
}
pub struct Req {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
pub struct Spec {
    /// The plugin id and the namespace of its operations.
    pub id: &'static str,
    pub ns: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub fields: &'static [Field],
    /// Checks what a person filled in (the values by field name) before it is kept.
    pub check: fn(&Map<String, Value>) -> Result<()>,
    /// The request for one message.
    pub build: fn(&Map<String, Value>, &Msg) -> Req,
    /// Did the service accept it? The default is any 2xx status.
    pub accept: fn(&NetResponse) -> Result<()>,
}

pub struct Kind(pub &'static Spec);

fn bad(field: &str, why: &str) -> Error {
    Error::invalid(field, why).with_reason("channels.bad_field")
}
fn failed(why: String) -> Error {
    Error::new(Category::Internal, "channels.send_failed", why).with_reason("channels.send_failed")
}
fn s<'a>(m: &'a Map<String, Value>, k: &str) -> &'a str {
    m.get(k).and_then(|v| v.as_str()).unwrap_or("")
}
fn json_req(url: String, mut headers: Vec<(String, String)>, body: Value) -> Req {
    headers.push(("content-type".into(), "application/json".into()));
    Req { url, headers, body: serde_json::to_vec(&body).unwrap_or_default() }
}
fn ok_2xx(r: &NetResponse) -> Result<()> {
    if (200..300).contains(&r.status) {
        Ok(())
    } else {
        Err(failed(format!("the service answered {}", r.status)))
    }
}
fn starts(m: &Map<String, Value>, field: &str, prefixes: &[&str]) -> Result<()> {
    let v = s(m, field);
    if prefixes.iter().any(|p| v.starts_with(p)) {
        Ok(())
    } else {
        Err(bad(field, &format!("must start with {}", prefixes[0])))
    }
}
/// Standard base64 (for the basic-authentication header).
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in data.chunks(3) {
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
fn form(pairs: &[(&str, &str)]) -> Vec<u8> {
    let enc = |v: &str| -> String { v.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect() };
    pairs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&").into_bytes()
}

pub static SPECS: [Spec; 6] = [
    Spec {
        id: "@nuah/channel-telegram", ns: "telegram", title: "Telegram", description: "A message from your own Telegram bot to a chat",
        fields: &[
            Field { name: "token", label: "Bot token", secret: true, required: true, help: "From @BotFather when you create the bot" },
            Field { name: "chat_id", label: "Chat id", secret: false, required: true, help: "Your chat's number; message the bot first so it may write to you" }],
        check: |m| if s(m, "chat_id").trim().is_empty() || s(m, "token").len() < 10 { Err(bad("token", "needs the bot token and the chat id")) } else { Ok(()) },
        build: |m, msg| json_req(format!("https://api.telegram.org/bot{}/sendMessage", s(m, "token")), vec![], json!({"chat_id": s(m, "chat_id"), "text": msg.plain().chars().take(4000).collect::<String>()})),
        accept: |r| {
            ok_2xx(r)?;
            let v: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
            if v["ok"] == true { Ok(()) } else { Err(failed(format!("Telegram refused: {}", v["description"].as_str().unwrap_or("no reason given")))) }
        },
    },
    Spec {
        id: "@nuah/channel-whatsapp", ns: "whatsapp", title: "WhatsApp", description: "A WhatsApp message through Meta's Cloud API",
        fields: &[
            Field { name: "token", label: "Access token", secret: true, required: true, help: "A permanent token of your WhatsApp Business app" },
            Field { name: "phone_number_id", label: "Phone number id", secret: false, required: true, help: "The id of the business number that sends" },
            Field { name: "to", label: "Send to", secret: false, required: true, help: "Your number with the country code, digits only. A free-form message reaches you only within 24 hours of your last message to the business number" }],
        check: |m| if s(m, "to").chars().any(|c| !c.is_ascii_digit()) || s(m, "to").is_empty() || s(m, "phone_number_id").is_empty() || s(m, "token").is_empty() { Err(bad("to", "needs the token, the phone number id and your number in digits")) } else { Ok(()) },
        build: |m, msg| json_req(format!("https://graph.facebook.com/v20.0/{}/messages", s(m, "phone_number_id")), vec![("authorization".into(), format!("Bearer {}", s(m, "token")))],
            json!({"messaging_product": "whatsapp", "to": s(m, "to"), "type": "text", "text": {"body": msg.plain().chars().take(4000).collect::<String>()}})),
        accept: ok_2xx,
    },
    Spec {
        id: "@nuah/channel-slack", ns: "slack", title: "Slack", description: "A message to a Slack channel through an incoming webhook",
        fields: &[Field { name: "url", label: "Webhook address", secret: true, required: true, help: "An incoming webhook address from your Slack app (https://hooks.slack.com/...)" }],
        check: |m| starts(m, "url", &["https://hooks.slack.com/"]),
        build: |m, msg| json_req(s(m, "url").to_string(), vec![], json!({"text": msg.plain().chars().take(3000).collect::<String>()})),
        accept: ok_2xx,
    },
    Spec {
        id: "@nuah/channel-discord", ns: "discord", title: "Discord", description: "A message to a Discord channel through a webhook",
        fields: &[Field { name: "url", label: "Webhook address", secret: true, required: true, help: "A webhook address from the channel's settings (https://discord.com/api/webhooks/...)" }],
        check: |m| starts(m, "url", &["https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/"]),
        build: |m, msg| json_req(s(m, "url").to_string(), vec![], json!({"content": msg.plain().chars().take(1900).collect::<String>()})),
        accept: ok_2xx,
    },
    Spec {
        id: "@nuah/channel-sms", ns: "sms", title: "SMS (Twilio)", description: "A text message to your phone through your Twilio account",
        fields: &[
            Field { name: "sid", label: "Account SID", secret: false, required: true, help: "From the Twilio console" },
            Field { name: "token", label: "Auth token", secret: true, required: true, help: "From the Twilio console" },
            Field { name: "from", label: "From number", secret: false, required: true, help: "A Twilio number, with the + and country code" },
            Field { name: "to", label: "Your number", secret: false, required: true, help: "With the + and country code" }],
        check: |m| if !s(m, "from").starts_with('+') || !s(m, "to").starts_with('+') || s(m, "sid").is_empty() || s(m, "token").is_empty() { Err(bad("to", "needs the account, the token and both numbers starting with +")) } else { Ok(()) },
        build: |m, msg| Req {
            url: format!("https://api.twilio.com/2010-04-01/Accounts/{}/Messages.json", s(m, "sid")),
            headers: vec![("content-type".into(), "application/x-www-form-urlencoded".into()), ("authorization".into(), format!("Basic {}", b64(format!("{}:{}", s(m, "sid"), s(m, "token")).as_bytes())))],
            body: form(&[("From", s(m, "from")), ("To", s(m, "to")), ("Body", &msg.plain().chars().take(1500).collect::<String>())]),
        },
        accept: ok_2xx,
    },
    Spec {
        id: "@nuah/channel-webhook", ns: "webhook", title: "Web address", description: "Your own address that receives each message as JSON (title, text, link)",
        fields: &[
            Field { name: "url", label: "Address", secret: true, required: true, help: "An https address that accepts a POST with JSON" },
            Field { name: "bearer", label: "Bearer token", secret: true, required: false, help: "Sent as an authorization header when you give one" }],
        check: |m| starts(m, "url", &["https://"]),
        build: |m, msg| {
            let mut h = vec![];
            if !s(m, "bearer").is_empty() {
                h.push(("authorization".into(), format!("Bearer {}", s(m, "bearer"))));
            }
            json_req(s(m, "url").to_string(), h, json!({"title": msg.title, "text": msg.text, "link": msg.link}))
        },
        accept: ok_2xx,
    },
];

fn conns(ns: &str) -> String {
    format!("{ns}.connections")
}
fn secret_name(id: &str, field: &str) -> String {
    format!("c:{id}:{field}")
}

impl Plugin for Kind {
    fn manifest(&self) -> Manifest {
        let sp = self.0;
        let ns = sp.ns;
        let by_id = json!({"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}, "additionalProperties": false});
        let mut m = json!({
            "id": sp.id, "version": "0.1.0", "name": sp.title, "namespaces": [ns],
            "description": sp.description,
            "requires": {"capabilities": ["net", "secrets", "call"], "extension_points": ["channels.kind@^1"], "plugins": ["@nuah/channels"]},
            "provides": [{"extension_point": "channels.kind"}],
            "data": {"schema": {"version": 1, "collections": {
                conns(ns): {"type": "object", "per_subject": true, "required": ["label"], "properties": {"label": {"type": "string", "maxLength": 100}, "enabled": {"type": "boolean"}, "fields": {"type": "object"}, "created": {"type": "integer"}}}}}},
            "operations": {
                format!("{ns}.add"): {"kind": "command", "permission": "channels.use", "description": format!("Connect {}", sp.title),
                    "input": {"type": "object", "required": ["label", "fields"], "properties": {"label": {"type": "string", "minLength": 1, "maxLength": 100}, "fields": {"type": "object"}}, "additionalProperties": false},
                    "reasons": {format!("{ns}.bad_field"): "A field is missing or not valid", format!("{ns}.too_many"): "At most 10 connections of a kind"}},
                format!("{ns}.update"): {"kind": "command", "permission": "channels.use", "input": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}, "label": {"type": "string", "maxLength": 100}, "enabled": {"type": "boolean"}}, "additionalProperties": false}},
                format!("{ns}.remove"): {"kind": "command", "permission": "channels.use", "input": by_id.clone()},
                format!("{ns}.target"): {"kind": "query", "permission": "channels.use", "description": "A connection without its secrets (used by send)", "input": by_id},
                format!("{ns}.send"): {"kind": "outbound", "permission": "channels.use", "description": format!("Send a message to one of your {} connections", sp.title),
                    "input": {"type": "object", "required": ["id", "text"], "properties": {"id": {"type": "string"}, "title": {"type": ["string", "null"]}, "text": {"type": "string"}, "link": {"type": ["string", "null"]}}, "additionalProperties": false},
                    "reasons": {format!("{ns}.send_failed"): "The service did not accept the message"}}
            }
        });
        if ns == "telegram" {
            // Telegram also receives (ADR 0148): the poll is a service, so the plugin needs serve
            m["requires"]["capabilities"] = json!(["net", "secrets", "call", "serve"]);
            m["permissions"] = json!({"telegram.watch": {"description": "Read whom the instance polls for (the instance's own clock)", "default": ["admin"]}});
            m["settings_schema"] = json!({"type": "object", "properties": {"poll_seconds": {"type": "integer", "minimum": 1, "maximum": 60, "default": 3, "title": "Seconds between looks for new messages", "x-tier": "operator", "x-apply": "service"}}, "additionalProperties": false});
            m["data"]["schema"]["collections"][WATCH] = json!({"type": "object", "required": ["who"], "properties": {"who": {"type": "object"}}});
            m["data"]["schema"]["collections"][conns(ns)]["properties"]["offset"] = json!({"type": "integer"});
            m["operations"]["telegram.watching"] = json!({"kind": "query", "permission": "telegram.watch", "description": "Whom to poll for and who to act as"});
            m["operations"]["telegram.cursor"] = json!({"kind": "command", "permission": "channels.use", "description": "Remember how far the messages were read (used by telegram.poll)",
                "input": {"type": "object", "required": ["id", "offset"], "properties": {"id": {"type": "string"}, "offset": {"type": "integer"}}, "additionalProperties": false}});
            m["operations"]["telegram.poll"] = json!({"kind": "outbound", "permission": "channels.use", "description": "Look for new messages from your own chat and hand them to the product (the clock calls it)",
                "input": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}, "additionalProperties": false}});
        }
        manifest(m)
    }
    fn serve(&self, ctx: ServiceContext) -> Result<Option<Box<dyn Service>>> {
        if self.0.ns != "telegram" {
            return Ok(None);
        }
        let secs = ctx.settings["poll_seconds"].as_u64().unwrap_or(3).clamp(1, 60);
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let core = ctx.core;
        let handle = std::thread::Builder::new()
            .name("channels-telegram-poll".into())
            .spawn(move || {
                let mut waited = 0u64;
                while !flag.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    waited += 100;
                    if waited >= secs * 1000 {
                        waited = 0;
                        poll_all(&core);
                    }
                }
            })
            .map_err(|e| Error::internal(format!("cannot start the Telegram poll: {e}")))?;
        Ok(Some(Box::new(Poller { stop, handle: Some(handle) })))
    }
    fn bind(&self, b: &mut Bindings) {
        let sp: &'static Spec = self.0;
        let (c1, c2, c3, c4, c5) = (conns(sp.ns), conns(sp.ns), conns(sp.ns), conns(sp.ns), conns(sp.ns));
        b.provide("channels.kind", move |tx, _| {
            let list: Vec<Value> = tx.query(&c1, &Query::new().limit(100))?.items.iter().map(|d| json!({"id": d.id, "label": d.body["label"], "enabled": d.body["enabled"] != false})).collect();
            let fields: Vec<Value> = sp.fields.iter().map(|f| json!({"name": f.name, "label": f.label, "secret": f.secret, "required": f.required, "help": f.help})).collect();
            Ok(json!({"kind": sp.ns, "title": sp.title, "description": sp.description, "fields": fields,
                "inbound": sp.ns == "telegram", "ops": {"add": format!("{}.add", sp.ns), "update": format!("{}.update", sp.ns), "remove": format!("{}.remove", sp.ns), "send": format!("{}.send", sp.ns)}, "connections": list}))
        });
        b.op(&format!("{}.add", sp.ns), move |tx, i| {
            let reason = |e: Error| e.with_reason(&format!("{}.bad_field", sp.ns));
            let given = i["fields"].as_object().cloned().unwrap_or_default();
            // only the fields this kind has, as text
            let mut values = Map::new();
            for f in sp.fields {
                let v = given.get(f.name).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                if v.is_empty() && f.required {
                    return Err(reason(bad(f.name, "is required")));
                }
                if v.len() > 1000 {
                    return Err(reason(bad(f.name, "is too long")));
                }
                values.insert(f.name.into(), json!(v));
            }
            (sp.check)(&values).map_err(reason)?;
            if tx.query(&c2, &Query::new().limit(20))?.items.len() >= 10 {
                return Err(Error::invalid("label", "you have 10 connections of this kind").with_reason(&format!("{}.too_many", sp.ns)));
            }
            let plain: Map<String, Value> = sp.fields.iter().filter(|f| !f.secret).map(|f| (f.name.to_string(), values[f.name].clone())).collect();
            let d = tx.create(&c2, json!({"label": text(&i, "label").trim(), "enabled": true, "fields": plain, "created": tx.now()}))?;
            for f in sp.fields.iter().filter(|f| f.secret) {
                let v = values[f.name].as_str().unwrap_or("");
                if !v.is_empty() {
                    tx.set_secret(&secret_name(&d.id, f.name), v)?;
                }
            }
            if sp.ns == "telegram" {
                watch(tx, &d.id, true)?;
            }
            Ok(json!({"id": d.id}))
        });
        b.op(&format!("{}.update", sp.ns), move |tx, i| {
            let mut d = tx.get(&c3, text(&i, "id"))?.ok_or_else(|| Error::not_found("connection"))?;
            if let Some(l) = i.get("label").and_then(|l| l.as_str()).filter(|l| !l.trim().is_empty()) {
                d.body["label"] = json!(l.trim());
            }
            if let Some(e) = i.get("enabled").and_then(|e| e.as_bool()) {
                d.body["enabled"] = json!(e);
            }
            tx.put(&c3, &d.id, d.body.clone(), Expect::Any)?;
            if sp.ns == "telegram" {
                watch(tx, &d.id, d.body["enabled"] != false)?;
            }
            Ok(json!({"id": d.id}))
        });
        b.op(&format!("{}.remove", sp.ns), move |tx, i| {
            let id = text(&i, "id").to_string();
            if !tx.delete(&c4, &id)? {
                return Err(Error::not_found("connection"));
            }
            for f in sp.fields.iter().filter(|f| f.secret) {
                tx.delete_secret(&secret_name(&id, f.name))?;
            }
            if sp.ns == "telegram" {
                watch(tx, &id, false)?;
            }
            Ok(json!({"deleted": true}))
        });
        b.op(&format!("{}.target", sp.ns), move |tx, i| {
            let d = tx.get(&c5, text(&i, "id"))?.ok_or_else(|| Error::not_found("connection"))?;
            Ok(json!({"id": d.id, "label": d.body["label"], "enabled": d.body["enabled"] != false, "fields": d.body["fields"], "offset": d.body["offset"]}))
        });
        b.outbound(&format!("{}.send", sp.ns), move |cx, i| {
            let id = text(&i, "id").to_string();
            let t = cx.call(&format!("{}.target", sp.ns), json!({"id": id}))?;
            let mut values = t["fields"].as_object().cloned().unwrap_or_default();
            for f in sp.fields.iter().filter(|f| f.secret) {
                if let Some(v) = cx.secret(&secret_name(&id, f.name))? {
                    values.insert(f.name.into(), json!(v));
                }
            }
            let msg = Msg { title: text(&i, "title").to_string(), text: text(&i, "text").to_string(), link: text(&i, "link").to_string() };
            let built = (sp.build)(&values, &msg);
            let mut req = NetRequest::get(&built.url);
            req.method = "POST".into();
            for (k, v) in &built.headers {
                req = req.header(k, v);
            }
            req.body = Some(built.body);
            req.max_bytes = 1 << 16;
            req.timeout_ms = 15_000;
            // the address of a webhook is a secret: it is never in an error the person or a log can read
            let r = cx.net()?.fetch(&req).map_err(|_| failed(format!("{} cannot be reached", sp.title)))?;
            (sp.accept)(&r).map_err(|e| e.with_reason(&format!("{}.send_failed", sp.ns)))?;
            Ok(json!({"ok": true}))
        });
        if sp.ns == "telegram" {
            let conn = conns(sp.ns);
            b.op("telegram.watching", |tx, _| {
                let list: Vec<Value> = tx.query(WATCH, &Query::new().limit(2000))?.items.iter().map(|d| json!({"id": d.id, "who": d.body["who"]})).collect();
                Ok(json!({"watch": list}))
            });
            b.op("telegram.cursor", move |tx, i| {
                let mut d = tx.get(&conn, text(&i, "id"))?.ok_or_else(|| Error::not_found("connection"))?;
                d.body["offset"] = i["offset"].clone();
                tx.put(&conn, &d.id, d.body.clone(), Expect::Any)?;
                Ok(json!({"ok": true}))
            });
            b.outbound("telegram.poll", |cx, i| poll(cx, i));
        }
    }
}

/// Keep the index of connections to poll for in step with the connection (ADR 0148).
fn watch(tx: &mut Tx, id: &str, on: bool) -> Result<()> {
    if on {
        let w = tx.who();
        tx.put(WATCH, id, json!({"who": {"subject": w.subject, "display": w.display, "roles": w.roles}}), Expect::Any)?;
    } else {
        tx.delete(WATCH, id)?;
    }
    Ok(())
}

/// One look at the bot's new messages (ADR 0148). Only a message in a private chat with the connection's own chat id is handed on;
/// the position is saved first, so a message is handled at most once, and what was waiting before the first look is skipped.
fn poll(cx: &Outbound, i: Value) -> Result<Value> {
    let id = text(&i, "id").to_string();
    let t = cx.call("telegram.target", json!({"id": id}))?;
    if t["enabled"] == false {
        return Ok(json!({"handled": 0}));
    }
    let Some(token) = cx.secret(&secret_name(&id, "token"))? else { return Ok(json!({"handled": 0})) };
    let mut url = format!("https://api.telegram.org/bot{token}/getUpdates?timeout=0&limit=20&allowed_updates=%5B%22message%22%5D");
    if let Some(o) = t["offset"].as_i64() {
        url.push_str(&format!("&offset={o}"));
    }
    let mut req = NetRequest::get(&url);
    req.max_bytes = 1 << 18;
    req.timeout_ms = 15_000;
    // the token is in the address: never in an error
    let r = cx.net()?.fetch(&req).map_err(|_| failed("Telegram cannot be reached".into()))?;
    let v: Value = serde_json::from_slice(&r.body).unwrap_or(Value::Null);
    if !(200..300).contains(&r.status) || v["ok"] != true {
        return Err(failed(format!("Telegram refused to hand over messages: {}", v["description"].as_str().unwrap_or("no reason given"))));
    }
    let updates = v["result"].as_array().cloned().unwrap_or_default();
    let next = updates.iter().filter_map(|u| u["update_id"].as_i64()).max().map(|m| m + 1);
    let first = t["offset"].is_null();
    if let Some(n) = next.or(if first { Some(1) } else { None }) {
        cx.call("telegram.cursor", json!({"id": id, "offset": n}))?;
    }
    if first {
        return Ok(json!({"handled": 0, "skipped": updates.len()}));
    }
    let own = text(&t["fields"], "chat_id");
    let mut handled = 0;
    for u in &updates {
        let m = &u["message"];
        let said = m["text"].as_str().unwrap_or("");
        if m["chat"]["type"] == "private" && m["chat"]["id"].to_string() == own && !said.trim().is_empty() {
            let _ = cx.call("channels.receive", json!({"kind": "telegram", "id": id, "text": said.chars().take(1000).collect::<String>()}));
            handled += 1;
        }
    }
    Ok(json!({"handled": handled}))
}
