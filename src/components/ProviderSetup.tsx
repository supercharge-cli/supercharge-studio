import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { applyCli, mergeCli, readCli, rpcSetup, CUSTOM, CUSTOM_MODEL, FORMATS, filterModels, filterProviders, keyReusable, pollDevice, type DeviceStart, type Fmt, type SetupApi, type SetupModel, type SetupProvider, type SetupStatus } from "../lib/setup";
import type { Provider } from "../lib/store";
import { Icon } from "./Icon";
import "./provider-setup.css";

type Step = "provider" | "url" | "format" | "key" | "device" | "busy" | "error" | "model" | "custom" | "done";
const TITLE: Record<Step, string> = { provider: "choose provider", url: "base URL", format: "API format", key: "API key", device: "Nous Portal login", busy: "working", error: "error", model: "choose model", custom: "custom model id", done: "saved" };

/**
 * The CLI's `/setup` wizard: provider → (base URL) → API format → API key → model, or the
 * Nous Research device-code login. Saves to the Supercharge config the CLI reads.
 */
export default function ProviderSetup({ api, open, onSaved, onClose, sessionId }: { api: SetupApi; open: (url: string) => void; onSaved?: (s: SetupStatus) => void; onClose?: () => void; sessionId?: () => string | undefined }) {
  const [step, setStep] = useState<Step>("provider");
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [filter, setFilter] = useState("");
  const [sel, setSel] = useState(0);
  const [prov, setProv] = useState<SetupProvider>(CUSTOM);
  const [url, setUrl] = useState("");
  const [fmt, setFmt] = useState<Fmt>("chat_completions");
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [models, setModels] = useState<SetupModel[]>([]);
  const [custom, setCustom] = useState("");
  const [customName, setCustomName] = useState("");
  const [customBack, setCustomBack] = useState<Step>("model");
  const [busyText, setBusyText] = useState("");
  const [err, setErr] = useState<{ msg: string; back: Step }>({ msg: "", back: "provider" });
  const [device, setDevice] = useState<DeviceStart | null>(null);
  const [copied, setCopied] = useState("");
  const gen = useRef(0);
  useEffect(() => { void api.status().then(setStatus, () => {}); return () => { gen.current++; void api.deviceCancel().catch(() => {}); }; }, [api]);

  const go = (s: Step) => { setStep(s); setSel(0); setFilter(""); };
  const fail = (e: any, back: Step) => { setErr({ msg: String(e?.message ?? e), back }); setStep("error"); };
  // Like the CLI: a blank key reuses the saved one only for the same base URL.
  const keepKey = keyReusable(status, url);
  const apiKey = (p: SetupProvider, u = url) => (key.trim() && !p.device ? key.trim() : p.device || keyReusable(status, u) ? undefined : "");

  async function fetchModels(back: Step, p = prov, u = url, f = fmt) {
    const g = ++gen.current;
    setBusyText("Fetching models from the provider…"); setStep("busy");
    try {
      const m = await api.models(p.id, u, apiKey(p, u), f);
      if (g !== gen.current) return;
      setModels(m); go("model");
    } catch (e) { if (g === gen.current) fail(e, back); }
  }
  async function save(modelId: string, modelName?: string, back: Step = "model") {
    const g = ++gen.current;
    setBusyText("Saving provider configuration…"); setStep("busy");
    try {
      const s = await api.save({ providerId: prov.id, baseUrl: url, apiKey: apiKey(prov), format: fmt, modelId, modelName: modelName && modelName !== modelId ? modelName : undefined, sessionId: sessionId?.() || undefined });
      if (g !== gen.current) return;
      setStatus(s); setStep("done"); onSaved?.(s);
    } catch (e) { if (g === gen.current) fail(e, back); }
  }
  async function deviceLogin(p: SetupProvider) {
    const g = ++gen.current;
    setDevice(null); setBusyText("Starting Nous Portal login…"); setStep("device");
    try {
      const d = await api.deviceStart();
      if (g !== gen.current) return;
      setDevice(d); open(d.verificationUri);
      await pollDevice(api, d.interval, d.expiresIn, () => g !== gen.current);
      if (g !== gen.current) return;
      setStatus((s) => s && { ...s, nousSignedIn: true });
      void fetchModels("provider", p, p.baseUrl, p.format);
    } catch (e: any) { if (g === gen.current && e?.message !== "cancelled") fail(e, "provider"); }
  }
  function choose(p: SetupProvider) {
    setProv(p); setFmt(p.format); setUrl(p.baseUrl); setKey(""); setReveal(false); setCustom(""); setCustomName("");
    if (p.id === CUSTOM.id) { setUrl(status?.providerId === "custom" ? status.baseUrl ?? "" : ""); return go("url"); }
    if (p.device) return void (status?.nousSignedIn ? fetchModels("provider", p, p.baseUrl, p.format) : deviceLogin(p));
    go("format"); setSel(FORMATS.findIndex(([f]) => f === p.format));
  }

  const providers = filterProviders(filter);
  const shownModels = filterModels(models, filter);
  const pickModel = (m: SetupModel) => (m.id === CUSTOM_MODEL ? (setCustom(custom || prov.defaultModel), setCustomName(""), setCustomBack("model"), setStep("custom")) : void save(m.id, m.name));
  const listKeys = (n: number, enter: () => void) => (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, n - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); enter(); }
  };
  const back: Partial<Record<Step, Step>> = { url: "provider", format: prov.id === CUSTOM.id ? "url" : "provider", key: "format", model: prov.device ? "provider" : "key", custom: customBack, error: err.back, device: "provider", done: "provider" };
  const copy = (t: string, what: string) => { void navigator.clipboard?.writeText(t).then(() => { setCopied(what); setTimeout(() => setCopied(""), 1500); }); };
  const fmtName = FORMATS.find(([f]) => f === fmt)?.[1];
  const current = status?.model ? `${[...filterProviders(""), CUSTOM].find((p) => p.id === status.providerId)?.name ?? status.providerId ?? "Custom"} · ${status.model}` : "";

  return (
    <div className="psetup" data-testid="provider-setup">
      <div className="psetup-head">
        {back[step] && step !== "busy" && <button className="icon" aria-label="Back" data-testid="setup-back" onClick={() => { gen.current++; if (step === "device") void api.deviceCancel().catch(() => {}); go(back[step]!); }}><Icon name="arrowLeft" size={15} /></button>}
        <b>Provider setup · {TITLE[step]}</b>
        <span className="spacer" />
        {onClose && <button className="icon" aria-label="Close" onClick={onClose}><Icon name="x" size={15} /></button>}
      </div>
      {current && step === "provider" && <p className="muted small" data-testid="setup-current">Current: {current}</p>}

      {step === "provider" && <>
        <input autoFocus data-testid="setup-filter" placeholder="type to filter providers" value={filter} onChange={(e) => { setFilter(e.target.value); setSel(0); }} onKeyDown={listKeys(providers.length, () => providers[sel] && choose(providers[sel]))} />
        <div className="psetup-list" role="listbox" aria-label="Providers">
          {providers.map((p, i) => (
            <button key={p.id} role="option" aria-selected={i === sel} className={`psetup-row ${i === sel ? "on" : ""} ${p.id === "pollinations" ? "rec" : ""}`} data-testid={`setup-p-${p.id}`} onMouseEnter={() => setSel(i)} onClick={() => choose(p)}>
              <b>{p.name}</b>{p.description && <span>{p.description}</span>}
            </button>
          ))}
          {!providers.length && <p className="muted small">No providers match.</p>}
        </div>
      </>}

      {step === "url" && <form className="psetup-form" onSubmit={(e) => { e.preventDefault(); if (url.trim()) { go("format"); setSel(FORMATS.findIndex(([f]) => f === fmt)); } }}>
        <label>Provider base URL (without the inference endpoint)<input autoFocus data-testid="setup-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1" /></label>
        <p className="muted small">Example: https://api.example.com/v1 or http://127.0.0.1:11434/v1</p>
        <button disabled={!url.trim()} data-testid="setup-next">Continue</button>
      </form>}

      {step === "format" && <div className="psetup-list" role="radiogroup" aria-label="API format" tabIndex={0} onKeyDown={listKeys(FORMATS.length, () => { setFmt(FORMATS[sel][0]); go("key"); })}>
        {FORMATS.map(([f, name, path], i) => (
          <button key={f} role="radio" aria-checked={i === sel} className={`psetup-row ${i === sel ? "on" : ""}`} data-testid={`setup-f-${f}`} onClick={() => { setFmt(f); go("key"); }}><b>{name}</b><span>{path}</span></button>
        ))}
      </div>}

      {step === "key" && <form className="psetup-form" onSubmit={(e) => { e.preventDefault(); void fetchModels("key"); }}>
        <label>API key (leave blank for local endpoints)
          <span className="psetup-key">
            <input autoFocus data-testid="setup-key" type={reveal ? "text" : "password"} autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={keepKey ? "Saved key, leave blank to keep it" : prov.keyOptional ? "Optional" : "Paste your API key"} />
            <button type="button" className="ghost" data-testid="setup-reveal" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
          </span>
        </label>
        <p className="muted small">{prov.name} · {fmtName} API · {url}</p>
        <div className="row">
          <button data-testid="setup-fetch">Fetch models</button>
          <button type="button" className="secondary" data-testid="setup-enter-model" onClick={() => { setCustom(custom || prov.defaultModel); setCustomName(""); setCustomBack("key"); go("custom"); }}>Enter model id…</button>
        </div>
      </form>}

      {step === "device" && <div className="psetup-device" data-testid="setup-device">
        {device ? <>
          <p>To continue:</p>
          <ol>
            <li>Open: <a href={device.verificationUri} target="_blank" rel="noreferrer" data-testid="setup-device-url" onClick={(e) => { e.preventDefault(); open(device.verificationUri); }}>{device.verificationUri}</a></li>
            <li>If prompted, enter code:</li>
          </ol>
          <div className="psetup-code"><code data-testid="setup-code">{device.userCode}</code><button className="secondary compact" data-testid="setup-copy-code" onClick={() => copy(device.userCode, "code")}>{copied === "code" ? "Copied" : "Copy code"}</button></div>
          <div className="row">
            <button className="secondary compact" data-testid="setup-open" onClick={() => open(device.verificationUri)}><Icon name="globe" size={14} /> Open link</button>
            <button className="ghost compact" data-testid="setup-copy-url" onClick={() => copy(device.verificationUri, "url")}>{copied === "url" ? "Copied" : "Copy link"}</button>
          </div>
          <p className="muted small psetup-wait"><i className="psetup-spin" /> Opened in your browser. Waiting for approval…</p>
        </> : <p className="muted small psetup-wait"><i className="psetup-spin" /> {busyText}</p>}
      </div>}

      {step === "busy" && <p className="muted psetup-wait" role="status"><i className="psetup-spin" /> {busyText}</p>}

      {step === "error" && <div className="psetup-form">
        <p className="danger-text" role="alert" data-testid="setup-error">{err.msg}</p>
        <div className="row">
          <button data-testid="setup-retry" onClick={() => (prov.device && err.back === "provider" ? void deviceLogin(prov) : err.back === "key" ? void fetchModels("key") : go(err.back))}>Retry</button>
          <button type="button" className="secondary" data-testid="setup-enter-model" onClick={() => { setCustom(custom || prov.defaultModel); setCustomName(""); setCustomBack(err.back === "key" ? "key" : "model"); go("custom"); }}>Enter model id…</button>
        </div>
      </div>}

      {step === "model" && <>
        <input autoFocus data-testid="setup-model-filter" placeholder="type to filter models" value={filter} onChange={(e) => { setFilter(e.target.value); setSel(0); }} onKeyDown={listKeys(shownModels.length, () => shownModels[sel] && pickModel(shownModels[sel]))} />
        <div className="psetup-list" role="listbox" aria-label="Models">
          {shownModels.map((m, i) => (
            <button key={m.id} role="option" aria-selected={i === sel} className={`psetup-row ${i === sel ? "on" : ""}`} data-testid="setup-model" onMouseEnter={() => setSel(i)} onClick={() => pickModel(m)}>
              <b>{m.name}</b>{m.id !== m.name && m.id !== CUSTOM_MODEL && <span>{m.id}</span>}{m.context && <span>{Math.round(m.context / 1000)}k context</span>}
            </button>
          ))}
        </div>
        <p className="muted small">{models.length} models from {prov.name}</p>
      </>}

      {step === "custom" && <form className="psetup-form" onSubmit={(e) => { e.preventDefault(); const id = custom.trim(); if (id) void save(id, customName.trim() || undefined, "custom"); }}>
        <label>Model id<input autoFocus data-testid="setup-custom-model" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="vendor/model" required /></label>
        <label>Name <span className="muted">(optional)</span><input data-testid="setup-custom-name" value={customName} onChange={(e) => setCustomName(e.target.value)} placeholder="Picker label" /></label>
        <label>Base URL <span className="muted">(optional)</span><input data-testid="setup-custom-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1" /></label>
        <label>API key <span className="muted">(optional)</span>
          <span className="psetup-key">
            <input data-testid="setup-custom-key" type={reveal ? "text" : "password"} autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={keepKey ? "Saved key, leave blank to keep it" : "Optional"} />
            <button type="button" className="ghost" data-testid="setup-custom-reveal" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>{reveal ? "Hide" : "Show"}</button>
          </span>
        </label>
        <label>Format
          <select data-testid="setup-custom-format" value={fmt} onChange={(e) => setFmt(e.target.value as Fmt)}>
            {FORMATS.map(([f, n]) => <option key={f} value={f}>{n}</option>)}
          </select>
        </label>
        <p className="muted small">Saves via setup/save · {prov.name}</p>
        <button disabled={!custom.trim()} data-testid="setup-save">Save</button>
      </form>}

      {step === "done" && <div className="psetup-form" data-testid="setup-done">
        <p><Icon name="check" size={14} /> Saved provider settings. Default model: <code>{status?.model}</code></p>
        <p className="muted small">New chats use it. The CLI's /setup shows the same provider.</p>
        {onClose && <button onClick={onClose}>Done</button>}
      </div>}
    </div>
  );
}

// ---- Phone: the CLI's provider, imported (desktop keeps these in Settings → Providers) ----
/** Phone copy of the CLI's provider references (never a key), the removals and the on/off toggle. */
export { ModelCustomForm } from "./ModelCustomForm";
export { saveCustomModel } from "../lib/setup";
/** The paired computer's setup methods, through the gateway. */
export const phoneSetup = (c: { ext: (m: string, p: Record<string, unknown>) => Promise<any> }) => rpcSetup((op, p) => c.ext("_supercharge/setup", { ...p, op }));
const K = "supercharge-mobile/cli-";
const get = (k: string, d: any) => { try { return JSON.parse(localStorage.getItem(K + k) ?? "") ?? d; } catch { return d; } };
const put = (k: string, v: unknown) => { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch { /* full or blocked */ } };

/** Import the CLI's configured provider unless turned off; `again` also brings back removed ones. */
export async function autoImport(api: SetupApi, again?: boolean): Promise<Provider[]> {
  const list: Provider[] = get("providers", []);
  if (!again && get("import", true) === false) return list;
  const p = await readCli(api);
  const next = p && mergeCli(list, p, again ? [] : get("removed", []));
  if (again) put("removed", []);
  if (next) put("providers", next);
  return next ?? list;
}

export function CliProviders({ api, sessionId }: { api: SetupApi; sessionId: () => string | undefined }) {
  const [list, setList] = useState<Provider[]>(() => get("providers", []));
  const [on, setOn] = useState<boolean>(() => get("import", true));
  const [msg, setMsg] = useState("");
  return (
    <div className="psetup" data-testid="m-cli-providers">
      {list.map((p) => (
        <div key={p.id} className="psetup-row" data-testid="m-cli-provider">
          <span><strong>{p.name}</strong> <small className="muted">Imported from CLI</small><br /><small className="muted">{p.models.join(", ")}</small></span>
          <button className="secondary compact" onClick={() => void applyCli(api, p, sessionId()).then(() => setMsg(`Using ${p.name}`), (e) => setMsg(String(e?.message ?? e)))}>Use</button>
          <button className="ghost compact" aria-label="Remove" onClick={() => { const l = list.filter((x) => x !== p); put("providers", l); put("removed", [...get("removed", []), p.cli]); setList(l); }}>✕</button>
        </div>
      ))}
      <div className="psetup-row"><label style={{ display: "inline" }}><input type="checkbox" style={{ width: "auto" }} data-testid="m-cli-import" checked={on} onChange={(e) => { put("import", e.target.checked); setOn(e.target.checked); }} /> Import the CLI's provider</label>
        <button className="secondary compact" data-testid="m-cli-reimport" onClick={() => void autoImport(api, true).then(setList)}>Re-import from CLI</button></div>
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}
