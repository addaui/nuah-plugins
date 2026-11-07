use nuah_adapters::*;
use nuah_kernel::*;
use nuah_metric_prometheus::{render, MetricPrometheus};
use serde_json::json;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn get(addr: &str, path: &str, auth: Option<&str>) -> String {
    let mut c = std::net::TcpStream::connect(addr).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let a = auth.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    c.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n{a}\r\n").as_bytes()).unwrap();
    let mut out = String::new();
    let _ = c.read_to_string(&mut out);
    out
}

fn core(settings: serde_json::Value) -> Core {
    let catalog = Catalog(vec![
        Arc::new(AdapterMemory) as Arc<dyn Plugin>, Arc::new(AuthLocal), Arc::new(PolicyAllowAll), Arc::new(StdClock), Arc::new(StdIds), Arc::new(MetricPrometheus),
    ]);
    let mut profile = Profile { name: "t".into(), enabled: ["db-memory", "auth-local", "policy-allow-all", "clock-system", "ids-random", "metric-prometheus"].iter().map(|s| s.to_string()).collect(), ..Default::default() };
    profile.grants.insert("metric-prometheus".into(), vec!["serve".into()]);
    profile.settings.insert("metric-prometheus".into(), settings);
    Core::start(&Distribution { name: "t".into(), catalog, profile }).unwrap_or_else(|p| panic!("{p:#?}"))
}

#[test]
fn prometheus_can_scrape_the_cores_metrics_on_its_own_port() {
    let addr = format!("127.0.0.1:{}", free_port());
    let core = core(json!({"listen": addr}));
    core.metrics().inc("shop_orders_total", &[("kind", "a\"b")], 3.0);
    core.metrics().observe("shop_latency_ms", &[], 7.0);
    let services = core.start_services().unwrap();
    let ok = get(&addr, "/metrics", None);
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    assert!(ok.contains("# TYPE shop_orders_total counter\n") && ok.contains("shop_orders_total{kind=\"a\\\"b\"} 3\n"), "{ok}");
    assert!(ok.contains("shop_latency_ms_bucket{le=\"10\"} 1\n") && ok.contains("shop_latency_ms_bucket{le=\"5\"} 0\n") && ok.contains("shop_latency_ms_bucket{le=\"+Inf\"} 1\n"), "{ok}");
    assert!(ok.contains("shop_latency_ms_sum 7\n") && ok.contains("shop_latency_ms_count 1\n"));
    assert!(get(&addr, "/other", None).starts_with("HTTP/1.1 404"));
    services.stop();
    assert!(std::net::TcpStream::connect(&addr).is_err(), "the port is free after the Core stops");
}

#[test]
fn a_token_is_required_when_one_is_set() {
    let addr = format!("127.0.0.1:{}", free_port());
    let core = core(json!({"listen": addr, "token": "s3cret-token"}));
    let services = core.start_services().unwrap();
    assert!(get(&addr, "/metrics", None).starts_with("HTTP/1.1 401"));
    assert!(get(&addr, "/metrics", Some("wrong-token")).starts_with("HTTP/1.1 401"));
    assert!(get(&addr, "/metrics", Some("s3cret-token")).starts_with("HTTP/1.1 200"));
    services.stop();
}

#[test]
fn the_text_format_has_one_type_line_per_metric() {
    let s = Snapshot {
        time: 0,
        series: vec![
            Series { name: "a_total".into(), kind: Kind::Counter, labels: [("x".to_string(), "1".to_string())].into(), value: 1.0, buckets: vec![], count: 0 },
            Series { name: "a_total".into(), kind: Kind::Counter, labels: [("x".to_string(), "2".to_string())].into(), value: 2.5, buckets: vec![], count: 0 },
        ],
    };
    let t = render(&s);
    assert_eq!(t.matches("# TYPE a_total counter").count(), 1);
    assert!(t.contains("a_total{x=\"2\"} 2.5"));
}
