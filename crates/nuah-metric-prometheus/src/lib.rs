//! The `metric-prometheus` Adapter: lets Prometheus scrape the Core's counters, gauges and histograms.
//!
//! It answers `GET /metrics` on a port of its own (default `127.0.0.1:9464`), never on the application's
//! door, so metrics are not public by accident. Settings: `listen`, and an optional bearer `token`.

use nuah_kernel::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A snapshot in the Prometheus text exposition format.
pub fn render(s: &Snapshot) -> String {
    fn esc(v: &str) -> String {
        v.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
    }
    fn labels(l: &std::collections::BTreeMap<String, String>, extra: Option<(&str, String)>) -> String {
        let mut parts: Vec<String> = l.iter().map(|(k, v)| format!("{k}=\"{}\"", esc(v))).collect();
        if let Some((k, v)) = extra {
            parts.push(format!("{k}=\"{v}\""));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!("{{{}}}", parts.join(","))
        }
    }
    fn num(v: f64) -> String {
        if v.is_nan() {
            return "NaN".into();
        }
        if v.is_infinite() {
            return if v > 0.0 { "+Inf".into() } else { "-Inf".into() };
        }
        if v.fract() == 0.0 && v.abs() < 1e15 {
            format!("{}", v as i64)
        } else {
            format!("{v}")
        }
    }
    let mut out = String::new();
    let mut last = String::new();
    for x in &s.series {
        if x.name != last {
            let t = match x.kind {
                Kind::Counter => "counter",
                Kind::Gauge => "gauge",
                Kind::Histogram => "histogram",
            };
            out.push_str(&format!("# TYPE {} {t}\n", x.name));
            last = x.name.clone();
        }
        match x.kind {
            Kind::Histogram => {
                for (le, n) in &x.buckets {
                    out.push_str(&format!("{}_bucket{} {n}\n", x.name, labels(&x.labels, Some(("le", num(*le))))));
                }
                out.push_str(&format!("{}_bucket{} {}\n", x.name, labels(&x.labels, Some(("le", "+Inf".into()))), x.count));
                out.push_str(&format!("{}_sum{} {}\n", x.name, labels(&x.labels, None), num(x.value)));
                out.push_str(&format!("{}_count{} {}\n", x.name, labels(&x.labels, None), x.count));
            }
            _ => out.push_str(&format!("{}{} {}\n", x.name, labels(&x.labels, None), num(x.value))),
        }
    }
    out
}

/// What the Core hands the Port. Nothing is pushed: Prometheus pulls, so the interval is 0.
struct Pull;
impl MetricAdapter for Pull {
    fn name(&self) -> &str {
        "metric-prometheus"
    }
    fn interval_secs(&self) -> u64 {
        0
    }
    fn export(&self, _s: &Snapshot) {}
}

pub struct MetricPrometheus;

impl Plugin for MetricPrometheus {
    fn manifest(&self) -> Manifest {
        serde_json::from_value(json!({
            "id": "metric-prometheus", "version": "0.1.0", "name": "Prometheus metrics", "fills": "metric",
            "description": "Answers Prometheus scrapes (GET /metrics) on a port of its own",
            "requires": {"capabilities": ["serve"]},
            "settings_schema": {"type": "object", "additionalProperties": false, "properties": {
                "listen": {"type": "string", "minLength": 3, "x-tier": "bootstrap", "x-apply": "service", "description": "Address to listen on (127.0.0.1:9464 when absent)"},
                "token": {"type": "string", "minLength": 8, "x-secret": true, "x-tier": "operator", "x-apply": "service", "description": "Require `Authorization: Bearer <token>` (give it as a reference, {\"$env\": \"NAME\"}, to keep it out of the Profile)"}
            }}
        })).expect("a valid manifest")
    }

    fn fill(&self, _s: &Value) -> Result<Option<PortImpl>> {
        Ok(Some(PortImpl::Metric(Arc::new(Pull))))
    }

    fn serve(&self, ctx: ServiceContext) -> Result<Option<Box<dyn Service>>> {
        let listen = ctx.settings.get("listen").and_then(|v| v.as_str()).unwrap_or("127.0.0.1:9464").to_string();
        let token = ctx.settings.get("token").and_then(|v| v.as_str()).map(String::from);
        let listener = TcpListener::bind(&listen).map_err(|e| Error::internal(format!("cannot listen on {listen}: {e}")))?;
        listener.set_nonblocking(true).map_err(|e| Error::internal(e.to_string()))?;
        let addr = listener.local_addr().map(|a| a.to_string()).unwrap_or(listen);
        ctx.core.log(Level::Info, "metric-prometheus", "metrics.listening", json!({"addr": addr}));
        let stop = Arc::new(AtomicBool::new(false));
        let (flag, core) = (stop.clone(), ctx.core.clone());
        let thread = std::thread::Builder::new()
            .name("nuah-metric-prometheus".into())
            .spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((conn, _)) => answer(conn, &core, token.as_deref()),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(20)),
                        Err(_) => std::thread::sleep(Duration::from_millis(100)),
                    }
                }
            })
            .map_err(|e| Error::internal(format!("cannot start the metrics thread: {e}")))?;
        Ok(Some(Box::new(Running { stop, thread })))
    }
}

struct Running {
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}
impl Service for Running {
    fn stop(self: Box<Self>) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.thread.join();
    }
}

/// Compare without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn reply(mut c: TcpStream, status: &str, extra: &str, body: &str) {
    let head = format!("HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = c.write_all(head.as_bytes());
    let _ = c.write_all(body.as_bytes());
}

/// One scrape: read the request head, check it, answer, close. Slow or oversized requests are cut.
fn answer(mut c: TcpStream, core: &Core, token: Option<&str>) {
    let _ = c.set_nonblocking(false);
    let _ = c.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = c.set_write_timeout(Some(Duration::from_secs(2)));
    let mut head = Vec::new();
    let started = Instant::now();
    let mut buf = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") && head.len() < 8192 && started.elapsed() < Duration::from_secs(2) {
        match c.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    let text = String::from_utf8_lossy(&head).to_string();
    let first = text.lines().next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" {
        return reply(c, "405 Method Not Allowed", "Allow: GET\r\n", "");
    }
    if path.split('?').next() != Some("/metrics") {
        return reply(c, "404 Not Found", "", "");
    }
    if let Some(t) = token {
        let given = text.lines().find_map(|l| {
            let (name, value) = l.split_once(':')?;
            let value = value.trim();
            (name.eq_ignore_ascii_case("authorization") && value.len() > 7 && value[..7].eq_ignore_ascii_case("bearer ")).then(|| value[7..].trim())
        });
        if !given.is_some_and(|g| same(g, t)) {
            return reply(c, "401 Unauthorized", "WWW-Authenticate: Bearer\r\n", "");
        }
    }
    reply(c, "200 OK", "Content-Type: text/plain; version=0.0.4; charset=utf-8\r\n", &render(&core.metrics_snapshot()));
}
