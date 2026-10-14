import { describe, expect, it } from "vitest";
import { defaultGatewayPrefs, load, parseAgentUrl, mergeCliSessions, migrate, projectsByCwd, relTime, ensureFolderProject, applyTree as tree2, CLI_GROUP } from "../src/lib/store";

describe("gateway defaults", () => {
  it("seeds the public relay and persists a stable host ID for existing settings", () => {
    const saved = new Map<string, string>();
    const previous = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => { saved.set(key, value); },
    } });
    try {
      saved.set("supercharge-studio/v1", JSON.stringify({ settings: { gateway: { enabled: true, mode: "lan", port: 2422, publicUrl: "" } }, groups: [] }));
      const first = load().settings.gateway!;
      expect(first.relayUrl).toBe("wss://relay.superchargeai.in");
      expect(first.hostId).toMatch(/^[0-9a-f]{24}$/);
      expect(load().settings.gateway!.hostId).toBe(first.hostId);
      expect(defaultGatewayPrefs.enabled).toBe(false);

      saved.set("supercharge-studio/v1", JSON.stringify({ settings: { gateway: { enabled: true, mode: "lan", port: 2422, publicUrl: "", relayUrl: "" } }, groups: [] }));
      expect(load().settings.gateway).toMatchObject({ relayUrl: "", reach: "local" });
      expect(load().settings.gateway!.hostId).toBeUndefined();
      saved.set("supercharge-studio/v1", JSON.stringify({ settings: { gateway: { enabled: true, mode: "lan", port: 2422, publicUrl: "", relayUrl: "wss://other.example", hostId: "existing-id" } }, groups: [] }));
      expect(load().settings.gateway).toMatchObject({ relayUrl: "wss://other.example", hostId: "existing-id" });
      saved.delete("supercharge-studio/v1");
      expect(load().settings.gateway).toMatchObject({ relayUrl: "wss://relay.superchargeai.in", enabled: false });
    } finally {
      if (previous === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
      else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
    }
  });
});

describe("parseAgentUrl", () => {
  it("splits a pasted agent URL into address and key", () => {
    expect(parseAgentUrl("ws://127.0.0.1:2419/ws?server-key=abc%2B1")).toEqual({ bind: "127.0.0.1:2419", secret: "abc+1" });
    expect(parseAgentUrl("  wss://host.example:443/ws?server-key=k ")).toEqual({ bind: "host.example", secret: "k" });
  });
  it("ignores plain addresses and junk", () => {
    expect(parseAgentUrl("127.0.0.1:2419")).toEqual({});
    expect(parseAgentUrl("ws://")).toEqual({});
  });
});

describe("CLI session sync", () => {
  const base: any = { settings: {}, groups: [{ id: "g", name: "Personal", projects: [{ id: "p", name: "app", cwd: "/a/", chats: [{ id: "c", title: "New chat", sessionId: "s1", createdAt: 1 }] }] }] };
  it("migrates v1 data without losing anything", () => {
    const m = migrate(base);
    expect(m.schema).toBe(2);
    expect(m.sidebarView).toBe("projects");
    expect(m.groups[0].projects[0].chats[0]).toMatchObject({ id: "c", sessionId: "s1", updatedAt: 1 });
    expect(migrate(m)).toBe(m);
  });
  it("merges by session id and cwd, creates folder projects, respects hidden", () => {
    const d = mergeCliSessions(migrate(base), [
      { sessionId: "s1", cwd: "/a", title: "Named by CLI", updatedAt: "2026-10-13T10:00:00Z" },
      { sessionId: "s2", cwd: "/a", updatedAt: "2026-10-13T11:00:00Z" },
      { sessionId: "s3", cwd: "/b/proj", title: "B", updatedAt: "2026-10-12T11:00:00Z" },
    ]);
    const f = projectsByCwd(d);
    expect(f.map((x) => x.cwd)).toEqual(["/a", "/b/proj"]);
    expect(f[0].chats.map((c) => c.chat.title)).toEqual(["Untitled chat", "Named by CLI"]);
    expect(f[1].name).toBe("proj");
    expect(d.groups.find((g) => g.name === CLI_GROUP)!.projects[0].cwd).toBe("/b/proj");
    const h = tree2(d, { type: "removeChat", chatId: f[1].chats[0].chat.id });
    expect(h.hiddenSessions).toContain("s3");
    expect(projectsByCwd(mergeCliSessions(h, [{ sessionId: "s3", cwd: "/b/proj" }])).find((x) => x.cwd === "/b/proj")?.chats ?? []).toHaveLength(0);
    expect(mergeCliSessions(d, [{ sessionId: "s1", cwd: "/a", title: "Named by CLI", updatedAt: "2026-10-13T10:00:00Z" }])).toBe(d);
  });
  it("relative time and folder projects", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect([relTime(now - 10e3, now), relTime(now - 5 * 60e3, now), relTime(now - 3 * 3600e3, now), relTime(now - 2 * 86400e3, now), relTime(now - 15 * 86400e3, now)]).toEqual(["now", "5m", "3h", "2d", "2w"]);
    const r = ensureFolderProject(migrate(base), "/a");
    expect(r.projectId).toBe("p");
    expect(ensureFolderProject(migrate(base), "/new/x").data.groups.some((g) => g.name === CLI_GROUP)).toBe(true);
  });
});
