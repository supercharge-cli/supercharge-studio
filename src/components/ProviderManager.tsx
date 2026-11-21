import { KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { errText, filterInfo, formatChoices, isMissingMethod, isSetUp, keyOptional, removable, signInKinds, takesKey, untilReady, signInFlow, type ProviderInfo, type ProvidersApi, type ProvidersList, type WireFormat } from "../lib/providers";
import { CUSTOM_MODEL, filterModels, type AuthKind, type AuthStart, type SetupModel } from "../lib/setup";
import { track } from "../lib/track";
import { Icon } from "./Icon";
import "./provider-setup.css";

type Step = "home" | "pick" | "detail" | "custom" | "auth" | "model" | "typed" | "busy" | "error" | "done";
const TITLE: Record<Step, string> = { home: "Providers", pick: "Add new provider", detail: "", custom: "Custom provider", auth: "Sign in", model: "Choose a model", typed: "Model id", busy: "Working", error: "Could not continue", done: "Saved" };
const CUSTOM_ROW = "__custom_provider__";

/** One status word per provider, from what the CLI reports. */
function state(p: ProviderInfo): { text: string; ok: boolean } {
  if (p.active) return { text: "Active", ok: true };
  if (p.signedIn === true) return { text: "Signed in", ok: true };
  if (p.hasApiKey) return { text: "Key saved", ok: true };
  if (keyOptional(p)) return { text: "Local, no key needed", ok: true };
  if (signInKinds(p).length && !takesKey(p)) return { text: "Sign in needed", ok: false };
  return { text: p.ready ? "Ready" : "Needs a key", ok: !!p.ready };
}
const how = (p: ProviderInfo) => [signInKinds(p).includes("browser") && "Browser sign-in", signInKinds(p).includes("device") && "Sign in with a code", keyOptional(p) ? "Local server" : takesKey(p) && "API key"].filter(Boolean).join(" · ");

/**
 * Settings → Providers when the CLI offers its provider catalogue: every provider, sign-in and
 * custom endpoint comes from the CLI, and every change goes back through it. A CLI from before the
 * catalogue answers method-not-found; then `fallback` (the older setup) is shown with a note.
 */
export default function ProviderManager({ api, open, onSaved, sessionId, fallback, onClose, onReady }: { api: ProvidersApi; open: (url: string) => void; onSaved?: (r: unknown) => void; sessionId?: () => string | undefined; fallback: ReactNode; onClose?: () => void; onReady?: (cliOwns: boolean) => void }) {
  const [list, setList] = useState<ProvidersList | null>(null);
  const [mode, setMode] = useState<"loading" | "ready" | "old" | "failed">("loading");
  const [loadErr, setLoadErr] = useState("");
  const [step, setStep] = useState<Step>("home");
  const [prov, setProv] = useState<ProviderInfo | null>(null);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState(0);
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [models, setModels] = useState<SetupModel[]>([]);
  const [typed, setTyped] = useState("");
  const [cust, setCust] = useState<{ name: string; baseUrl: string; format: WireFormat; apiKey: string; validate: boolean }>({ name: "", baseUrl: "", format: "openai", apiKey: "", validate: true });
  const [login, setLogin] = useState<AuthStart | null>(null);
  const [busyText, setBusyText] = useState("");
  const [err, setErr] = useState<{ msg: string; back: Step }>({ msg: "", back: "home" });
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState("");
  const gen = useRef(0);
  const loginId = useRef("");

  const cancelLogin = () => { const id = loginId.current; loginId.current = ""; if (id) void api.authCancel(id).catch(() => {}); };
  async function refresh() {
    try { const l = await api.list(); setList(l); setMode("ready"); onReady?.(true); return l; }
    catch (e) { if (isMissingMethod(e)) setMode("old"); else { setLoadErr(errText(e)); setMode((m) => (m === "ready" ? m : "failed")); } return null; }
  }
  useEffect(() => { void refresh(); return () => { gen.current++; cancelLogin(); }; }, [api]);

  if (mode === "old") return <div className="stack" data-testid="prov-fallback"><p className="psetup-note" data-testid="prov-update-cli"><Icon name="alert" size={14} /> Update the Supercharge CLI to add and manage every provider here, including sign-ins and custom providers. This version offers the basic setup below.</p>{fallback}</div>;
  if (mode === "loading") return <p className="muted psetup-wait" role="status"><i className="psetup-spin" /> Loading providers from the CLI…</p>;
  if (mode === "failed") return <div className="stack" data-testid="prov-load-error"><p className="danger-text" role="alert">Could not load providers from the CLI: {loadErr}</p><div className="row"><button className="secondary" onClick={() => { setMode("loading"); void refresh(); }}>Retry</button></div>{fallback}</div>;

  const all = list?.providers ?? [];
  const setUp = all.filter(isSetUp);
  const active = all.find((p) => p.id === list?.activeProviderId) ?? all.find((p) => p.active);
  const go = (s: Step) => { setStep(s); setSel(0); setFilter(""); setConfirm(""); };
  const fail = (e: unknown, back: Step) => { if ((e as any)?.message === "cancelled") return; setErr({ msg: errText(e), back }); setStep("error"); };
  const busy = (t: string) => { setBusyText(t); setStep("busy"); return ++gen.current; };
  const latest = (id: string) => all.find((p) => p.id === id);
  const copy = (t: string, what: string) => { void navigator.clipboard?.writeText(t).then(() => { setCopied(what); setTimeout(() => setCopied(""), 1500); }); };

  function openDetail(p: ProviderInfo) { setProv(p); setKey(""); setReveal(false); setNote(""); go("detail"); }
  function choose(id: string) {
    if (id === CUSTOM_ROW) { setCust({ name: "", baseUrl: "", format: "openai", apiKey: "", validate: true }); setReveal(false); return go("custom"); }
    const p = latest(id); if (p) openDetail(p);
  }
  async function fetchModels(p: ProviderInfo, back: Step, have?: SetupModel[]) {
    const g = busy(`Fetching models from ${p.name}…`);
    try {
      const m = have?.length ? have : await api.models(p.id);
      if (g !== gen.current) return;
      setProv(p); setModels(m); setTyped(p.defaultModel ?? ""); go("model");
    } catch (e) { if (g === gen.current) fail(e, back); }
  }
  async function saveKey(p: ProviderInfo) {
    const k = key.trim();
    const g = busy(`Checking the key with ${p.name}…`);
    try {
      const r = await api.setKey(p.id, k);
      setKey(""); setReveal(false);
      if (g !== gen.current) return;
      track("feature_used", { feature: "provider_setup" });
      const l = await refresh();
      const np = l?.providers.find((x) => x.id === p.id) ?? r.provider ?? p;
      await fetchModels(np, "detail", r.models);
    } catch (e) { setKey(""); if (g === gen.current) fail(e, "detail"); }
  }
  async function signIn(p: ProviderInfo, kind: AuthKind) {
    const g = ++gen.current;
    setLogin(null); setBusyText("Starting sign-in…"); setStep("auth");
    try {
      await signInFlow(api, p.id, kind, {
        cancelled: () => g !== gen.current,
        shown: (s) => { loginId.current = s.loginId; setLogin(s); if (/^https:\/\//i.test(s.url)) open(s.url); },
      });
      loginId.current = "";
      if (g !== gen.current) return;
      setBusyText("Signed in. Checking the provider…");
      const np = await untilReady(api, p.id);
      track("feature_used", { feature: "provider_setup" });
      await refresh();
      if (g === gen.current) await fetchModels(np, "detail");
    } catch (e) { loginId.current = ""; if (g === gen.current) fail(e, "detail"); }
  }
  async function addCustom() {
    const g = busy(cust.validate ? "Checking the endpoint…" : "Saving the provider…");
    try {
      const r = await api.addCustom({ name: cust.name.trim(), baseUrl: cust.baseUrl.trim(), format: cust.format, apiKey: cust.apiKey.trim() || undefined, validate: cust.validate });
      setCust((c) => ({ ...c, apiKey: "" })); setReveal(false);
      if (g !== gen.current) return;
      track("feature_used", { feature: "provider_setup" });
      await refresh();
      await fetchModels(r.provider, "home", r.models);
    } catch (e) { setCust((c) => ({ ...c, apiKey: "" })); if (g === gen.current) fail(e, "custom"); }
  }
  async function use(modelId: string, modelName?: string) {
    const p = prov!; const g = busy("Saving…");
    try {
      const r = await api.use(p.id, modelId, modelName, sessionId?.() || undefined);
      if (g !== gen.current) return;
      await refresh(); setNote(`${p.name} · ${r?.modelId ?? modelId}`); go("done"); onSaved?.(r);
    } catch (e) { if (g === gen.current) fail(e, "model"); }
  }
  async function remove(p: ProviderInfo) {
    const g = busy(`Removing ${p.name}…`);
    try { await api.remove(p.id); if (g === gen.current) { await refresh(); go("home"); } }
    catch (e) { if (g === gen.current) fail(e, "home"); }
  }
  const listKeys = (n: number, enter: () => void) => (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, n - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); enter(); }
  };

  const picks = [...filterInfo(all, filter).map((p) => p.id), ...(!filter.trim() || /custom|url|endpoint/i.test(filter) ? [CUSTOM_ROW] : [])];
  const shownModels = filterModels(models, filter);
  const p = prov && (latest(prov.id) ?? prov);
  const back: Partial<Record<Step, Step>> = { pick: "home", detail: setUp.some((x) => x.id === p?.id) && step === "detail" && !filter ? "home" : "pick", custom: "pick", auth: "detail", model: "detail", typed: "model", error: err.back, done: "home" };
  if (p?.custom) back.model = "home";
  const fmts = formatChoices(all);

  return (
    <div className="psetup" data-testid="provider-manager">
      <div className="psetup-head">
        {back[step] && step !== "busy" && <button className="icon" aria-label="Back" data-testid="pm-back" onClick={() => { gen.current++; if (step === "auth") cancelLogin(); go(back[step]!); }}><Icon name="arrowLeft" size={15} /></button>}
        <h3>{step === "detail" ? p?.name : TITLE[step]}</h3>
        <span className="spacer" />
        {step === "home" && <button className="secondary compact" data-testid="pm-add" onClick={() => go("pick")}><Icon name="plus" size={14} /> Add new provider</button>}
        {onClose && <button className="icon" aria-label="Close" onClick={onClose}><Icon name="x" size={15} /></button>}
      </div>

      {step === "home" && <>
        <p className="psetup-current" data-testid="pm-current">{active ? <>Using <b>{active.name}</b>{list?.activeModelId ? <> · <code>{list.activeModelId}</code></> : null}</> : "No provider is active yet. Add one to start chatting."}</p>
        {setUp.length === 0 && <div className="empty-card" data-testid="pm-empty">No providers set up in the CLI yet.</div>}
        {setUp.map((x) => {
          const st = state(x);
          return (
            <div key={x.id} className={`prov-row ${x.active ? "active" : ""}`} data-testid={`pm-row-${x.id}`}>
              <div className="prov-main">
                <strong>{x.name}{x.custom && <small className="muted"> · Custom</small>}</strong>
                <span className="muted">{[x.formatName, x.custom ? x.baseUrl : x.description].filter(Boolean).join(" · ")}</span>
              </div>
              <span className={`pill ${st.ok ? "ok" : ""}`} data-testid="pm-state">{st.ok && <Icon name="check" size={12} />} {st.text}</span>
              {confirm === x.id ? <>
                <span className="muted small">Remove?</span>
                <button className="secondary compact danger-text" data-testid="pm-remove-yes" onClick={() => void remove(x)}>Remove</button>
                <button className="ghost compact" onClick={() => setConfirm("")}>Keep</button>
              </> : <>
                <button className="secondary compact" data-testid="pm-use" disabled={!x.ready} title={x.ready ? "" : "Add a key or sign in first"} onClick={() => void fetchModels(x, "home")}>{x.active ? "Change model" : "Use"}</button>
                <button className="icon" title="Edit" aria-label={`Edit ${x.name}`} data-testid="pm-edit" onClick={() => openDetail(x)}><Icon name="edit" /></button>
                {removable(x) && <button className="icon" title="Remove" aria-label={`Remove ${x.name}`} data-testid="pm-remove" onClick={() => setConfirm(x.id)}><Icon name="trash" /></button>}
              </>}
            </div>
          );
        })}
        {list?.configPath && <p className="muted small">Saved by the Supercharge CLI in <code>{list.configPath}</code>. The CLI's /setup shows the same providers.</p>}
      </>}

      {step === "pick" && <>
        <input autoFocus data-testid="pm-filter" placeholder="Search providers" value={filter} onChange={(e) => { setFilter(e.target.value); setSel(0); }} onKeyDown={listKeys(picks.length, () => picks[sel] && choose(picks[sel]))} />
        <div className="psetup-list" role="listbox" aria-label="Providers">
          {picks.map((id, i) => {
            const x = id === CUSTOM_ROW ? null : latest(id);
            return (
              <button key={id} role="option" aria-selected={i === sel} className={`psetup-row ${i === sel ? "on" : ""}`} data-testid={`pm-p-${id === CUSTOM_ROW ? "custom" : id}`} onMouseEnter={() => setSel(i)} onClick={() => choose(id)}>
                {x ? <><b>{x.name}{isSetUp(x) && <small className="psetup-tag ok"> · {state(x).text}</small>}</b><span>{[x.description, how(x)].filter(Boolean).join(" · ")}</span></>
                  : <><b>Custom provider</b><span>Any compatible endpoint: paste a base URL</span></>}
              </button>
            );
          })}
          {!picks.length && <p className="muted small">No providers match.</p>}
        </div>
      </>}

      {step === "detail" && p && <div className="psetup-form" data-testid="pm-detail">
        {p.description && <p className="muted small">{p.description}</p>}
        <p className="muted small" data-testid="pm-meta">{[p.formatName, p.baseUrl].filter(Boolean).join(" · ")} · <span data-testid="pm-detail-state">{state(p).text}</span></p>
        {signInKinds(p).map((k) => (
          <button key={k} data-testid={`pm-signin-${k}`} className={takesKey(p) ? "secondary" : ""} onClick={() => void signIn(p, k)}>
            <Icon name="globe" size={14} /> {p.signedIn ? "Sign in again" : k === "browser" ? "Sign in with your browser" : "Sign in with a code"}
          </button>
        ))}
        {takesKey(p) && <form className="psetup-form" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void saveKey(p); else if (p.ready) void fetchModels(p, "detail"); }}>
          <label>{keyOptional(p) ? "API key (optional, only for protected servers)" : "API key"}
            <span className="psetup-key">
              <input autoFocus={!signInKinds(p).length} data-testid="pm-key" type={reveal ? "text" : "password"} autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.hasApiKey ? "Key saved. Paste a new one to replace it" : keyOptional(p) ? "Optional" : "Paste your API key"} />
              <button type="button" className="ghost" data-testid="pm-reveal" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
            </span>
          </label>
          <p className="muted small">The CLI checks the key by listing the provider's models, then keeps it in its own config. Studio never stores it.</p>
          <div className="row">
            <button data-testid="pm-save-key" disabled={!key.trim() && !p.ready}>{key.trim() ? "Save key" : "Choose a model"}</button>
          </div>
        </form>}
        {!takesKey(p) && p.ready && <button className="secondary" data-testid="pm-models" onClick={() => void fetchModels(p, "detail")}>Choose a model</button>}
        {removable(p) && <button className="ghost compact danger-text" data-testid="pm-detail-remove" onClick={() => void remove(p)}><Icon name="trash" size={14} /> {p.custom ? "Remove provider" : p.signedIn ? "Sign out" : "Forget key"}</button>}
        {p.active && <p className="muted small">This is the active provider. Switch to another one before removing it.</p>}
      </div>}

      {step === "custom" && <form className="psetup-form" data-testid="pm-custom" onSubmit={(e) => { e.preventDefault(); if (cust.name.trim() && cust.baseUrl.trim()) void addCustom(); }}>
        <label>Name<input autoFocus data-testid="pm-c-name" value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} placeholder="My gateway" required /></label>
        <label>Base URL<input data-testid="pm-c-url" value={cust.baseUrl} onChange={(e) => setCust({ ...cust, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" required /></label>
        <label>API format
          <select data-testid="pm-c-format" value={cust.format} onChange={(e) => setCust({ ...cust, format: e.target.value as WireFormat })}>
            {fmts.map(([f, n]) => <option key={f} value={f}>{n}</option>)}
          </select>
        </label>
        <label>API key <span className="muted">(optional for local servers)</span>
          <span className="psetup-key">
            <input data-testid="pm-c-key" type={reveal ? "text" : "password"} autoComplete="off" spellCheck={false} value={cust.apiKey} onChange={(e) => setCust({ ...cust, apiKey: e.target.value })} placeholder="Optional" />
            <button type="button" className="ghost" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
          </span>
        </label>
        <label className="check"><input type="checkbox" style={{ width: "auto" }} data-testid="pm-c-validate" checked={cust.validate} onChange={(e) => setCust({ ...cust, validate: e.target.checked })} /> Check the endpoint by listing its models</label>
        <p className="muted small">http:// works only for this computer (localhost). The CLI saves the provider; pick a model next to start using it.</p>
        <button data-testid="pm-c-save" disabled={!cust.name.trim() || !cust.baseUrl.trim()}>Add provider</button>
      </form>}

      {step === "auth" && <div className="psetup-device" data-testid="pm-auth">
        {login?.url ? <>
          <p>{login.kind === "browser" ? `Finish signing in to ${p?.name} in your browser. The CLI saves the result itself.` : `Sign in to ${p?.name} on this or any device:`}</p>
          <ol>
            <li>Open: <a href={login.url} target="_blank" rel="noreferrer" data-testid="pm-auth-url" onClick={(e) => { e.preventDefault(); open(login.url); }}>{login.url}</a></li>
            {login.userCode && <li>If asked, enter this code:</li>}
          </ol>
          {login.userCode && <div className="psetup-code"><code data-testid="pm-auth-code">{login.userCode}</code><button className="secondary compact" data-testid="pm-copy-code" onClick={() => copy(login.userCode!, "code")}>{copied === "code" ? "Copied" : "Copy code"}</button></div>}
          <div className="row">
            <button className="secondary compact" data-testid="pm-open" onClick={() => open(login.url)}><Icon name="globe" size={14} /> Open in browser</button>
            <button className="ghost compact" data-testid="pm-copy-url" onClick={() => copy(login.url, "url")}>{copied === "url" ? "Copied" : "Copy link"}</button>
          </div>
          <p className="muted small psetup-wait"><i className="psetup-spin" /> Waiting for you to approve…</p>
        </> : <p className="muted small psetup-wait"><i className="psetup-spin" /> {busyText}</p>}
        <button className="ghost compact" data-testid="pm-cancel-login" onClick={() => { gen.current++; cancelLogin(); go("detail"); }}>Cancel</button>
      </div>}

      {step === "busy" && <p className="muted psetup-wait" role="status"><i className="psetup-spin" /> {busyText}</p>}

      {step === "error" && <div className="psetup-form">
        <p className="danger-text" role="alert" data-testid="pm-error">{err.msg}</p>
        <div className="row"><button data-testid="pm-retry" onClick={() => go(err.back)}>Back</button></div>
      </div>}

      {step === "model" && <>
        <input autoFocus data-testid="pm-model-filter" placeholder="Search models" value={filter} onChange={(e) => { setFilter(e.target.value); setSel(0); }} onKeyDown={listKeys(shownModels.length, () => { const m = shownModels[sel]; if (m) m.id === CUSTOM_MODEL ? go("typed") : void use(m.id, m.name); })} />
        <div className="psetup-list" role="listbox" aria-label="Models">
          {shownModels.map((m, i) => (
            <button key={m.id} role="option" aria-selected={i === sel} className={`psetup-row ${i === sel ? "on" : ""}`} data-testid="pm-model" onMouseEnter={() => setSel(i)} onClick={() => (m.id === CUSTOM_MODEL ? go("typed") : void use(m.id, m.name))}>
              <b>{m.name}</b>{m.id !== m.name && m.id !== CUSTOM_MODEL && <span>{m.id}</span>}{m.context && <span>{Math.round(m.context / 1000)}k context</span>}
            </button>
          ))}
        </div>
        <p className="muted small">{models.length} models from {p?.name}, listed live by the CLI</p>
      </>}

      {step === "typed" && <form className="psetup-form" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) void use(typed.trim()); }}>
        <label>Model id<input autoFocus data-testid="pm-typed" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="vendor/model" required /></label>
        <button data-testid="pm-typed-save" disabled={!typed.trim()}>Use this model</button>
      </form>}

      {step === "done" && <div className="psetup-form" data-testid="pm-done">
        <p><Icon name="check" size={14} /> Now using <code>{note}</code></p>
        <p className="muted small">Open chats switched to it, and new chats use it too.</p>
        <button data-testid="pm-done-ok" onClick={() => go("home")}>Done</button>
      </div>}
    </div>
  );
}
