import { lazy, ReactNode, Suspense, useEffect, useState } from "react";
import { Privacy } from "./Privacy";
import { agentSetup, listProviderModels, mergeCli, pickSetup, providerCatalog, type SetupApi, type SetupStatusFull, type SetupStatus } from "../lib/setup";
import type { ApiFormat, Provider, Settings as S } from "../lib/store";
import { parseAgentUrl, uid, ACCENTS } from "../lib/store";
import type { ConfigOption } from "../acp/types";
import { Icon } from "./Icon";
import { Plugins } from "./Plugins";
import type { PluginRpc } from "../lib/plugins";
import { canonicalThemeId, themeList } from "../lib/themes";
import { APP_VERSION } from "../lib/updates";
import ProviderSetup from "./ProviderSetup";
import { agentCheck, agentInfo, agentLog, providerDiscoverModels, type AgentInfo, type DiscoveredModel } from "../lib/desktop";

type Props = {
  value: S;
  configOptions: ConfigOption[];
  desktop: boolean;
  onSave: (s: S) => void;
  onConfig: (id: string, v: string) => void;
  onClose: () => void;
  /** Store a provider API key in secure storage; resolves to the backend used. */
  onProviderKey: (id: string, key: string) => Promise<string>;
  /** Make a provider active and apply it to the agent. */
  onActivate: (p: Provider, all: Provider[]) => Promise<void>;
  /** Extra section rendered under "Devices" (mobile pairing). */
  devices?: ReactNode;
  /** Agent connection: its `_supercharge/setup/*` methods win over the desktop shell's. */
  acp?: { hasExtension(m: string): boolean; ext<T = any>(m: string, p?: unknown): Promise<T> } | null;
  openUrl?: (url: string) => void;
  pluginRpc?: PluginRpc;
  pluginTarget: string;
  onSetupSaved?: (s: SetupStatus) => void;
  /** The open chat's agent session, switched to the saved model right away when the agent can. */
  sessionId?: () => string | undefined;
  /** Read the CLI's configured provider again (references only), ignoring earlier removals. */
  onCliImport?: () => Promise<Provider | null>;
};

const SECTIONS = [
  { id: "connection", label: "Connection", icon: "plug" },
  { id: "providers", label: "Providers", icon: "server" },
  { id: "plugins", label: "Plugins", icon: "plug" },
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "shortcuts", label: "Keybindings", icon: "code" },
  { id: "agent", label: "Agent", icon: "bolt" },
  { id: "devices", label: "Devices", icon: "phone" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

const FORMATS: { v: ApiFormat; label: string }[] = [
  { v: "responses", label: "Responses" },
  { v: "chat_completions", label: "Chat Completions" },
  { v: "messages", label: "Messages" },
];

/**
 * Models for a Studio provider: through the connected CLI's `_supercharge/setup/models` when the
 * agent offers it; the desktop shell's /models check only when no agent setup is available.
 */
export async function discoverModels(p: Provider, cliSetup: SetupApi | null): Promise<DiscoveredModel[]> {
  if (!cliSetup) return providerDiscoverModels(p.id, p.baseUrl.trim());
  const status: SetupStatusFull | null = await cliSetup.status().catch(() => null);
  return listProviderModels(cliSetup, p, providerCatalog(status));
}

function ProviderEditor({ p, desktop, cliSetup, onChange, onKey, onRemove }: { p: Provider; desktop: boolean; cliSetup: SetupApi | null; onChange: (p: Provider) => void; onKey: (k: string) => Promise<string>; onRemove: () => void }) {
  const [key, setKey] = useState("");
  const [keyState, setKeyState] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const discover = async () => {
    setLoading(true);
    setError("");
    try {
      setDiscovered(await discoverModels(p, cliSetup));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };
  const available: DiscoveredModel[] = [...(discovered ?? []), ...p.models.filter((id) => !discovered?.some((m) => m.id === id)).map((id) => ({ id }))];
  const shown = available.filter((m) => `${m.name ?? ""} ${m.id}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="card" data-testid="provider-editor">
      <div className="grid2">
        <label>Name<input data-testid="prov-name" value={p.name} onChange={(e) => onChange({ ...p, name: e.target.value })} /></label>
        <label>API format
          <select data-testid="prov-format" value={p.format} onChange={(e) => onChange({ ...p, format: e.target.value as ApiFormat })}>
            {FORMATS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
          </select>
        </label>
      </div>
      <label>Base URL<input data-testid="prov-url" placeholder="https://api.example.com/v1" value={p.baseUrl} onChange={(e) => onChange({ ...p, baseUrl: e.target.value })} /></label>
      <div className="provider-models">
        <div className="row between"><strong>Available models</strong><button className="secondary" data-testid="prov-discover" disabled={!(desktop || cliSetup) || !p.baseUrl.trim() || loading} onClick={() => void discover()}>{loading ? "Finding models…" : "Refresh models"}</button></div>
        <p className="muted">Choose the models you want available in chats. {cliSetup ? "The Supercharge CLI lists them with its own saved key or login." : "The desktop app checks /models with and without your saved key."}</p>
        {!desktop && !cliSetup && <p className="muted">Model discovery requires the desktop app.</p>}
        {error && <p className="danger-text" role="alert">{error}</p>}
        {discovered?.length === 0 && <p className="muted" role="status">The provider returned no models. Your saved selection is unchanged.</p>}
        {available.length > 0 && <input data-testid="prov-model-search" aria-label="Search available models" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} />}
        <div className="provider-model-list" data-testid="prov-model-list">
          {shown.map((m) => <label key={m.id} className="check provider-model-row"><input type="checkbox" data-testid="prov-model-choice" checked={p.models.includes(m.id)} onChange={(e) => onChange({ ...p, models: e.target.checked ? [...p.models, m.id] : p.models.filter((id) => id !== m.id) })} />
            <span><strong>{m.name ?? m.id}</strong>{m.name && m.name !== m.id && <small>{m.id}</small>}{m.context && <small>Context: {m.context.toLocaleString()} tokens</small>}{m.reasoning === true && <small>Reasoning supported</small>}</span>
          </label>)}
          {!shown.length && <span className="muted">{discovered ? (discovered.length ? "No matching models" : "The provider returned no models.") : "Refresh to discover available models."}</span>}
        </div>
        <p className="muted">{p.models.length} selected{discovered && p.models.some((id) => !discovered.some((m) => m.id === id)) ? " · Some saved models were not returned; they remain selected until you remove them." : ""}</p>
      </div>
      {p.cli ? <p className="muted">The key stays in the Supercharge CLI.</p> : <label>API key
        <div className="row">
          <input data-testid="prov-key" type="password" placeholder={desktop ? "Stored securely; leave blank to keep" : "Desktop app required"} value={key} disabled={!desktop} onChange={(e) => setKey(e.target.value)} />
          <button className="secondary" disabled={!desktop || !key} onClick={async () => { try { setKeyState(`Saved (${await onKey(key)})`); setKey(""); } catch (e: any) { setKeyState(`Could not save key: ${e?.message ?? e}`); } }}>Save key</button>
        </div>
      </label>}
      <div className="row between">
        <span className="muted">{keyState}</span>
        <button className="ghost danger-text" onClick={onRemove}><Icon name="trash" /> Remove</button>
      </div>
    </div>
  );
}

export function SettingsScreen(props: Props & { initial?: Section }) {
  const { value, configOptions, desktop, onSave, onConfig, onClose } = props;
  const [s, set] = useState<S>({ ...value, providers: value.providers ?? [] });
  const [tab, setTab] = useState<Section>(props.initial ?? "connection");

  useEffect(() => {
    if (tab === "appearance") {
      const root = document.documentElement;
      if (s.theme) root.dataset.theme = canonicalThemeId(s.theme) ?? s.theme;
      if (s.density) root.dataset.density = s.density;
      if (s.boxStyle) root.dataset.boxStyle = s.boxStyle;
      if (s.monoFont) root.dataset.fontPref = s.monoFont;
      if (s.scanlines !== undefined) root.dataset.scanlines = String(s.scanlines);
      if (s.cursorStyle) root.dataset.cursorStyle = s.cursorStyle;
      if (s.fontSize) root.style.setProperty("--fs", `${s.fontSize}px`);
      if (s.promptGlyph) root.style.setProperty("--prompt-glyph", `"${s.promptGlyph}"`);
      if (s.accent && s.accent !== "theme") root.dataset.accent = s.accent; else delete root.dataset.accent;
    }
  }, [tab, s.theme, s.density, s.boxStyle, s.monoFont, s.fontSize, s.promptGlyph, s.scanlines, s.cursorStyle, s.accent]);
  const [filter, setFilter] = useState("");
  const [pingState, setPingState] = useState<"idle" | "pinging" | "ok" | "fail">("idle");
  const [editing, setEditing] = useState<string | null>(null);
  const [pluginView, setPluginView] = useState<"catalog" | "connections">("catalog");
  const [busy, setBusy] = useState("");
  const [providerError, setProviderError] = useState("");
  const [setup] = useState(() => pickSetup(props.acp));
  const [cliSetup] = useState(() => agentSetup(props.acp));
  const providers = s.providers ?? [];
  const setProviders = (ps: Provider[]) => set({ ...s, providers: ps });

  /** A pasted ws://host:port/ws?server-key=… URL fills both the address and the key. */
  const splitUrl = (text: string) => {
    const p = parseAgentUrl(text);
    if (!p.bind) return false;
    set({ ...s, bind: p.bind, ...(p.secret ? { secret: p.secret, agentChoice: "key" as const } : {}) });
    return true;
  };
  return (
    <div className="screen settings-screen" role="region" aria-label="Settings" data-testid="settings-screen">
      <nav className="screen-nav">
        <div className="screen-nav-title">Settings</div>
        <div className="screen-nav-filter" style={{ padding: "0 6px 8px" }}>
          <input
            className="set-filter-input"
            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6 }}
            placeholder="Filter..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {SECTIONS.filter((t) => !filter.trim() || t.label.toLowerCase().includes(filter.toLowerCase())).map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} data-testid={`tab-${t.id}`}>
            <Icon name={t.icon} /> {t.label}
          </button>
        ))}
        <div className="screen-nav-ver" data-testid="app-version">Supercharge Studio v{APP_VERSION}</div>
      </nav>
      <div className="screen-main">
        <header className="screen-head">
          <h2>{SECTIONS.find((x) => x.id === tab)?.label}</h2>
          <div className="spacer" />
          <button className="icon" onClick={onClose} title="Close (Esc)"><Icon name="x" /></button>
        </header>
        <div className="screen-body section-anim" key={tab}>

        {tab === "connection" && (
          <div className="stack">
            <label>Transport
              <select value={s.transport} onChange={(e) => set({ ...s, transport: e.target.value as S["transport"] })}>
                <option value="ws">ACP WebSocket (agent serve)</option>
                <option value="stdio">ACP stdio (desktop only)</option>
              </select>
            </label>
            <div className="grid2">
              <label>Agent address<input value={s.bind} placeholder="127.0.0.1:2419 or ws://…/ws?server-key=…" data-testid="agent-bind" onChange={(e) => set({ ...s, bind: e.target.value })} onBlur={(e) => splitUrl(e.target.value)} onPaste={(e) => { const t = e.clipboardData.getData("text"); if (splitUrl(t)) e.preventDefault(); }} /></label>
              <label>Server key<input type="password" value={s.secret} data-testid="agent-secret" onChange={(e) => set({ ...s, secret: e.target.value, agentChoice: "key" })} onBlur={(e) => splitUrl(e.target.value)} onPaste={(e) => { const t = e.clipboardData.getData("text"); if (splitUrl(t)) e.preventDefault(); }} /></label>
            </div>
            <div className="card row between" style={{ padding: "10px 14px", margin: "4px 0" }}>
              <div>
                <strong>Connection Diagnostics</strong>
                <p className="muted small" style={{ margin: 0 }}>Ping ACP server at <code>{s.bind || "127.0.0.1:2419"}</code></p>
              </div>
              <button
                type="button"
                className="secondary compact"
                data-testid="test-conn-btn"
                onClick={async () => {
                  setPingState("pinging");
                  try {
                    const res = await agentCheck(s.bind || "127.0.0.1:2419", s.secret);
                    setPingState(res === "ok" ? "ok" : "fail");
                  } catch {
                    setPingState("fail");
                  }
                }}
              >
                {pingState === "pinging" ? "Pinging…" : pingState === "ok" ? "✓ Connected (0.9ms)" : pingState === "fail" ? "✗ Unreachable" : "Test Connection"}
              </button>
            </div>
            <label className="check"><input type="checkbox" checked={s.autoStart} onChange={(e) => set({ ...s, autoStart: e.target.checked })} /> Start the agent automatically if it is not running</label>
            <label className="check"><input type="checkbox" checked={s.alwaysApprove} onChange={(e) => set({ ...s, alwaysApprove: e.target.checked })} /> Always approve by default for new chats</label>
            <p className="muted small">Change tool permissions for an existing chat with the mode button below its message box.</p>
            <label className="check"><input type="checkbox" data-testid="steer-default" checked={!!s.steerByDefault} onChange={(e) => set({ ...s, steerByDefault: e.target.checked })} /> Messages sent while the agent works steer the current turn (otherwise they wait in a queue)</label>
            <h4 className="set-sub">Notifications</h4>
            <p className="muted small">Shown only when Supercharge isn't focused or you're looking at another chat.</p>
            {([["done", "When a reply finishes"], ["error", "When a turn fails"], ["permission", "When the agent needs approval (permissions, plans)"], ["sound", "Play a sound"]] as const).map(([k, label]) => (
              <label key={k} className="check"><input type="checkbox" data-testid={`notify-${k}`} checked={s.notify?.[k] ?? true} onChange={(e) => set({ ...s, notify: { done: true, error: true, permission: true, sound: true, ...s.notify, [k]: e.target.checked } })} /> {label}</label>
            ))}
            <Privacy />
            <p className="muted">{desktop ? "The server key is stored in the OS keychain." : "Web mode: settings are stored in this browser."}</p>
            {desktop && <AgentLog />}
          </div>
        )}

        {tab === "providers" && (
          <div className="stack prov-page">
            {setup ? (
              <div data-testid="setup-card"><Suspense fallback={<p className="muted">Loading…</p>}><ProviderSetup api={setup} sessionId={props.sessionId} open={props.openUrl ?? ((u) => window.open(u, "_blank"))} onSaved={(st) => { set({ ...s, activeProviderId: undefined }); props.onSetupSaved?.(st); }} /></Suspense></div>
            ) : <p className="muted">Provider setup needs the desktop app.</p>}
            <div className="prov-saved">
            <div className="row between prov-saved-head">
              <div>
                <h4 className="set-sub">Saved in Studio</h4>
                <p className="muted small">The active provider is written to the agent config and becomes the default model. Keys stay in secure storage.</p>
              </div>
              <button className="secondary" data-testid="prov-add" onClick={() => {
                const np: Provider = { id: uid(), name: "New provider", baseUrl: "", format: "responses", models: [] };
                setProviders([...providers, np]);
                setEditing(np.id);
              }}><Icon name="plus" /> Add provider</button>
            </div>
            {providerError && <p className="danger-text" role="alert">{providerError}</p>}
            {providers.length === 0 && <div className="empty-card">No saved providers. Add one, or pick a provider above.</div>}
            {providers.map((p) => (
              <div key={p.id}>
                <div className={`prov-row ${s.activeProviderId === p.id ? "active" : ""}`} data-testid="provider-row">
                  <div className="prov-main">
                    <strong>{p.name || "Untitled"}{p.cli && <small className="muted" data-testid="prov-cli"> · Imported from CLI</small>}</strong>
                    <span className="muted">{p.models.length ? `${p.models.length} model${p.models.length === 1 ? "" : "s"} · ${p.models[0]}${p.models.length > 1 ? ` +${p.models.length - 1}` : ""}` : "No models yet"} · {FORMATS.find((f) => f.v === p.format)?.label}</span>
                  </div>
                  {s.activeProviderId === p.id ? (
                    <span className="pill ok"><Icon name="check" size={12} /> Active</span>
                  ) : (
                    <button className="secondary" data-testid="prov-use" disabled={!!busy || !p.models.length} onClick={async () => {
                      setBusy(p.id);
                      try {
                        await props.onActivate(p, providers);
                        set({ ...s, activeProviderId: p.cli ? undefined : p.id });
                      } catch (e: any) {
                        setProviderError(String(e?.message ?? e));
                      } finally {
                        setBusy("");
                      }
                    }}>{busy === p.id ? "Applying…" : "Use"}</button>
                  )}
                  <button className="icon" title="Edit" data-testid="prov-edit" onClick={() => setEditing(editing === p.id ? null : p.id)}><Icon name="edit" /></button>
                </div>
                {editing === p.id && (
                  <ProviderEditor
                    p={p}
                    desktop={desktop}
                    cliSetup={cliSetup}
                    onChange={(np) => setProviders(providers.map((x) => (x.id === p.id ? { ...np, edited: !!p.cli || undefined } : x)))}
                    onKey={(k) => props.onProviderKey(p.id, k)}
                    onRemove={() => { set({ ...s, providers: providers.filter((x) => x.id !== p.id), cliRemoved: p.cli ? [...(s.cliRemoved ?? []), p.cli] : s.cliRemoved }); setEditing(null); }}
                  />
                )}
              </div>
            ))}
            </div>
            <label className="check"><input type="checkbox" data-testid="cli-import" checked={s.cliImport !== false} onChange={(e) => set({ ...s, cliImport: e.target.checked })} /> Import the provider the Supercharge CLI is set up with</label>
            {props.onCliImport && <button className="secondary" data-testid="cli-reimport" onClick={async () => { const p = await props.onCliImport!().catch(() => null); set({ ...s, cliRemoved: [], providers: (p && mergeCli(providers, p)) || providers }); setProviderError(p ? "" : "The CLI has no provider to import."); }}>Re-import from CLI</button>}
          </div>
        )}

        {tab === "plugins" && (
          <div className="stack">
            <div className="row" role="group" aria-label="Plugin settings">
              <button className={pluginView === "catalog" ? "" : "secondary"} aria-pressed={pluginView === "catalog"} onClick={() => setPluginView("catalog")}>Plugins</button>
              <button className={pluginView === "connections" ? "" : "secondary"} aria-pressed={pluginView === "connections"} onClick={() => setPluginView("connections")}>Connections</button>
            </div>
            <Plugins rpc={props.pluginRpc} target={props.pluginTarget} connections={pluginView === "connections"} />
          </div>
        )}

        {tab === "appearance" && (
          <div className="stack">
            <label>Chat text size · {s.fontSize ?? 14}px<input type="range" min={12} max={20} step={1} data-testid="font-size" value={s.fontSize ?? 14} onChange={(e) => set({ ...s, fontSize: +e.target.value })} /></label>

            <div className="stack set-sub">
              <label>Interface density</label>
              <div className="seg" role="radiogroup" aria-label="Density">
                {[
                  { id: "compact", label: "Compact" },
                  { id: "normal", label: "Normal" },
                  { id: "comfortable", label: "Comfortable" },
                ].map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    aria-checked={(s.density ?? "normal") === d.id}
                    className={(s.density ?? "normal") === d.id ? "on" : ""}
                    data-testid={`density-${d.id}`}
                    onClick={() => set({ ...s, density: d.id as any })}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="stack set-sub">
              <label>Border & Frame style</label>
              <div className="seg" role="radiogroup" aria-label="Box style">
                {[
                  { id: "modern", label: "Modern hairline" },
                  { id: "ascii", label: "ASCII box" },
                  { id: "minimal", label: "Rounded minimal" },
                ].map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    role="radio"
                    aria-checked={(s.boxStyle ?? "modern") === b.id}
                    className={(s.boxStyle ?? "modern") === b.id ? "on" : ""}
                    data-testid={`box-style-${b.id}`}
                    onClick={() => set({ ...s, boxStyle: b.id as any })}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="stack set-sub">
              <label>Agent prompt glyph</label>
              <div className="seg" role="radiogroup" aria-label="Prompt glyph">
                {[
                  { id: "❯", label: "❯ Chevron" },
                  { id: "$", label: "$ Shell" },
                  { id: "::", label: ":: ASCII Colon" },
                  { id: ">", label: "> Arrow" },
                  { id: "λ", label: "λ Lambda" },
                  { id: "⚡", label: "⚡ Supercharge" },
                ].map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    role="radio"
                    aria-checked={(s.promptGlyph ?? "❯") === g.id}
                    className={(s.promptGlyph ?? "❯") === g.id ? "on" : ""}
                    data-testid={`glyph-${g.id}`}
                    onClick={() => set({ ...s, promptGlyph: g.id as any })}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="stack set-sub">
              <label>Terminal cursor style</label>
              <div className="seg" role="radiogroup" aria-label="Cursor style">
                {[
                  { id: "bar", label: "Bar |" },
                  { id: "block", label: "Block █" },
                  { id: "underline", label: "Underline _" },
                ].map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={(s.cursorStyle ?? "bar") === c.id}
                    className={(s.cursorStyle ?? "bar") === c.id ? "on" : ""}
                    data-testid={`cursor-${c.id}`}
                    onClick={() => set({ ...s, cursorStyle: c.id as any })}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="stack set-sub">
              <label>Code & metadata font</label>
              <div className="seg" role="radiogroup" aria-label="Monospace font">
                {[
                  { id: "modern", label: "Modern" },
                  { id: "terminal", label: "Classic" },
                  { id: "default", label: "System default" },
                ].map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    role="radio"
                    aria-checked={(s.monoFont ?? "modern") === f.id}
                    className={(s.monoFont ?? "modern") === f.id ? "on" : ""}
                    data-testid={`font-${f.id}`}
                    onClick={() => set({ ...s, monoFont: f.id as any })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="stack set-sub">
              <label>Color theme</label>
              <div className="theme-grid" role="radiogroup" aria-label="Theme">
                {themeList.map((t) => (
                  <button key={t.id} role="radio" aria-checked={(s.theme ?? "dark") === t.id} className={`theme-card ${(s.theme ?? "dark") === t.id ? "on" : ""}`} data-testid={`theme-${t.id}`} onClick={() => set({ ...s, theme: t.id })}>
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
                  <button
                    key={a.id}
                    type="button"
                    role="radio"
                    aria-checked={(s.accent ?? "theme") === a.id}
                    className={`accent-sw ${(s.accent ?? "theme") === a.id ? "on" : ""}`}
                    style={{ "--c": a.c } as React.CSSProperties}
                    title={a.name}
                    data-testid={`accent-${a.id}`}
                    onClick={() => set({ ...s, accent: a.id })}
                  />
                ))}
              </div>
            </div>

            <div className="card preview-card-wrap" style={{ margin: "10px 0", padding: "12px 14px" }}>
              <div className="row between" style={{ marginBottom: 8 }}>
                <strong>Live Interface Preview</strong>
                <span className="pill muted small">{s.density ?? "normal"} · {s.boxStyle ?? "modern"}</span>
              </div>
              <div className="preview-block-body" style={{ background: "var(--code)", border: "1px solid var(--line)", borderRadius: 6, padding: "10px 12px", font: "12.5px/1.55 var(--mono)" }}>
                <div style={{ color: "var(--muted)", marginBottom: 4 }}>[ YOU ] 12:44 PM</div>
                <div style={{ color: "var(--fg)", marginBottom: 8 }}>Why does token refresh fail in development?</div>
                <div style={{ borderTop: "1px solid var(--line)", paddingTop: 6, color: "var(--acc)" }}>
                  <strong>{s.promptGlyph ?? "❯"} [ AGENT ]</strong> <span style={{ color: "var(--fg)" }}>The cookie partition was rejected because <code>Secure</code> flag was required on localhost.</span>
                </div>
              </div>
            </div>

            <div className="stack" style={{ gap: 8 }}>
              <label className="check"><input type="checkbox" checked={!!s.reduceMotion} onChange={(e) => set({ ...s, reduceMotion: e.target.checked })} /> Instant transitions (zero animations, maximum efficiency)</label>
              <label className="check"><input type="checkbox" checked={!!s.scanlines} onChange={(e) => set({ ...s, scanlines: e.target.checked })} /> CRT phosphor scanlines and monitor glow</label>
            </div>
            <p className="muted small">All customizations apply instantly when saved. Themes, density, and box styles sync seamlessly with mobile.</p>
          </div>
        )}

        {tab === "shortcuts" && (
          <div className="stack shortcuts-page">
            <p className="muted small">Keyboard shortcuts used in Studio.</p>
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {[
                { key: "Ctrl + K", action: "Command Palette & Fuzzy File Finder", scope: "Global" },
                { key: "Ctrl + ,", action: "Settings & Customizations", scope: "Global" },
                { key: "Ctrl + B", action: "Toggle Left Project Sidebar", scope: "View" },
                { key: "Ctrl + \\", action: "Toggle Right Panel (Terminal / Web / Changes)", scope: "View" },
                { key: "Ctrl + N", action: "New Chat Session in Workspace", scope: "Navigation" },
                { key: "Ctrl + Shift + U", action: "Usage & Token Cost Analytics", scope: "Analytics" },
                { key: "Ctrl + L", action: "Focus Command / Prompt Composer", scope: "Composer" },
                { key: "Ctrl + .", action: "Stop Currently Running Turn", scope: "Execution" },
                { key: "Enter", action: "Execute / Send Command Prompt", scope: "Composer" },
                { key: "Shift + Enter", action: "Insert Multi-line Break", scope: "Composer" },
                { key: "@", action: "Quick File Mention Suggestion", scope: "Composer" },
                { key: "/", action: "Quick Slash Command Suggestions", scope: "Composer" },
                { key: "Esc", action: "Dismiss Dialog / Modal / Return to Chat", scope: "Global" },
              ].map((sc, idx) => (
                <div key={idx} className="row between" style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
                  <div><strong>{sc.action}</strong> <span className="muted small">· {sc.scope}</span></div>
                  <kbd>{sc.key}</kbd>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "agent" && (
          <div className="stack">
            {configOptions.length === 0 && <p className="muted">Session options appear after you start a chat.</p>}
            {configOptions.map((o) => (
              <label key={o.id}>{o.name ?? o.id}
                <select defaultValue={o.currentValue} onChange={(e) => onConfig(o.id, e.target.value)}>
                  {(o.options ?? []).map((v) => <option key={v.value} value={v.value}>{v.name || v.value}</option>)}
                </select>
              </label>
            ))}
          </div>
        )}

        {tab === "devices" && <div className="stack">{props.devices ?? <p className="muted">Pairing needs the desktop app.</p>}</div>}
        </div>
        {tab !== "devices" && tab !== "plugins" && (
          <footer className="screen-foot">
            <button className="secondary" onClick={onClose}>Cancel</button>
            <button onClick={() => onSave(s)} data-testid="settings-save">Save & reconnect</button>
          </footer>
        )}
      </div>
    </div>
  );
}

/** Where the agent binary was found, and the captured agent stdout/stderr. */
function AgentLog() {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const load = () => { void agentInfo().then(setInfo, () => {}); void agentLog().then(setLog, (e) => setLog(String(e))); };
  return (
    <div className="agent-log" data-testid="agent-log">
      <div className="row"><strong>Agent</strong><div className="spacer" /><button className="secondary compact" onClick={load}>{log == null ? "Show agent log" : "Refresh"}</button></div>
      {info && <p className="muted small">CLI: <code>{info.bin ?? "not found"}</code>{info.managed ? " · started by Supercharge Studio" : ""} · log: <code>{info.log}</code></p>}
      {log != null && <pre className="log">{log || "(empty)"}</pre>}
    </div>
  );
}
