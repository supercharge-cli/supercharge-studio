import { Notes } from "../lib/releaseNotes";

/** Phone update prompt (lazy): version, what's new from the release notes, then Install / Restart / Later. */
export function UpdateSheet({ u, set }: { u: any; set: (u: any) => void }) {
  return (
    <div className="m-sheet-bg top" data-testid="m-update">
      <div className="m-sheet" role="dialog" aria-label="Update" onClick={(e) => e.stopPropagation()}>
        <div className="m-grabber" aria-hidden />
        <h3>{u.ready ? "Update ready" : `Update ${u.version}`}</h3>
        <Notes md={u.notes} open />
        {u.err ? <p className="muted">{u.err}</p> : u.p != null && !u.ready && <progress data-testid="m-update-progress" max={1} value={u.p || undefined} />}
        {(u.ready || u.p == null) && <button className="m-big" onClick={() => u.ready ? (window as any).SuperchargeAndroid.installUpdate() : window.open(u.err ? u.asset : u.page)}>{u.ready ? "Restart" : u.err ? "Download manually" : "Install"}</button>}
        <button className="m-big secondary" onClick={() => set({ ...u, hide: 1 })}>Later</button>
      </div>
    </div>
  );
}
