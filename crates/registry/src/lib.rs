//! The index of first-party plugins: what each one is, fills, defines, needs and how it is configured.
//! The setup wizard and the console read it to show what could be added; `registry.json` at the root of
//! the repository is this function's output (a test keeps them equal).

use nuah_kernel::Plugin;
use serde_json::{json, Value};
use std::sync::Arc;

/// Every plugin in this repository, with the crate that provides it.
pub fn plugins() -> Vec<(&'static str, Arc<dyn Plugin>)> {
    let mut v: Vec<(&'static str, Arc<dyn Plugin>)> = vec![
        ("nuah-prefs", Arc::new(nuah_prefs::Prefs)),
        ("nuah-appearance", Arc::new(nuah_appearance::Appearance)),
        ("nuah-metric-prometheus", Arc::new(nuah_metric_prometheus::MetricPrometheus)),
    ];
    for t in nuah_appearance::themes() {
        v.push(("nuah-appearance", Arc::new(t)));
    }
    v
}

fn pick(m: &Value, key: &str) -> Value {
    m.get(key).cloned().unwrap_or(Value::Null)
}

pub fn index() -> Value {
    let mut entries: Vec<Value> = plugins()
        .into_iter()
        .map(|(krate, p)| {
            let m = serde_json::to_value(p.manifest()).expect("a manifest serializes");
            let kind = if m["fills"].is_string() {
                "adapter"
            } else if m["theme"].is_object() {
                "theme"
            } else {
                "plugin"
            };
            let ops: Vec<String> = m["operations"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            json!({
                "id": m["id"], "version": m["version"], "name": pick(&m, "name"), "description": pick(&m, "description"),
                "crate": krate, "kind": kind, "fills": pick(&m, "fills"),
                "requires": pick(&m, "requires"), "provides": pick(&m, "provides"),
                "defines": m["defines"]["extension_points"].as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
                "operations": ops, "settings_schema": pick(&m, "settings_schema"),
            })
        })
        .collect();
    entries.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    json!({"nuah": "0.4", "plugins": entries})
}
