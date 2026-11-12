import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyUpdate, emptySession } from "../src/acp/session";
import { OptText } from "../src/components/OptText";
import ContextWindowPop from "../src/components/ContextWindowPop";

const info = (agent: string, title?: string) => ({ sessionUpdate: "session_info_update", ...(title && { title }), _meta: { supercharge: { agent } } }) as any;

describe("Lean agent marker", () => {
  it("records the session's agent profile from session_info_update _meta", () => {
    const s = applyUpdate(emptySession(), info("lean"));
    expect(s.agent).toBe("lean");
    expect(applyUpdate(s, info("supercharge-build")).agent).toBe("supercharge-build");
  });
  it("keeps the title and agent independent", () => {
    const s = applyUpdate(applyUpdate(emptySession(), { sessionUpdate: "session_info_update", title: "Proofs" } as any), info("lean"));
    expect(s).toMatchObject({ title: "Proofs", agent: "lean" });
    expect(applyUpdate(s, { sessionUpdate: "session_info_update", title: "Next" } as any)).toMatchObject({ title: "Next", agent: "lean" });
  });
});

describe("model choices show name, full id and description", () => {
  it("renders the whole id, never truncated", () => {
    const id = "vendor/some-really-long-model-identifier-2026-11-01-preview";
    const html = renderToStaticMarkup(createElement(OptText, { o: { value: id, name: "Fast", description: "Quick and cheap" } }));
    expect(html).toContain(`<code>${id}</code>`);
    expect(html).toContain("<b>Fast</b>");
    expect(html).toContain("Quick and cheap");
  });
  it("shows the id once when there is no separate name", () => {
    const html = renderToStaticMarkup(createElement(OptText, { o: { value: "m-1", name: "m-1" } }));
    expect(html).toBe('<span class="opt"><b>m-1</b></span>');
  });
});

describe("context window popover", () => {
  const pop = (current: number | "auto") => renderToStaticMarkup(createElement(ContextWindowPop, { used: 1000, max: 400000, ctl: { ext: true, current, onSet: () => {} }, onDone: () => {} }));
  it("explains Auto only while Auto is selected", () => {
    expect(pop("auto")).toContain("Auto uses the size the model reports.");
    expect(pop(400000)).not.toContain("Auto uses");
  });
});

import { readFileSync } from "node:fs";
import { releaseNotes } from "../src/lib/releaseNotes";
describe("release notes in the update prompt", () => {
  it("flattens markdown to short lines, skipping headings and comments", () => {
    expect(releaseNotes("# Title\n<!-- hidden -->\n\n- **Bold** item with [a link](https://x)\n* `code` two\n1. three\nPlain line\n")).toEqual(["Bold item with a link", "code two", "three", "Plain line"]);
  });
  it("is robust to missing, empty or heading-only bodies, and caps size", () => {
    expect(releaseNotes(undefined)).toEqual([]);
    expect(releaseNotes("")).toEqual([]);
    expect(releaseNotes("## v1.2.3\n")).toEqual([]);
    const many = releaseNotes(Array.from({ length: 30 }, (_, i) => `- ${"x".repeat(300)}${i}`).join("\n"));
    expect(many).toHaveLength(10);
    expect(many[0].length).toBe(180);
  });
  it("WHATS_NEW.md has notes for the next release", () => {
    const n = releaseNotes(readFileSync("WHATS_NEW.md", "utf8"));
    expect(n.length).toBeGreaterThan(0);
    expect(n.join(" ")).toMatch(/Public URL/);
  });
});
