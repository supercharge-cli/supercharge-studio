import { useEffect, useState } from "react";

// [key, label, on] for each kind of report this build can send (labels and note come from the app).
type S = { rows: [string, string, boolean][]; note: string };
const call = (cmd: string, args?: object): Promise<S> | undefined => (globalThis as any).__TAURI_INTERNALS__?.invoke(cmd, args);

/** Crash report / usage stat switches; nothing renders in builds that can't send either. */
export function Privacy() {
  const [s, set] = useState<S>();
  useEffect(() => void call("telemetry_get")?.then(set, () => {}), []);
  return s?.rows.length ? (
    <div>
      {s.rows.map(([k, label, on]) => <label key={k} className="check"><input type="checkbox" checked={on} onChange={(e) => void call("telemetry_set", { [k]: e.target.checked })?.then(set)} /> {label}</label>)}
      <p className="muted small">{s.note}</p>
    </div>
  ) : null;
}
