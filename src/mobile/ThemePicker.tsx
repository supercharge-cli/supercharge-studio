import { useState } from "react";

const CHOICES = "system:System,dark:Dark,graphite:Graphite,carbon:Carbon,ascii:ASCII Mono,matrix:Matrix Green,amber:Amber Phosphor,arctic:Arctic,twilight:Twilight,retro:Retro,midnight:Midnight,forest:Forest,ember:Ember,contrast:High contrast,light:Light,paper:Paper,sky:Sky,rose:Rose";

export function ThemePicker() {
  const [value, setValue] = useState(() => {
    try { return JSON.parse(localStorage.getItem("supercharge-studio/v1") ?? "null")?.settings?.theme ?? "system"; }
    catch { return "system"; }
  });
  return (
    <div className="m-row" data-testid="m-appearance">
      <span>Theme</span>
      <select className="m-theme-select" value={value} onChange={(e) => {
        const id = e.target.value;
        setValue(id);
        try {
          const data = JSON.parse(localStorage.getItem("supercharge-studio/v1") ?? "{}") ?? {};
          data.settings = { ...data.settings, theme: id };
          localStorage.setItem("supercharge-studio/v1", JSON.stringify(data));
        } catch {}
        const light = window.matchMedia?.("(prefers-color-scheme: light)")?.matches;
        document.documentElement.dataset.theme = id !== "system" ? id : (light ? "light" : "dark");
      }}>
        {CHOICES.split(",").map((p) => { const [id, name] = p.split(":"); return <option key={id} value={id}>{name}</option>; })}
      </select>
    </div>
  );
}
