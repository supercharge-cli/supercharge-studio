/**
 * In-app update (lazy chunk): downloads in the background with a progress bar, installs
 * where the OS allows, then offers Restart / Later. Errors fall back to a manual download.
 * The native side is src-tauri/src/updater.rs.
 */
import { useEffect, useState } from "react";
import { invoke, isDesktop, listen } from "../lib/desktop";
import type { AvailableUpdate } from "../lib/updates";

type St = { p?: number; ready?: string; err?: string };

export default function UpdateBanner({ u, onLater }: { u: AvailableUpdate; onLater: () => void }) {
  const [st, setSt] = useState<St>(isDesktop() ? { p: 0 } : { err: "" });
  useEffect(() => {
    if (!isDesktop()) return;
    let live = true, off: (() => void) | undefined;
    const set = (s: St) => live && setSt(s);
    void listen<{ done: number; total: number }>("update://progress", (e) => set({ p: e.total ? e.done / e.total : undefined })).then((f) => (live ? (off = f) : f()));
    const { format } = u;
    const pkg = (format === "rpm" || format === "deb") && u.asset && u.sums ? { url: u.asset, name: u.assetName, sums: u.sums, format } : null;
    invoke<string>("update_download", { pkg }).then((ready) => set({ ready }), (e) => set({ err: String(e) }));
    return () => { live = false; off?.(); };
  }, [u.version, u.format]);
  const restart = () => invoke(st.ready === "process" ? "plugin:process|restart" : "update_restart").catch((e) => setSt({ err: String(e) }));
  return (
    <div className="notice update-banner" data-testid="update-banner" data-state={st.ready ? "ready" : st.err != null ? "error" : "downloading"} role="status">
      {st.ready ? (
        <>
          <span>Update ready — restart to use Supercharge Studio {u.version}.</span>
          <button onClick={restart}>Restart</button>
        </>
      ) : st.err != null ? (
        <>
          <span>{st.err ? `Couldn't install Supercharge Studio ${u.version}: ${st.err}` : `Supercharge Studio ${u.version} is available.`}</span>
          <button onClick={() => window.open(u.asset || u.page, "_blank")}>Download manually</button>
        </>
      ) : (
        <>
          <span>Downloading Supercharge Studio {u.version}…</span>
          <progress data-testid="update-progress" max={1} value={st.p} />
        </>
      )}
      {(st.ready || st.err != null) && <button className="ghost" onClick={onLater}>Later</button>}
    </div>
  );
}
