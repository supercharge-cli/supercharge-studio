import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const panel = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");

describe("side panel layout", () => {
  it("really hides the terminal stack when another tab is active", () => {
    // .term-stack is display:flex, which beats the hidden attribute unless overridden.
    expect(css).toMatch(/\.term-stack\[hidden\][^{]*\{display:none!important\}/);
  });
  it("puts terminals in the main tab row, not a second strip", () => {
    expect(panel).not.toContain("term-tabs");
    expect(panel).toMatch(/terms\.map\(\(t\) => \(\s*<button key=\{t\.id\} data-testid="terminal-tab"/);
    expect(panel).toContain("closeTerm(t.id)");
  });

  it("keeps the update banner outside the app grid as a fixed slim bar", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    // Banner is a sibling of .app, not a grid child (a grid child would squeeze the panes).
    expect(app).toMatch(/<>\s*\{available && \([\s\S]*?update-banner[\s\S]*?\)\}\s*<div className=\{`app/);
    expect(css).toMatch(/\.update-banner\{[^}]*position:fixed/);
    expect(css).toMatch(/\.update-banner\{[^}]*top:0/);
    expect(css).not.toMatch(/\.update-banner\{[^}]*position:sticky/);
  });
});
