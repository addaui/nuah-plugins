// SPDX-License-Identifier: Apache-2.0
//! A run answers at once, works in the background as the person, shows its steps, can be stopped, is the person's own, and is
//! "interrupted" when its process is gone (Nuah ADR 0136).
use nuah_adapters::*;
use nuah_kernel::*;
use nuah_runs::Runs;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// An executor: counts to `n` slowly, reporting each step and checking for a stop between them.
struct Counter;
impl Plugin for Counter {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": "@test/counter", "version": "1", "namespaces": ["counter"],
            "requires": {"capabilities": ["call"]},
            "permissions": {"counter.use": {"default": ["member"]}},
            "operations": {"counter.run": {"kind": "outbound", "permission": "counter.use"}}
        }))
        .unwrap()
    }
    fn bind(&self, b: &mut Bindings) {
        b.outbound("counter.run", |cx, i| {
            let run = i["run"].as_str().unwrap().to_string();
            if i["input"]["boom"] == true {
                return Err(Error::new(Category::Internal, "counter.boom", "it blew up").with_reason("counter.boom").with_params(json!({"status": 503})));
            }
            for n in 1..=i["input"]["n"].as_u64().unwrap_or(3) {
                if cx.call("runs.status", json!({"run": run}))?["status"] != "running" {
                    return Ok(json!({}));
                }
                cx.call("runs.record", json!({"run": run, "kind": "step", "data": {"n": n}}))?;
                std::thread::sleep(Duration::from_millis(60));
            }
            Ok(json!({"usage": {"input": 3, "output": 4}, "cost": 0.5}))
        });
    }
}

fn start() -> (Core, Services) {
    start_with(Runs::default())
}
fn start_with(runs: Runs) -> (Core, Services) {
    let mut enabled: Vec<String> = ["@nuah/db-memory", "@nuah/auth-local", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@nuah/runs", "@test/counter"].map(String::from).to_vec();
    enabled.sort();
    let mut p = Profile { name: "test".into(), enabled, ..Default::default() };
    p.grants.insert("@nuah/runs".into(), vec!["emit".into(), "serve".into(), "call".into()]);
    p.grants.insert("@test/counter".into(), vec!["call".into()]);
    let mut cat = Catalog(vec![Arc::new(AdapterMemory), Arc::new(AuthLocal), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds)]);
    cat.0.push(Arc::new(runs));
    cat.0.push(Arc::new(Counter));
    let core = Core::start(&Distribution { name: "test".into(), catalog: cat, profile: p }).unwrap_or_else(|p| panic!("start failed: {p:#?}"));
    let services = core.start_services().unwrap();
    (core, services)
}
fn who(n: &str) -> Identity {
    Identity::new(n, n, &["member"])
}
fn call(c: &Core, w: &Identity, op: &str, input: Value) -> Result<Value> {
    c.call_as(w, op, input, None).map(|r| r.output)
}
fn wait_for(c: &Core, w: &Identity, run: &str, status: &str) -> Value {
    let t = Instant::now();
    loop {
        let g = call(c, w, "runs.get", json!({"id": run})).unwrap();
        if g["status"] == status || t.elapsed() > Duration::from_secs(5) {
            return g;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_run_answers_at_once_and_finishes_in_the_background_with_its_steps() {
    let (c, _s) = start();
    let a = who("alice");
    let c0 = c.pulse_now().unwrap();
    let t = Instant::now();
    let run = call(&c, &a, "runs.start", json!({"executor": "counter.run", "ref": "thread-1", "input": {"n": 3}})).unwrap()["run"].as_str().unwrap().to_string();
    assert!(t.elapsed() < Duration::from_millis(150), "start did not wait for the work: {:?}", t.elapsed());
    assert_eq!(call(&c, &a, "runs.get", json!({"id": run})).unwrap()["status"], "running");
    let done = wait_for(&c, &a, &run, "done");
    assert_eq!((done["status"].as_str(), done["usage"]["output"].as_u64(), done["cost"].as_f64(), done["ref"].as_str()), (Some("done"), Some(4), Some(0.5), Some("thread-1")));
    let kinds: Vec<String> = call(&c, &a, "runs.events", json!({"run": run})).unwrap()["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
    assert_eq!(kinds, ["run.started", "step", "step", "step", "run.finished"]);
    let live = c.pulse(&a, Some(&c0), 100).unwrap().events.iter().filter(|e| e.kind == "runs.event").count();
    assert_eq!(live, 5, "every step also reached the person's screens");
    assert_eq!(call(&c, &a, "runs.list", json!({"ref": "thread-1"})).unwrap()["runs"].as_array().unwrap().len(), 1);
}

#[test]
fn a_failed_executor_ends_the_run_with_its_reason_and_code() {
    let (c, _s) = start();
    let a = who("alice");
    let run = call(&c, &a, "runs.start", json!({"executor": "counter.run", "input": {"boom": true}})).unwrap()["run"].as_str().unwrap().to_string();
    let g = wait_for(&c, &a, &run, "failed");
    assert_eq!((g["status"].as_str(), g["reason"].as_str(), g["code"].as_i64()), (Some("failed"), Some("counter.boom"), Some(503)));
}

#[test]
fn stopping_a_run_stops_the_work_and_it_stays_stopped() {
    let (c, _s) = start();
    let a = who("alice");
    let run = call(&c, &a, "runs.start", json!({"executor": "counter.run", "input": {"n": 50}})).unwrap()["run"].as_str().unwrap().to_string();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(call(&c, &a, "runs.cancel", json!({"run": run})).unwrap()["cancelled"], true);
    std::thread::sleep(Duration::from_millis(300));
    let n = call(&c, &a, "runs.events", json!({"run": run})).unwrap()["events"].as_array().unwrap().len();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(call(&c, &a, "runs.events", json!({"run": run})).unwrap()["events"].as_array().unwrap().len(), n, "no step after the stop");
    assert_eq!(call(&c, &a, "runs.get", json!({"id": run})).unwrap()["status"], "cancelled", "the executor's end did not overwrite the stop");
    assert_eq!(call(&c, &a, "runs.cancel", json!({"run": run})).unwrap()["cancelled"], false);
}

#[test]
fn a_run_is_its_persons_own() {
    let (c, _s) = start();
    let (a, b) = (who("alice"), who("bob"));
    let run = call(&c, &a, "runs.start", json!({"executor": "counter.run", "input": {"n": 1}})).unwrap()["run"].as_str().unwrap().to_string();
    wait_for(&c, &a, &run, "done");
    assert!(call(&c, &b, "runs.get", json!({"id": run})).is_err(), "another person cannot open it");
    assert!(call(&c, &b, "runs.cancel", json!({"run": run})).is_err());
    assert_eq!(call(&c, &b, "runs.list", json!({})).unwrap()["runs"].as_array().unwrap().len(), 0);
}

#[test]
fn a_run_left_running_by_a_process_that_is_gone_is_interrupted_and_can_be_resumed() {
    let (c, _s) = start_with(Runs::as_left_by("a-process-that-is-gone"));
    let a = who("alice");
    // the run as an earlier process left it: still "running", under another process's name
    let run = call(&c, &a, "runs.create", json!({"executor": "counter.run", "ref": "t", "input": {"n": 2}})).unwrap()["run"].as_str().unwrap().to_string();
    assert_eq!(call(&c, &a, "runs.get", json!({"id": run})).unwrap()["status"], "interrupted");
    assert_eq!(call(&c, &a, "runs.list", json!({"status": "interrupted"})).unwrap()["runs"].as_array().unwrap().len(), 1);
    assert_eq!(call(&c, &a, "runs.status", json!({"run": run})).unwrap()["status"], "interrupted", "a stage that asks sees it too");
    call(&c, &a, "runs.resume", json!({"run": run})).unwrap();
    // the resumed run was reopened under this process's own name by the same plugin; the test's stamp is only for creation
    let done = wait_for(&c, &a, &run, "done");
    assert_eq!(done["status"], "done");
    let kinds: Vec<String> = call(&c, &a, "runs.events", json!({"run": run})).unwrap()["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
    assert_eq!(kinds, ["run.started", "run.resumed", "step", "step", "run.finished"]);
    assert!(call(&c, &a, "runs.resume", json!({"run": run})).is_err(), "a finished run cannot be resumed");
}
