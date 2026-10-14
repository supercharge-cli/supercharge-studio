import { useEffect, useState } from "react";
import { background, BackgroundStatus } from "../lib/desktop";

/** "Start at login and keep running in the background" switch (desktop only). */
export function BackgroundSetting() {
  const [st, setSt] = useState<BackgroundStatus | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { void background.get().then(setSt).catch((e) => setErr(String(e))); }, []);
  const on = !!st && st.autostart && st.keep_running;
  async function set(v: boolean) {
    setErr("");
    try { setSt(await background.set(v)); } catch (e) { setErr(String((e as Error)?.message ?? e)); void background.get().then(setSt).catch(() => {}); }
  }
  return (
    <div className="card" data-testid="bg-setting">
      <div className="row between">
        <div>
          <strong>Start at login and keep running in the background</strong>
          <div className="muted small">Opens when you sign in and stays in the system tray when you close the window, so your phone (Local or Public) can always reach this computer. Quit from the tray icon.</div>
        </div>
        <label className="switch"><input type="checkbox" data-testid="bg-toggle" checked={on} disabled={!st} onChange={(e) => void set(e.target.checked)} /><i /></label>
      </div>
      {err && <div className="error-text small">{err}</div>}
    </div>
  );
}
