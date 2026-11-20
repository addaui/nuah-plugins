// SPDX-License-Identifier: Apache-2.0
//! `@nuah/mcp` ([ADR 0101]): agents reach a Distribution through the Model Context Protocol. The tools are the Operations the
//! caller may run, as `describe` lists them for that person; a call runs through the Core like any other (sign-in, permission,
//! input check, idempotency), so an agent can do exactly what the person whose API key it holds can do, and nothing more.
//!
//! The transport is MCP's Streamable HTTP, answered with plain JSON (no event stream, no session): `POST /mcp` with a JSON-RPC
//! request, notification or batch. The Distribution mounts [`routes`] on its HTTP Projection (`Http::with_routes`); the plugin being
//! enabled is the switch, so an instance that does not want agents leaves it off and `/mcp` answers 404.
//!
//! [ADR 0101]: https://docs.addaui.com/nuah/adr/0101-agents-reach-a-distribution-through-mcp-and-api-keys-a-key-acts-as-its-owner/

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use nuah_kernel::*;
use serde_json::{json, Value};

pub const ID: &str = "@nuah/mcp";
/// The protocol versions this server speaks, newest first; a client asking for another gets the newest.
pub const VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// Operations that belong to a person signing in or out, not to an agent holding a key.
const NOT_TOOLS: &[&str] = &["auth.sign_in", "auth.sign_out", "auth.refresh"];

pub struct Mcp;

impl Plugin for Mcp {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": ID, "version": "0.1.0", "name": "MCP for agents",
            "description": "AI agents (Claude, ChatGPT, Cursor...) use this instance through MCP with a person's API key: the tools are the Operations that person may run, nothing more.",
        }))
        .expect("the @nuah/mcp manifest")
    }
}

/// What to send back: a status and, unless the request was only notifications, a JSON-RPC body.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Option<Value>,
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// Answers one MCP request body for the holder of `credential` (an API key, or a session token). Blocking: run it off the async threads.
pub fn respond(core: &Core, credential: Option<&str>, body: &[u8]) -> Reply {
    if !core.plugin_ids().iter().any(|p| p == ID) {
        return Reply { status: 404, body: None };
    }
    let who = match core.authenticate(credential) {
        Ok(w) if !w.subject.is_empty() || credential.is_none() => w,
        _ => return Reply { status: 401, body: Some(rpc_error(Value::Null, -32001, "Sign in with an API key: Authorization: Bearer <key>")) },
    };
    if who.subject.is_empty() {
        return Reply { status: 401, body: Some(rpc_error(Value::Null, -32001, "Sign in with an API key: Authorization: Bearer <key>")) };
    }
    let msg: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return Reply { status: 200, body: Some(rpc_error(Value::Null, -32700, "The body is not JSON")) },
    };
    let answers: Vec<Value> = match &msg {
        Value::Array(batch) if !batch.is_empty() => batch.iter().filter_map(|m| one(core, credential, &who, m)).collect(),
        Value::Array(_) => return Reply { status: 200, body: Some(rpc_error(Value::Null, -32600, "An empty batch")) },
        m => one(core, credential, &who, m).into_iter().collect(),
    };
    match (msg.is_array(), answers.len()) {
        (_, 0) => Reply { status: 202, body: None },
        (false, _) => Reply { status: 200, body: answers.into_iter().next() },
        (true, _) => Reply { status: 200, body: Some(Value::Array(answers)) },
    }
}

/// One JSON-RPC message: a request gets an answer, a notification (no id) gets none.
fn one(core: &Core, credential: Option<&str>, who: &Identity, m: &Value) -> Option<Value> {
    let id = m.get("id").cloned();
    let method = m["method"].as_str();
    let Some(method) = method.filter(|_| m["jsonrpc"] == "2.0") else {
        return id.map(|id| rpc_error(id, -32600, "Not a JSON-RPC 2.0 request"));
    };
    let id = id?; // notifications (initialized, cancelled) need no answer
    let params = m.get("params").cloned().unwrap_or(json!({}));
    let ok = |result: Value| json!({"jsonrpc": "2.0", "id": id.clone(), "result": result});
    Some(match method {
        "initialize" => {
            let asked = params["protocolVersion"].as_str().unwrap_or("");
            let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
            let d = core.describe(who);
            let name = d["about"]["name"].as_str().or(d["profile"].as_str()).unwrap_or("nuah").to_string();
            let mut info = json!({"name": name});
            if let Some(v) = d["about"]["version"].as_str() {
                info["version"] = json!(v);
            } else {
                info["version"] = json!(env!("CARGO_PKG_VERSION"));
            }
            ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": info,
                "instructions": format!("You act as {}, with their rights. Each tool is one operation of this instance; read its description and input schema. A refused call says why.", who.display),
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({"tools": tools(core, who).into_iter().map(|(_, t)| t).collect::<Vec<_>>()})),
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or("");
            let Some((op, _)) = tools(core, who).into_iter().find(|(_, t)| t["name"] == name) else {
                return Some(rpc_error(id, -32602, &format!("Unknown tool: {name}")));
            };
            let input = params.get("arguments").cloned().filter(|a| !a.is_null()).unwrap_or(json!({}));
            let req = CallRequest { credential: credential.map(String::from), op, input, key: None, contract: None };
            ok(match core.call(req) {
                Ok(r) => {
                    let text = serde_json::to_string_pretty(&r.output).unwrap_or_default();
                    let mut out = json!({"content": [{"type": "text", "text": text}], "isError": false});
                    if r.output.is_object() {
                        out["structuredContent"] = r.output;
                    }
                    out
                }
                Err(e) => {
                    let category = serde_json::to_value(e.category).ok().and_then(|c| c.as_str().map(String::from)).unwrap_or_default();
                    let reason = e.reason.as_deref().map(|r| format!(", {r}")).unwrap_or_default();
                    json!({"content": [{"type": "text", "text": format!("{} ({category}{reason})", e.message)}], "isError": true})
                }
            })
        }
        _ => rpc_error(id, -32601, &format!("Unknown method: {method}")),
    })
}

/// The tools for this person: every Operation `describe` lists for them, but signing in and out. (operation, tool)
fn tools(core: &Core, who: &Identity) -> Vec<(String, Value)> {
    let defs = contract::tool_definitions(&core.describe(who));
    defs.as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let op = t["op"].as_str()?.to_string();
            if NOT_TOOLS.contains(&op.as_str()) {
                return None;
            }
            Some((op, json!({"name": t["name"], "description": t["description"], "inputSchema": t["inputSchema"], "annotations": t["annotations"]})))
        })
        .collect()
}

/// `POST /mcp` for the Distribution's HTTP Projection (`Http::with_routes(nuah_mcp::routes)`). A browser page of another site cannot
/// use it: a request that names an Origin other than the host is refused (MCP asks servers to check, against DNS rebinding).
pub fn routes(core: Core) -> Router {
    Router::new().route("/mcp", post(handle).get(no_stream).delete(no_stream)).with_state(core)
}

async fn no_stream() -> Response {
    (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "POST")]).into_response()
}

async fn handle(State(core): State<Core>, headers: HeaderMap, body: Bytes) -> Response {
    let get = |n: &str| headers.get(n).and_then(|v| v.to_str().ok()).map(String::from);
    if let (Some(origin), Some(host)) = (get("origin"), get("host")) {
        let origin_host = origin.split("://").nth(1).unwrap_or("");
        if origin_host != host {
            return (StatusCode::FORBIDDEN, "cross-site requests are not allowed").into_response();
        }
    }
    let credential = get("authorization").and_then(|a| a.strip_prefix("Bearer ").map(|t| t.trim().to_string()));
    let reply = tokio::task::spawn_blocking(move || respond(&core, credential.as_deref(), &body)).await;
    let Ok(reply) = reply else { return StatusCode::INTERNAL_SERVER_ERROR.into_response() };
    let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    match reply.body {
        None => status.into_response(),
        Some(b) => {
            let mut r = (status, [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))], b.to_string()).into_response();
            if status == StatusCode::UNAUTHORIZED {
                r.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            }
            r
        }
    }
}
