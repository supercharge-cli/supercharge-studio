/**
 * ACP JSON-RPC client for `supercharge agent serve` (ws://HOST/ws?server-key=TOKEN)
 * or a stdio child provided by the desktop shell.
 *
 * Features: request id tracking + timeouts, auto-reconnect with exponential
 * backoff, session/update dispatch, agent→client requests (permissions, fs),
 * cancel, and extension method discovery.
 */
import { LegacyNotificationDedup, canonicalName, legacyName } from "./legacyNames";
import type {
  InitializeResult,
  JsonRpcId,
  JsonRpcMessage,
  NewSessionResult,
  PermissionOutcome,
  PermissionRequest,
  PlanApprovalRequest,
  PlanApprovalResult,
  SessionUpdate,
  StopReason,
} from "./types";
import { Transport, WebSocketCtor, WebSocketTransport } from "./transport";

export type { SessionUpdate } from "./types";

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export class AcpRpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export class AcpTimeoutError extends Error {
  constructor(public method: string, ms: number) {
    super(`ACP request "${method}" timed out after ${ms}ms`);
    this.name = "AcpTimeoutError";
  }
}

type Pending = {
  method: string;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Handler for an agent → client request. Return value is the JSON-RPC result. */
export type RequestHandler = (params: any) => unknown | Promise<unknown>;

export type ReconnectOptions = {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  maxAttempts?: number; // Infinity by default
};

export type AcpClientOptions = {
  /** WebSocket URL, e.g. ws://127.0.0.1:2419/ws?server-key=dev-secret */
  url?: string;
  /** Custom transport factory (stdio, tests). Overrides url. */
  transportFactory?: () => Transport;
  /** WebSocket constructor override (tests / non-browser runtimes). */
  WebSocketImpl?: WebSocketCtor;
  clientName?: string;
  clientVersion?: string;
  /** Extra `_meta` advertised in clientCapabilities (e.g. client-side extension methods). */
  clientMeta?: Record<string, unknown>;
  /** Default per-request timeout. `session/prompt` uses promptTimeoutMs. */
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  reconnect?: ReconnectOptions;
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  onNotification?: (method: string, params: unknown) => void;
  /** Called for session/request_permission. Defaults to "cancelled". */
  onPermissionRequest?: (req: PermissionRequest) => Promise<PermissionOutcome> | PermissionOutcome;
  /** Called when the agent finishes a plan and waits for approval. Defaults to approved. */
  onPlanApproval?: (req: PlanApprovalRequest) => Promise<PlanApprovalResult> | PlanApprovalResult;
  onStateChange?: (state: ConnectionState, info?: { attempt?: number; delayMs?: number; error?: string }) => void;
  /** Called after a successful automatic reconnect + re-initialize. */
  onReconnected?: (init: InitializeResult) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** Send a lightweight ping this often while open so dead sockets are found fast (0 = off). */
  heartbeatMs?: number;
  /** How long a ping may take before the socket is treated as dead. */
  heartbeatTimeoutMs?: number;
};

/** Heartbeat method. Any reply, even "method not found", proves the link is alive. */
export const PING_METHOD = "_supercharge/ping";

export type ExtensionInfo = {
  /** Extension method names (leading underscore), e.g. "_supercharge/fs/tree". */
  methods: string[];
  /** Namespaced capability flags advertised in `_meta` (keys of the form "ns/feature"). */
  features: string[];
  /** Extension notifications (leading underscore) actually received from the agent. */
  notifications: string[];
  /** Raw _meta capability blocks advertised by the agent. */
  meta: Record<string, unknown>;
};

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

export class AcpClient {
  private transport: Transport | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private handlers = new Map<string, RequestHandler>();
  private opts: AcpClientOptions;
  private manualClose = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnecting = false;
  private _state: ConnectionState = "idle";
  private dedup = new LegacyNotificationDedup();

  initResult: InitializeResult | null = null;
  private initWaiters: ((r: InitializeResult | null) => void)[] = [];
  extensions: ExtensionInfo = { methods: [], features: [], notifications: [], meta: {} };

  constructor(opts: AcpClientOptions) {
    if (!opts.url && !opts.transportFactory) throw new Error("AcpClient needs url or transportFactory");
    this.opts = opts;
    this.handlers.set("session/request_permission", async (params: PermissionRequest) => {
      const outcome = this.opts.onPermissionRequest
        ? await this.opts.onPermissionRequest(params)
        : ({ outcome: "cancelled" } as PermissionOutcome);
      return { outcome };
    });
    this.handlers.set("_supercharge/exit_plan_mode", async (params: PlanApprovalRequest) => {
      if (!this.opts.onPlanApproval) return { outcome: "approved" };
      const result = await this.opts.onPlanApproval(params ?? { sessionId: "" });
      return { outcome: result.outcome, ...(result.feedback ? { feedback: result.feedback } : {}) };
    });
  }

  get state() {
    return this._state;
  }

  private setState(s: ConnectionState, info?: { attempt?: number; delayMs?: number; error?: string }) {
    this._state = s;
    if (s === "closed") this.flushInit();
    this.opts.onStateChange?.(s, info);
  }

  /** Register a handler for an agent → client request method. */
  handle(method: string, handler: RequestHandler) {
    this.handlers.set(canonicalName(method), handler);
  }

  private makeTransport(): Transport {
    if (this.opts.transportFactory) return this.opts.transportFactory();
    return new WebSocketTransport(this.opts.url!, this.opts.WebSocketImpl);
  }

  async connect(): Promise<void> {
    this.manualClose = false;
    this.clearReconnect();
    this.setState(this._state === "reconnecting" ? "reconnecting" : "connecting");
    const t = this.makeTransport();
    this.dedup.reset();
    t.onMessage = (d) => this.handleRaw(d);
    t.onClose = (reason) => this.handleTransportClose(t, reason);
    await t.open();
    this.transport = t;
    this.attempt = 0;
    this.setState("open");
    this.startHeartbeat();
    this.opts.onOpen?.();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    const every = this.opts.heartbeatMs ?? 0;
    if (every > 0) this.heartbeat = setInterval(() => void this.checkAlive(), every);
  }
  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Ping the other side. Resolves true if it answered in time; otherwise drops the
   * socket (which starts a reconnect) and resolves false.
   */
  async checkAlive(timeoutMs = this.opts.heartbeatTimeoutMs ?? 4000): Promise<boolean> {
    const t = this.transport;
    if (!t || this._state !== "open") return false;
    try {
      await this.request(PING_METHOD, {}, { timeoutMs });
      return true;
    } catch (e) {
      if (!(e instanceof AcpTimeoutError) && !/Not connected|Connection/.test(String((e as Error)?.message))) return true; // an error reply still means it's alive
      if (this.transport !== t) return false;
      try { t.close(); } catch { /* already gone */ }
      this.handleTransportClose(t, "no answer to ping");
      return false;
    }
  }

  /**
   * The app came back to the foreground or the network changed: check the link now and,
   * if it is down, reconnect at once instead of waiting out the backoff.
   */
  reconnectNow(): void {
    if (this.manualClose) return;
    this.attempt = 0;
    if (this._state === "open") { void this.checkAlive(2500); return; }
    if (this.reconnecting) return; // an attempt is already running
    if (this._state === "reconnecting" || this.reconnectTimer) {
      this.clearReconnect();
      void this.runReconnect();
    }
  }

  close() {
    this.manualClose = true;
    this.clearReconnect();
    this.stopHeartbeat();
    const t = this.transport;
    this.transport = null;
    t?.close();
    this.failAll(new Error("Connection closed"));
    this.setState("closed");
    this.opts.onClose?.();
  }

  private clearReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private failAll(err: Error) {
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private handleTransportClose(t: Transport, reason?: string) {
    if (this.transport !== t) return;
    this.transport = null;
    this.stopHeartbeat();
    this.failAll(new Error(`Connection lost${reason ? `: ${reason}` : ""}`));
    this.opts.onClose?.();
    if (this.manualClose) return;
    this.scheduleReconnect(reason);
  }

  /** Delay for a given (1-based) attempt. Exposed for tests. */
  backoffDelay(attempt: number): number {
    const r = this.opts.reconnect ?? {};
    const initial = r.initialDelayMs ?? 500;
    const max = r.maxDelayMs ?? 15000;
    const factor = r.factor ?? 2;
    return Math.min(max, initial * Math.pow(factor, attempt - 1));
  }

  private scheduleReconnect(error?: string) {
    const r = this.opts.reconnect ?? {};
    if (r.enabled === false) {
      this.setState("closed", { error });
      return;
    }
    const maxAttempts = r.maxAttempts ?? Infinity;
    if (this.attempt >= maxAttempts) {
      this.setState("closed", { error: error ?? "max reconnect attempts reached" });
      return;
    }
    this.attempt++;
    const delayMs = this.backoffDelay(this.attempt);
    this.setState("reconnecting", { attempt: this.attempt, delayMs, error });
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.runReconnect(); }, delayMs);
  }

  private async runReconnect() {
    if (this.manualClose || this.reconnecting) return;
    this.reconnecting = true;
    this._state = "reconnecting";
    try {
      await this.connect();
      const init = await this.initialize();
      this.opts.onReconnected?.(init);
    } catch (e: any) {
      if (!this.manualClose && !this.transport) { this.reconnecting = false; this.scheduleReconnect(e?.message); }
      else if (this.transport && !this.manualClose) { const t = this.transport; try { t.close(); } catch { /* */ } this.reconnecting = false; this.handleTransportClose(t, e?.message); }
    } finally {
      this.reconnecting = false;
    }
  }

  private handleRaw(raw: string) {
    // One frame is normally one JSON object; tolerate NDJSON batches.
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (Array.isArray(msg)) (msg as JsonRpcMessage[]).forEach((m) => this.dispatch(m));
      else this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage) {
    const hasId = msg.id !== undefined && msg.id !== null;
    // Response
    if (hasId && !msg.method && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id!);
      if (!p) return;
      this.pending.delete(msg.id!);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new AcpRpcError(msg.error.code, rpcErrorMessage(msg.error), msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    // Agent → client request: legacy and `_supercharge/` names reach the same handler.
    if (hasId) {
      this.noteExtension(canonicalName(msg.method));
      void this.answerRequest(msg.id!, canonicalName(msg.method), msg.params);
      return;
    }
    // Dual-sent notifications: skip the legacy copy of one already handled.
    if (!this.dedup.accept(msg.method, msg.params)) return;
    const method = canonicalName(msg.method);
    this.noteExtension(method);
    // Notification
    if (msg.method === "session/update") {
      const sid = msg.params?.sessionId ?? "";
      const update = (msg.params?.update ?? msg.params) as SessionUpdate;
      if (update && typeof update.sessionUpdate === "string") this.opts.onUpdate?.(sid, update);
      return;
    }
    this.opts.onNotification?.(method, msg.params);
  }

  private noteExtension(method: string) {
    if (method.startsWith("_") && !this.extensions.notifications.includes(method)) {
      this.extensions.notifications = [...this.extensions.notifications, method].sort();
    }
  }

  private async answerRequest(id: JsonRpcId, method: string, params: unknown) {
    const h = this.handlers.get(method);
    let reply: JsonRpcMessage;
    if (!h) {
      reply = { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    } else {
      try {
        const result = await h(params);
        reply = { jsonrpc: "2.0", id, result: result ?? null };
      } catch (e: any) {
        reply = { jsonrpc: "2.0", id, error: { code: e?.code ?? -32603, message: e?.message ?? String(e) } };
      }
    }
    try {
      this.transport?.send(JSON.stringify(reply));
    } catch {
      /* connection dropped; agent will see the request as abandoned */
    }
  }

  request<T = any>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const t = this.transport;
    if (!t || this._state !== "open") return Promise.reject(new Error("Not connected"));
    const id = this.nextId++;
    const timeoutMs =
      opts?.timeoutMs ??
      (method === "session/prompt" ? this.opts.promptTimeoutMs ?? 0 : this.opts.requestTimeoutMs ?? 30000);
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { method, resolve, reject };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new AcpTimeoutError(method, timeoutMs));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      try {
        t.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e: any) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Number of in-flight requests (for tests / UI). */
  get pendingCount() {
    return this.pending.size;
  }

  notify(method: string, params?: unknown) {
    try {
      this.transport?.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    } catch {
      /* ignore */
    }
  }

  async initialize(): Promise<InitializeResult> {
    const res = await this.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: this.opts.clientMeta
        ? { ...CLIENT_CAPABILITIES, _meta: this.opts.clientMeta }
        : CLIENT_CAPABILITIES,
      clientInfo: {
        name: this.opts.clientName ?? "supercharge-studio",
        title: "Supercharge Studio",
        version: this.opts.clientVersion ?? "0.1.0",
      },
    });
    this.initResult = res;
    this.extensions = discoverExtensions(res);
    this.flushInit();
    return res;
  }

  /**
   * The initialize result once the handshake is done (at once if it already is), or null if
   * the client closes first. Callers that read agent capabilities (e.g. whether the agent takes
   * HTTP MCP servers) must wait for this: before it, initResult is still null.
   */
  initialized(): Promise<InitializeResult | null> {
    if (this.initResult || this._state === "closed") return Promise.resolve(this.initResult);
    return new Promise((r) => this.initWaiters.push(r));
  }

  private flushInit() {
    const w = this.initWaiters;
    this.initWaiters = [];
    for (const r of w) r(this.initResult);
  }

  authenticate(methodId: string) {
    return this.request("authenticate", { methodId });
  }

  newSession(cwd: string, meta?: Record<string, unknown>, mcpServers: unknown[] = []) {
    const r = this.request<NewSessionResult>("session/new", {
      cwd,
      mcpServers,
      ...(meta ? { _meta: meta } : {}),
    });
    // Anonymous "session_start" usage event (the app decides whether it is sent at all).
    r.then(() => (globalThis as any).__TAURI_INTERNALS__?.invoke("telemetry_event", { name: "session_start" }), () => {});
    return r;
  }

  /** Requires agentCapabilities.sessionCapabilities.list */
  listSessions(params: Record<string, unknown> = {}) {
    return this.request<{ sessions: { sessionId: string; cwd?: string; title?: string; updatedAt?: string }[] }>("session/list", params);
  }

  /** Requires agentCapabilities.sessionCapabilities.resume (no history replay). */
  resumeSession(sessionId: string, cwd: string, mcpServers: unknown[] = []) {
    return this.request("session/resume", { sessionId, cwd, mcpServers });
  }

  /** Requires agentCapabilities.sessionCapabilities.close */
  closeSession(sessionId: string) {
    return this.request("session/close", { sessionId });
  }

  sessionCapability(name: "list" | "resume" | "close"): boolean {
    const sc = (this.initResult?.agentCapabilities as any)?.sessionCapabilities;
    return !!(sc && sc[name] != null);
  }

  loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []) {
    return this.request("session/load", { sessionId, cwd, mcpServers });
  }

  /** Send a prompt. `extra` carries resource links / embedded files from @ mentions. */
  async prompt(sessionId: string, text: string, extra: unknown[] = []): Promise<{ stopReason: StopReason }> {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }, ...extra] });
  }

  cancel(sessionId: string) {
    this.notify("session/cancel", { sessionId });
  }

  setConfigOption(sessionId: string, configId: string, value: string) {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  setMode(sessionId: string, modeId: string) {
    return this.request("session/set_mode", { sessionId, modeId });
  }

  hasExtension(method: string) {
    const m = method.startsWith("_") ? method : `_${method}`;
    return this.extensions.methods.includes(m);
  }

  /**
   * Memory upkeep (`_supercharge/memory/flush|dream|rewrite|forget`, params use `sessionId`).
   * CLIs before 1.3.47 only know the pre-rename name: retry it once on method-not-found.
   */
  async memory<T = any>(kind: "flush" | "dream" | "rewrite" | "forget", params: Record<string, unknown>): Promise<T> {
    const m = `_supercharge/memory/${kind}`;
    try {
      return await this.request<T>(m, params);
    } catch (e) {
      if (!(e instanceof AcpRpcError) || e.code !== -32601) throw e;
      return this.request<T>(legacyName(m), params);
    }
  }

  /** Call an advertised extension method (name with or without leading "_"). */
  ext<T = any>(method: string, params?: unknown) {
    const m = method.startsWith("_") ? method : `_${method}`;
    return this.request<T>(m, params);
  }
}

/** Agents often send a generic message ("Internal error") with the real cause in `data`. */
export function rpcErrorMessage(e: { message?: string; data?: unknown }): string {
  const msg = e.message || "Error";
  const data = typeof e.data === "string" ? e.data : (e.data as any)?.message;
  if (typeof data === "string" && data && !msg.includes(data)) return `${msg}: ${data}`;
  return msg;
}

/** True when an error looks like a missing / invalid model-provider credential. */
export function isAuthError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /\b401\b|unauthori[sz]ed|invalid or expired credentials|auth_required/i.test(m) || (e as any)?.code === -32000;
}

/** True when the provider rejected the model id (unknown / unsupported model). */
export function isModelError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /no upstream owns model|model[^\n]{0,40}(not found|not supported|does not exist|unknown)|unknown model|invalid model/i.test(m);
}

/**
 * Collect extension methods from an initialize result. Agents advertise them in
 * `_meta` blocks (on the result or under agentCapabilities) as either a
 * `methods`/`extensions` string array, or an object keyed by method name.
 */
export function discoverExtensions(init: InitializeResult | null | undefined): ExtensionInfo {
  const methods = new Set<string>();
  const features = new Set<string>();
  const meta: Record<string, unknown> = {};
  const add = (name: unknown) => {
    if (typeof name !== "string" || !name) return;
    methods.add(canonicalName(name.startsWith("_") ? name : `_${name}`));
  };
  const scan = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "methods" || k === "extensions" || k === "extMethods") && Array.isArray(val)) {
        val.forEach((n) => add(typeof n === "string" ? n : (n as any)?.name ?? (n as any)?.method));
      } else if ((k === "methods" || k === "extensions" || k === "extMethods") && val && typeof val === "object") {
        Object.keys(val).forEach((n) => add(n));
      } else if (val && typeof val === "object" && !Array.isArray(val)) {
        scan(val);
      }
    }
  };
  for (const block of [init?._meta, init?.agentCapabilities?._meta]) {
    if (block && typeof block === "object") {
      // Capability keys may arrive under a legacy key, the `_supercharge/` key, or both;
      // the `_supercharge/` value wins.
      for (const [k, v] of Object.entries(block)) {
        const c = canonicalName(k);
        if (c === k || !(c in block)) meta[c] = v;
      }
      scan(block);
      for (const [k, v] of Object.entries(block)) if (k.includes("/") && v !== false && v != null) features.add(canonicalName(k));
    }
  }
  return { methods: [...methods].sort(), features: [...features].sort(), notifications: [], meta };
}

/** JSON-RPC error the CLI returns when a session's saved model is not configured. */
export const MODEL_NOT_CONFIGURED = -32050;

/**
 * For a model_not_configured error, the configured model to switch to: the first preferred id
 * that is configured, else the first configured one. Never returns an unconfigured id.
 */
export function pickConfiguredModel(e: unknown, preferred: string[] = []): { pick: string; requested?: string } | null {
  if ((e as any)?.code !== MODEL_NOT_CONFIGURED) return null;
  const d = (e as any)?.data ?? {};
  const ids: string[] = (Array.isArray(d.configured) ? d.configured : [])
    .map((x: any) => (typeof x === "string" ? x : x?.id ?? x?.modelId ?? x?.model_id))
    .filter((x: unknown): x is string => typeof x === "string" && !!x);
  if (!ids.length) return null;
  const pick = preferred.find((m) => ids.includes(m)) ?? ids[0];
  const requested = d.requested ?? d.model ?? d.modelId ?? d.model_id;
  return { pick, ...(typeof requested === "string" ? { requested } : {}) };
}
