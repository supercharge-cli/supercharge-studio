import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, cells } from "../src/components/Markdown";

const md = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));

describe("GFM tables", () => {
  it("renders header, body and alignment", () => {
    const h = md("Intro\n| Name | Size | Mid |\n|:---|---:|:-:|\n| `a\\|b` | **2** | x |\n| c | 3 |");
    expect(h).toContain("<p>Intro</p>");
    expect(h).toContain('<div class="md-tablewrap"');
    expect(h).toMatch(/<th style="text-align:left">Name<\/th><th style="text-align:right">Size<\/th><th style="text-align:center">Mid<\/th>/);
    expect(h).toContain("<code>a|b</code>");
    expect(h).toContain("<strong>2</strong>");
    expect((h.match(/<tr>/g) || []).length).toBe(3);
    expect(h).not.toContain("| c |");
  });
  it("works without outer pipes and keeps pipes inside code", () => {
    expect(cells("a | `x|y` | b")).toEqual(["a", "`x|y`", "b"]);
    expect(md("a | b\n--- | ---\n1 | 2")).toContain("<td>1</td><td>2</td>");
  });
  it("leaves non-tables alone", () => {
    expect(md("a | b\nplain")).not.toContain("<table");
    expect(md("| a | b |\n|---|")).not.toContain("<table");
  });
});
