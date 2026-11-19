// SPDX-License-Identifier: Apache-2.0
//! The index of entities (ADR 0092) in a Core with no product around it: a small notes plugin announces its notes in
//! its Events, and search, get and backlinks answer only with what the caller would receive the Events of.

use nuah_adapters::*;
use nuah_entities::Entities;
use nuah_kernel::*;
use serde_json::{json, Value};
use std::sync::Arc;

/// Notes, each either personal (addressed to its writer) or in a team (the Scope `notes.team`).
struct Notes;
impl Plugin for Notes {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({"id": "@test/notes", "version": "1.0.0", "namespaces": ["notes"],
            "requires": {"capabilities": ["emit"]},
            "scopes": ["notes.team"],
            "events": {"notes.saved": {}, "notes.removed": {}, "notes.odd": {}},
            "operations": {
                "notes.team": {"kind": "command", "input": {"type": "object"}},
                "notes.save": {"kind": "command", "input": {"type": "object"}},
                "notes.remove": {"kind": "command", "input": {"type": "object"}},
                "notes.odd": {"kind": "command", "input": {"type": "object"}}
            },
            "data": {"schema": {"version": 1, "collections": {"notes.teams": {"type": "object", "properties": {"members": {"type": "array", "items": {"type": "string"}}}}}}}
        })).unwrap()
    }
    fn bind(&self, b: &mut Bindings) {
        b.scope("notes.team", |r, id, subject| {
            Ok(r.get("notes.teams", id)?.filter(|d| !d.deleted).is_some_and(|d| d.body["members"].as_array().is_some_and(|m| m.iter().any(|x| x == subject))))
        });
        b.op("notes.team", |tx, i| {
            tx.put("notes.teams", i["id"].as_str().unwrap(), json!({"members": i["members"]}), Expect::Any)?;
            Ok(json!({}))
        });
        fn audience(tx: &Tx, i: &Value) -> Audience {
            match i["team"].as_str() {
                Some(t) => Audience::scope("notes.team", t),
                None => Audience::subject(&tx.who().subject),
            }
        }
        b.op("notes.save", |tx, i| {
            let id = i["id"].as_str().unwrap();
            let to: Vec<Value> = i["links"].as_array().cloned().unwrap_or_default().iter().map(|t| json!({"type": "notes.note", "id": t})).collect();
            let aud = audience(tx, &i);
            tx.emit("notes.saved", aud, json!({
                "entity": {"kind": "notes.note", "id": id, "title": i["title"], "text": i["text"], "tags": i.get("tags").cloned().unwrap_or(json!([])), "context": {"team": i["team"]}},
                "refs": {"from": {"type": "notes.note", "id": id}, "title": i["title"], "to": to}
            }))?;
            Ok(json!({}))
        });
        b.op("notes.remove", |tx, i| {
            let aud = audience(tx, &i);
            tx.emit("notes.removed", aud, json!({"entity": {"kind": "notes.note", "id": i["id"], "removed": true}, "refs": {"from": {"type": "notes.note", "id": i["id"]}, "to": []}}))?;
            Ok(json!({}))
        });
        // announcements the index must not take: another plugin's kind, and one that is not an entity at all
        b.op("notes.odd", |tx, _i| {
            let me = Audience::subject(&tx.who().subject);
            tx.emit("notes.odd", me.clone(), json!({"entity": {"kind": "tasks.task", "id": "t1", "title": "Not yours"}}))?;
            tx.emit("notes.odd", me, json!({"entity": {"kind": "notes.note", "title": 5}}))?;
            Ok(json!({}))
        });
    }
}

fn core() -> Core {
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyAllowAll), Arc::new(StdClock), Arc::new(StdIds), Arc::new(Entities), Arc::new(Notes)];
    let enabled = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-allow-all", "@nuah/clock-system", "@nuah/ids-random", "@nuah/entities", "@test/notes"];
    let mut profile = Profile { name: "t".into(), enabled: enabled.iter().map(|s| s.to_string()).collect(), ..Default::default() };
    profile.grants.insert("@test/notes".into(), vec!["emit".into()]);
    Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile }).unwrap_or_else(|p| panic!("{p:#?}"))
}

fn who(s: &str) -> Identity {
    Identity::new(s, s, &[])
}

fn call(c: &Core, as_: &str, op: &str, input: Value) -> Value {
    let out = c.call_as(&who(as_), op, input, None).unwrap_or_else(|e| panic!("{op}: {e:?}")).output;
    c.drain_listeners().unwrap();
    out
}

fn titles(v: &Value) -> Vec<String> {
    v["items"].as_array().unwrap().iter().map(|x| x["title"].as_str().unwrap().to_string()).collect()
}

#[test]
fn search_finds_what_was_announced_best_match_first_with_a_snippet() {
    let c = core();
    call(&c, "ann", "notes.save", json!({"id": "n1", "title": "Release plan", "text": "We ship the plan in March. Nothing else."}));
    call(&c, "ann", "notes.save", json!({"id": "n2", "title": "Groceries", "text": "Buy bread; plan the week"}));
    call(&c, "ann", "notes.save", json!({"id": "n3", "title": "خُطَّة الإصدار", "text": "نُطلق في مارس"}));
    let r = call(&c, "ann", "entities.search", json!({"q": "plan"}));
    assert_eq!(titles(&r), vec!["Release plan", "Groceries"], "a title hit first");
    let first = &r["items"][0];
    assert_eq!((first["kind"].as_str(), first["id"].as_str()), (Some("notes.note"), Some("n1")));
    assert!(first["snippet"].as_str().unwrap().contains("ship the plan"), "{first}");
    assert_eq!(first["context"], json!({"team": null}), "context comes back as given");
    assert_eq!(titles(&call(&c, "ann", "entities.search", json!({"q": "خطة الاصدار"}))), vec!["خُطَّة الإصدار"], "Arabic as people type it");
    assert_eq!(titles(&call(&c, "ann", "entities.search", json!({"q": "plan march"}))), vec!["Release plan"], "every word");
    assert_eq!(titles(&call(&c, "ann", "entities.search", json!({"q": "plan", "kinds": ["other.kind"]}))), Vec::<String>::new());
}

#[test]
fn a_changed_or_removed_entity_is_found_as_it_is_now() {
    let c = core();
    call(&c, "ann", "notes.save", json!({"id": "n1", "title": "Draft", "text": ""}));
    call(&c, "ann", "notes.save", json!({"id": "n1", "title": "Final report", "text": ""}));
    assert!(titles(&call(&c, "ann", "entities.search", json!({"q": "draft"}))).is_empty());
    assert_eq!(titles(&call(&c, "ann", "entities.search", json!({"q": "report"}))), vec!["Final report"]);
    call(&c, "ann", "notes.remove", json!({"id": "n1"}));
    assert!(titles(&call(&c, "ann", "entities.search", json!({"q": "report"}))).is_empty());
    assert_eq!(call(&c, "ann", "entities.get", json!({"kind": "notes.note", "id": "n1"})), json!({"missing": true}));
}

#[test]
fn only_what_the_caller_would_receive_is_found_and_a_reference_to_the_rest_is_private() {
    let c = core();
    call(&c, "ann", "notes.team", json!({"id": "t1", "members": ["ann", "bo"]}));
    call(&c, "ann", "notes.save", json!({"id": "n1", "title": "Team plan", "text": "", "team": "t1"}));
    call(&c, "ann", "notes.save", json!({"id": "n2", "title": "Ann's own plan", "text": ""}));
    assert_eq!(titles(&call(&c, "bo", "entities.search", json!({"q": "plan"}))), vec!["Team plan"]);
    assert_eq!(titles(&call(&c, "cy", "entities.search", json!({"q": "plan"}))), Vec::<String>::new(), "no counts, no snippets");
    assert_eq!(call(&c, "bo", "entities.get", json!({"kind": "notes.note", "id": "n2"})), json!({"private": true}));
    assert_eq!(call(&c, "bo", "entities.get", json!({"kind": "notes.note", "id": "n1"}))["entity"]["title"], "Team plan");
    // someone who leaves the team stops finding it: the Scope is resolved at search time
    call(&c, "ann", "notes.team", json!({"id": "t1", "members": ["ann"]}));
    assert!(titles(&call(&c, "bo", "entities.search", json!({"q": "plan"}))).is_empty());
}

#[test]
fn a_tag_is_found_whole_and_in_any_case() {
    let c = core();
    call(&c, "ann", "notes.save", json!({"id": "n1", "title": "One", "text": "", "tags": ["Release"]}));
    call(&c, "ann", "notes.save", json!({"id": "n2", "title": "Two", "text": "", "tags": ["release-notes"]}));
    call(&c, "ann", "notes.save", json!({"id": "n3", "title": "Release three", "text": ""}));
    assert_eq!(titles(&call(&c, "ann", "entities.search", json!({"tag": "release"}))), vec!["One"]);
}

#[test]
fn backlinks_come_only_from_what_the_caller_may_see_and_follow_changes() {
    let c = core();
    call(&c, "ann", "notes.team", json!({"id": "t1", "members": ["ann", "bo"]}));
    call(&c, "ann", "notes.save", json!({"id": "target", "title": "Target", "text": "", "team": "t1"}));
    call(&c, "ann", "notes.save", json!({"id": "a", "title": "Shared mention", "text": "", "team": "t1", "links": ["target"]}));
    call(&c, "ann", "notes.save", json!({"id": "b", "title": "Private mention", "text": "", "links": ["target"]}));
    let from = |who: &str| -> Vec<String> {
        call(&c, who, "entities.backlinks", json!({"kind": "notes.note", "id": "target"}))["links"].as_array().unwrap().iter().map(|l| l["title"].as_str().unwrap().to_string()).collect()
    };
    let mut ann = from("ann");
    ann.sort();
    assert_eq!(ann, vec!["Private mention", "Shared mention"]);
    assert_eq!(from("bo"), vec!["Shared mention"]);
    call(&c, "ann", "notes.save", json!({"id": "a", "title": "Shared mention", "text": "", "team": "t1", "links": []}));
    assert!(from("bo").is_empty(), "a new announcement of the source replaces its links");
}

#[test]
fn an_announcement_of_another_plugins_kind_or_a_malformed_one_is_skipped_without_stopping_the_index() {
    let c = core();
    call(&c, "ann", "notes.odd", json!({}));
    call(&c, "ann", "notes.save", json!({"id": "n1", "title": "After the odd ones", "text": ""}));
    assert_eq!(titles(&call(&c, "ann", "entities.search", json!({"q": "after"}))), vec!["After the odd ones"]);
    assert_eq!(call(&c, "ann", "entities.get", json!({"kind": "tasks.task", "id": "t1"})), json!({"missing": true}));
}
