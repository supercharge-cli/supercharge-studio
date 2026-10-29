//! Crash reports and anonymous usage stats, shared by the desktop app, the phone app and the
//! headless server (included with `#[path]`).
//!
//! * Compiled in only when the build sets `SENTRY_DSN` (crash reports) and/or
//!   `SUPERCHARGE_TELEMETRY_POSTHOG_API_KEY` + `SUPERCHARGE_TELEMETRY_POSTHOG_ENABLED=true`
//!   (usage stats). Local, fork and PR builds have neither: everything here is a no-op.
//! * The user can turn either off in Settings; `DO_NOT_TRACK=1` or
//!   `SUPERCHARGE_TELEMETRY_DISABLED=1` turn both off for a run.
//! * Crash reports: Rust panics and uncaught web UI errors, as a minimal envelope (message,
//!   panic location, version, OS, arch, release). Messages are scrubbed of paths, the home
//!   directory, URLs, e-mail addresses, keys/tokens and long quoted text (which is where prompts
//!   or chat content would show up), then truncated.
//! * Usage stats: `app_start`, `session_start`, `feature_used` (a fixed feature name only) and
//!   `update_installed`, with a random install id. No content, paths or account data.
//! * Plain HTTPS POSTs through ureq on a background thread; failures are silent.

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
        let enabled = build_env(option_env!("SUPERCHARGE_TELEMETRY_POSTHOG_ENABLED")).is_some_and(|v| v.eq_ignore_ascii_case("true"));
        let usage = match (enabled, build_env(option_env!("SUPERCHARGE_TELEMETRY_POSTHOG_API_KEY"))) {
            (true, Some(key)) => {
                let host = build_env(option_env!("SUPERCHARGE_TELEMETRY_POSTHOG_HOST")).unwrap_or(DEFAULT_USAGE_HOST);
                Some(UsageTarget { url: format!("{}/i/v0/e/", host.trim_end_matches('/')), key: key.to_string() })
            }
            _ => None,
        };
        Config { crash, usage }
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

fn http() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("supercharge-studio/", env!("CARGO_PKG_VERSION")))
        .redirects(0)
        .build()
}

fn post(url: &str, headers: &[(&str, &str)], body: &str) -> bool {
    let mut req = http().post(url);
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
        };
        t.refresh();
        if dirty && (t.cfg.crash.is_some() || t.cfg.usage.is_some()) {
            t.save();
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
        self.status()
    }

    fn base_props(&self) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert("app".into(), json!(self.component));
        m.insert("version".into(), json!(self.version));
        m.insert("os".into(), json!(std::env::consts::OS));
        m.insert("arch".into(), json!(std::env::consts::ARCH));
        // Anonymous events: no person profile, no IP geolocation.
        m.insert("$process_person_profile".into(), json!(false));
        m.insert("$geoip_disable".into(), json!(true));
        m
    }

    /// The JSON body for a usage event (None when usage stats are off or the name isn't allowed).
    pub fn usage_body(&self, event: &str, extra: &[(&str, &str)]) -> Option<String> {
        let target = self.cfg.usage.as_ref()?;
        if !self.usage_enabled() || !USAGE_EVENTS.contains(&event) {
            return None;
        }
        let mut props = self.base_props();
        for (k, v) in extra {
            props.insert((*k).into(), json!(v));
        }
        let id = self.prefs.lock().unwrap().install_id.clone();
        Some(json!({ "api_key": target.key, "event": event, "distinct_id": id, "timestamp": now_secs(), "properties": props }).to_string())
    }

    fn event_with(&self, event: &str, extra: &[(&str, &str)]) -> Option<std::thread::JoinHandle<()>> {
        let body = self.usage_body(event, extra)?;
        let url = self.cfg.usage.as_ref()?.url.clone();
        std::thread::Builder::new().name("telemetry".into()).spawn(move || {
            post(&url, &[("Content-Type", "application/json")], &body);
        }).ok()
    }

    /// Send a usage event (no extra properties) in the background; the thread is returned for tests.
    pub fn send_event(&self, event: &str) -> Option<std::thread::JoinHandle<()>> {
        self.event_with(event, &[])
    }

    /// `feature_used` once per run per feature; only names from [`FEATURES`].
    pub fn feature(&self, name: &'static str) -> Option<std::thread::JoinHandle<()>> {
        if !self.usage_enabled() || !FEATURES.contains(&name) || !self.seen.lock().unwrap().insert(format!("f:{name}")) {
            return None;
        }
        self.event_with("feature_used", &[("feature", name)])
    }

    /// Startup: `app_start`, then `update_installed` if the version changed since the last run.
    pub fn started(&self) -> Vec<std::thread::JoinHandle<()>> {
        let prev = {
            let mut p = self.prefs.lock().unwrap();
            std::mem::replace(&mut p.last_version, self.version.to_string())
        };
        if prev != self.version && (self.cfg.crash.is_some() || self.cfg.usage.is_some()) {
            self.save();
        }
        let mut out = vec![];
        out.extend(self.event_with("app_start", &[]));
        if !prev.is_empty() && prev != self.version {
            out.extend(self.event_with("update_installed", &[("from", prev.as_str())]));
        }
        out
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
pub const USAGE_EVENTS: &[&str] = &["app_start", "session_start", "feature_used", "update_installed"];
/// Feature names for `feature_used` (nothing else is accepted).
pub const FEATURES: &[&str] = &[
    "terminal", "side_browser", "git_commit", "git_push", "pull_request", "worktree", "checkpoint", "phone_pairing", "public_relay",
    "provider_setup", "export_chat", "attachment", "project_rules", "stdio_transport", "cli_install",
];

fn dirs_home() -> Option<String> {
    std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok()).filter(|h| h.len() > 1)
}

// ---- global instance --------------------------------------------------------------------

/// Set up once at startup: load prefs, install the panic hook, send `app_start`/pending reports.
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
    if t.crash_enabled() || t.usage_enabled() || t.cfg.crash.is_some() {
        let _ = std::thread::Builder::new().name("telemetry".into()).spawn(move || {
            t.flush_pending();
            for h in t.started() {
                let _ = h.join();
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
pub const JS_HOOK: &str = r#"(()=>{let n=0;const s=(m,k)=>{if(n++>9)return;try{window.__TAURI_INTERNALS__.invoke("telemetry_js_error",{message:String(m||"Error").slice(0,1000),stack:String(k||"").slice(0,6000)}).catch(()=>{})}catch(_){}};addEventListener("error",e=>s(e.message,e.error&&e.error.stack));addEventListener("unhandledrejection",e=>{const r=e.reason;if(r&&typeof r.code=="number"&&r.name=="AcpRpcError")return s("AcpRpcError "+r.code,"");s(r&&r.message||r,r&&r.stack)})})()"#;

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
            usage: Some(UsageTarget { url: format!("{base}/i/v0/e/"), key: "phc_testkey".into() }),
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
    fn builds_without_secrets_are_off() {
        // Local / fork / PR builds: no secrets in the build environment.
        if option_env!("SENTRY_DSN").unwrap_or("").is_empty() && option_env!("SUPERCHARGE_TELEMETRY_POSTHOG_API_KEY").unwrap_or("").is_empty() {
            let c = Config::from_build();
            assert!(c.crash.is_none() && c.usage.is_none());
            let d = tmp("off");
            let t = Telemetry::new(c, "desktop", "1.0.0", &d, false);
            assert!(!t.crash_enabled() && !t.usage_enabled());
            assert_eq!(t.status(), Status { crash_available: false, usage_available: false, crash: false, usage: false });
            assert!(t.usage_body("app_start", &[]).is_none());
            assert!(t.feature("terminal").is_none());
            assert!(t.started().is_empty());
            t.panic("boom", None);
            assert!(t.js_error("x", "").is_none());
            assert!(!d.exists(), "nothing is written when telemetry isn't compiled in");
        }
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
        assert!(t.feature("terminal").is_none());
        assert!(t.started().is_empty());
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
        assert!(u.feature("terminal").is_none());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn usage_payloads() {
        let (base, rx) = mock();
        let d = tmp("usage");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(PREFS_FILE), r#"{"last_version":"1.0.0"}"#).unwrap();
        let t = Telemetry::new(cfg(&base), "desktop", "1.0.1", &d, false);
        for h in t.started() {
            h.join().unwrap();
        }
        let mut got = vec![rx.recv_timeout(WAIT).unwrap(), rx.recv_timeout(WAIT).unwrap()];
        got.sort_by_key(|g| g.2.contains("update_installed"));
        let (path, _, body) = &got[0];
        assert_eq!(path, "/i/v0/e/");
        let v: Value = serde_json::from_str(body).unwrap();
        assert_eq!(v["event"], "app_start");
        assert_eq!(v["api_key"], "phc_testkey");
        let id = v["distinct_id"].as_str().unwrap().to_string();
        assert_eq!(id.len(), 32);
        assert_eq!(v["properties"]["version"], "1.0.1");
        assert_eq!(v["properties"]["os"], std::env::consts::OS);
        assert_eq!(v["properties"]["arch"], std::env::consts::ARCH);
        assert_eq!(v["properties"]["$process_person_profile"], false);
        let u: Value = serde_json::from_str(&got[1].2).unwrap();
        assert_eq!(u["event"], "update_installed");
        assert_eq!(u["properties"]["from"], "1.0.0");
        // Only allowed names, once per run.
        t.feature("terminal").unwrap().join().unwrap();
        assert!(t.feature("terminal").is_none());
        assert!(t.feature("read_my_files").is_none());
        let (_, _, body) = rx.recv_timeout(WAIT).unwrap();
        let f: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(f["event"], "feature_used");
        assert_eq!(f["properties"]["feature"], "terminal");
        assert_eq!(f["distinct_id"], id.as_str());
        assert!(t.usage_body("something_else", &[]).is_none());
        // Same install id next run; no second update_installed.
        let t2 = Telemetry::new(cfg(&base), "desktop", "1.0.1", &d, false);
        let hs = t2.started();
        assert_eq!(hs.len(), 1);
        for h in hs {
            h.join().unwrap();
        }
        let (_, _, body) = rx.recv_timeout(WAIT).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["distinct_id"], id.as_str());
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
}
