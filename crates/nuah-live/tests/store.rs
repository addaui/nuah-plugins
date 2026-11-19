// SPDX-License-Identifier: Apache-2.0
//! Live documents kept in the owning plugin's own Collections (ADR 0093): an update log folded into snapshots, and Versions.

use nuah_adapters::*;
use nuah_kernel::*;
use nuah_live::loro::{ExportMode, LoroDoc};
use nuah_live::*;
use serde_json::{json, Value};
use std::sync::Arc;

const STORE: LiveStore = LiveStore { bodies: "docs.bodies", updates: "docs.updates", versions: "docs.versions", rejected: "docs.rejected", styles: &[("link", Expand::None)] };

fn check(v: &Value) -> Result<()> {
    if v["content"].as_array().is_some_and(|c| c.len() > 5) {
        return Err(Error::invalid("body", "too long"));
    }
    Ok(())
}

struct Docs;
impl Plugin for Docs {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({"id": "@test/docs", "version": "1.0.0", "namespaces": ["docs"],
            "operations": {
                "docs.create": {"kind": "command", "input": {"type": "object"}},
                "docs.push": {"kind": "command", "input": {"type": "object"}, "reasons": {"docs.rejected": "The change was refused"}},
                "docs.write": {"kind": "command", "input": {"type": "object"}},
                "docs.pull": {"kind": "query", "input": {"type": "object"}},
                "docs.json": {"kind": "query", "input": {"type": "object"}},
                "docs.rows": {"kind": "query", "input": {"type": "object"}},
                "docs.mark": {"kind": "command", "input": {"type": "object"}},
                "docs.at": {"kind": "query", "input": {"type": "object"}},
                "docs.restore": {"kind": "command", "input": {"type": "object"}}
            },
            "data": {"schema": {"version": 1, "collections": nuah_live::store::collections("docs.bodies", "docs.updates", "docs.versions")}}
        })).unwrap()
    }
    fn bind(&self, b: &mut Bindings) {
        let key = |i: &Value| i["key"].as_str().unwrap().to_string();
        b.op("docs.create", move |tx, i| Ok(json!({"version": b64(&STORE.create(tx, &key(&i), &i["json"])?.version)})));
        b.op("docs.push", move |tx, i| {
            let w = STORE.push(tx, &key(&i), &unb64("update", i["update"].as_str().unwrap())?, &check)?;
            Ok(json!({"version": b64(&w.version), "update": b64(&w.update), "json": w.json}))
        });
        b.op("docs.write", move |tx, i| Ok(json!({"changed": STORE.write(tx, &key(&i), &i["json"])?.is_some()})));
        b.op("docs.pull", move |tx, i| {
            let since = i["since"].as_str().map(|s| unb64("since", s)).transpose()?;
            let (u, v) = STORE.pull(tx, &key(&i), since.as_deref())?;
            Ok(json!({"update": b64(&u), "version": b64(&v)}))
        });
        b.op("docs.json", move |tx, i| Ok(to_json(&STORE.load(tx, &key(&i))?)));
        b.op("docs.rows", move |tx, i| {
            let n = tx.count("docs.updates", &[Cond { field: "key".into(), op: Cmp::Eq, value: json!(key(&i)) }])?;
            Ok(json!({"updates": n}))
        });
        b.op("docs.mark", move |tx, i| Ok(json!({"id": STORE.mark(tx, &key(&i), i["name"].as_str(), "T")?.id})));
        b.op("docs.at", move |tx, i| STORE.at(tx, &key(&i), i["version"].as_str().unwrap()));
        b.op("docs.restore", move |tx, i| Ok(json!({"changed": STORE.restore(tx, &key(&i), i["version"].as_str().unwrap())?.is_some()})));
    }
}

fn core() -> Core {
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyAllowAll), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Docs)];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-allow-all", "@nuah/clock-system", "@nuah/ids-random", "@test/docs"];
    let profile = Profile { name: "t".into(), enabled: enabled.iter().map(|s| s.to_string()).collect(), ..Default::default() };
    Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile }).unwrap_or_else(|p| panic!("{p:#?}"))
}

fn me() -> Identity {
    Identity::new("alice", "Alice", &["member"])
}

fn call(c: &Core, op: &str, input: Value) -> Result<Value> {
    c.call_as(&me(), op, input, None).map(|r| r.output)
}

fn para(id: &str, t: &str) -> Value {
    json!({"type": "paragraph", "attrs": {"blockId": id}, "content": [{"type": "text", "text": t}]})
}

fn body(paras: &[(&str, &str)]) -> Value {
    json!({"type": "doc", "content": paras.iter().map(|(i, t)| para(i, t)).collect::<Vec<_>>()})
}

/// A browser's copy: the server's state, then one edit made with the same JSON writer.
fn browser(c: &Core, key: &str) -> LoroDoc {
    let d = new_doc(&TextStyles::default());
    let p = call(c, "docs.pull", json!({"key": key})).unwrap();
    d.import(&unb64("u", p["update"].as_str().unwrap()).unwrap()).unwrap();
    d
}

fn edit(d: &LoroDoc, to: &Value) -> String {
    let before = d.oplog_vv();
    write_json(d, to).unwrap();
    b64(&d.export(ExportMode::updates(&before)).unwrap())
}

#[test]
fn a_pushed_update_is_loaded_back() {
    let c = core();
    call(&c, "docs.create", json!({"key": "p1", "json": body(&[("a", "hello")])})).unwrap();
    let d = browser(&c, "p1");
    let up = edit(&d, &body(&[("a", "hello world")]));
    let out = call(&c, "docs.push", json!({"key": "p1", "update": up})).unwrap();
    assert_eq!(out["json"], body(&[("a", "hello world")]));
    assert_eq!(call(&c, "docs.json", json!({"key": "p1"})).unwrap(), body(&[("a", "hello world")]));
}

#[test]
fn the_same_push_twice_changes_nothing_the_second_time() {
    let c = core();
    call(&c, "docs.create", json!({"key": "p1", "json": body(&[("a", "hello")])})).unwrap();
    let d = browser(&c, "p1");
    let up = edit(&d, &body(&[("a", "hello!")]));
    call(&c, "docs.push", json!({"key": "p1", "update": up})).unwrap();
    let again = call(&c, "docs.push", json!({"key": "p1", "update": up})).unwrap();
    assert_eq!(again["update"], "", "nothing new to pass on");
    assert_eq!(call(&c, "docs.rows", json!({"key": "p1"})).unwrap()["updates"], 1);
    assert_eq!(call(&c, "docs.json", json!({"key": "p1"})).unwrap(), body(&[("a", "hello!")]));
}

#[test]
fn compaction_keeps_the_same_document() {
    let c = core();
    call(&c, "docs.create", json!({"key": "p1", "json": body(&[("a", "")])})).unwrap();
    let d = browser(&c, "p1");
    let mut text = String::new();
    for i in 0..250 {
        text.push(char::from(b'a' + (i % 26) as u8));
        let up = edit(&d, &body(&[("a", &text)]));
        call(&c, "docs.push", json!({"key": "p1", "update": up})).unwrap();
    }
    assert!(call(&c, "docs.rows", json!({"key": "p1"})).unwrap()["updates"].as_u64().unwrap() <= 50);
    assert_eq!(call(&c, "docs.json", json!({"key": "p1"})).unwrap(), body(&[("a", &text)]));
}

#[test]
fn a_rejected_update_writes_nothing() {
    let c = core();
    call(&c, "docs.create", json!({"key": "p1", "json": body(&[("a", "one")])})).unwrap();
    let d = browser(&c, "p1");
    let up = edit(&d, &body(&[("a", "1"), ("b", "2"), ("c", "3"), ("d", "4"), ("e", "5"), ("f", "6")]));
    let e = call(&c, "docs.push", json!({"key": "p1", "update": up})).unwrap_err();
    assert_eq!((e.category, e.reason.as_deref()), (Category::Invalid, Some("docs.rejected")));
    assert_eq!(call(&c, "docs.json", json!({"key": "p1"})).unwrap(), body(&[("a", "one")]));
    assert_eq!(call(&c, "docs.rows", json!({"key": "p1"})).unwrap()["updates"], 0);
    let junk = b64(b"not an update");
    assert_eq!(call(&c, "docs.push", json!({"key": "p1", "update": junk})).unwrap_err().reason.as_deref(), Some("docs.rejected"));
}

#[test]
fn pull_since_a_version_gives_only_what_is_missing() {
    let c = core();
    call(&c, "docs.create", json!({"key": "p1", "json": body(&[("a", "one")])})).unwrap();
    let d = browser(&c, "p1");
    let since = b64(&d.oplog_vv().encode());
    call(&c, "docs.write", json!({"key": "p1", "json": body(&[("a", "one two")])})).unwrap();
    let small = call(&c, "docs.pull", json!({"key": "p1", "since": since})).unwrap();
    let full = call(&c, "docs.pull", json!({"key": "p1"})).unwrap();
    assert!(small["update"].as_str().unwrap().len() < full["update"].as_str().unwrap().len());
    d.import(&unb64("u", small["update"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(to_json(&d), body(&[("a", "one two")]));
    assert_eq!(call(&c, "docs.write", json!({"key": "p1", "json": body(&[("a", "one two")])})).unwrap()["changed"], false);
}

#[test]
fn a_version_opens_the_content_it_had_and_restore_keeps_later_history() {
    let c = core();
    call(&c, "docs.create", json!({"key": "p1", "json": body(&[("a", "first draft")])})).unwrap();
    let v = call(&c, "docs.mark", json!({"key": "p1", "name": "draft"})).unwrap()["id"].as_str().unwrap().to_string();
    call(&c, "docs.write", json!({"key": "p1", "json": body(&[("a", "second draft"), ("b", "more")])})).unwrap();
    assert_eq!(call(&c, "docs.at", json!({"key": "p1", "version": v})).unwrap(), body(&[("a", "first draft")]));
    let d = browser(&c, "p1");
    assert_eq!(call(&c, "docs.restore", json!({"key": "p1", "version": v})).unwrap()["changed"], true);
    assert_eq!(call(&c, "docs.json", json!({"key": "p1"})).unwrap(), body(&[("a", "first draft")]));
    // a browser that still has the later text catches up by a pull, like any other change
    let since = b64(&d.oplog_vv().encode());
    let p = call(&c, "docs.pull", json!({"key": "p1", "since": since})).unwrap();
    d.import(&unb64("u", p["update"].as_str().unwrap()).unwrap()).unwrap();
    assert_eq!(to_json(&d), body(&[("a", "first draft")]));
    assert!(call(&c, "docs.at", json!({"key": "p1", "version": "nope"})).is_err());
}
