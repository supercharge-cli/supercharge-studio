import { afterEach, describe, expect, it } from "vitest";
import { track, trackModels } from "../src/lib/track";

const calls: [string, any][] = [];
const g = globalThis as any;
const install = (fail = false) => {
  calls.length = 0;
  g.__TAURI_INTERNALS__ = { invoke: (cmd: string, args: any) => (calls.push([cmd, args]), fail ? Promise.reject(new Error("no")) : Promise.resolve()) };
};
afterEach(() => { delete g.__TAURI_INTERNALS__; });

describe("usage stats (web side)", () => {
  it("hands events to the app and never throws", async () => {
    install();
    track("message_sent");
    track("agent_connected", { cli_version: "0.9.3" });
    expect(calls).toEqual([["telemetry_event", { name: "message_sent", props: undefined }], ["telemetry_event", { name: "agent_connected", props: { cli_version: "0.9.3" } }]]);
    install(true);
    expect(() => track("error", { kind: "agent_connect" })).not.toThrow();
    await Promise.resolve();
    delete g.__TAURI_INTERNALS__;
    expect(() => track("session_started")).not.toThrow(); // plain browser / tests: nothing to call
  });

  it("reports model picks by id only, and passes every request through", async () => {
    install();
    const sent: [string, any][] = [];
    const c = { request: async (m: string, p?: any) => (sent.push([m, p]), "ok") };
    trackModels(c);
    expect(await c.request("session/set_model", { sessionId: "s", modelId: "acme/fast-5" })).toBe("ok");
    await c.request("session/set_config_option", { sessionId: "s", configId: "model", value: "m2" });
    await c.request("session/set_config_option", { sessionId: "s", configId: "reasoning_effort", value: "high" });
    await c.request("session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "secret" }] });
    expect(sent.map((x) => x[0])).toEqual(["session/set_model", "session/set_config_option", "session/set_config_option", "session/prompt"]);
    expect(calls).toEqual([["telemetry_event", { name: "model_selected", props: { model: "acme/fast-5" } }], ["telemetry_event", { name: "model_selected", props: { model: "m2" } }]]);
    expect(JSON.stringify(calls)).not.toContain("secret");
  });
});
