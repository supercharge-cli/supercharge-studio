//! Crash reports and anonymous usage stats, shared by the desktop app, the phone app and the
//! headless server (included with `#[path]`).
//!
//! * Crash reports are compiled in only when the build sets `SENTRY_DSN`. Usage stats are on in
//!   release builds and off in debug builds; `SUPERCHARGE_TELEMETRY_POSTHOG_ENABLED=true|false` at
//!   build time overrides that. The server never sends usage stats.
//! * The user can turn either off in Settings; `DO_NOT_TRACK=1` or
//!   `SUPERCHARGE_TELEMETRY_DISABLED=1` turn both off for a run.
//! * Crash reports: Rust panics and uncaught web UI errors, as a minimal envelope (message,
//!   panic location, version, OS, arch, release). Messages are scrubbed of paths, the home
//!   directory, URLs, e-mail addresses, keys/tokens and long quoted text (which is where prompts
//!   or chat content would show up), then truncated.
//! * Usage stats: the events in [`USAGE_EVENTS`] with an allowlisted, sanitized set of properties
//!   and a random install id. No content, paths, host names, IPs or account data. Events are queued
//!   in memory (at most [`QUEUE_MAX`]), sent in one batch every [`FLUSH_EVERY`] and on exit, and kept
//!   on disk only when a batch could not be delivered (sent on the next start).
//! * Plain HTTPS POSTs through ureq on background threads; failures are silent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// Build-time configuration (empty values count as unset).
fn build_env(v: Option<&'static str>) -> Option<&'static str> {
    v.map(str::trim).filter(|v| !v.is_empty())
}
const DEFAULT_USAGE_HOST: &str = "https://us.i.posthog.com";
/// The usage stats project's public ingestion key (it can only add events, not read them).
const USAGE_KEY: &str = "phc_zQ4JMELY4e6vfQbfBAJdyGMHgqv9M2A4MYqtmRLtUHhY";
/// Unsent usage events kept in memory and on disk (oldest dropped first).
pub const QUEUE_MAX: usize = 200;
/// How often queued usage events are sent.
pub const FLUSH_EVERY: Duration = Duration::from_secs(30);
const QUEUE_FILE: &str = "usage-pending.json";
const MAX_CRASHES_PER_RUN: u32 = 5;
const PREFS_FILE: &str = "telemetry.json";
const PENDING_DIR: &str = "crash-pending";

/// Where crash envelopes go, from a DSN `scheme://KEY@HOST[:PORT]/[PREFIX/]PROJECT`.
#[derive(Clone, Debug, PartialEq)]
pub struct CrashTarget {
    pub url: String,
    pub auth: String,
}

impl CrashTarget {
    pub fn from_dsn(dsn: &str) -> Option<CrashTarget> {
        let (scheme, rest) = dsn.trim().split_once("://")?;
        if scheme != "https" && scheme != "http" {
            return None;
        }
        let (key, rest) = rest.split_once('@')?;
        let key = key.split(':').next()?;
        let (host, path) = rest.split_once('/')?;
        let path = path.trim_end_matches('/');
        let (prefix, project) = match path.rsplit_once('/') {
            Some((p, id)) => (format!("/{p}"), id),
            None => (String::new(), path),
        };
        if key.is_empty() || host.is_empty() || project.is_empty() || !project.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(CrashTarget {
            url: format!("{scheme}://{host}{prefix}/api/{project}/envelope/"),
            auth: format!("Sentry sentry_version=7, sentry_key={key}, sentry_client=supercharge-studio/{}", env!("CARGO_PKG_VERSION")),
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct UsageTarget {
    pub url: String,
    pub key: String,
}

/// What this build can send. `None` = not compiled in.
#[derive(Clone, Debug, Default)]
pub struct Config {
    pub crash: Option<CrashTarget>,
    pub usage: Option<UsageTarget>,
}

impl Config {
    /// From the build environment (CI injects the repository secrets; other builds get nothing).
    pub fn from_build() -> Config {
        let crash = build_env(option_env!("SENTRY_DSN")).and_then(CrashTarget::from_dsn);
        let flag = build_env(option_env!("SUPERCHARGE_TELEMETRY_POSTHOG_ENABLED"));
        let usage = usage_built_in(flag, cfg!(debug_assertions)).then(|| {
            let host = build_env(option_env!("SUPERCHARGE_TELEMETRY_POSTHOG_HOST")).unwrap_or(DEFAULT_USAGE_HOST);
            UsageTarget { url: format!("{}/batch/", host.trim_end_matches('/')), key: USAGE_KEY.to_string() }
        });
        Config { crash, usage }
    }
}

/// Usage stats are on in release builds; the build flag (`true`/`false`, `1`/`0`, …) overrides that.
pub fn usage_built_in(flag: Option<&str>, debug: bool) -> bool {
    match flag.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "false" | "0" | "no" | "off") => false,
        Some(v) if matches!(v.as_str(), "true" | "1" | "yes" | "on") => true,
        _ => !debug,
    }
}

/// The user's choices plus the anonymous install id (stored next to the other settings).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Prefs {
    #[serde(default = "yes")]
    pub crash: bool,
    #[serde(default = "yes")]
    pub usage: bool,
    #[serde(default)]
    pub install_id: String,
    /// Version that last ran here, to report `update_installed` once.
    #[serde(default)]
    pub last_version: String,
}
fn yes() -> bool {
    true
}
impl Default for Prefs {
    fn default() -> Self {
        Prefs { crash: true, usage: true, install_id: String::new(), last_version: String::new() }
    }
}

/// Settings view for the UI: what is compiled in and what the user chose.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct Status {
    pub crash_available: bool,
    pub usage_available: bool,
    pub crash: bool,
    pub usage: bool,
}

pub struct Telemetry {
    cfg: Config,
    /// desktop | mobile | server
    component: &'static str,
    version: &'static str,
    dir: PathBuf,
    prefs: Mutex<Prefs>,
    killed: bool,
    crash_on: AtomicBool,
    usage_on: AtomicBool,
    crashes: AtomicU32,
    seen: Mutex<HashSet<String>>,
    home: Option<String>,
    /// Usage events waiting for the next batch.
    queue: Mutex<Vec<Value>>,
    /// Messages sent since the last batch (reported as one `message_sent` with a count).
    messages: AtomicU32,
    /// One batch at a time.
    flushing: Mutex<()>,
}

static GLOBAL: OnceLock<Telemetry> = OnceLock::new();
static IN_HOOK: AtomicBool = AtomicBool::new(false);

/// `DO_NOT_TRACK=1` / `SUPERCHARGE_TELEMETRY_DISABLED=1` switch everything off for this run.
pub fn killed_by_env() -> bool {
    let on = |k: &str| std::env::var(k).is_ok_and(|v| !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false"));
    on("DO_NOT_TRACK") || on("SUPERCHARGE_TELEMETRY_DISABLED")
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if getrandom::fill(&mut b).is_err() {
        let t = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        for (i, x) in b.iter_mut().enumerate() {
            *x = (t >> ((i % 16) * 8)) as u8 ^ (i as u8).wrapping_mul(151);
        }
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn http(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(timeout.min(Duration::from_secs(4)))
        .timeout(timeout)
        .user_agent(concat!("supercharge-studio/", env!("CARGO_PKG_VERSION")))
        .redirects(0)
        .build()
}

fn post(url: &str, headers: &[(&str, &str)], body: &str) -> bool {
    post_with(url, headers, body, Duration::from_secs(8))
}

fn post_with(url: &str, headers: &[(&str, &str)], body: &str, timeout: Duration) -> bool {
    let mut req = http(timeout).post(url);
    for (k, v) in headers {
        req = req.set(k, v);
    }
    req.send_string(body).is_ok()
}

impl Telemetry {
    /// Load prefs from `dir`, create the install id, note an update since the last run.
    pub fn new(cfg: Config, component: &'static str, version: &'static str, dir: &Path, killed: bool) -> Telemetry {
        let mut prefs: Prefs = std::fs::read(dir.join(PREFS_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut dirty = false;
        if prefs.install_id.len() != 32 {
            prefs.install_id = random_hex(16);
            dirty = true;
        }
        let t = Telemetry {
            cfg,
            component,
            version,
            dir: dir.to_path_buf(),
            crash_on: AtomicBool::new(false),
            usage_on: AtomicBool::new(false),
            prefs: Mutex::new(prefs),
            killed,
            crashes: AtomicU32::new(0),
            seen: Mutex::new(HashSet::new()),
            home: dirs_home(),
            queue: Mutex::new(vec![]),
            messages: AtomicU32::new(0),
            flushing: Mutex::new(()),
        };
        t.refresh();
        if dirty && (t.cfg.crash.is_some() || t.cfg.usage.is_some()) {
            t.save();
        }
        // Events a previous run could not deliver (dropped if usage stats are now off).
        let file = t.dir.join(QUEUE_FILE);
        if let Ok(b) = std::fs::read(&file) {
            let _ = std::fs::remove_file(&file);
            if t.usage_enabled() {
                let mut old: Vec<Value> = serde_json::from_slice(&b).unwrap_or_default();
                old.retain(|e| e["event"].as_str().is_some_and(|n| USAGE_EVENTS.contains(&n)));
                let skip = old.len().saturating_sub(QUEUE_MAX);
                *t.queue.lock().unwrap() = old.into_iter().skip(skip).collect();
            }
        }
        t
    }

    fn refresh(&self) {
        let p = self.prefs.lock().unwrap();
        self.crash_on.store(!self.killed && self.cfg.crash.is_some() && p.crash, Ordering::SeqCst);
        self.usage_on.store(!self.killed && self.cfg.usage.is_some() && p.usage, Ordering::SeqCst);
    }

    fn save(&self) {
        let p = self.prefs.lock().unwrap().clone();
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = std::fs::write(self.dir.join(PREFS_FILE), serde_json::to_vec(&p).unwrap_or_default());
    }

    pub fn crash_enabled(&self) -> bool {
        self.crash_on.load(Ordering::SeqCst)
    }
    pub fn usage_enabled(&self) -> bool {
        self.usage_on.load(Ordering::SeqCst)
    }

    pub fn status(&self) -> Status {
        let p = self.prefs.lock().unwrap();
        // A DO_NOT_TRACK-style kill switch shows as off (nothing is sent this run).
        Status { crash_available: self.cfg.crash.is_some(), usage_available: self.cfg.usage.is_some(), crash: self.cfg.crash.is_some() && p.crash && !self.killed, usage: self.cfg.usage.is_some() && p.usage && !self.killed }
    }

    /// Save the user's choice. Turning crash reports off also drops unsent reports.
    pub fn set(&self, crash: Option<bool>, usage: Option<bool>) -> Status {
        {
            let mut p = self.prefs.lock().unwrap();
            if let Some(c) = crash {
                p.crash = c;
            }
            if let Some(u) = usage {
                p.usage = u;
            }
        }
        self.save();
        self.refresh();
        if crash == Some(false) {
            let _ = std::fs::remove_dir_all(self.dir.join(PENDING_DIR));
        }
        if !self.usage_enabled() {
            self.clear_queue();
        }
        self.status()
    }

    fn base_props(&self) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert("source".into(), json!("studio"));
        m.insert("app".into(), json!(self.component));
        m.insert("app_version".into(), json!(self.version));
        m.insert("platform".into(), json!(platform(self.component)));
        m.insert("os".into(), json!(std::env::consts::OS));
        m.insert("arch".into(), json!(std::env::consts::ARCH));
        m.insert("$lib".into(), json!("supercharge-studio"));
        // Anonymous events: no person profile, no IP address or IP-based location.
        m.insert("$process_person_profile".into(), json!(false));
        m.insert("$geoip_disable".into(), json!(true));
        m.insert("$ip".into(), Value::Null);
        m
    }

    /// One usage event as queued (None when usage stats are off or the name isn't allowed).
    pub fn usage_event(&self, event: &str, extra: serde_json::Map<String, Value>) -> Option<Value> {
        self.cfg.usage.as_ref()?;
        if !self.usage_enabled() || !USAGE_EVENTS.contains(&event) {
            return None;
        }
        let mut props = self.base_props();
        props.extend(extra);
        let id = self.prefs.lock().ok()?.install_id.clone();
        Some(json!({ "event": event, "distinct_id": id, "timestamp": iso_time(SystemTime::now()), "properties": props }))
    }

    /// Queue a usage event for the next batch (oldest dropped past [`QUEUE_MAX`]).
    fn enqueue(&self, event: &str, extra: serde_json::Map<String, Value>) -> bool {
        let Some(ev) = self.usage_event(event, extra) else { return false };
        // try_lock: never wait (this also runs from the panic hook).
        let Ok(mut q) = self.queue.try_lock() else { return false };
        q.push(ev);
        let over = q.len().saturating_sub(QUEUE_MAX);
        q.drain(..over);
        true
    }

    /// Queue an event at most once per run (per `key`).
    fn enqueue_once(&self, key: String, event: &str, extra: serde_json::Map<String, Value>) -> bool {
        if !self.usage_enabled() || !self.seen.lock().unwrap().insert(key) {
            return false;
        }
        self.enqueue(event, extra)
    }

    /// Number of queued events (plus a pending `message_sent`), for tests and the exit path.
    pub fn queued(&self) -> usize {
        self.queue.lock().map(|q| q.len()).unwrap_or(0) + usize::from(self.messages.load(Ordering::SeqCst) > 0)
    }

    fn clear_queue(&self) {
        if let Ok(mut q) = self.queue.lock() {
            q.clear();
        }
        self.messages.store(0, Ordering::SeqCst);
        let _ = std::fs::remove_file(self.dir.join(QUEUE_FILE));
    }

    /// Send everything queued in one batch. On failure the events stay queued (and are saved to
    /// disk for the next start); returns whether the batch was delivered (true when empty).
    pub fn flush(&self, timeout: Duration) -> bool {
        let Some(target) = self.cfg.usage.clone() else { return true };
        let Ok(_one) = self.flushing.lock() else { return false };
        if !self.usage_enabled() {
            self.clear_queue();
            return true;
        }
        let n = self.messages.swap(0, Ordering::SeqCst);
        if n > 0 {
            let mut m = serde_json::Map::new();
            m.insert("count".into(), json!(n));
            self.enqueue("message_sent", m);
        }
        let batch = std::mem::take(&mut *self.queue.lock().unwrap());
        if batch.is_empty() {
            return true;
        }
        let body = json!({ "api_key": target.key, "batch": batch }).to_string();
        if post_with(&target.url, &[("Content-Type", "application/json")], &body, timeout) {
            let _ = std::fs::remove_file(self.dir.join(QUEUE_FILE));
            return true;
        }
        let mut q = self.queue.lock().unwrap();
        let newer = std::mem::take(&mut *q);
        let mut all = batch;
        all.extend(newer);
        let over = all.len().saturating_sub(QUEUE_MAX);
        all.drain(..over);
        if self.usage_enabled() {
            let _ = std::fs::create_dir_all(&self.dir);
            let _ = std::fs::write(self.dir.join(QUEUE_FILE), serde_json::to_vec(&all).unwrap_or_default());
        }
        *q = all;
        false
    }

    /// A usage event reported by the web UI: only [`JS_EVENTS`], with sanitized properties.
    /// The phone only reports its own connection and errors; its chats run through the desktop
    /// app, which counts them, so nothing is counted twice.
    pub fn track(&self, event: &str, props: &Value) -> bool {
        if !self.usage_enabled() || !JS_EVENTS.contains(&event) || (self.component == "mobile" && !matches!(event, "agent_connected" | "error")) {
            return false;
        }
        if event == "message_sent" {
            self.messages.fetch_add(1, Ordering::SeqCst);
            return true;
        }
        let Some(extra) = allowed_props(event, props) else { return false };
        match event {
            // Once per run (reconnects and repeated picks of the same model are not new).
            "agent_connected" => self.enqueue_once(format!("a:{}", extra.get("cli_version").and_then(Value::as_str).unwrap_or("")), event, extra),
            "model_selected" => self.enqueue_once(format!("m:{}", Value::Object(extra.clone())), event, extra),
            "error" => self.enqueue_once(format!("e:{}", Value::Object(extra.clone())), event, extra),
            _ => self.enqueue(event, extra),
        }
    }

    /// `cli_version_detected` once per run per version.
    pub fn cli_version(&self, version: &str) -> bool {
        let Some(v) = clean_version(version) else { return false };
        let mut m = serde_json::Map::new();
        m.insert("version".into(), json!(v));
        self.enqueue_once(format!("v:{v}"), "cli_version_detected", m)
    }

    /// `feature_used` once per run per feature; only names from [`FEATURES`].
    pub fn feature(&self, name: &'static str) -> bool {
        if !FEATURES.contains(&name) {
            return false;
        }
        let mut m = serde_json::Map::new();
        m.insert("feature".into(), json!(name));
        self.enqueue_once(format!("f:{name}"), "feature_used", m)
    }

    /// An uncaught error as a `$exception` usage event: type and scrubbed message only, sent only
    /// when both crash reports and usage stats are on, each distinct error once per run.
    fn exception(&self, kind: &str, message: &str) -> bool {
        if !self.crash_enabled() || self.seen.lock().map(|s| s.len()).unwrap_or(usize::MAX) > 500 {
            return false;
        }
        let value = scrub(message, self.home.as_deref(), 200);
        let mut m = serde_json::Map::new();
        m.insert("$exception_list".into(), json!([{ "type": kind, "value": value, "mechanism": { "type": "generic", "handled": false } }]));
        m.insert("$exception_type".into(), json!(kind));
        m.insert("$exception_message".into(), json!(value));
        self.enqueue_once(format!("x:{kind}:{value}"), "$exception", m)
    }

    /// Startup: queue `app_opened`, then `update_installed` if the version changed since the last run.
    pub fn started(&self) -> usize {
        let prev = {
            let mut p = self.prefs.lock().unwrap();
            std::mem::replace(&mut p.last_version, self.version.to_string())
        };
        if prev != self.version && (self.cfg.crash.is_some() || self.cfg.usage.is_some()) {
            self.save();
        }
        let mut n = usize::from(self.enqueue("app_opened", serde_json::Map::new()));
        if !prev.is_empty() && prev != self.version {
            let mut m = serde_json::Map::new();
            m.insert("from".into(), json!(clean_version(&prev).unwrap_or_default()));
            n += usize::from(self.enqueue("update_installed", m));
        }
        n
    }

    /// The crash envelope (header, item header, event) for a scrubbed error.
    pub fn crash_envelope(&self, kind: &str, message: &str, location: Option<&str>, stack: &str, fatal: bool) -> String {
        let id = random_hex(16);
        let value = scrub(message, self.home.as_deref(), 300);
        let mut ex = json!({ "type": kind, "value": value, "mechanism": { "type": kind, "handled": false } });
        let frames: Vec<Value> = stack
            .lines()
            .filter_map(|l| scrub_frame(l, self.home.as_deref()))
            .take(40)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .chain(location.map(|l| json!({ "filename": scrub_location(l) })))
            .collect();
        if !frames.is_empty() {
            ex["stacktrace"] = json!({ "frames": frames });
        }
        let event = json!({
            "event_id": id,
            "timestamp": now_secs(),
            "platform": "other",
            "level": if fatal { "fatal" } else { "error" },
            "logger": self.component,
            "release": format!("supercharge-studio@{}", self.version),
            "environment": "production",
            "tags": { "app": self.component, "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
            "contexts": {
                "os": { "name": std::env::consts::OS },
                "device": { "arch": std::env::consts::ARCH },
                "app": { "app_version": self.version },
            },
            "exception": { "values": [ex] },
        });
        format!("{}\n{}\n{}\n", json!({ "event_id": id }), json!({ "type": "event", "content_type": "application/json" }), event)
    }

    fn crash_allowed(&self, dedupe: &str) -> bool {
        self.crash_enabled()
            && self.crashes.fetch_add(1, Ordering::SeqCst) < MAX_CRASHES_PER_RUN
            && self.seen.lock().unwrap().insert(format!("c:{dedupe}"))
    }

    fn send_crash(&self, env: &str) -> bool {
        match &self.cfg.crash {
            Some(t) => post(&t.url, &[("Content-Type", "application/x-sentry-envelope"), ("X-Sentry-Auth", &t.auth)], env),
            None => false,
        }
    }

    /// An uncaught error from the web UI (sent in the background).
    pub fn js_error(&self, message: &str, stack: &str) -> Option<std::thread::JoinHandle<()>> {
        let message: String = message.chars().take(1000).collect();
        // Agent errors are reported by code only (see JS_HOOK).
        match message.strip_prefix("AcpRpcError ") {
            Some(code) => {
                self.track("error", &json!({ "kind": "acp_rpc", "code": code.trim().parse::<i64>().ok() }));
            }
            None => {
                let kind = message.split(':').next().filter(|k| k.len() < 40 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).unwrap_or("js_error");
                self.exception(kind, &message);
            }
        }
        if !self.crash_allowed(&message) {
            return None;
        }
        let env = self.crash_envelope("js_error", &message, None, stack, false);
        let cfg = self.cfg.crash.clone()?;
        std::thread::Builder::new().name("telemetry".into()).spawn(move || {
            post(&cfg.url, &[("Content-Type", "application/x-sentry-envelope"), ("X-Sentry-Auth", &cfg.auth)], &env);
        }).ok()
    }

    /// A Rust panic: written to disk first (the process may abort right after), then sent.
    pub fn panic(&self, message: &str, location: Option<&str>) {
        if !self.crash_allowed(&format!("{message}@{}", location.unwrap_or(""))) {
            return;
        }
        // Saved with the queue so it goes out next run if the process aborts.
        if self.exception("panic", message) {
            if let Ok(q) = self.queue.try_lock() {
                let _ = std::fs::create_dir_all(&self.dir);
                let _ = std::fs::write(self.dir.join(QUEUE_FILE), serde_json::to_vec(&*q).unwrap_or_default());
            }
        }
        let env = self.crash_envelope("panic", message, location, "", true);
        let dir = self.dir.join(PENDING_DIR);
        let file = dir.join(format!("{}.envelope", random_hex(8)));
        let saved = std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&file, &env).is_ok();
        if self.send_crash(&env) && saved {
            let _ = std::fs::remove_file(&file);
        }
    }

    /// Send reports a previous run saved but couldn't deliver (at most a few, oldest dropped).
    pub fn flush_pending(&self) -> usize {
        let dir = self.dir.join(PENDING_DIR);
        let Ok(rd) = std::fs::read_dir(&dir) else { return 0 };
        let files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "envelope")).collect();
        if !self.crash_enabled() {
            let _ = std::fs::remove_dir_all(&dir);
            return 0;
        }
        let mut sent = 0;
        for (i, f) in files.iter().enumerate() {
            if i < MAX_CRASHES_PER_RUN as usize {
                if let Ok(env) = std::fs::read_to_string(f) {
                    if self.send_crash(&env) {
                        sent += 1;
                    } else {
                        continue;
                    }
                }
            }
            let _ = std::fs::remove_file(f);
        }
        sent
    }
}

/// Usage event names that may be sent.
pub const USAGE_EVENTS: &[&str] = &[
    "app_opened", "update_installed", "session_started", "message_sent", "model_selected", "agent_connected", "cli_version_detected",
    "feature_used", "error", "$exception",
];
/// Usage events the web UI may report (through `telemetry_event`).
pub const JS_EVENTS: &[&str] = &["session_started", "message_sent", "model_selected", "agent_connected", "error"];
/// Feature names for `feature_used` (nothing else is accepted).
pub const FEATURES: &[&str] = &[
    "terminal", "side_browser", "git_commit", "git_push", "pull_request", "worktree", "checkpoint", "phone_pairing", "public_relay",
    "provider_setup", "export_chat", "attachment", "project_rules", "stdio_transport", "cli_install",
];

/// desktop | android | ios | server
fn platform(component: &str) -> &'static str {
    match component {
        "mobile" if cfg!(target_os = "ios") => "ios",
        "mobile" => "android",
        "server" => "server",
        _ => "desktop",
    }
}

/// RFC 3339 UTC time with milliseconds (the ingestion API rejects bare epoch numbers).
pub fn iso_time(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 → civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, d.subsec_millis())
}

/// A provider or model id kept as data: short, plain characters, and nothing that looks like a
/// path, URL, e-mail address or key.
pub fn clean_id(v: &str, max: usize) -> Option<String> {
    let v = v.trim();
    let plain = v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/' | '+' | '@' | '[' | ']'));
    let lower = v.to_ascii_lowercase();
    const KEY_PREFIXES: &[&str] = &["sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghs_", "ghu_", "github_pat_", "xox", "glpat-", "aiza", "eyj", "hf_", "phc_", "phx_", "nous-"];
    let keyish = KEY_PREFIXES.iter().any(|p| lower.starts_with(p))
        || v.split(|c: char| !c.is_ascii_alphanumeric()).any(|s| s.len() >= 24 && s.bytes().any(|b| b.is_ascii_digit()) && s.bytes().any(|b| b.is_ascii_alphabetic()));
    let email = v.split_once('@').is_some_and(|(a, b)| !a.is_empty() && b.contains('.'));
    let pathish = v.starts_with(['/', '.', '~']) || v.contains("..") || v.contains("//") || v.matches('/').count() > 3;
    (!v.is_empty() && v.chars().count() <= max && plain && !keyish && !email && !pathish).then(|| v.to_string())
}

/// A version such as `1.2.3`, `v0.9.0-beta.1` or `1.0.0+abc`.
pub fn clean_version(v: &str) -> Option<String> {
    let v = v.trim().trim_start_matches('v');
    (v.len() <= 40 && v.starts_with(|c: char| c.is_ascii_digit()) && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))).then(|| v.to_string())
}

/// The properties a web UI event may carry, sanitized; anything else is dropped. None when a
/// required property is missing or unsafe.
pub fn allowed_props(event: &str, props: &Value) -> Option<serde_json::Map<String, Value>> {
    let s = |k: &str| props.get(k).and_then(Value::as_str);
    let mut m = serde_json::Map::new();
    match event {
        "session_started" | "message_sent" => {}
        "model_selected" => {
            let model = clean_id(s("model")?, 120)?;
            // The provider is the id's prefix (`provider/model` or `provider:model`) unless given.
            let provider = s("provider").and_then(|p| clean_id(p, 60)).or_else(|| model.split_once(['/', ':']).and_then(|(p, _)| clean_id(p, 60)));
            if let Some(p) = provider {
                m.insert("provider".into(), json!(p));
            }
            m.insert("model".into(), json!(model));
        }
        "agent_connected" => {
            if let Some(v) = s("cli_version").and_then(clean_version) {
                m.insert("cli_version".into(), json!(v));
            }
        }
        "error" => {
            let kind = s("kind")?;
            if kind.is_empty() || kind.len() > 40 || !kind.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
                return None;
            }
            m.insert("kind".into(), json!(kind));
            match props.get("code") {
                Some(Value::Number(n)) if n.is_i64() => {
                    m.insert("code".into(), json!(n));
                }
                Some(Value::String(c)) => {
                    if let Some(c) = clean_id(c, 40).filter(|c| !c.contains(['/', '@'])) {
                        m.insert("code".into(), json!(c));
                    }
                }
                _ => {}
            }
        }
        _ => return None,
    }
    Some(m)
}

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()).filter(|h| h.len() > 1)
}

// ---- global instance --------------------------------------------------------------------

/// Set up once at startup: load prefs, install the panic hook, queue `app_opened`, send pending reports, then batch usage events.
/// `usage`: whether this component sends usage stats at all (the server only sends crashes);
/// `off`: an extra opt-out for this run (e.g. the server's `--no-crash-reports`).
pub fn init(component: &'static str, version: &'static str, dir: &Path, usage: bool, off: bool) -> &'static Telemetry {
    let t = GLOBAL.get_or_init(|| {
        let mut cfg = Config::from_build();
        if !usage {
            cfg.usage = None;
        }
        Telemetry::new(cfg, component, version, dir, off || killed_by_env())
    });
    if t.cfg.crash.is_some() {
        install_panic_hook();
    }
    if t.crash_enabled() || t.usage_enabled() || t.cfg.crash.is_some() || t.cfg.usage.is_some() {
        let _ = std::thread::Builder::new().name("telemetry".into()).spawn(move || {
            t.flush_pending();
            if t.cfg.usage.is_none() {
                return;
            }
            t.started();
            // Usage batches: right after start, then every FLUSH_EVERY (a no-op while off or empty).
            loop {
                t.flush(Duration::from_secs(8));
                std::thread::sleep(FLUSH_EVERY);
            }
        });
    }
    t
}

/// Report panics (then run the default hook, which prints the message as before).
fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if !IN_HOOK.swap(true, Ordering::SeqCst) {
            let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".into());
            let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line()));
            if let Some(t) = GLOBAL.get() {
                t.panic(&msg, loc.as_deref());
            }
            IN_HOOK.store(false, Ordering::SeqCst);
        }
        prev(info);
    }));
}

pub fn get() -> Option<&'static Telemetry> {
    GLOBAL.get()
}

/// `feature_used` from anywhere (no-op until `init`, or when off).
pub fn feature(name: &'static str) {
    if let Some(t) = GLOBAL.get() {
        t.feature(name);
    }
}

/// `cli_version_detected` from anywhere (no-op until `init`, or when off).
pub fn cli_version(version: &str) {
    if let Some(t) = GLOBAL.get() {
        t.cli_version(version);
    }
}

/// Send queued usage events now, waiting at most a moment (on exit).
pub fn shutdown() {
    if let Some(t) = GLOBAL.get() {
        if t.usage_enabled() && t.queued() > 0 {
            t.flush(Duration::from_secs(2));
        }
    }
}

/// Send queued usage events in the background (e.g. when the phone app goes to the background).
#[allow(dead_code)] // phone app only
pub fn flush_soon() {
    if let Some(t) = GLOBAL.get() {
        if t.usage_enabled() && t.queued() > 0 {
            let _ = std::thread::Builder::new().name("telemetry".into()).spawn(move || t.flush(Duration::from_secs(5)));
        }
    }
}

// ---- scrubbing ----------------------------------------------------------------------------

fn is_sep(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';' | '|')
}

fn looks_secret(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    const PREFIXES: &[&str] = &["sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghs_", "ghu_", "github_pat_", "xox", "glpat-", "aiza", "eyj", "hf_", "phc_", "phx_", "nous-"];
    if t.len() >= 12 && PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return true;
    }
    let body = t.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if body.len() < 20 {
        return false;
    }
    let ok = body.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '=' | '.'));
    let digits = body.chars().filter(|c| c.is_ascii_digit()).count();
    let letters = body.chars().filter(|c| c.is_ascii_alphabetic()).count();
    ok && digits >= 2 && letters >= 2 && !body.contains("::")
}

fn looks_path(t: &str) -> bool {
    let b = t.as_bytes();
    t.starts_with('/') && t.len() > 1
        || t.starts_with("~/") || t.starts_with("~\\") || t == "~"
        || t.starts_with("./") || t.starts_with("../") || t.starts_with(".\\")
        || t.starts_with("\\\\")
        || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || t.matches(['/', '\\']).count() >= 2
}

const SECRET_KEYS: &[&str] = &["key", "token", "secret", "password", "passwd", "auth", "bearer", "credential", "session", "cookie", "dsn"];

fn scrub_token(t: &str, out: &mut String) {
    if t.contains("://") {
        out.push_str("<url>");
    } else if t.contains('@') && t.contains('.') && !t.starts_with('@') {
        out.push_str("<email>");
    } else if let Some((k, v)) = t.split_once(['=', ':']).filter(|(k, v)| !v.is_empty() && SECRET_KEYS.iter().any(|s| k.to_ascii_lowercase().contains(s))) {
        out.push_str(k);
        out.push_str(&t[k.len()..k.len() + 1]);
        let _ = v;
        out.push_str("<redacted>");
    } else if looks_path(t) {
        out.push_str("<path>");
    } else if looks_secret(t) {
        out.push_str("<redacted>");
    } else {
        out.push_str(t);
    }
}

/// Remove anything personal from an error message and cap its length (in characters).
pub fn scrub(s: &str, home: Option<&str>, max: usize) -> String {
    let mut s = s.to_string();
    if let Some(h) = home.filter(|h| h.len() > 1) {
        s = s.replace(h, "~");
        s = s.replace(&h.replace('\\', "/"), "~");
    }
    // Quoted text that is long or has spaces (prompts, chat, file contents) is dropped entirely;
    // only short single-word quotes such as `'map'` stay.
    let mut q = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if matches!(c, '"' | '\'' | '`') {
            if let Some(end) = chars[i + 1..].iter().position(|&d| d == c) {
                let inner: String = chars[i + 1..i + 1 + end].iter().collect();
                q.push(c);
                if inner.chars().count() > 24 || inner.contains(char::is_whitespace) {
                    q.push_str("<redacted>");
                } else {
                    q.push_str(&inner);
                }
                q.push(c);
                i += end + 2;
                continue;
            }
        }
        q.push(c);
        i += 1;
    }
    let mut out = String::with_capacity(q.len());
    let mut tok = String::new();
    let mut bearer = false;
    for c in q.chars().chain(std::iter::once(' ')) {
        if is_sep(c) {
            if !tok.is_empty() {
                // Trailing punctuation ("…/notes.md:", "token.") stays outside the token.
                let core = tok.trim_end_matches([':', '.', ',', '!', '?']);
                let core = if core.is_empty() { tok.as_str() } else { core };
                if bearer {
                    out.push_str("<redacted>");
                } else {
                    scrub_token(core, &mut out);
                }
                out.push_str(&tok[core.len()..]);
                bearer = tok.eq_ignore_ascii_case("bearer") || tok.eq_ignore_ascii_case("basic");
                tok.clear();
            }
            out.push(c);
        } else {
            tok.push(c);
        }
    }
    out.pop();
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > max {
        out.chars().take(max).collect::<String>() + "…"
    } else {
        out
    }
}

/// `src/foo.rs:12` style location: keep the crate-relative part, never a full path.
pub fn scrub_location(l: &str) -> String {
    let l = l.replace('\\', "/");
    let tail = match l.rfind("/src/") {
        Some(i) => {
            // Keep `<crate>/src/file.rs` when it's a dependency, `src/file.rs` for our own code.
            let before = &l[..i];
            let krate = before.rsplit('/').next().unwrap_or("");
            if l.starts_with("src/") || before.is_empty() { l[i + 1..].to_string() } else if krate.is_empty() { l[i + 1..].to_string() } else { format!("{krate}/{}", &l[i + 1..]) }
        }
        None if l.starts_with("src/") => l.clone(),
        None => l.rsplit('/').next().unwrap_or("").to_string(),
    };
    tail.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':' | '@')).take(120).collect()
}

/// One JS stack line → `{function, filename, lineno, colno}` with only the bundle file name.
pub fn scrub_frame(line: &str, _home: Option<&str>) -> Option<Value> {
    let l = line.trim();
    if l.is_empty() {
        return None;
    }
    // Chrome: "at fn (url:1:2)" / "at url:1:2"; WebKit/Firefox: "fn@url:1:2".
    let (func, loc) = if let Some(rest) = l.strip_prefix("at ") {
        match rest.rsplit_once(" (") {
            Some((f, loc)) => (f.trim(), loc.trim_end_matches(')')),
            None => ("", rest),
        }
    } else if let Some((f, loc)) = l.rsplit_once('@').filter(|(f, loc)| !f.contains(char::is_whitespace) && !loc.contains(char::is_whitespace)) {
        // (A message line such as "Error: mail bob@x.io:1" has spaces and is not a frame.)
        (f, loc)
    } else {
        return None;
    };
    let mut parts = loc.rsplitn(3, ':');
    let col = parts.next()?.parse::<u64>().ok();
    let line_no = parts.next().and_then(|v| v.parse::<u64>().ok());
    let file = parts.next().unwrap_or(loc);
    let (file, line_no, col) = if line_no.is_none() { (loc, col, None) } else { (file, line_no, col) };
    let name = file.split(['?', '#']).next().unwrap_or("").rsplit(['/', '\\']).next().unwrap_or("");
    // Only our bundle's own files are named; anything else (extensions, user pages) is anonymous.
    let app_file = name.ends_with(".js") || name.ends_with(".mjs");
    let func: String = func.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '$' | '<' | '>')).take(80).collect();
    Some(json!({
        "function": if func.is_empty() { "?".to_string() } else { func },
        "filename": if app_file { name.chars().take(80).collect::<String>() } else { "<anonymous>".to_string() },
        "lineno": line_no,
        "colno": col,
        "in_app": app_file,
    }))
}

/// Injected into the app UI webview (not the side browser): forwards uncaught errors and
/// unhandled promise rejections to `telemetry_js_error`. Kept out of the JS bundle on purpose.
/// Browser notices that are not app errors (also dropped in `JS_HOOK`, before sending).
pub fn benign_js_error(message: &str) -> bool {
    message.trim_start().starts_with("ResizeObserver loop")
}

pub const JS_HOOK: &str = r#"(()=>{let n=0;const s=(m,k)=>{m=String(m||"Error");if(/^ResizeObserver loop/.test(m))return;if(n++>9)return;try{window.__TAURI_INTERNALS__.invoke("telemetry_js_error",{message:m.slice(0,1000),stack:String(k||"").slice(0,6000)}).catch(()=>{})}catch(_){}};addEventListener("error",e=>s(e.message,e.error&&e.error.stack));addEventListener("unhandledrejection",e=>{const r=e.reason;if(r&&typeof r.code=="number"&&r.name=="AcpRpcError")return s("AcpRpcError "+r.code,"");s(r&&r.message||r,r&&r.stack)})})()"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// A local HTTP server that records each request (path, headers, body) and answers 200.
    fn mock() -> (String, mpsc::Receiver<(String, Vec<(String, String)>, String)>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", l.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut first = String::new();
                r.read_line(&mut first).unwrap();
                let path = first.split_whitespace().nth(1).unwrap_or("").to_string();
                let mut headers = vec![];
                let mut len = 0;
                loop {
                    let mut h = String::new();
                    r.read_line(&mut h).unwrap();
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    let (k, v) = h.split_once(':').unwrap();
                    if k.eq_ignore_ascii_case("content-length") {
                        len = v.trim().parse().unwrap();
                    }
                    headers.push((k.to_ascii_lowercase(), v.trim().to_string()));
                }
                let mut body = vec![0; len];
                r.read_exact(&mut body).unwrap();
                let mut w = s;
                let _ = w.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
                let _ = tx.send((path, headers, String::from_utf8(body).unwrap()));
            }
        });
        (addr, rx)
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("scs-telemetry-{name}-{}", random_hex(4)));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn cfg(base: &str) -> Config {
        Config {
            crash: CrashTarget::from_dsn(&format!("{}/42", base.replace("http://", "http://pubkey@"))),
            usage: Some(UsageTarget { url: format!("{base}/batch/"), key: "phc_testkey".into() }),
        }
    }

    const WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn dsn_parsing() {
        let t = CrashTarget::from_dsn("https://abc123@o1.ingest.example.io/4500").unwrap();
        assert_eq!(t.url, "https://o1.ingest.example.io/api/4500/envelope/");
        assert!(t.auth.contains("sentry_key=abc123"));
        assert_eq!(CrashTarget::from_dsn("https://k@host:9000/prefix/7").unwrap().url, "https://host:9000/prefix/api/7/envelope/");
        assert!(CrashTarget::from_dsn("").is_none());
        assert!(CrashTarget::from_dsn("not a dsn").is_none());
        assert!(CrashTarget::from_dsn("https://host/12").is_none());
        assert!(CrashTarget::from_dsn("ftp://k@h/1").is_none());
    }

    #[test]
    fn usage_stats_follow_the_build_profile() {
        // Release builds send usage stats, debug builds don't; the build flag overrides either.
        assert!(usage_built_in(None, false));
        assert!(!usage_built_in(None, true));
        assert!(!usage_built_in(Some("false"), false) && !usage_built_in(Some("0"), false) && !usage_built_in(Some("OFF"), false));
        assert!(usage_built_in(Some("true"), true) && usage_built_in(Some("1"), true));
        assert!(!usage_built_in(Some("maybe"), true));
        let c = Config::from_build();
        if let Some(u) = &c.usage {
            assert!(u.url.ends_with("/batch/") && u.key.starts_with("phc_"));
        }
    }

    #[test]
    fn builds_without_telemetry_are_off() {
        let d = tmp("off");
        let t = Telemetry::new(Config::default(), "desktop", "1.0.0", &d, false);
        assert!(!t.crash_enabled() && !t.usage_enabled());
        assert_eq!(t.status(), Status { crash_available: false, usage_available: false, crash: false, usage: false });
        assert!(t.usage_event("app_opened", Default::default()).is_none());
        assert!(!t.feature("terminal"));
        assert_eq!(t.started(), 0);
        assert!(!t.track("session_started", &Value::Null));
        assert!(t.flush(WAIT));
        t.panic("boom", None);
        assert!(t.js_error("x", "").is_none());
        assert!(!d.exists(), "nothing is written when telemetry isn't compiled in");
    }

    #[test]
    fn iso_times() {
        assert_eq!(iso_time(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(UNIX_EPOCH + Duration::from_millis(1_763_078_400_123)), "2025-11-14T00:00:00.123Z");
        assert_eq!(iso_time(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn props_allowlist_and_sanitizer() {
        let p = |e: &str, v: Value| allowed_props(e, &v).map(Value::Object);
        // Unknown keys are dropped; content never passes.
        assert_eq!(p("session_started", json!({ "text": "my secret prompt", "cwd": "/home/a" })).unwrap(), json!({}));
        assert_eq!(p("message_sent", json!({ "text": "hi" })).unwrap(), json!({}));
        assert!(p("prompt_text", json!({})).is_none());
        // Provider/model ids are data; the provider defaults to the id's prefix.
        assert_eq!(p("model_selected", json!({ "model": "hub/some-org/big-model-3.1-405b-instruct", "extra": 1 })).unwrap(), json!({ "provider": "hub", "model": "hub/some-org/big-model-3.1-405b-instruct" }));
        assert_eq!(p("model_selected", json!({ "model": "fast-5", "provider": "acme" })).unwrap(), json!({ "provider": "acme", "model": "fast-5" }));
        assert_eq!(p("model_selected", json!({ "model": "chat-model-4@20250514" })).unwrap(), json!({ "model": "chat-model-4@20250514" }));
        for bad in ["/home/alice/models/x.gguf", "C:\\Users\\bob\\m.bin", "~/m", "../m", "http://10.0.0.5:8080/v1", "bob@example.com", "sk-proj-AAAAbbbbCCCC1234dddd", "write me a poem", "a".repeat(200).as_str(), "x/../../etc", "model\nname"] {
            assert!(p("model_selected", json!({ "model": bad })).is_none(), "{bad}");
        }
        assert!(p("model_selected", json!({})).is_none());
        assert_eq!(p("model_selected", json!({ "model": "m1", "provider": "/etc/passwd" })).unwrap(), json!({ "model": "m1" }));
        // Versions.
        assert_eq!(p("agent_connected", json!({ "cli_version": "v1.4.2-beta.1" })).unwrap(), json!({ "cli_version": "1.4.2-beta.1" }));
        assert_eq!(p("agent_connected", json!({ "cli_version": "my laptop" })).unwrap(), json!({}));
        assert_eq!(clean_version("0.9.1+abc"), Some("0.9.1+abc".into()));
        assert_eq!(clean_version("/usr/bin/x"), None);
        // Errors: a short kind and a code, nothing else.
        assert_eq!(p("error", json!({ "kind": "agent_connect", "code": -32603, "message": "failed at /home/a" })).unwrap(), json!({ "kind": "agent_connect", "code": -32603 }));
        assert_eq!(p("error", json!({ "kind": "agent_connect", "code": "ECONNREFUSED" })).unwrap(), json!({ "kind": "agent_connect", "code": "ECONNREFUSED" }));
        assert_eq!(p("error", json!({ "kind": "x", "code": "/home/a/b" })).unwrap(), json!({ "kind": "x" }));
        assert!(p("error", json!({ "kind": "Has Spaces" })).is_none());
        assert!(p("error", json!({ "code": 1 })).is_none());
    }

    #[test]
    fn usage_opt_out_clears_the_queue() {
        let dead = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let d = tmp("optout-queue");
        let t = Telemetry::new(cfg(&dead), "desktop", "1.0.0", &d, false);
        assert_eq!(t.started(), 1);
        assert!(t.track("session_started", &Value::Null) && t.track("message_sent", &Value::Null));
        assert_eq!(t.queued(), 3);
        // Offline: kept in memory and on disk.
        assert!(!t.flush(Duration::from_millis(500)));
        assert!(d.join(QUEUE_FILE).exists());
        assert_eq!(t.queued(), 3);
        t.set(None, Some(false));
        assert_eq!(t.queued(), 0);
        assert!(!d.join(QUEUE_FILE).exists());
        assert!(!t.track("session_started", &Value::Null) && !t.feature("terminal") && t.usage_event("app_opened", Default::default()).is_none());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn usage_queue_is_capped_and_survives_restarts() {
        let dead = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let d = tmp("queue");
        let t = Telemetry::new(cfg(&dead), "desktop", "1.0.0", &d, false);
        for _ in 0..(QUEUE_MAX + 50) {
            t.track("session_started", &Value::Null);
        }
        assert_eq!(t.queued(), QUEUE_MAX);
        assert!(!t.flush(Duration::from_millis(500)));
        // Next run (now online) sends what was saved, in one batch.
        let (base, rx) = mock();
        let t2 = Telemetry::new(cfg(&base), "desktop", "1.0.0", &d, false);
        assert!(!d.join(QUEUE_FILE).exists());
        assert_eq!(t2.queued(), QUEUE_MAX);
        assert!(t2.flush(WAIT));
        let (path, _, body) = rx.recv_timeout(WAIT).unwrap();
        assert_eq!(path, "/batch/");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["batch"].as_array().unwrap().len(), QUEUE_MAX);
        assert_eq!(t2.queued(), 0);
        assert!(t2.flush(WAIT), "empty queue: nothing to send");
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn scrubs_personal_data() {
        let home = Some("/home/alice");
        let s = scrub("failed to open /home/alice/projects/secret-plan/notes.md: denied", home, 300);
        assert_eq!(s, "failed to open <path>: denied");
        assert_eq!(scrub("cannot read C:\\Users\\bob\\work\\a.txt", None, 300), "cannot read <path>");
        assert_eq!(scrub("cwd ~/code/app", None, 300), "cwd <path>");
        assert_eq!(scrub("auth failed for sk-ant-api03-AbCdEf0123456789xyz", home, 300), "auth failed for <redacted>");
        assert_eq!(scrub("header Authorization: Bearer abc.def.ghi", home, 300), "header Authorization: Bearer <redacted>");
        assert_eq!(scrub("api_key=hunter2 token:xyz", home, 300), "api_key=<redacted> token:<redacted>");
        assert_eq!(scrub("ghp_0123456789abcdefABCDEF0123", home, 300), "<redacted>");
        assert_eq!(scrub("send to bob@example.com now", home, 300), "send to <email> now");
        assert_eq!(scrub("GET https://api.example.com/v1?key=1 failed", home, 300), "GET <url> failed");
        assert_eq!(
            scrub(r#"called `Result::unwrap()` on an `Err` value: Parse("please refactor my billing module and email the CFO")"#, home, 300),
            "called `Result::unwrap()` on an `Err` value: Parse(\"<redacted>\")"
        );
        // Short, ordinary messages survive.
        assert_eq!(scrub("index out of bounds: the len is 3 but the index is 7", home, 300), "index out of bounds: the len is 3 but the index is 7");
        assert_eq!(scrub("TypeError: Cannot read properties of undefined (reading 'map')", home, 300), "TypeError: Cannot read properties of undefined (reading 'map')");
        assert_eq!(scrub(&"a".repeat(500), None, 10).chars().count(), 11);
        // Short quotes with spaces can still be chat text.
        assert_eq!(scrub("Unexpected token 'h', \"hi there\" is not valid JSON", home, 300), "Unexpected token 'h', \"<redacted>\" is not valid JSON");
        // A stack's message line is not a frame, even with an '@' in it.
        assert!(scrub_frame("Error: write to bob@example.com:12", None).is_none());
        assert!(scrub_frame("Error: mail bob@x.io", None).is_none());
        assert_eq!(scrub_location("/home/runner/work/scs/src-tauri/src/gateway.rs:88"), "src-tauri/src/gateway.rs:88");
        assert_eq!(scrub_location("src/gateway.rs:88"), "src/gateway.rs:88");
        assert_eq!(scrub_location("/Users/x/.cargo/registry/src/index/tokio-1.4/src/rt.rs:9"), "tokio-1.4/src/rt.rs:9");
        let f = scrub_frame("at render (tauri://localhost/assets/index-AbC.js:1:2345)", None).unwrap();
        assert_eq!(f["filename"], "index-AbC.js");
        assert_eq!(f["lineno"], 1);
        assert_eq!(f["colno"], 2345);
        let f = scrub_frame("go@file:///home/alice/x/thing.html:3:4", None).unwrap();
        assert_eq!(f["filename"], "<anonymous>");
        assert!(!f.to_string().contains("alice"));
    }

    #[test]
    fn opt_out_gates_everything() {
        let (base, rx) = mock();
        let d = tmp("optout");
        let t = Telemetry::new(cfg(&base), "desktop", "1.0.0", &d, false);
        assert!(t.crash_enabled() && t.usage_enabled());
        let st = t.set(Some(false), Some(false));
        assert_eq!(st, Status { crash_available: true, usage_available: true, crash: false, usage: false });
        assert!(!t.feature("terminal"));
        assert_eq!(t.started(), 0);
        assert!(t.flush(WAIT));
        assert!(t.js_error("boom", "").is_none());
        t.panic("boom", Some("src/lib.rs:1"));
        assert!(!d.join(PENDING_DIR).exists());
        // The choice persists.
        let t2 = Telemetry::new(cfg(&base), "desktop", "1.0.0", &d, false);
        assert!(!t2.crash_enabled() && !t2.usage_enabled());
        // Usage alone can be turned back on.
        t2.set(None, Some(true));
        assert!(!t2.crash_enabled() && t2.usage_enabled());
        // DO_NOT_TRACK-style kill switch beats the prefs.
        let k = Telemetry::new(cfg(&base), "desktop", "1.0.0", &d, true);
        assert!(!k.crash_enabled() && !k.usage_enabled());
        assert!(!k.status().usage, "Settings shows the kill switch as off");
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err(), "nothing sent while opted out");
        // Usage stats compiled out (ENABLED != true): no usage even with prefs on.
        let mut c = cfg(&base);
        c.usage = None;
        let u = Telemetry::new(c, "desktop", "1.0.0", &tmp("nousage"), false);
        assert!(!u.usage_enabled() && u.crash_enabled());
        assert!(!u.feature("terminal"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn usage_payloads() {
        let (base, rx) = mock();
        let d = tmp("usage");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(PREFS_FILE), r#"{"last_version":"1.0.0"}"#).unwrap();
        let t = Telemetry::new(cfg(&base), "desktop", "1.0.1", &d, false);
        assert_eq!(t.started(), 2);
        assert!(t.track("session_started", &json!({ "cwd": "/home/alice/secret" })));
        assert!(t.track("message_sent", &json!({ "text": "please refactor billing" })));
        assert!(t.track("message_sent", &Value::Null));
        assert!(t.track("model_selected", &json!({ "model": "acme/fast-5" })));
        assert!(!t.track("model_selected", &json!({ "model": "acme/fast-5" })), "same pick once per run");
        assert!(t.track("agent_connected", &json!({ "cli_version": "0.9.3" })));
        assert!(!t.track("agent_connected", &json!({ "cli_version": "0.9.3" })), "reconnects are not new");
        assert!(t.cli_version("0.9.3") && !t.cli_version("0.9.3"));
        assert!(t.feature("terminal") && !t.feature("terminal") && !t.feature("read_my_files"));
        assert!(!t.track("app_opened", &Value::Null), "the UI can't fake app events");
        assert!(!t.track("whatever", &Value::Null));
        assert!(t.flush(WAIT));
        let (path, _, body) = rx.recv_timeout(WAIT).unwrap();
        assert_eq!(path, "/batch/");
        assert!(!body.contains("alice") && !body.contains("refactor"));
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["api_key"], "phc_testkey");
        let evs = v["batch"].as_array().unwrap();
        let names: Vec<&str> = evs.iter().map(|e| e["event"].as_str().unwrap()).collect();
        assert_eq!(names, ["app_opened", "update_installed", "session_started", "model_selected", "agent_connected", "cli_version_detected", "feature_used", "message_sent"]);
        let id = evs[0]["distinct_id"].as_str().unwrap().to_string();
        assert_eq!(id.len(), 32);
        for e in evs {
            assert_eq!(e["distinct_id"], id.as_str());
            assert!(e["timestamp"].as_str().unwrap().ends_with('Z'));
            let p = &e["properties"];
            assert_eq!(p["source"], "studio");
            assert_eq!(p["app_version"], "1.0.1");
            assert_eq!(p["platform"], "desktop");
            assert_eq!(p["os"], std::env::consts::OS);
            assert_eq!(p["arch"], std::env::consts::ARCH);
            assert_eq!(p["$process_person_profile"], false);
            assert_eq!(p["$geoip_disable"], true);
            assert!(p.get("$ip").is_some_and(Value::is_null));
        }
        assert_eq!(evs[1]["properties"]["from"], "1.0.0");
        assert_eq!(evs[3]["properties"]["provider"], "acme");
        assert_eq!(evs[3]["properties"]["model"], "acme/fast-5");
        assert_eq!(evs[4]["properties"]["cli_version"], "0.9.3");
        assert_eq!(evs[5]["properties"]["version"], "0.9.3");
        assert_eq!(evs[6]["properties"]["feature"], "terminal");
        assert_eq!(evs[7]["properties"]["count"], 2);
        // Same install id next run; no second update_installed.
        let t2 = Telemetry::new(cfg(&base), "desktop", "1.0.1", &d, false);
        assert_eq!(t2.started(), 1);
        assert!(t2.flush(WAIT));
        let (_, _, body) = rx.recv_timeout(WAIT).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["batch"][0]["distinct_id"], id.as_str());
        // The phone only reports its connection and errors (its chats are counted by the desktop).
        let m = Telemetry::new(cfg(&base), "mobile", "1.0.1", &tmp("phone"), false);
        assert!(!m.track("message_sent", &Value::Null) && !m.track("session_started", &Value::Null) && !m.track("model_selected", &json!({ "model": "a" })));
        assert!(m.track("agent_connected", &Value::Null));
        assert_eq!(m.usage_event("app_opened", Default::default()).unwrap()["properties"]["platform"], if cfg!(target_os = "ios") { "ios" } else { "android" });
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn exceptions_are_scrubbed_usage_events() {
        let (base, rx) = mock();
        let d = tmp("exc");
        let t = Telemetry::new(cfg(&base), "desktop", "1.0.0", &d, false);
        let _ = t.js_error("TypeError: cannot open /home/alice/notes.md", "");
        let _ = t.js_error("AcpRpcError -32603", "");
        assert!(t.flush(WAIT));
        // The crash report and the batch arrive in either order.
        let mut batch = None;
        for _ in 0..3 {
            if let Ok((path, _, body)) = rx.recv_timeout(WAIT) {
                if path == "/batch/" {
                    batch = Some(body);
                    break;
                }
            }
        }
        let v: Value = serde_json::from_str(&batch.unwrap()).unwrap();
        let evs = v["batch"].as_array().unwrap();
        assert_eq!(evs[0]["event"], "$exception");
        assert_eq!(evs[0]["properties"]["$exception_type"], "TypeError");
        assert_eq!(evs[0]["properties"]["$exception_message"], "TypeError: cannot open <path>");
        assert_eq!(evs[1]["event"], "error");
        assert_eq!(evs[1]["properties"]["kind"], "acp_rpc");
        assert_eq!(evs[1]["properties"]["code"], -32603);
        assert!(!v.to_string().contains("alice"));
        // Crash reports off: no exceptions in usage stats either.
        t.set(Some(false), None);
        let _ = t.js_error("RangeError: other", "");
        assert_eq!(t.queued(), 0);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn crash_payloads() {
        let (base, rx) = mock();
        let d = tmp("crash");
        let t = Telemetry::new(cfg(&base), "mobile", "1.0.2", &d, false);
        let home = dirs_home().unwrap_or_else(|| "/home/x".into());
        t.panic(&format!("could not open {home}/proj/app.rs with key sk-proj-AAAAbbbbCCCC1234dddd"), Some("/home/runner/work/scs/src-tauri/src/gateway.rs:88"));
        let (path, headers, body) = rx.recv_timeout(WAIT).unwrap();
        assert_eq!(path, "/api/42/envelope/");
        let auth = &headers.iter().find(|h| h.0 == "x-sentry-auth").unwrap().1;
        assert!(auth.contains("sentry_key=pubkey"));
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 3);
        let ev: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(serde_json::from_str::<Value>(lines[0]).unwrap()["event_id"], ev["event_id"]);
        assert_eq!(serde_json::from_str::<Value>(lines[1]).unwrap()["type"], "event");
        assert_eq!(ev["release"], "supercharge-studio@1.0.2");
        assert_eq!(ev["level"], "fatal");
        assert_eq!(ev["tags"]["os"], std::env::consts::OS);
        assert_eq!(ev["tags"]["arch"], std::env::consts::ARCH);
        assert_eq!(ev["tags"]["app"], "mobile");
        assert_eq!(ev["contexts"]["app"]["app_version"], "1.0.2");
        let ex = &ev["exception"]["values"][0];
        assert_eq!(ex["type"], "panic");
        assert_eq!(ex["value"], "could not open <path> with key <redacted>");
        assert_eq!(ex["stacktrace"]["frames"][0]["filename"], "src-tauri/src/gateway.rs:88");
        assert!(!body.contains(&home) && !body.contains("sk-proj") && !body.contains("runner"));
        assert!(ev.get("user").is_none() && ev.get("server_name").is_none());
        // Delivered → not left on disk.
        assert_eq!(std::fs::read_dir(d.join(PENDING_DIR)).map(|r| r.count()).unwrap_or(0), 0);
        // JS errors: scrubbed message + bundle-only frames; duplicates are dropped.
        let stack = "TypeError: x is undefined\n    at render (tauri://localhost/assets/index-AbC.js:1:2345)\n    at https://evil.example/u/alice/page.js:9:9";
        t.js_error("TypeError: x is undefined", stack).unwrap().join().unwrap();
        assert!(t.js_error("TypeError: x is undefined", stack).is_none());
        let (_, _, body) = rx.recv_timeout(WAIT).unwrap();
        let ev: Value = serde_json::from_str(body.lines().nth(2).unwrap()).unwrap();
        assert_eq!(ev["level"], "error");
        assert_eq!(ev["platform"], "other");
        let frames = ev["exception"]["values"][0]["stacktrace"]["frames"].as_array().unwrap();
        assert!(frames.iter().any(|f| f["filename"] == "index-AbC.js"));
        assert!(!body.contains("evil.example") && !body.contains("alice"));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn undelivered_panics_are_sent_next_run() {
        // Nothing listens on this port: the report stays on disk.
        let dead = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let d = tmp("pending");
        let t = Telemetry::new(cfg(&dead), "desktop", "1.0.0", &d, false);
        t.panic("first", None);
        assert_eq!(std::fs::read_dir(d.join(PENDING_DIR)).unwrap().count(), 1);
        let (base, rx) = mock();
        let t2 = Telemetry::new(cfg(&base), "desktop", "1.0.0", &d, false);
        assert_eq!(t2.flush_pending(), 1);
        let (_, _, body) = rx.recv_timeout(WAIT).unwrap();
        assert!(body.contains("\"first\""));
        assert_eq!(std::fs::read_dir(d.join(PENDING_DIR)).unwrap().count(), 0);
        // Opting out drops what's pending without sending.
        t.panic("second", Some("src/a.rs:1"));
        let t3 = Telemetry::new(cfg(&dead), "desktop", "1.0.0", &d, false);
        t3.set(Some(false), None);
        assert!(!d.join(PENDING_DIR).exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn panic_hook_reports_real_panics() {
        let (base, rx) = mock();
        let d = tmp("hook");
        assert!(GLOBAL.set(Telemetry::new(cfg(&base), "server", "1.0.3", &d, false)).is_ok());
        install_panic_hook();
        let r = std::panic::catch_unwind(|| {
            let v: Vec<u8> = vec![];
            v[3]
        });
        assert!(r.is_err());
        let (_, _, body) = rx.recv_timeout(WAIT).unwrap();
        let ev: Value = serde_json::from_str(body.lines().nth(2).unwrap()).unwrap();
        assert_eq!(ev["level"], "fatal");
        assert_eq!(ev["tags"]["app"], "server");
        assert!(ev["exception"]["values"][0]["value"].as_str().unwrap().contains("index out of bounds"));
        assert!(ev["exception"]["values"][0]["stacktrace"]["frames"][0]["filename"].as_str().unwrap().contains("src/telemetry.rs:"));
        let _ = std::panic::take_hook();
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn js_hook_targets_the_command() {
        assert!(JS_HOOK.contains("telemetry_js_error") && JS_HOOK.contains("unhandledrejection"));
        // Agent errors carry agent text (it can echo a prompt or config): code only.
        assert!(JS_HOOK.contains(r#"s("AcpRpcError "+r.code,"")"#));
    }

    #[test]
    fn js_hook_drops_resize_observer_loop_notices() {
        // Browsers raise "ResizeObserver loop completed with undelivered notifications" as a
        // window error when a layout settles over two frames; it is harmless noise. It is
        // dropped before the per-page cap so it cannot crowd out real errors.
        let drop = JS_HOOK.find("ResizeObserver loop").unwrap();
        assert!(drop < JS_HOOK.find("n++>9").unwrap());
        assert!(benign_js_error("ResizeObserver loop completed with undelivered notifications."));
        assert!(benign_js_error("ResizeObserver loop limit exceeded"));
        assert!(!benign_js_error("TypeError: Cannot read properties of undefined (reading '0')"));
    }
}
