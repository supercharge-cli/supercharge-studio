import { describe, expect, it, vi } from "vitest";
import { b64, Channel, deviceKey, hex, hmac, parsePairUri, sessionKey } from "../src/gateway/crypto";
import { GatewayHub, HubHost } from "../src/gateway/hub";
import type { ConfigOption } from "../src/acp/types";

describe("gateway crypto", () => {
  it("seals and opens across directions, rejects replay and tampering", async () => {
    const sk = await sessionKey(await deviceKey(new Uint8Array(32).fill(7)), new Uint8Array(16).fill(1), new Uint8Array(16).fill(2));
    const cli = await Channel.create(sk, false);
    const srv = await Channel.create(sk, true);
    const f = await cli.seal('{"a":1}');
    expect(await srv.open(f)).toBe('{"a":1}');
    await expect(srv.open(f)).rejects.toThrow(/replay/);
    const g = await srv.seal("hi");
    expect(await cli.open(g)).toBe("hi");
    const t = await cli.seal("xyz");
    t[t.length - 1] ^= 1;
    await expect(srv.open(t)).rejects.toThrow();
  });
  it("matches the desktop (Rust) implementation", async () => {
    // Vector printed by `cargo test gateway -- --nocapture` (known_vectors_match_ts_client).
    const k = await deviceKey(new Uint8Array(32).fill(7));
    const sk = await sessionKey(k, new Uint8Array(16).fill(1), new Uint8Array(16).fill(2));
    expect(hex(k)).toBe(RUST_K);
    expect(hex(sk)).toBe(RUST_SK);
    const cli = await Channel.create(sk, false);
    expect(hex(await cli.seal("ping"))).toBe(RUST_FRAME);
  });
  it("parses pairing codes", () => {
    const secret = b64.enc(new Uint8Array(32).fill(9)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const p = parsePairUri(`scstudio://pair?u=ws%3A%2F%2F10.0.0.2%3A2420%2Fgw&i=p-ab&k=${secret}&n=My%20PC`);
    expect(p).toMatchObject({ url: "ws://10.0.0.2:2420/gw", pairingId: "p-ab", desktopName: "My PC" });
    expect(p.secret[0]).toBe(9);
    expect(() => parsePairUri("https://example.com")).toThrow();
  });
  it("hmac is deterministic", async () => {
    expect(hex(await hmac(new Uint8Array([1]), "a", "b"))).toBe(hex(await hmac(new Uint8Array([1]), "ab")));
  });
});

const RUST_K = "a8d2257bae4eb22c5b7c61b326406960c30a2bec5351a33062fb54d24bdca610";
const RUST_SK = "5f07b9525e8ae3f800a266d2dc15a0fd4305e9a2073377979ab7e23c27fc74c1";
const RUST_FRAME = "00000000000000019a5c67de7d49a6a5a8c6cd26d05da1de57c8cff4";

function makeHub() {
  const sent: { d: string; m: any }[] = [];
  const options = new Map<string, ConfigOption[]>([
    ["s1", [{ id: "model", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] }, { id: "reasoning_effort", currentValue: "low", options: [{ value: "low" }, { value: "high" }] }, { id: "secret", options: [{ value: "private" }] }]],
    ["s2", [{ id: "model", currentValue: "deep", options: [{ value: "deep", name: "Deep" }] }]],
  ]);
  const host: HubHost = {
    sessions: () => [{ sessionId: "s1", title: "Fix bug", cwd: "/w", project: "w", projectId: "p1", group: "Personal" }, { sessionId: "s2", title: "New chat", cwd: "/w", project: "w", projectId: "p1", group: "Personal" }],
    configOptions: (sid) => options.get(sid) ?? [],
    setConfigOption: vi.fn(async (sid, configId, value) => {
      const next = (options.get(sid) ?? []).map((o) => o.id === configId ? { ...o, currentValue: value } : o);
      options.set(sid, next);
      return next;
    }),
    projects: () => [{ projectId: "p1", name: "w", cwd: "/w", group: "Personal" }],
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    cancel: vi.fn(),
    newSession: vi.fn(async () => "s2"),
    focus: vi.fn(),
  };
  const hub = new GatewayHub((d, m) => sent.push({ d, m }), host, (d) => `dev-${d}`);
  return { hub, host, sent };
}

describe("gateway hub", () => {
  it("lists sessions, replays history on load, then streams live", async () => {
    const { hub, sent } = makeHub();
    hub.connected("A");
    hub.update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } });
    await hub.receive("A", { id: 1, method: "session/list", params: {} });
    expect(sent.at(-1)!.m.result.sessions[0]).toMatchObject({ sessionId: "s1", title: "Fix bug", _meta: { project: "w" } });
    await hub.receive("A", { id: 2, method: "session/load", params: { sessionId: "s1" } });
    expect(sent.at(-2)!.m).toMatchObject({ method: "session/update", params: { sessionId: "s1", update: { content: { text: "old" } } } });
    expect(sent.at(-1)!.m).toMatchObject({ id: 2, result: {} });
    hub.update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live" } });
    expect(sent.at(-1)).toMatchObject({ d: "A", m: { params: { update: { content: { text: "live" } } } } });
  });
  it("rejects methods outside the whitelist and unknown sessions", async () => {
    const { hub, sent } = makeHub();
    await hub.receive("A", { id: 1, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
    expect(sent.at(-1)!.m.error.code).toBe(-32601);
    await hub.receive("A", { id: 2, method: "session/load", params: { sessionId: "nope" } });
    expect(sent.at(-1)!.m.error.code).toBe(-32602);
  });
  it("forwards prompts, cancel, new session and focus (handoff)", async () => {
    const { hub, host, sent } = makeHub();
    await hub.receive("A", { id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "hi" }] } });
    expect(host.prompt).toHaveBeenCalledWith("s1", "hi", "dev-A");
    expect(sent.at(-1)!.m).toMatchObject({ id: 3, result: { stopReason: "end_turn" } });
    await hub.receive("A", { method: "session/cancel", params: { sessionId: "s1" } });
    expect(host.cancel).toHaveBeenCalledWith("s1");
    await hub.receive("A", { id: 4, method: "session/new", params: { cwd: "/w" } });
    expect(sent.find((x) => x.m.id === 4)!.m.result.sessionId).toBe("s2");
    await hub.receive("A", { id: 5, method: "_supercharge/focus", params: { sessionId: "s1" } });
    expect(host.focus).toHaveBeenCalledWith("s1");
    hub.connected("B");
    expect(hub.handoff("s1")).toBe(2);
  });
  it("returns each session's options on load and new", async () => {
    const { hub, sent } = makeHub();
    await hub.receive("A", { id: 1, method: "session/load", params: { sessionId: "s1" } });
    expect(sent.at(-1)!.m.result.configOptions[0]).toMatchObject({ id: "model", currentValue: "fast" });
    await hub.receive("A", { id: 2, method: "session/new", params: { cwd: "/w" } });
    expect(sent.at(-1)!.m.result).toMatchObject({ sessionId: "s2", configOptions: [{ id: "model", currentValue: "deep" }] });
  });
  it("validates model and reasoning changes and fans out only to subscribed devices", async () => {
    const { hub, host, sent } = makeHub();
    await hub.receive("A", { id: 1, method: "session/load", params: { sessionId: "s1" } });
    await hub.receive("B", { id: 2, method: "session/load", params: { sessionId: "s1" } });
    await hub.receive("C", { id: 3, method: "session/load", params: { sessionId: "s2" } });
    sent.length = 0;
    for (const [id, configId, value, sessionId] of [[4, "secret", "private", "s1"], [5, "model", "invalid", "s1"], [6, "model", "deep", "unknown"], [7, "reasoning_effort", "high", "s2"]] as const) {
      await hub.receive("A", { id, method: "session/set_config_option", params: { sessionId, configId, value } });
      expect(sent.at(-1)!.m.error.code).toBe(-32602);
    }
    expect(host.setConfigOption).not.toHaveBeenCalled();
    await hub.receive("A", { id: 8, method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "deep" } });
    expect(host.setConfigOption).toHaveBeenCalledWith("s1", "model", "deep");
    expect(sent.find((x) => x.m.id === 8)!.m.result.configOptions[0].currentValue).toBe("deep");
    expect(sent.filter((x) => x.m.method === "session/update").map((x) => x.d).sort()).toEqual(["A", "B"]);
    expect(sent.find((x) => x.m.method === "session/update")!.m.params.update.configOptions[0]).toMatchObject({ id: "model", currentValue: "deep" });
    await hub.receive("A", { id: 9, method: "session/set_config_option", params: { sessionId: "s1", configId: "reasoning_effort", value: "high" } });
    expect(host.setConfigOption).toHaveBeenCalledWith("s1", "reasoning_effort", "high");
  });
  it("fans out permission requests: first device answer wins, others are dismissed", async () => {
    const { hub, sent } = makeHub();
    hub.connected("A");
    hub.connected("B");
    const { answer } = hub.requestPermission("s1", { toolCall: { toolCallId: "t" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] });
    const reqs = sent.filter((x) => x.m.method === "session/request_permission");
    expect(reqs.map((r) => r.d).sort()).toEqual(["A", "B"]);
    const b = reqs.find((r) => r.d === "B")!;
    await hub.receive("B", { id: b.m.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    expect(await answer).toEqual({ outcome: "selected", optionId: "ok" });
    expect(sent.at(-1)).toMatchObject({ d: "A", m: { method: "_supercharge/permission/resolved", params: { by: "dev-B" } } });
  });
  it("desktop answering first dismisses device prompts", () => {
    const { hub, sent } = makeHub();
    hub.connected("A");
    const { token } = hub.requestPermission("s1", { options: [] });
    hub.resolved(token, { outcome: "cancelled" });
    expect(sent.at(-1)).toMatchObject({ d: "A", m: { method: "_supercharge/permission/resolved", params: { by: "desktop" } } });
  });
});
