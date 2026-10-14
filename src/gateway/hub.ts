/**
 * Desktop side of the mobile gateway: speaks ACP (as an agent) to paired devices
 * and multiplexes them onto the desktop's own ACP session(s).
 *
 * Allowed device → desktop methods: initialize, session/list, session/load, session/new,
 * session/prompt, session/cancel, session/set_mode, session/set_config_option,
 * _supercharge/focus, _supercharge/upload (chunked file upload; prompts link uploads by id). Everything else is rejected.
 * Desktop → device: session/update (live + replay), session/request_permission (fan-out,
 * first answer wins), _supercharge/permission/resolved, _supercharge/handoff,
 * _supercharge/sessions/changed.
 */
import type { ConfigOption, PermissionOutcome, SessionModes } from "../acp/types";

export type HubSession = { sessionId: string; title: string; cwd: string; project: string; projectId: string; group: string; updatedAt?: number; busy?: boolean };
export type HubProject = { projectId: string; name: string; cwd: string; group: string };

export interface HubHost {
  sessions(): HubSession[];
  projects(): HubProject[];
  prompt(sessionId: string, text: string, from: string, extra?: unknown[]): Promise<{ stopReason: string; usage?: unknown }>;
  /** Save one chunk of a device upload; the last chunk resolves with {uploadId, uri, path, name, mimeType, size}. */
  upload?(params: any): Promise<any>;
  /** Point upload links in a device prompt at the saved files (images may become image blocks). */
  resolveUploads?(blocks: unknown[]): Promise<unknown[]>;
  cancel(sessionId: string): void;
  newSession(projectId: string): Promise<string>;
  configOptions?(sessionId: string): ConfigOption[];
  modes?(sessionId: string): SessionModes | undefined;
  setMode?(sessionId: string, modeId: string): Promise<void>;
  setConfigOption?(sessionId: string, id: string, value: string): Promise<ConfigOption[]>;
  focus(sessionId: string): void;
  /** Make sure a session's history is available (e.g. load it from the agent). */
  ensureLoaded?(sessionId: string): Promise<void>;
}

type Msg = { jsonrpc?: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: any };
type Send = (deviceId: string, msg: Msg) => void;

const ALLOWED = new Set(["initialize", "session/list", "session/load", "session/new", "session/prompt", "session/cancel", "session/set_config_option", "session/set_mode", "_supercharge/focus", "_supercharge/upload"]);
const MAX_REPLAY = 3000;

export class GatewayHub {
  private buffers = new Map<string, any[]>();
  private subs = new Map<string, Set<string>>(); // sessionId → deviceIds
  private devices = new Set<string>();
  private seq = 1;
  private perms = new Map<number, { sessionId: string; toolCallId?: string; resolve: (o: PermissionOutcome) => void; asked: Map<string, number | string> }>();

  constructor(private send: Send, private host: HubHost, private names: (deviceId: string) => string = (d) => d) {}

  connected(deviceId: string) {
    this.devices.add(deviceId);
  }
  disconnected(deviceId: string) {
    this.devices.delete(deviceId);
    for (const s of this.subs.values()) s.delete(deviceId);
  }
  get deviceCount() {
    return this.devices.size;
  }

  /** Record a session update from the agent (or desktop-local echo) and fan it out. */
  update(sessionId: string, update: any) {
    let b = this.buffers.get(sessionId);
    if (!b) this.buffers.set(sessionId, (b = []));
    b.push(update);
    if (b.length > MAX_REPLAY) b.splice(0, b.length - MAX_REPLAY);
    for (const d of this.subs.get(sessionId) ?? []) this.send(d, { jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  /** Seed history for a session (e.g. from a load replay) without fanning out. */
  seed(sessionId: string, updates: any[]) {
    this.buffers.set(sessionId, updates.slice(-MAX_REPLAY));
  }

  sessionsChanged() {
    for (const d of this.devices) this.send(d, { jsonrpc: "2.0", method: "_supercharge/sessions/changed", params: {} });
  }

  handoff(sessionId: string, deviceId = "*") {
    const targets = deviceId === "*" ? [...this.devices] : [deviceId];
    for (const d of targets) this.send(d, { jsonrpc: "2.0", method: "_supercharge/handoff", params: { sessionId } });
    return targets.length;
  }

  /**
   * Ask paired devices to answer a permission request. Resolves with the first
   * device answer; call `resolved(token)` if the desktop answered first.
   */
  requestPermission(sessionId: string, params: any): { token: number; answer: Promise<PermissionOutcome> } {
    const token = this.seq++;
    const asked = new Map<string, number | string>();
    const answer = new Promise<PermissionOutcome>((resolve) => this.perms.set(token, { sessionId, toolCallId: params?.toolCall?.toolCallId, resolve, asked }));
    for (const d of this.devices) {
      const id = `perm-${token}-${this.seq++}`;
      asked.set(d, id);
      this.send(d, { jsonrpc: "2.0", id, method: "session/request_permission", params: { ...params, sessionId } });
    }
    return { token, answer };
  }

  /** The permission was answered elsewhere: tell devices to dismiss it. */
  resolved(token: number, outcome?: PermissionOutcome, by = "desktop") {
    const p = this.perms.get(token);
    if (!p) return;
    this.perms.delete(token);
    for (const [d, id] of p.asked) this.send(d, { jsonrpc: "2.0", method: "_supercharge/permission/resolved", params: { sessionId: p.sessionId, toolCallId: p.toolCallId, requestId: id, outcome, by } });
  }

  private reply(d: string, id: Msg["id"], result: any) {
    this.send(d, { jsonrpc: "2.0", id, result });
  }
  private fail(d: string, id: Msg["id"], code: number, message: string) {
    this.send(d, { jsonrpc: "2.0", id, error: { code, message } });
  }

  async receive(deviceId: string, msg: Msg) {
    this.devices.add(deviceId);
    // Response to one of our requests (permission answers).
    if (msg.id !== undefined && !msg.method) {
      for (const [token, p] of this.perms) {
        if (p.asked.get(deviceId) === msg.id) {
          const outcome: PermissionOutcome = msg.result?.outcome ?? { outcome: "cancelled" };
          this.perms.delete(token);
          p.resolve(outcome);
          for (const [d, id] of p.asked) if (d !== deviceId) this.send(d, { jsonrpc: "2.0", method: "_supercharge/permission/resolved", params: { sessionId: p.sessionId, toolCallId: p.toolCallId, requestId: id, outcome, by: this.names(deviceId) } });
          return;
        }
      }
      return;
    }
    const { id, method = "", params = {} } = msg;
    if (!ALLOWED.has(method)) {
      if (id !== undefined) this.fail(deviceId, id, -32601, `Method not available over the gateway: ${method}`);
      return;
    }
    try {
      switch (method) {
        case "initialize":
          return this.reply(deviceId, id, {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: { image: true, embeddedContext: true }, _meta: { supercharge: { upload: !!this.host.upload } } },
            agentInfo: { name: "supercharge-studio-gateway", title: "Supercharge Studio" },
            authMethods: [],
            _meta: { supercharge: { gateway: { version: 1, projects: this.host.projects() } } },
          });
        case "session/list":
          return this.reply(deviceId, id, {
            sessions: this.host.sessions().map((s) => ({ sessionId: s.sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : undefined, _meta: { project: s.project, projectId: s.projectId, group: s.group, busy: !!s.busy } })),
            _meta: { projects: this.host.projects() },
          });
        case "session/load": {
          const sid = String(params.sessionId ?? "");
          if (!this.host.sessions().some((s) => s.sessionId === sid)) return this.fail(deviceId, id, -32602, "Unknown session");
          await this.host.ensureLoaded?.(sid);
          for (const u of this.buffers.get(sid) ?? []) this.send(deviceId, { jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: u } });
          if (!this.subs.has(sid)) this.subs.set(sid, new Set());
          this.subs.get(sid)!.add(deviceId);
          return this.reply(deviceId, id, { configOptions: this.host.configOptions?.(sid) ?? [], modes: this.host.modes?.(sid) });
        }
        case "session/new": {
          const pid = String(params?._meta?.projectId ?? this.host.projects().find((p) => p.cwd === params.cwd)?.projectId ?? "");
          if (!pid) return this.fail(deviceId, id, -32602, "Unknown project");
          const sid = await this.host.newSession(pid);
          if (!this.subs.has(sid)) this.subs.set(sid, new Set());
          this.subs.get(sid)!.add(deviceId);
          this.sessionsChanged();
          return this.reply(deviceId, id, { sessionId: sid, configOptions: this.host.configOptions?.(sid) ?? [], modes: this.host.modes?.(sid) });
        }
        case "session/set_config_option": {
          const sid = params.sessionId;
          const configId = params.configId;
          const value = params.value;
          if (typeof sid !== "string" || !this.host.sessions().some((s) => s.sessionId === sid)) return this.fail(deviceId, id, -32602, "Unknown session");
          const option = (this.host.configOptions?.(sid) ?? []).find((o) => o.id === configId);
          if (!(["model", "reasoning_effort", "permission_mode"].includes(configId) && typeof value === "string" && option?.options?.some((o) => o.value === value)))
            return this.fail(deviceId, id, -32602, "Invalid config option or value");
          if (!this.host.setConfigOption) return this.fail(deviceId, id, -32603, "Session configuration unavailable");
          const configOptions = await this.host.setConfigOption(sid, configId, value);
          this.update(sid, { sessionUpdate: "config_option_update", configOptions });
          return this.reply(deviceId, id, { configOptions });
        }
        case "session/set_mode": {
          const sid = params.sessionId;
          const modeId = params.modeId;
          if (typeof sid !== "string" || !this.host.sessions().some((s) => s.sessionId === sid)) return this.fail(deviceId, id, -32602, "Unknown session");
          if (typeof modeId !== "string" || !this.host.modes?.(sid)?.availableModes.some((m) => m.id === modeId)) return this.fail(deviceId, id, -32602, "Invalid work mode");
          if (!this.host.setMode) return this.fail(deviceId, id, -32603, "Work mode unavailable");
          await this.host.setMode(sid, modeId);
          return this.reply(deviceId, id, {});
        }
        case "session/prompt": {
          const sid = String(params.sessionId ?? "");
          const blocks: any[] = Array.isArray(params.prompt) ? params.prompt : [];
          const text = blocks.map((b: any) => (b?.type === "text" ? b.text : "")).join("");
          let extra: unknown[] = blocks.filter((b: any) => b && typeof b === "object" && ["image", "resource", "resource_link"].includes(b.type));
          if (!text.trim() && !extra.length) return this.fail(deviceId, id, -32602, "Empty prompt");
          if (extra.length && this.host.resolveUploads) extra = await this.host.resolveUploads(extra);
          if (!this.subs.has(sid)) this.subs.set(sid, new Set());
          this.subs.get(sid)!.add(deviceId);
          const r = await this.host.prompt(sid, text, this.names(deviceId), extra);
          return this.reply(deviceId, id, r);
        }
        case "_supercharge/upload":
          if (!this.host.upload) return this.fail(deviceId, id, -32601, "Uploads are not available");
          return this.reply(deviceId, id, await this.host.upload(params));
        case "session/cancel":
          this.host.cancel(String(params.sessionId ?? ""));
          return;
        case "_supercharge/focus":
          this.host.focus(String(params.sessionId ?? ""));
          if (id !== undefined) this.reply(deviceId, id, {});
          return;
      }
    } catch (e: any) {
      if (id !== undefined) this.fail(deviceId, id, -32603, String(e?.message ?? e));
    }
  }
}
