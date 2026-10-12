import { useState } from "react";
import type { Settings as S } from "../lib/store";
import type { ConfigOption } from "../acp/types";

type Props = {
  value: S;
  configOptions: ConfigOption[];
  extensions: string[];
  onSave: (s: S) => void;
  onConfig: (id: string, v: string) => void;
  onClose: () => void;
};

export function SettingsModal({ value, configOptions, extensions, onSave, onConfig, onClose }: Props) {
  const [s, set] = useState(value);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <label>Transport
          <select value={s.transport} onChange={(e) => set({ ...s, transport: e.target.value as S["transport"] })}>
            <option value="ws">ACP WebSocket (agent serve)</option>
            <option value="stdio">ACP stdio (desktop only)</option>
          </select>
        </label>
        <label>Agent address<input value={s.bind} onChange={(e) => set({ ...s, bind: e.target.value })} /></label>
        <label>Server key<input type="password" value={s.secret} onChange={(e) => set({ ...s, secret: e.target.value })} /></label>
        <label className="row"><input type="checkbox" checked={s.autoStart} onChange={(e) => set({ ...s, autoStart: e.target.checked })} /> Start agent automatically if not running</label>
        <label className="row"><input type="checkbox" checked={s.alwaysApprove} onChange={(e) => set({ ...s, alwaysApprove: e.target.checked })} /> Always approve tool calls</label>
        {configOptions.length > 0 && <h4>Session options</h4>}
        {configOptions.map((o) => (
          <label key={o.id}>{o.name ?? o.id}
            <select defaultValue={o.currentValue} onChange={(e) => onConfig(o.id, e.target.value)}>
              {(o.options ?? []).map((v) => <option key={v.value} value={v.value}>{v.name && v.name !== v.value ? `${v.name} (${v.value})` : v.value}</option>)}
            </select>
          </label>
        ))}
        {extensions.length > 0 && (
          <>
            <h4>Agent extensions</h4>
            <div className="mono muted">{extensions.join("\n")}</div>
          </>
        )}
        <div className="row end">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button onClick={() => onSave(s)}>Save & reconnect</button>
        </div>
      </div>
    </div>
  );
}
