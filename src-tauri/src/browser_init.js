// Injected into every page of the side browser before page scripts run (dev mode capture).
// Console messages, uncaught errors, unhandled rejections and fetch/XHR requests go into a
// ring buffer on the page; the app reads it with browser_eval (pages get no app IPC).
(() => {
  if (window.__scDev) return;
  const MAX = 500, d = (window.__scDev = { id: Math.random().toString(36).slice(2), seq: 0, logs: [], net: [] });
  const push = (arr, e) => { e.seq = ++d.seq; e.t = Date.now(); arr.push(e); if (arr.length > MAX) arr.shift(); };
  const str = (v) => {
    try {
      if (v instanceof Error) return (v.stack || String(v)).slice(0, 2000);
      if (typeof v === "string") return v.slice(0, 2000);
      return JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x))?.slice(0, 2000) ?? String(v);
    } catch { return String(v); }
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level];
    console[level] = function (...a) {
      try { push(d.logs, { level, text: a.map(str).join(" ") }); } catch {}
      return orig.apply(this, a);
    };
  }
  addEventListener("error", (e) => {
    if (e.target && e.target !== window && e.target.tagName) {
      push(d.logs, { level: "error", text: "Failed to load " + e.target.tagName.toLowerCase() + ": " + (e.target.src || e.target.href || "") });
      return;
    }
    push(d.logs, { level: "error", kind: "uncaught", text: str(e.error || e.message), source: e.filename ? e.filename + ":" + e.lineno + ":" + e.colno : undefined });
  }, true);
  addEventListener("unhandledrejection", (e) => push(d.logs, { level: "error", kind: "rejection", text: "Unhandled rejection: " + str(e.reason) }));
  const net = (method, url, start) => {
    const e = { method: String(method || "GET").toUpperCase(), url: String(url), status: 0 };
    push(d.net, e);
    return (status, err) => { e.status = status; e.ms = Math.round(performance.now() - start); if (err) e.error = err; };
  };
  const f = window.fetch;
  if (f) window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input && (input.url || String(input));
    const done = net((init && init.method) || (input && input.method), new URL(url, location.href).href, performance.now());
    return f.apply(this, arguments).then((r) => { done(r.status); return r; }, (err) => { done(0, String(err && err.message || err)); throw err; });
  };
  const X = window.XMLHttpRequest && XMLHttpRequest.prototype;
  if (X) {
    const open = X.open, send = X.send;
    X.open = function (m, u) { this.__sc = [m, u]; return open.apply(this, arguments); };
    X.send = function () {
      if (this.__sc) {
        const done = net(this.__sc[0], new URL(this.__sc[1], location.href).href, performance.now());
        this.addEventListener("loadend", () => done(this.status, this.status ? undefined : "network error"));
      }
      return send.apply(this, arguments);
    };
  }
  // Document, scripts, images, CSS: resource timing (status where the engine reports it).
  try {
    new PerformanceObserver((l) => {
      for (const r of l.getEntries()) {
        if (r.initiatorType === "fetch" || r.initiatorType === "xmlhttprequest") continue;
        push(d.net, { method: "GET", url: r.name, status: r.responseStatus || 0, ms: Math.round(r.duration), type: r.initiatorType });
      }
    }).observe({ type: "resource", buffered: true });
  } catch {}
})();
