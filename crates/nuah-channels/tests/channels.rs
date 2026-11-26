// SPDX-License-Identifier: Apache-2.0
//! Channels (Nuah ADR 0145): connections are the person's own and their secrets never come back; one notify goes to the chosen
//! connections; a failing channel never fails the caller; each service gets the request its documentation asks for. Against a
//! stand-in network, not the real services.
use nuah_adapters::*;
use nuah_channels::{kind_plugins, Channels};
use nuah_kernel::*;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// What the stand-in Telegram hands over on the next look, by bot token (each test uses its own token).
static UPDATES: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);
fn queue_updates(token: &str, body: Value) {
    UPDATES.lock().get_or_insert_with(HashMap::new).entry(token.to_string()).or_default().push(body.to_string());
}

type Seen = Arc<Mutex<Vec<(String, Vec<(String, String)>, String)>>>;
struct StubNet(Seen);
impl Net for StubNet {
    fn name(&self) -> &str {
        "@nuah/net-stub"
    }
    fn fetch(&self, r: &NetRequest) -> Result<NetResponse> {
        self.0.lock().push((r.url.clone(), r.headers.clone(), String::from_utf8_lossy(r.body.as_deref().unwrap_or(b"")).to_string()));
        if r.url.contains("unreachable") {
            return Err(Error::internal("connection refused"));
        }
        if r.url.contains("/getUpdates") {
            let token = r.url.split("/bot").nth(1).and_then(|t| t.split('/').next()).unwrap_or("").to_string();
            let next = UPDATES.lock().get_or_insert_with(HashMap::new).get_mut(&token).and_then(|q| if q.is_empty() { None } else { Some(q.remove(0)) });
            let body = next.unwrap_or_else(|| r#"{"ok":true,"result":[]}"#.to_string());
            return Ok(NetResponse { status: 200, url: r.url.clone(), headers: vec![], body: body.into_bytes(), truncated: false });
        }
        let (status, body) = if r.url.contains("refused") { (403, "{}") } else if r.url.contains("api.telegram.org") { (200, r#"{"ok":true,"result":{}}"#) } else { (200, "ok") };
        Ok(NetResponse { status, url: r.url.clone(), headers: vec![], body: body.as_bytes().to_vec(), truncated: false })
    }
}
struct StubNetPlugin(Seen);
impl Plugin for StubNetPlugin {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({"id": "@nuah/net-stub", "version": "1", "fills": "net"})).unwrap()
    }
    fn fill(&self, _: &Value) -> Result<Option<PortImpl>> {
        Ok(Some(PortImpl::Net(Arc::new(StubNetPlugin_net(self.0.clone())))))
    }
}
#[allow(non_snake_case)]
fn StubNetPlugin_net(s: Seen) -> StubNet {
    StubNet(s)
}

/// A product: lists two topics.
struct Product;
impl Plugin for Product {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({"id": "@test/product", "version": "1", "namespaces": ["test"],
            "provides": [{"extension_point": "channels.topic"}, {"extension_point": "channels.inbound"}],
            "operations": {"test.reply": {"kind": "command", "permission": "channels.use", "input": {"type": "object"}}}})).unwrap()
    }
    fn bind(&self, b: &mut Bindings) {
        b.provide("channels.inbound", |_, _| Ok(json!({"op": "test.reply"})));
        b.op("test.reply", |_, i| {
            let t = i["text"].as_str().unwrap_or("").to_lowercase();
            Ok(if t == "yes" { json!({"handled": true, "reply": "Allowed."}) } else { json!({"handled": false}) })
        });
        b.provide("channels.topic", |_, _| Ok(json!({"topics": [{"topic": "approval", "title": "An approval is waiting", "default": true}, {"topic": "finished", "title": "A long answer is ready", "default": false}]})));
    }
}

fn core() -> (Core, Seen) {
    let seen: Seen = Arc::new(Mutex::new(vec![]));
    let mut enabled: Vec<String> = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@nuah/net-stub", "@nuah/channels", "@test/product"].map(String::from).to_vec();
    let mut cat = Catalog(vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds), Arc::new(StubNetPlugin(seen.clone())), Arc::new(Channels), Arc::new(Product)]);
    let mut p = Profile { name: "test".into(), ..Default::default() };
    p.grants.insert("@nuah/channels".into(), vec!["call".into()]);
    for k in kind_plugins() {
        let m = k.manifest();
        enabled.push(m.id.clone());
        p.grants.insert(m.id.clone(), if m.id == "@nuah/channel-inbox" { vec![] } else if m.id == "@nuah/channel-telegram" { vec!["net".into(), "secrets".into(), "call".into(), "serve".into()] } else { vec!["net".into(), "secrets".into(), "call".into()] });
        cat.0.push(k);
    }
    p.enabled = enabled;
    (Core::start(&Distribution { name: "test".into(), catalog: cat, profile: p }).unwrap_or_else(|p| panic!("start failed: {p:#?}")), seen)
}
fn who(n: &str) -> Identity {
    Identity::new(n, n, &["member"])
}
fn call(c: &Core, w: &Identity, op: &str, input: Value) -> Result<Value> {
    c.call_as(w, op, input, None).map(|r| r.output)
}

#[test]
fn every_kind_is_listed_with_its_fields_and_a_connection_keeps_its_secret() {
    let (c, _) = core();
    let ana = who("ana");
    let kinds = call(&c, &ana, "channels.kinds", json!({})).unwrap()["kinds"].as_array().unwrap().clone();
    let names: Vec<&str> = kinds.iter().filter_map(|k| k["kind"].as_str()).collect();
    for n in ["telegram", "whatsapp", "slack", "discord", "sms", "webhook", "inbox"] {
        assert!(names.contains(&n), "{names:?}");
    }
    let id = call(&c, &ana, "telegram.add", json!({"label": "My phone", "fields": {"token": "123456:ABC-secret", "chat_id": "42"}})).unwrap()["id"].as_str().unwrap().to_string();
    let k = call(&c, &ana, "channels.kinds", json!({})).unwrap()["kinds"].as_array().unwrap().iter().find(|k| k["kind"] == "telegram").unwrap().clone();
    assert_eq!(k["connections"][0]["label"], "My phone");
    // the token is never handed back: not by the target, not by the list
    let all = format!("{}{}", call(&c, &ana, "telegram.target", json!({"id": id})).unwrap(), k);
    assert!(!all.contains("ABC-secret"), "{all}");
    // another person sees none of it
    assert!(call(&c, &who("ben"), "telegram.target", json!({"id": id})).is_err());
    let theirs = call(&c, &who("ben"), "channels.kinds", json!({})).unwrap()["kinds"].as_array().unwrap().iter().find(|k| k["kind"] == "telegram").unwrap()["connections"].clone();
    assert_eq!(theirs, json!([]));
    // a bad field is refused with a reason, a missing one too
    for (kind, fields) in [("slack", json!({"url": "https://evil.example/x"})), ("discord", json!({"url": "http://discord.com/api/webhooks/1"})), ("sms", json!({"sid": "AC1", "token": "t", "from": "123", "to": "+1"})), ("webhook", json!({}))] {
        let e = call(&c, &ana, &format!("{kind}.add"), json!({"label": "x", "fields": fields})).unwrap_err();
        assert_eq!(e.reason, Some(format!("{kind}.bad_field")), "{kind}");
    }
    // removing forgets the connection and its secret
    call(&c, &ana, "telegram.remove", json!({"id": id})).unwrap();
    assert!(call(&c, &ana, "telegram.target", json!({"id": id})).is_err());
}

#[test]
fn a_notification_goes_where_the_person_chose_and_each_service_gets_the_request_it_documents() {
    let (c, seen) = core();
    let ana = who("ana");
    call(&c, &ana, "telegram.add", json!({"label": "tg", "fields": {"token": "123456:TOKEN", "chat_id": "42"}})).unwrap();
    call(&c, &ana, "slack.add", json!({"label": "sl", "fields": {"url": "https://hooks.slack.com/services/T/B/X"}})).unwrap();
    call(&c, &ana, "discord.add", json!({"label": "dc", "fields": {"url": "https://discord.com/api/webhooks/1/abc"}})).unwrap();
    call(&c, &ana, "sms.add", json!({"label": "sms", "fields": {"sid": "AC123", "token": "tok", "from": "+15550001", "to": "+15550002"}})).unwrap();
    call(&c, &ana, "whatsapp.add", json!({"label": "wa", "fields": {"token": "wtok", "phone_number_id": "999", "to": "15550003"}})).unwrap();
    call(&c, &ana, "webhook.add", json!({"label": "hook", "fields": {"url": "https://example.org/in", "bearer": "b-tok"}})).unwrap();
    call(&c, &ana, "inbox.add", json!({})).unwrap();
    let r = call(&c, &ana, "channels.notify", json!({"topic": "approval", "title": "Approval needed", "text": "Run the clock tool?", "link": "https://app.example/t/1"})).unwrap();
    assert_eq!((r["sent"].as_i64(), r["failed"].as_i64()), (Some(7), Some(0)), "{r}");
    let seen = seen.lock().clone();
    let find = |frag: &str| seen.iter().find(|(u, _, _)| u.contains(frag)).unwrap_or_else(|| panic!("no request to {frag}")).clone();
    let tg = find("api.telegram.org/bot123456:TOKEN/sendMessage");
    assert!(tg.2.contains("\"chat_id\":\"42\"") && tg.2.contains("Approval needed\\nRun the clock tool?\\nhttps://app.example/t/1"), "{}", tg.2);
    assert!(find("hooks.slack.com").2.contains("\"text\""));
    assert!(find("discord.com/api/webhooks/1/abc").2.contains("\"content\""));
    let sms = find("api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    assert!(sms.1.iter().any(|(k, v)| k == "authorization" && v == "Basic QUMxMjM6dG9r"), "{:?}", sms.1);
    assert!(sms.2.starts_with("From=%2B15550001&To=%2B15550002&Body="), "{}", sms.2);
    let wa = find("graph.facebook.com/v20.0/999/messages");
    assert!(wa.1.iter().any(|(k, v)| k == "authorization" && v == "Bearer wtok") && wa.2.contains("\"messaging_product\":\"whatsapp\""));
    let hook = find("example.org/in");
    assert!(hook.1.iter().any(|(k, v)| k == "authorization" && v == "Bearer b-tok") && hook.2.contains("\"title\":\"Approval needed\""));
    // the inbox kept it, unread
    let inbox = call(&c, &ana, "inbox.list", json!({})).unwrap();
    assert_eq!(inbox["unread"], 1);
    assert_eq!(inbox["items"][0]["title"], "Approval needed");
    call(&c, &ana, "inbox.read", json!({})).unwrap();
    assert_eq!(call(&c, &ana, "inbox.list", json!({})).unwrap()["unread"], 0);
    // the history says where each went
    assert_eq!(call(&c, &ana, "channels.history", json!({})).unwrap()["history"].as_array().unwrap().len(), 7);
}

#[test]
fn topics_can_be_off_or_limited_a_failing_channel_never_fails_the_caller_and_no_secret_is_in_an_error() {
    let (c, seen) = core();
    let ana = who("ana");
    // "finished" is off by default
    call(&c, &ana, "inbox.add", json!({})).unwrap();
    let r = call(&c, &ana, "channels.notify", json!({"topic": "finished", "text": "done"})).unwrap();
    assert_eq!(r["sent"], 0);
    let topics = call(&c, &ana, "channels.topics", json!({})).unwrap()["topics"].clone();
    assert_eq!(topics.as_array().unwrap().iter().find(|t| t["topic"] == "finished").unwrap()["enabled"], false);
    call(&c, &ana, "channels.route.set", json!({"topic": "finished", "enabled": true})).unwrap();
    assert_eq!(call(&c, &ana, "channels.notify", json!({"topic": "finished", "text": "done"})).unwrap()["sent"], 1);
    // a chosen connection only
    let good = call(&c, &ana, "webhook.add", json!({"label": "good", "fields": {"url": "https://good.example/in"}})).unwrap()["id"].as_str().unwrap().to_string();
    call(&c, &ana, "webhook.add", json!({"label": "refused", "fields": {"url": "https://refused.example/SECRETPATH"}})).unwrap();
    call(&c, &ana, "webhook.add", json!({"label": "down", "fields": {"url": "https://unreachable.example/SECRETPATH"}})).unwrap();
    let r = call(&c, &ana, "channels.notify", json!({"topic": "approval", "text": "x"})).unwrap();
    assert_eq!((r["sent"].as_i64(), r["failed"].as_i64()), (Some(2), Some(2)), "{r}");
    seen.lock().clear();
    call(&c, &ana, "channels.route.set", json!({"topic": "approval", "connections": [good]})).unwrap();
    assert_eq!(call(&c, &ana, "channels.notify", json!({"topic": "approval", "text": "y"})).unwrap()["sent"], 1);
    assert_eq!(seen.lock().len(), 1);
    // the history keeps the failures without the address
    let h = call(&c, &ana, "channels.history", json!({})).unwrap().to_string();
    assert!(h.contains("cannot be reached") && h.contains("403"), "{h}");
    assert!(!h.contains("SECRETPATH"), "{h}");
    // a test message goes to one connection, and fails honestly
    let hist = call(&c, &ana, "channels.kinds", json!({})).unwrap();
    let bad = hist["kinds"].as_array().unwrap().iter().find(|k| k["kind"] == "webhook").unwrap()["connections"].as_array().unwrap().iter().find(|c| c["label"] == "refused").unwrap()["id"].as_str().unwrap().to_string();
    assert!(call(&c, &ana, "channels.test", json!({"kind": "webhook", "id": bad})).is_err());
    assert!(call(&c, &ana, "channels.test", json!({"kind": "webhook", "id": good})).is_ok());
    // another person cannot test someone else's connection
    assert!(call(&c, &who("ben"), "channels.test", json!({"kind": "webhook", "id": good})).is_err());
}

#[test]
fn a_runaway_sender_is_stopped_after_an_hour_s_worth() {
    let (c, _) = core();
    let ana = who("ana");
    call(&c, &ana, "inbox.add", json!({})).unwrap();
    let mut sent = 0;
    for _ in 0..70 {
        sent += call(&c, &ana, "channels.notify", json!({"topic": "approval", "text": "x"})).unwrap()["sent"].as_i64().unwrap();
    }
    assert_eq!(sent, 60);
}

const TOKEN_A: &str = "111111:token-for-the-receive-test";
fn update(id: i64, chat: i64, kind: &str, text: &str) -> Value {
    json!({"update_id": id, "message": {"message_id": id, "chat": {"id": chat, "type": kind}, "text": text}})
}
fn sent_texts(seen: &Seen) -> Vec<String> {
    seen.lock().iter().filter(|(u, _, _)| u.contains("/sendMessage")).map(|(_, _, b)| b.clone()).collect()
}

#[test]
fn a_telegram_connection_receives_only_from_its_own_private_chat_skips_the_backlog_and_hands_each_message_on_once() {
    let (c, seen) = core();
    let (ana, ben) = (who("ana"), who("ben"));
    let id = call(&c, &ana, "telegram.add", json!({"label": "me", "fields": {"token": TOKEN_A, "chat_id": "42"}})).unwrap()["id"].as_str().unwrap().to_string();
    assert_eq!(call(&c, &ana, "channels.kinds", json!({})).unwrap()["kinds"].as_array().unwrap().iter().find(|k| k["kind"] == "telegram").unwrap()["inbound"], true);
    // what waited before the first look is not acted on, even a yes
    queue_updates(TOKEN_A, json!({"ok": true, "result": [update(10, 42, "private", "yes")]}));
    assert_eq!(call(&c, &ana, "telegram.poll", json!({"id": id})).unwrap()["handled"], 0);
    assert!(sent_texts(&seen).is_empty(), "no reply to the backlog");
    // a stranger, a group and a plain word are not answered; the person's own yes is, once
    queue_updates(TOKEN_A, json!({"ok": true, "result": [update(11, 99, "private", "yes"), update(12, 42, "group", "yes"), update(13, 42, "private", "hello"), update(14, 42, "private", "yes")]}));
    assert_eq!(call(&c, &ana, "telegram.poll", json!({"id": id})).unwrap()["handled"], 2);
    let texts = sent_texts(&seen);
    assert_eq!(texts.len(), 1, "{texts:?}");
    assert!(texts[0].contains("Allowed."));
    // the next look asks from where it stopped, and nothing is handled twice
    let before = seen.lock().len();
    assert_eq!(call(&c, &ana, "telegram.poll", json!({"id": id})).unwrap()["handled"], 0);
    assert!(seen.lock()[before].0.contains("offset=15"), "{:?}", seen.lock()[before].0);
    // nobody else can poll for the connection, and the token is not in anything that comes back
    assert!(call(&c, &ben, "telegram.poll", json!({"id": id})).is_err());
    assert!(!call(&c, &ana, "channels.history", json!({})).unwrap().to_string().contains(TOKEN_A));
}

#[test]
fn the_clock_polls_for_each_watched_connection_as_its_owner_and_removing_a_connection_stops_it() {
    let (c, _) = core();
    let ana = who("ana");
    let token = "222222:token-for-the-clock-test";
    let id = call(&c, &ana, "telegram.add", json!({"label": "me", "fields": {"token": token, "chat_id": "7"}})).unwrap()["id"].as_str().unwrap().to_string();
    let system = Identity::new("channels", "Channels", &["admin"]);
    assert_eq!(call(&c, &system, "telegram.watching", json!({})).unwrap()["watch"].as_array().unwrap().len(), 1);
    // only the instance's clock reads the list
    assert!(call(&c, &ana, "telegram.watching", json!({})).is_err());
    assert_eq!(nuah_channels::poll_all(&c), 1);
    call(&c, &ana, "telegram.update", json!({"id": id, "enabled": false})).unwrap();
    assert_eq!(nuah_channels::poll_all(&c), 0, "a switched-off connection is not polled");
    call(&c, &ana, "telegram.update", json!({"id": id, "enabled": true})).unwrap();
    call(&c, &ana, "telegram.remove", json!({"id": id})).unwrap();
    assert_eq!(nuah_channels::poll_all(&c), 0);
}

#[test]
fn a_reply_hint_goes_only_where_an_answer_can_come_back() {
    let (c, seen) = core();
    let ana = who("ana");
    call(&c, &ana, "inbox.add", json!({})).unwrap();
    call(&c, &ana, "telegram.add", json!({"label": "me", "fields": {"token": "333333:token-for-the-hint-test", "chat_id": "7"}})).unwrap();
    call(&c, &ana, "channels.notify", json!({"topic": "approval", "title": "Approval needed", "text": "A tool waits.", "reply_hint": "Reply yes or no."})).unwrap();
    assert!(sent_texts(&seen).iter().any(|t| t.contains("Reply yes or no.")));
    let inbox = call(&c, &ana, "inbox.list", json!({})).unwrap().to_string();
    assert!(inbox.contains("A tool waits.") && !inbox.contains("Reply yes"), "{inbox}");
}
