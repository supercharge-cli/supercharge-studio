import { describe, expect, it } from "vitest";
import { hardenTerminalInput, isTerminalTarget } from "../src/lib/terminalInput";

const fakeEl = (inTerm: boolean) => ({ closest: (s: string) => (inTerm && s.includes(".xterm") ? {} : null) });

describe("terminal input", () => {
  it("ignores app shortcuts for keys typed in the terminal", () => {
    expect(isTerminalTarget(fakeEl(true) as any)).toBe(true);
    expect(isTerminalTarget(fakeEl(false) as any)).toBe(false);
    expect(isTerminalTarget(null)).toBe(false);
  });
  it("turns off autocorrect, predictive text and spellcheck", () => {
    const attrs: Record<string, string> = {};
    const ta = { setAttribute: (k: string, v: string) => (attrs[k] = v) } as unknown as Element;
    expect(hardenTerminalInput({ querySelectorAll: () => [ta] })).toBe(1);
    expect(attrs).toMatchObject({ autocomplete: "off", autocorrect: "off", autocapitalize: "off", spellcheck: "false" });
  });
});
