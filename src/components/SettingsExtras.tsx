import type { Settings as S, UiAccent } from "../lib/store";
import { canonicalThemeId, themeList } from "../lib/themes";
import { Icon } from "./Icon";
import { agentCheck } from "../lib/desktop";
import { useEffect, useState } from "react";

const ACCENTS: { id: UiAccent; name: string; c: string }[] = [
  { id: "theme", name: "Theme default", c: "var(--fg)" },
  { id: "sky", name: "Sky", c: "#38bdf8" },
  { id: "emerald", name: "Emerald", c: "#34d399" },
  { id: "amber", name: "Amber", c: "#fbbf24" },
  { id: "rose", name: "Rose", c: "#fb7185" },
  { id: "violet", name: "Violet", c: "#a78bfa" },
];

const SEGS: { key: keyof S; label: string; aria: string; test: string; fallback: string; opts: [string, string][] }[] = [
  { key: "density", label: "Interface density", aria: "Density", test: "density", fallback: "normal", opts: [["compact", "Compact"], ["normal", "Normal"], ["comfortable", "Comfortable"]] },
  { key: "boxStyle", label: "Border and frame style", aria: "Box style", test: "box-style", fallback: "modern", opts: [["modern", "Modern hairline"], ["ascii", "ASCII box"], ["minimal", "Rounded minimal"]] },
  { key: "promptGlyph", label: "Agent prompt glyph", aria: "Prompt glyph", test: "glyph", fallback: "❯", opts: [["❯", "❯ Chevron"], ["$", "$ Shell"], ["::", ":: Colon"], [">", "> Arrow"], ["λ", "λ Lambda"], ["⚡", "⚡ Supercharge"]] },
  { key: "cursorStyle", label: "Cursor style", aria: "Cursor style", test: "cursor", fallback: "bar", opts: [["bar", "Bar |"], ["block", "Block █"], ["underline", "Underline _"]] },
  { key: "monoFont", label: "Code and metadata font", aria: "Monospace font", test: "font", fallback: "modern", opts: [["modern", "Modern"], ["terminal", "Classic"], ["default", "System default"]] },
];

function Seg({ label, aria, test, value, opts, onPick }: {
  label: string; aria: string; test: string; value: string; opts: [string, string][]; onPick: (id: string) => void;
}) {
  return (
    <div className="stack set-sub">
      <label>{label}</label>
      <div className="seg" role="radiogroup" aria-label={aria}>
        {opts.map(([id, lab]) => (
          <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? "on" : ""} data-testid={`${test}-${id}`} onClick={() => onPick(id)}>{lab}</button>
        ))}
      </div>
    </div>
  );
}

export function TestConn({ bind, secret }: { bind: string; secret: string }) {
  const [st, setSt] = useState<"idle" | "pinging" | "ok" | "fail">("idle");
  const addr = bind || "127.0.0.1:2419";
  const label = st === "pinging" ? "Pinging…" : st === "ok" ? "Connected" : st === "fail" ? "Unreachable" : "Test connection";
  return (
    <div className="card row between test-conn">
      <div>
        <strong>Connection diagnostics</strong>
        <p className="muted small">Ping the agent at <code>{addr}</code></p>
      </div>
      <button type="button" className="secondary compact" data-testid="test-conn-btn" onClick={async () => {
        setSt("pinging");
        try { setSt(await agentCheck(addr, secret) === "ok" ? "ok" : "fail"); } catch { setSt("fail"); }
      }}>{label}</button>
    </div>
  );
}

export function Appearance({ s, set }: { s: S; set: (s: S) => void }) {
  useEffect(() => {
    const r = document.documentElement, d = r.dataset;
    const put = (k: string, v?: string) => { if (v) d[k] = v; else delete d[k]; };
    if (s.theme) d.theme = canonicalThemeId(s.theme) ?? s.theme;
    put("density", s.density);
    put("boxStyle", s.boxStyle);
    put("fontPref", s.monoFont);
    put("scanlines", s.scanlines ? "true" : undefined);
    put("cursorStyle", s.cursorStyle);
    put("accent", s.accent && s.accent !== "theme" ? s.accent : undefined);
    if (s.fontSize) r.style.setProperty("--fs", `${s.fontSize}px`);
    if (s.promptGlyph) r.style.setProperty("--prompt-glyph", `"${s.promptGlyph}"`);
  }, [s]);
  const glyph = s.promptGlyph ?? "❯";
  const theme = s.theme ?? "dark";
  return (
    <div className="stack">
      <label>Chat text size · {s.fontSize ?? 14}px<input type="range" min={12} max={20} step={1} data-testid="font-size" value={s.fontSize ?? 14} onChange={(e) => set({ ...s, fontSize: +e.target.value })} /></label>
      {SEGS.map((g) => (
        <Seg key={g.key} label={g.label} aria={g.aria} test={g.test} value={(s[g.key] as string) ?? g.fallback} opts={g.opts} onPick={(id) => set({ ...s, [g.key]: id })} />
      ))}
      <div className="stack set-sub">
        <label>Color theme</label>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {themeList.map((t) => (
            <button key={t.id} role="radio" aria-checked={theme === t.id} className={`theme-card ${theme === t.id ? "on" : ""}`} data-testid={`theme-${t.id}`} onClick={() => set({ ...s, theme: t.id })}>
              <span className="sw">{t.swatch.map((c, i) => <i key={i} style={{ background: c }} />)}</span>
              <span className="row"><Icon name={t.id === "system" ? "panelLeft" : t.dark ? "moon" : "sun"} size={14} /> {t.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="stack set-sub">
        <label>Accent color</label>
        <div className="accent-grid" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map((a) => (
            <button key={a.id} type="button" role="radio" aria-checked={(s.accent ?? "theme") === a.id} className={`accent-sw ${(s.accent ?? "theme") === a.id ? "on" : ""}`} style={{ "--c": a.c } as React.CSSProperties} title={a.name} data-testid={`accent-${a.id}`} onClick={() => set({ ...s, accent: a.id })} />
          ))}
        </div>
      </div>
      <div className="card preview-card-wrap">
        <div className="row between preview-head"><strong>Live preview</strong><span className="pill muted small">{s.density ?? "normal"} · {s.boxStyle ?? "modern"}</span></div>
        <div className="preview-block-body">
          <div className="muted">[ YOU ]</div>
          <div>Why does token refresh fail in development?</div>
          <div className="preview-agent"><strong>{glyph} [ AGENT ]</strong> The cookie partition was rejected because <code>Secure</code> was required on localhost.</div>
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={!!s.reduceMotion} onChange={(e) => set({ ...s, reduceMotion: e.target.checked })} /> Instant transitions (no animations)</label>
      <label className="check"><input type="checkbox" checked={!!s.scanlines} onChange={(e) => set({ ...s, scanlines: e.target.checked })} /> CRT phosphor scanlines and monitor glow</label>
      <p className="muted small">Changes apply as you edit them. Themes, density, and frame styles are stored with your other settings.</p>
    </div>
  );
}

const SHORTCUTS = [
  ["Ctrl + K", "Command palette", "Global"],
  ["Ctrl + ,", "Settings", "Global"],
  ["Ctrl + B", "Toggle the project sidebar", "View"],
  ["Ctrl + \\", "Toggle the right panel", "View"],
  ["Ctrl + N", "New chat", "Navigation"],
  ["Ctrl + Shift + U", "Usage", "Analytics"],
  ["Ctrl + L", "Focus the composer", "Composer"],
  ["Ctrl + .", "Stop the current turn", "Execution"],
  ["Enter", "Send", "Composer"],
  ["Shift + Enter", "Insert a line break", "Composer"],
  ["@", "Mention a file", "Composer"],
  ["/", "Slash commands", "Composer"],
  ["Esc", "Dismiss a dialog or return to chat", "Global"],
] as const;

export function Keybindings() {
  return (
    <div className="stack shortcuts-page">
      <p className="muted small">Keyboard shortcuts used in Studio.</p>
      <div className="card shortcuts-table">
        {SHORTCUTS.map(([k, title, group]) => (
          <div key={k} className="row between sc-row">
            <div><strong>{title}</strong> <span className="muted small">· {group}</span></div>
            <kbd className="sc-kbd">{k}</kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
