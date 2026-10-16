/** True when a key event comes from inside a terminal, so app shortcuts leave it alone. */
export function isTerminalTarget(t: EventTarget | null): boolean {
  const el = t as { closest?: (s: string) => unknown } | null;
  return !!el && typeof el.closest === "function" && !!el.closest(".term-host, .xterm");
}

/** Turn off browser typing aids (autocorrect, predictive text, spellcheck) on a terminal's input. */
export function hardenTerminalInput(root: { querySelectorAll: (s: string) => ArrayLike<Element> }): number {
  const els = root.querySelectorAll("textarea, input");
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    el.setAttribute("autocomplete", "off");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("spellcheck", "false");
    el.setAttribute("inputmode", "text");
    el.setAttribute("data-gramm", "false");
  }
  return els.length;
}
