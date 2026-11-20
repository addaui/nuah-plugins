// SPDX-License-Identifier: Apache-2.0
//! `@nuah/mcp` (ADR 0101): an agent reaches the Operations a person may call, as MCP tools, with that person's API key.

use nuah_adapters::*;
use nuah_kernel::*;
use nuah_mcp::{respond, Reply};
use serde_json::{json, Value};
use std::sync::Arc;

fn core(with_mcp: bool) -> Core {
    let mut p = Profile { name: "t".into(), ..Default::default() };
    p.enabled = ["@nuah/db-memory", "@nuah/auth-password", "@nuah/policy-roles", "@nuah/clock-system", "@nuah/ids-random", "@nuah/prefs"].iter().map(|s| s.to_string()).collect();
    if with_mcp {
        p.enabled.push("@nuah/mcp".into());
    }
    p.grants.insert("@nuah/prefs".into(), vec!["emit".into()]);
    p.settings.insert("@nuah/auth-password".into(), json!({"accounts": [
        {"username": "root", "password_hash": AuthPassword::hash_password("root-password"), "roles": ["admin"]},
        {"username": "sam", "password_hash": AuthPassword::hash_password("sam-password"), "roles": ["member"]},
    ]}));
    let list: Vec<Arc<dyn Plugin>> = vec![Arc::new(AdapterMemory), Arc::new(AuthPassword), Arc::new(PolicyRoles), Arc::new(StdClock), Arc::new(StdIds), Arc::new(nuah_prefs::Prefs), Arc::new(nuah_mcp::Mcp)];
    Core::start(&Distribution { name: "t".into(), catalog: Catalog(list), profile: p }).unwrap_or_else(|e| panic!("{e:?}"))
}

/// An API key of a person, made the way they would make one (signed in, in the app).
fn key(c: &Core, user: &str, pw: &str) -> String {
    let who: Identity = serde_json::from_value(c.call_as(&Identity::new("", "", &[]), "auth.sign_in", json!({"username": user, "password": pw}), None).unwrap().output["who"].clone()).unwrap();
    c.call_as(&who, "auth.keys.create", json!({"name": "agent"}), None).unwrap().output["key"].as_str().unwrap().to_string()
}

fn rpc(c: &Core, key: Option<&str>, body: Value) -> Reply {
    respond(c, key, &serde_json::to_vec(&body).unwrap())
}
fn result(r: &Reply) -> Value {
    assert_eq!(r.status, 200, "{r:?}");
    r.body.clone().expect("a body")["result"].clone()
}

#[test]
fn initialize_answers_with_the_servers_name_and_a_protocol_version_it_speaks() {
    let c = core(true);
    let k = key(&c, "root", "root-password");
    let r = result(&rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}})));
    assert_eq!(r["protocolVersion"], "2025-03-26");
    assert_eq!(r["capabilities"]["tools"], json!({"listChanged": false}));
    assert_eq!(r["serverInfo"]["name"], "t");
    // a version it does not know: it answers with its own
    let r = result(&rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "id": 2, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})));
    assert_eq!(r["protocolVersion"], "2025-06-18");
    // a notification is accepted with no body
    let n = rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    assert_eq!((n.status, n.body.is_none()), (202, true));
}

#[test]
fn without_a_valid_key_nothing_is_answered() {
    let c = core(true);
    for k in [None, Some("nuah_not-a-key")] {
        let r = rpc(&c, k, json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}));
        assert_eq!(r.status, 401, "{r:?}");
    }
}

#[test]
fn the_tools_are_the_operations_the_keys_owner_may_call() {
    let c = core(true);
    let tools = |k: &str| -> Vec<String> {
        result(&rpc(&c, Some(k), json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})))["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    };
    let (admin, member) = (tools(&key(&c, "root", "root-password")), tools(&key(&c, "sam", "sam-password")));
    assert!(admin.contains(&"prefs_set".to_string()) && admin.contains(&"auth_account_list".to_string()), "{admin:?}");
    assert!(member.contains(&"prefs_get".to_string()), "{member:?}");
    assert!(!member.contains(&"auth_account_list".to_string()), "a member's key does not see what a member may not do");
    // signing in and out belong to people, not to an agent holding a key
    assert!(!admin.iter().any(|t| t == "auth_sign_in" || t == "auth_sign_out" || t == "auth_refresh"), "{admin:?}");
    let t = result(&rpc(&c, Some(&key(&c, "root", "root-password")), json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})))["tools"].as_array().unwrap().iter().find(|t| t["name"] == "prefs_get").unwrap().clone();
    assert_eq!(t["inputSchema"]["type"], "object");
    assert_eq!(t["annotations"]["readOnlyHint"], true);
}

#[test]
fn a_tool_call_runs_the_operation_as_the_keys_owner() {
    let c = core(true);
    let k = key(&c, "sam", "sam-password");
    let call = |name: &str, args: Value| result(&rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": args}})));
    let set = call("prefs_set", json!({"language": "ar"}));
    assert_eq!(set["isError"], false, "{set}");
    let got = call("prefs_get", json!({}));
    assert_eq!(got["structuredContent"]["language"], "ar", "{got}");
    assert!(got["content"][0]["text"].as_str().unwrap().contains("\"ar\""));
    // a refused call comes back as a tool error the agent can read (the reason included)
    let refused = call("auth_keys_revoke", json!({"id": "no-such-key"}));
    assert_eq!(refused["isError"], true, "{refused}");
    assert!(refused["content"][0]["text"].as_str().unwrap().contains("auth.no_key"), "{refused}");
    // a tool the owner may not use is not one of theirs
    let r = rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "auth_account_list", "arguments": {}}}));
    assert_eq!(r.body.unwrap()["error"]["code"], -32602);
    // an unknown tool is the caller's mistake
    let r = rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "nope", "arguments": {}}}));
    assert_eq!(r.body.unwrap()["error"]["code"], -32602);
}

#[test]
fn malformed_requests_get_json_rpc_errors() {
    let c = core(true);
    let k = key(&c, "root", "root-password");
    let r = respond(&c, Some(&k), b"{not json");
    assert_eq!(r.body.unwrap()["error"]["code"], -32700);
    let r = rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "id": 3, "method": "resources/list"}));
    assert_eq!(r.body.unwrap()["error"]["code"], -32601);
    assert_eq!(result(&rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "id": 4, "method": "ping"}))), json!({}));
}

#[test]
fn switched_off_the_endpoint_is_not_there() {
    let c = core(false);
    let k = key(&c, "root", "root-password");
    assert_eq!(rpc(&c, Some(&k), json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).status, 404);
}

#[tokio::test(flavor = "current_thread")]
async fn the_route_takes_a_bearer_key_and_refuses_another_sites_page() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;
    let c = core(true);
    let k = key(&c, "root", "root-password");
    let app = nuah_mcp::routes(c);
    let req = |origin: Option<&str>| {
        let mut b = Request::post("/mcp").header("host", "madar.example").header("content-type", "application/json").header("authorization", format!("Bearer {k}"));
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        b.body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)).unwrap()
    };
    assert_eq!(app.clone().oneshot(req(None)).await.unwrap().status(), 200);
    assert_eq!(app.clone().oneshot(req(Some("https://madar.example"))).await.unwrap().status(), 200);
    assert_eq!(app.clone().oneshot(req(Some("https://evil.example"))).await.unwrap().status(), 403);
    let get = app.clone().oneshot(Request::get("/mcp").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(get.status(), 405);
    let anon = app.oneshot(Request::post("/mcp").header("host", "madar.example").body(Body::from(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)).unwrap()).await.unwrap();
    assert_eq!(anon.status(), 401);
    assert_eq!(anon.headers().get("www-authenticate").unwrap(), "Bearer");
}
