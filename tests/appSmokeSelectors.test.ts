import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The WebDriver smoke test drives the *release* desktop build, which strips data-testid
// (vite.shared stripTestIds). It must only use hooks that survive that build.
const src = readFileSync("scripts/app-smoke.mjs", "utf8");
const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("app smoke selectors", () => {
  it("never selects by data-testid", () => {
    expect(code).not.toMatch(/data-testid/);
  });
  it("aria labels it relies on exist in the source", () => {
    const devices = readFileSync("src/components/Devices.tsx", "utf8");
    for (const l of ["Mobile gateway", "Relay URL"]) expect(devices).toContain(`aria-label="${l}"`);
    expect(readFileSync("src/App.tsx", "utf8")).toContain('aria-label="Pair device"');
  });
  it("titles and labels it relies on exist in the source", () => {
    const side = readFileSync("src/components/Sidebar.tsx", "utf8");
    for (const t of ['title="Collapse sidebar"', 'title="Expand sidebar"', 'title="New chat in this folder"', 'className="side-search"', "Usage</button>", "Settings</button>"]) expect(side).toContain(t);
    const settings = readFileSync("src/components/Settings.tsx", "utf8");
    for (const t of ["Save & reconnect", 'placeholder="127.0.0.1:2419', 'className="agent-log"', 'className="screen-nav"']) expect(settings).toContain(t);
  });
});
