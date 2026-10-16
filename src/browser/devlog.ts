/** Dev mode: console and network entries captured in the side browser page (see src-tauri/src/browser_init.js). */
export type LogLevel = "log" | "info" | "warn" | "error" | "debug";
export type DevLog = { seq: number; t: number; level: LogLevel; text: string; kind?: "uncaught" | "rejection"; source?: string; page?: string };
export type DevNet = { seq: number; t: number; method: string; url: string; status: number; ms?: number; error?: string; type?: string; page?: string };
export type DevTake = { id: string; seq: number; logs: DevLog[]; net: DevNet[] };

const LEVELS = new Set(["log", "info", "warn", "error", "debug"]);
const MAX = 1000;

/** Page expression returning entries newer than `logSince` / `netSince` (null when capture is missing). */
export const takeExpr = (logSince: number, netSince: number) =>
  `(() => { const d = window.__scDev; if (!d) return null; return { id: d.id, seq: d.seq, logs: d.logs.filter((e) => e.seq > ${logSince | 0}), net: d.net.filter((e) => e.seq > ${netSince | 0}) }; })()`;

/** Validate what the page returned (it is page-controlled data). */
export function parseTake(raw: unknown): DevTake | null {
  const r = raw as any;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !Array.isArray(r.logs) || !Array.isArray(r.net)) return null;
  const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
  const s = (v: unknown, max = 2000) => String(v ?? "").slice(0, max);
  return {
    id: r.id.slice(0, 40),
    seq: n(r.seq),
    logs: r.logs.filter((e: any) => e && typeof e === "object").map((e: any) => ({
      seq: n(e.seq), t: n(e.t), level: (LEVELS.has(e.level) ? e.level : "log") as LogLevel, text: s(e.text),
      ...(e.kind === "uncaught" || e.kind === "rejection" ? { kind: e.kind } : {}), ...(e.source ? { source: s(e.source, 500) } : {}),
    })),
    net: r.net.filter((e: any) => e && typeof e === "object").map((e: any) => ({
      seq: n(e.seq), t: n(e.t), method: s(e.method, 12).toUpperCase() || "GET", url: s(e.url), status: n(e.status),
      ...(e.ms != null ? { ms: n(e.ms) } : {}), ...(e.error ? { error: s(e.error, 300) } : {}), ...(e.type ? { type: s(e.type, 30) } : {}),
    })),
  };
}

/** Accumulates entries across polls and page loads. Network entries are updated in place when they finish. */
export class DevStore {
  logs: DevLog[] = [];
  net: DevNet[] = [];
  private page = "";
  private logSeq = 0;
  private netSeq = 0;
  /** Cursor to ask the page with. Pending requests (status 0, no time) are asked for again. */
  cursor() {
    const pending = this.net.filter((e) => e.page === this.page && !e.status && e.ms == null && !e.error);
    return { logSince: this.logSeq, netSince: pending.length ? Math.min(...pending.map((e) => e.seq)) - 1 : this.netSeq };
  }
  merge(take: DevTake | null) {
    if (!take) return false;
    if (take.id !== this.page || take.seq < this.logSeq) { this.page = take.id; this.logSeq = 0; this.netSeq = 0; }
    let changed = false;
    for (const e of take.logs) if (e.seq > this.logSeq) { this.logs.push({ ...e, page: take.id }); this.logSeq = e.seq; changed = true; }
    for (const e of take.net) {
      const i = this.net.findIndex((x) => x.page === take.id && x.seq === e.seq);
      if (i >= 0) { if (JSON.stringify({ ...this.net[i], page: undefined }) !== JSON.stringify({ ...e, page: undefined })) { this.net[i] = { ...e, page: take.id }; changed = true; } }
      else { this.net.push({ ...e, page: take.id }); changed = true; }
      this.netSeq = Math.max(this.netSeq, e.seq);
    }
    if (this.logs.length > MAX) this.logs.splice(0, this.logs.length - MAX);
    if (this.net.length > MAX) this.net.splice(0, this.net.length - MAX);
    return changed;
  }
  clear() { this.logs = []; this.net = []; }
  /** Global position for `since` queries: index-based so it survives page loads. */
  console(o: { level?: string; since?: number; limit?: number } = {}) {
    const all = this.logs.map((e, i) => ({ ...e, seq: i + 1 }));
    return filterLogs(all, o.level).filter((e) => e.seq > (o.since ?? 0)).slice(-(o.limit ?? 100));
  }
  network(o: { failed_only?: boolean; since?: number; limit?: number; filter?: string } = {}) {
    return this.net.map((e, i) => ({ ...e, seq: i + 1 }))
      .filter((e) => e.seq > (o.since ?? 0) && (!o.failed_only || failed(e)) && (!o.filter || e.url.includes(o.filter)))
      .slice(-(o.limit ?? 100));
  }
}

export const failed = (e: DevNet) => (e.status === 0 && (e.ms != null || !!e.error)) || e.status >= 400;
export const filterLogs = <T extends { level: string }>(logs: T[], level?: string) =>
  !level || level === "all" ? logs : level === "warn" ? logs.filter((e) => e.level === "warn" || e.level === "error") : logs.filter((e) => e.level === level);

const hhmmss = (t: number) => new Date(t).toTimeString().slice(0, 8);
export const formatLogs = (logs: DevLog[]) => logs.map((e) => `${hhmmss(e.t)} [${e.level}] ${e.text}${e.source ? ` (${e.source})` : ""}`).join("\n");
export const formatNet = (net: DevNet[]) => net.map((e) => `${hhmmss(e.t)} ${e.method} ${e.status || (e.error ? "ERR" : "…")} ${e.url}${e.ms != null ? ` ${e.ms}ms` : ""}${e.error ? ` (${e.error})` : ""}`).join("\n");
