// SPDX-License-Identifier: Apache-2.0
//! Durable runs of long work ([Nuah ADR 0136]). A product starts a run by naming an executor, an operation of its own; the run
//! gets an id at once and the executor works in the background while its steps are stored and sent to the person's screens as
//! Pulse events. A run can be cancelled, survives a restart as "interrupted" (and can be resumed), and is the person's own.
//!
//! The plugin knows no product: `ref` and `meta` are the product's own handle and notes about a run.
//!
//! [Nuah ADR 0136]: https://madar.addaui.com/#/p/c732d1c1f2a8405da02ddc3cf964557c?tab=knowledge&page=bd634703517249f79883debc622dbc3f

use nuah_kernel::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const RUNS: &str = "runs.runs";
pub const EVENTS: &str = "runs.events";
/// How many runs may work at once in one process; one more is refused until another ends.
const MAX_ACTIVE: usize = 64;

fn manifest(v: Value) -> Manifest {
    serde_json::from_value(v).expect("a valid manifest")
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

/// Names this running process. A run records the process that drives it; one still "running" whose process is gone is shown as
/// interrupted.
fn boot_id() -> &'static str {
    static BOOT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BOOT.get_or_init(|| format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)))
}

fn shown(d: &Doc) -> Value {
    let b = &d.body;
    let status = if b["status"] == "running" && b["boot"] != boot_id() { json!("interrupted") } else { b["status"].clone() };
    let mut v = json!({"id": d.id, "ref": b["ref"], "kind": b["kind"], "executor": b["executor"], "status": status, "started": b["started"], "meta": b.get("meta").cloned().unwrap_or(json!({}))});
    for k in ["finished", "error", "reason", "code", "usage", "cost"] {
        if let Some(x) = b.get(k).filter(|x| !x.is_null()) {
            v[k] = x.clone();
        }
    }
    v
}

/// Add an entry to a run's log and tell the person's open screens.
fn record(tx: &mut Tx, run: &str, rf: &str, kind: &str, data: Value) -> Result<i64> {
    let seq = tx.count(EVENTS, &[Cond { field: "run".into(), op: Cmp::Eq, value: json!(run) }])? as i64 + 1;
    tx.create(EVENTS, json!({"run": run, "ref": rf, "seq": seq, "kind": kind, "at": tx.now(), "data": data}))?;
    let who = tx.who().subject.clone();
    tx.emit("runs.event", Audience::subject(&who), json!({"run": run, "ref": rf, "seq": seq, "kind": kind, "data": data}))?;
    Ok(seq)
}

/// What the service lends the operations: the Core, to work on a run in the background.
#[derive(Default)]
struct Launcher {
    core: Mutex<Option<Core>>,
    active: AtomicUsize,
}

impl Launcher {
    /// Work on a run in the background as the person who started it.
    fn launch(self: &Arc<Self>, who: Identity, run: String, input: Value, resumed: bool) -> Result<()> {
        let core = self.core.lock().unwrap().clone().ok_or_else(|| Error::internal("runs are not running: the service of @nuah/runs has not started"))?;
        if self.active.fetch_add(1, Ordering::SeqCst) >= MAX_ACTIVE {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return Err(Error::new(Category::Internal, "runs.busy", "too many runs are working; try again in a moment").with_reason("runs.busy"));
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name("nuah-run".into())
            .spawn(move || {
                let r = core.call_as(&who, text(&input, "executor"), json!({"run": run, "ref": input["ref"], "input": input["input"], "resumed": resumed}), None);
                let mut fin = json!({"run": run});
                match r {
                    Ok(out) => {
                        fin["status"] = json!("done");
                        for k in ["usage", "cost"] {
                            if let Some(v) = out.output.get(k).filter(|v| !v.is_null()) {
                                fin[k] = v.clone();
                            }
                        }
                    }
                    Err(e) => {
                        fin["status"] = json!("failed");
                        fin["error"] = json!(e.message);
                        if let Some(r) = &e.reason {
                            fin["reason"] = json!(r);
                        }
                        if let Some(c) = e.params["status"].as_i64() {
                            fin["code"] = json!(c);
                        }
                    }
                }
                let _ = core.call_as(&who, "runs.finish", fin, None);
                me.active.fetch_sub(1, Ordering::SeqCst);
            })
            .map_err(|e| Error::internal(format!("cannot start a run: {e}")))?;
        Ok(())
    }
}

struct RunsService(Arc<Launcher>);
impl Service for RunsService {
    fn stop(self: Box<Self>) {
        // work still going is given a moment to end; the Core has already waited for the calls it counted
        let started = std::time::Instant::now();
        while self.0.active.load(Ordering::SeqCst) > 0 && started.elapsed() < std::time::Duration::from_secs(2) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        *self.0.core.lock().unwrap() = None;
    }
}

#[derive(Default)]
pub struct Runs {
    launcher: Arc<Launcher>,
    stamp: Option<String>,
}

impl Runs {
    /// For tests: new runs are stamped with another process's name, as if an earlier process had left them running.
    pub fn as_left_by(process: &str) -> Self {
        Runs { stamp: Some(process.into()), ..Default::default() }
    }
}

impl Plugin for Runs {
    fn manifest(&self) -> Manifest {
        let id = |d: &str, props: Value, req: &[&str]| json!({"kind": "command", "permission": "runs.use", "description": d, "input": {"type": "object", "required": req, "properties": props, "additionalProperties": false}});
        manifest(json!({
            "id": "@nuah/runs", "version": "0.1.0", "name": "Runs", "namespaces": ["runs"],
            "description": "Long work that has an id, steps you can follow, a stop button and survives a restart: a product names the operation that does the work",
            "requires": {"capabilities": ["emit", "serve", "call"]},
            "permissions": {"runs.use": {"description": "Start, follow and stop your own runs", "default": ["admin", "member"]}},
            "events": {"runs.event": {}},
            "data": {"schema": serde_json::from_str::<Value>(include_str!("../schema/runs.json")).expect("the schema file is JSON")},
            "operations": {
                "runs.start": {"kind": "outbound", "permission": "runs.use", "description": "Start a run: answers its id at once while the executor works in the background",
                    "input": {"type": "object", "required": ["executor"], "properties": {"executor": {"type": "string"}, "ref": {"type": "string"}, "kind": {"type": "string"}, "input": {"type": "object"}, "meta": {"type": "object"}}, "additionalProperties": false}},
                "runs.resume": {"kind": "outbound", "permission": "runs.use", "description": "Start the executor again for a run that was interrupted",
                    "input": {"type": "object", "required": ["run"], "properties": {"run": {"type": "string"}}, "additionalProperties": false}},
                "runs.create": id("Create the record of a run (used by runs.start)", json!({"executor": {"type": "string"}, "ref": {"type": "string"}, "kind": {"type": "string"}, "input": {"type": "object"}, "meta": {"type": "object"}}), &["executor"]),
                "runs.reopen": id("Mark an interrupted run as running again (used by runs.resume)", json!({"run": {"type": "string"}}), &["run"]),
                "runs.input": {"kind": "query", "permission": "runs.use", "description": "What a run was started with (used by runs.resume)", "input": {"type": "object", "required": ["run"], "properties": {"run": {"type": "string"}}, "additionalProperties": false}},
                "runs.get": {"kind": "query", "permission": "runs.use", "input": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}, "additionalProperties": false}},
                "runs.list": {"kind": "query", "permission": "runs.use", "description": "Your runs, newest first, by ref, kind or status or since a time",
                    "input": {"type": "object", "properties": {"ref": {"type": "string"}, "kind": {"type": "string"}, "status": {"type": "string"}, "since": {"type": "integer"}, "limit": {"type": "integer", "minimum": 1, "maximum": 5000}}, "additionalProperties": false}},
                "runs.status": {"kind": "query", "permission": "runs.use", "input": {"type": "object", "required": ["run"], "properties": {"run": {"type": "string"}}, "additionalProperties": false}},
                "runs.events": {"kind": "query", "permission": "runs.use", "input": {"type": "object", "required": ["run"], "properties": {"run": {"type": "string"}}, "additionalProperties": false}},
                "runs.record": id("Add a step to a run's log", json!({"run": {"type": "string"}, "kind": {"type": "string"}, "data": {"type": "object"}}), &["run", "kind"]),
                "runs.delta": id("A piece of output as it is written: shown live, never stored; answers whether the run is still wanted", json!({"run": {"type": "string"}, "text": {"type": "string"}}), &["run", "text"]),
                "runs.cancel": id("Stop a run that is still going", json!({"run": {"type": "string"}}), &["run"]),
                "runs.finish": id("End a run as done or failed", json!({"run": {"type": "string"}, "status": {"type": "string"}, "error": {"type": "string"}, "reason": {"type": "string"}, "code": {"type": "integer"}, "usage": {"type": "object"}, "cost": {"type": "number"}}), &["run", "status"])
            }
        }))
    }

    fn bind(&self, b: &mut Bindings) {
        let stamp = self.stamp.clone();
        b.op("runs.create", move |tx, i| {
            let (rf, kind) = (text(&i, "ref").to_string(), text(&i, "kind").to_string());
            let d = tx.create(RUNS, json!({"kind": kind, "ref": rf, "executor": text(&i, "executor"), "input": i.get("input").cloned().unwrap_or(json!({})), "meta": i.get("meta").cloned().unwrap_or(json!({})), "status": "running", "started": tx.now(), "boot": stamp.clone().unwrap_or_else(|| boot_id().to_string())}))?;
            record(tx, &d.id, &rf, "run.started", json!({}))?;
            Ok(json!({"run": d.id}))
        });
        let launcher = self.launcher.clone();
        b.outbound("runs.start", move |cx, i| {
            let who = cx.who().clone();
            let created = cx.call("runs.create", json!({"executor": i["executor"], "ref": i.get("ref").cloned().unwrap_or(json!("")), "kind": i.get("kind").cloned().unwrap_or(json!("")), "input": i.get("input").cloned().unwrap_or(json!({})), "meta": i.get("meta").cloned().unwrap_or(json!({}))}))?;
            let run = text(&created, "run").to_string();
            let launch = json!({"executor": i["executor"], "ref": i.get("ref").cloned().unwrap_or(json!("")), "input": i.get("input").cloned().unwrap_or(json!({}))});
            if let Err(e) = launcher.launch(who, run.clone(), launch, false) {
                let _ = cx.call("runs.finish", json!({"run": run, "status": "failed", "error": e.message}));
                return Err(e);
            }
            Ok(json!({"run": run}))
        });
        let launcher = self.launcher.clone();
        b.outbound("runs.resume", move |cx, i| {
            let run = text(&i, "run").to_string();
            let got = cx.call("runs.get", json!({"id": run}))?;
            if got["status"] != "interrupted" {
                return Err(Error::new(Category::Conflict, "runs.not_interrupted", "only an interrupted run can be resumed").with_reason("runs.not_interrupted"));
            }
            cx.call("runs.reopen", json!({"run": run}))?;
            let full = cx.call("runs.input", json!({"run": run}))?;
            launcher.launch(cx.who().clone(), run.clone(), full, true)?;
            Ok(json!({"run": run}))
        });
        b.op("runs.reopen", |tx, i| {
            let run = text(&i, "run");
            let mut r = tx.get(RUNS, run)?.ok_or_else(|| Error::not_found("run"))?;
            r.body["status"] = json!("running");
            r.body["boot"] = json!(boot_id());
            if let Some(o) = r.body.as_object_mut() {
                o.remove("finished");
            }
            let rf = text(&r.body, "ref").to_string();
            tx.put(RUNS, run, r.body, Expect::Any)?;
            record(tx, run, &rf, "run.resumed", json!({}))?;
            Ok(json!({}))
        });
        b.op("runs.input", |tx, i| {
            let r = tx.get(RUNS, text(&i, "run"))?.ok_or_else(|| Error::not_found("run"))?;
            Ok(json!({"executor": r.body["executor"], "ref": r.body["ref"], "input": r.body["input"]}))
        });
        b.op("runs.get", |tx, i| Ok(shown(&tx.get(RUNS, text(&i, "id"))?.ok_or_else(|| Error::not_found("run"))?)));
        b.op("runs.list", |tx, i| {
            let mut q = Query::new().desc("started").limit(i["limit"].as_u64().unwrap_or(500) as usize);
            for k in ["ref", "kind", "status"] {
                if let Some(v) = i.get(k).and_then(|v| v.as_str()) {
                    // an interrupted run is stored as running: the stored status is compared after the view
                    if !(k == "status" && v == "interrupted") && !(k == "status" && v == "running") {
                        q = q.eq(k, v);
                    }
                }
            }
            if let Some(s) = i.get("since").and_then(|s| s.as_i64()) {
                q = q.gte("started", s);
            }
            let page = tx.query(RUNS, &q)?;
            let want = i.get("status").and_then(|s| s.as_str());
            let runs: Vec<Value> = page.items.iter().map(shown).filter(|v| want.is_none_or(|w| v["status"] == w)).collect();
            Ok(json!({"runs": runs}))
        });
        b.op("runs.status", |tx, i| {
            let d = tx.get(RUNS, text(&i, "run"))?.ok_or_else(|| Error::not_found("run"))?;
            Ok(json!({"status": shown(&d)["status"]}))
        });
        b.op("runs.events", |tx, i| {
            let page = tx.query(EVENTS, &Query::new().eq("run", text(&i, "run")).asc("seq").limit(5000))?;
            Ok(json!({"events": page.items.iter().map(|d| json!({"seq": d.body["seq"], "kind": d.body["kind"], "at": d.body["at"], "data": d.body["data"]})).collect::<Vec<_>>()}))
        });
        b.op("runs.record", |tx, i| {
            let r = tx.get(RUNS, text(&i, "run"))?.ok_or_else(|| Error::not_found("run"))?;
            let seq = record(tx, text(&i, "run"), text(&r.body, "ref"), text(&i, "kind"), i.get("data").cloned().unwrap_or(json!({})))?;
            Ok(json!({"seq": seq}))
        });
        b.op("runs.delta", |tx, i| {
            let r = tx.get(RUNS, text(&i, "run"))?.ok_or_else(|| Error::not_found("run"))?;
            let who = tx.who().subject.clone();
            tx.emit("runs.event", Audience::subject(&who), json!({"run": text(&i, "run"), "ref": r.body["ref"], "seq": 0, "kind": "delta", "data": {"text": text(&i, "text")}}))?;
            Ok(json!({"go_on": r.body["status"] == "running"}))
        });
        b.op("runs.cancel", |tx, i| {
            let run = text(&i, "run");
            let mut r = tx.get(RUNS, run)?.ok_or_else(|| Error::not_found("run"))?;
            if r.body["status"] != "running" {
                return Ok(json!({"cancelled": false}));
            }
            r.body["status"] = json!("cancelled");
            r.body["finished"] = json!(tx.now());
            let rf = text(&r.body, "ref").to_string();
            tx.put(RUNS, run, r.body, Expect::Any)?;
            record(tx, run, &rf, "run.cancelled", json!({}))?;
            Ok(json!({"cancelled": true}))
        });
        b.op("runs.finish", |tx, i| {
            let run = text(&i, "run");
            let mut r = tx.get(RUNS, run)?.ok_or_else(|| Error::not_found("run"))?;
            // a run the person stopped stays stopped
            if r.body["status"] == "cancelled" {
                return Ok(json!({}));
            }
            let status = text(&i, "status");
            if status != "done" && status != "failed" {
                return Err(Error::invalid("status", "is done or failed"));
            }
            r.body["status"] = json!(status);
            r.body["finished"] = json!(tx.now());
            for k in ["error", "reason", "code", "usage", "cost"] {
                if let Some(v) = i.get(k).filter(|v| !v.is_null()) {
                    r.body[k] = v.clone();
                }
            }
            let rf = text(&r.body, "ref").to_string();
            tx.put(RUNS, run, r.body, Expect::Any)?;
            record(tx, run, &rf, if status == "done" { "run.finished" } else { "run.failed" }, json!({"error": i.get("error"), "usage": i.get("usage")}))?;
            Ok(json!({}))
        });
    }

    fn serve(&self, ctx: ServiceContext) -> Result<Option<Box<dyn Service>>> {
        *self.launcher.core.lock().unwrap() = Some(ctx.core);
        Ok(Some(Box::new(RunsService(self.launcher.clone()))))
    }
}
