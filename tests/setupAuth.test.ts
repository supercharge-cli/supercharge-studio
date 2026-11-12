import { describe, expect, it, vi } from "vitest";
import { agentSetup, cliSignIn, emitAuthChanged, isSignedIn, normalizeStatus, providerCatalog, rpcSetup, waitAuth, type AuthLogin, type SetupApi } from "../src/lib/setup";
import { GatewayHub, type HubHost } from "../src/gateway/hub";
import { fakeSetup } from "../scripts/fakeSetup";

// A browser sign-in row as the CLI catalog sends it.
const BROWSER = { id: "browser-login", name: "Browser sign-in", description: "Sign in in the browser", baseUrl: "https://api.example.test/v1", defaultModel: "m-default", format: "openai", curated: true, auth: "api_key", authMethods: ["browser"], signedIn: false };
const noWait = async () => {};
const fakeApi = (extra = [BROWSER]) => {
  const f = fakeSetup(undefined, extra), calls: [string, any][] = [], notes: any[] = [];
  const api = rpcSetup(async (op, p) => { calls.push([op, p]); const r = await f.run(op, p, (_m, n) => notes.push(n)); return op === "models" ? { models: r } : op === "device_poll" ? { status: r } : r; }, true);
  return { api, calls, notes };
};

describe("sign-in catalog fields", () => {
  it("maps authMethods: device, browser, hidden key, signedIn", () => {
    const st = normalizeStatus({ providers: [
      { id: "nous", name: "N", format: "openai", auth: "oauth_device", authMethods: ["device"], signedIn: true },
      BROWSER,
      { id: "groq", name: "G", format: "openai", auth: "api_key", authMethods: ["api_key"], signedIn: null },
      { id: "old", name: "O", format: "openai", auth: "oauth_device" },
    ], oauth: { nous: { signedIn: true }, "browser-login": { signedIn: false } }, authLogin: null });
    const [n, b, g, o] = providerCatalog(st);
    expect(n).toMatchObject({ device: true, noKey: true, signedIn: true });
    expect(n.browser).toBeUndefined();
    expect(b).toMatchObject({ browser: true, noKey: true, signedIn: false, format: "chat_completions", name: "Browser sign-in" });
    expect(b.device).toBeUndefined();
    expect(g.device || g.browser || g.noKey).toBeFalsy();
    expect(g.signedIn).toBeUndefined();
    expect(o).toMatchObject({ device: true }); // 1.4.19 shape: no authMethods
    expect(o.noKey).toBeUndefined();
    expect(st.authLogin).toBeNull();
    expect(isSignedIn(st, n)).toBe(true);
    expect(isSignedIn(st, b)).toBe(false);
    expect(isSignedIn(normalizeStatus({ oauth: { nous: { signedIn: true } } }), { ...o, signedIn: undefined })).toBe(true); // older CLIs
  });
});

describe("auth_* over ACP", () => {
  it("sends the contract's request shapes", async () => {
    const call = vi.fn(async (op: string) => (op === "auth_start" ? { loginId: "L", providerId: "p", kind: "browser", url: "https://x", expiresIn: 60, interval: 2 } : op === "auth_poll" ? { loginId: "L", providerId: "p", kind: "browser", status: "pending", interval: 2 } : { cancelled: true }));
    const api = rpcSetup(call, true);
    expect((await api.authStart!("p")).url).toBe("https://x");
    expect(call).toHaveBeenLastCalledWith("auth_start", { providerId: "p" });
    await api.authStart!("p", "device");
    expect(call).toHaveBeenLastCalledWith("auth_start", { providerId: "p", kind: "device" });
    expect((await api.authPoll!("L")).status).toBe("pending");
    expect(call).toHaveBeenLastCalledWith("auth_poll", { loginId: "L" });
    expect(await api.authCancel!("L")).toEqual({ cancelled: true });
    expect(call).toHaveBeenLastCalledWith("auth_cancel", { loginId: "L" });
    expect(rpcSetup(call).authStart).toBeUndefined();
  });
  it("feature-detects auth_start on the agent", () => {
    const ext = vi.fn(async () => ({}));
    expect(agentSetup({ hasExtension: (m) => m === "_supercharge/setup/save" || m === "_supercharge/setup/auth_start", ext })!.authStart).toBeTypeOf("function");
    expect(agentSetup({ hasExtension: (m) => m === "_supercharge/setup/save", ext })!.authStart).toBeUndefined();
  });
});

describe("waiting for a sign-in", () => {
  const login = (status: AuthLogin["status"], interval = 1, message?: string): AuthLogin => ({ loginId: "L", providerId: "p", kind: "browser", status, interval, message });
  const poller = (seq: AuthLogin[]) => ({ authPoll: vi.fn(async () => seq.shift() ?? login("pending")) }) as unknown as SetupApi & { authPoll: ReturnType<typeof vi.fn> };
  it("polls at the interval, raising it when the CLI does, until done", async () => {
    const waits: number[] = [];
    const api = poller([login("pending", 1), login("pending", 3), login("done", 3)]);
    expect((await waitAuth(api, { loginId: "L", interval: 1, expiresIn: 600 }, () => false, async (ms) => { waits.push(ms); })).status).toBe("done");
    expect(waits).toEqual([1000, 1000, 3000]);
  });
  it("rejects on denied, expired, error (with the CLI's message) and cancel", async () => {
    for (const [st, msg] of [["denied", "Sign-in denied"], ["expired", "Sign-in expired"], ["error", "boom"]] as const)
      await expect(waitAuth(poller([login(st, 1, st === "error" ? "boom" : undefined)]), { loginId: "L", interval: 1, expiresIn: 600 }, () => false, noWait)).rejects.toThrow(msg);
    await expect(waitAuth(poller([]), { loginId: "L", interval: 1, expiresIn: 600 }, () => true, noWait)).rejects.toThrow("cancelled");
  });
  it("finishes on the auth_changed notification without another poll", async () => {
    const api = poller([]);
    let release = () => {};
    const p = waitAuth(api, { loginId: "L", interval: 5, expiresIn: 600 }, () => false, () => new Promise<void>((r) => { release = r; }));
    emitAuthChanged(login("pending")); // still pending: ignored
    emitAuthChanged({ ...login("done"), loginId: "other" }); // another login: ignored
    emitAuthChanged(login("done"));
    expect((await p).status).toBe("done");
    expect(api.authPoll).not.toHaveBeenCalled();
    release();
  });
});

describe("sign-in flow against the fake CLI", () => {
  it("browser: shows the URL, waits, then lists and saves with the provider and picked model only", async () => {
    const { api, calls, notes } = fakeApi();
    const shown: any[] = [];
    const st0 = await api.status();
    const p = providerCatalog(st0).find((x) => x.id === "browser-login")!;
    expect(p).toMatchObject({ browser: true, noKey: true, signedIn: false });
    await cliSignIn(api, p.id, { cancelled: () => false, shown: (d, id) => shown.push([d, id]), wait: noWait });
    expect(shown[0][0]).toMatchObject({ userCode: "", verificationUri: "https://auth.example.test/authorize?login=login-1" });
    expect(calls.find(([op]) => op === "auth_start")![1]).toEqual({ providerId: "browser-login" });
    expect(notes.at(-1)).toMatchObject({ loginId: "login-1", status: "done" });
    const st = await api.status();
    expect(isSignedIn(st, providerCatalog(st).find((x) => x.id === "browser-login")!)).toBe(true);
    expect(await api.models(p.id, p.baseUrl, undefined, p.format)).toHaveLength(3);
    // What the wizard sends after the user picks a model: no key for a sign-in provider.
    await api.save({ providerId: p.id, baseUrl: p.baseUrl, apiKey: undefined, format: p.format, modelId: "model-b", sessionId: "s1" });
    const save = JSON.parse(JSON.stringify(calls.filter(([op]) => op === "save").at(-1)![1]));
    expect(save).toEqual({ providerId: "browser-login", baseUrl: "https://api.example.test/v1", format: "chat_completions", modelId: "model-b", sessionId: "s1" });
    expect(calls.find(([op]) => op === "models")![1].apiKey).toBeUndefined();
  });
  it("device: shows the user code, and uses auth_* not device_*", async () => {
    const { api, calls } = fakeApi([]);
    const shown: any[] = [];
    await cliSignIn(api, "nous", { cancelled: () => false, shown: (d) => shown.push(d), wait: noWait });
    expect(shown[0].userCode).toBe("WDJB-MJHT");
    expect(calls.some(([op]) => op.startsWith("device_"))).toBe(false);
  });
  it("falls back to device_* when the agent has no auth_start", async () => {
    const f = fakeSetup();
    const ops: string[] = [];
    const api = rpcSetup(async (op, p) => { ops.push(op); const r = await f.run(op, p); return op === "device_poll" ? { status: r } : r; });
    await cliSignIn(api, "nous", { cancelled: () => false, shown: () => {}, wait: noWait });
    expect(ops).toEqual(["device_start", "device_poll", "device_poll"]);
  });
  it("resumes a login already running instead of starting another", async () => {
    const { api, calls } = fakeApi();
    const s = await api.authStart!("browser-login");
    const st = await api.status();
    expect(st.authLogin).toMatchObject({ loginId: s.loginId, status: "pending" });
    await cliSignIn(api, "browser-login", { resume: st.authLogin!, cancelled: () => false, shown: () => {}, wait: noWait });
    expect(calls.filter(([op]) => op === "auth_start")).toHaveLength(1);
  });
  it("fails closed: key-only providers, unlisted kinds, unknown or cancelled logins", async () => {
    const { api } = fakeApi();
    await expect(api.authStart!("groq")).rejects.toThrow();
    await expect(api.authStart!("browser-login", "device")).rejects.toThrow();
    const s = await api.authStart!("browser-login");
    expect(await api.authCancel!(s.loginId)).toEqual({ cancelled: true });
    expect(await api.authCancel!(s.loginId)).toEqual({ cancelled: false });
    await expect(api.authPoll!(s.loginId)).rejects.toThrow();
  });
});

describe("phone pass-through", () => {
  it("forwards auth_* ops, advertises sign-in and relays auth_changed", async () => {
    const sent: any[] = [];
    const setup = vi.fn(async (op: string) => (op === "auth_start" ? { loginId: "L", url: "https://x" } : op === "auth_cancel" ? { cancelled: true } : { status: "pending" }));
    const host = { sessions: () => [], projects: () => [], prompt: async () => ({ stopReason: "end_turn" }), cancel() {}, newSession: async () => "s", focus() {}, setup, setupAuth: () => true } as unknown as HubHost;
    const hub = new GatewayHub((_d, m) => sent.push(m), host);
    await hub.receive("d", { id: 1, method: "initialize", params: {} });
    expect(sent.at(-1).result.agentCapabilities._meta.supercharge.setupAuth).toBe(true);
    for (const op of ["auth_start", "auth_poll", "auth_cancel"]) {
      await hub.receive("d", { id: op, method: "_supercharge/setup", params: { op, providerId: "p", loginId: "L" } });
      expect(sent.at(-1).error).toBeUndefined();
    }
    expect(sent.at(-1).result).toEqual({ cancelled: true });
    hub.connected("d");
    hub.setupAuthChanged({ loginId: "L", status: "done" });
    expect(sent.at(-1)).toMatchObject({ method: "_supercharge/setup/auth_changed", params: { loginId: "L", status: "done" } });
    const old = new GatewayHub((_d, m) => sent.push(m), { ...host, setupAuth: () => false } as HubHost);
    await old.receive("d", { id: 9, method: "initialize", params: {} });
    expect(sent.at(-1).result.agentCapabilities._meta.supercharge.setupAuth).toBe(false);
  });
});
