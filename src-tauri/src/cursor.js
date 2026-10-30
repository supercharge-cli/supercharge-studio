// AI cursor layer. Runs in its own transparent webview stacked above the side browser,
// so the page under it can never see or script it. No IPC: the user's mouse is reported
// by navigating to a sentinel URL that the shell intercepts (see cursor.rs).
// Styles live in public/cursor.html: Tauri hashes that <style> into the CSP, which also
// turns off 'unsafe-inline', so a style element created here would be blocked.
(() => {
  if (window.top !== window || !/cursor\.html$/.test(location.pathname)) return;
  const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let c, b, start = null, gone = false, ripT = 0;
  const ICON = { type: "⌨ typing", key: "⌨ key", scroll: "↕ scrolling", hover: "", click: "" };
  function take() {
    if (gone) return;
    gone = true;
    location.href = "https://takeover.supercharge.invalid/";
  }
  function setup() {
    if (c) return;
    document.body.insertAdjacentHTML("beforeend",
      '<div id="l" role="status"><i></i>Supercharge is browsing</div>' +
      '<div id="c"><svg width="22" height="24" viewBox="0 0 22 24"><path d="M2 1.5l17 10.2-7.4 1.4-3.6 7.1z" fill="#7c5cff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div id="b"></div></div>');
    c = document.getElementById("c");
    b = document.getElementById("b");
    // A real mouse moving over the layer means the user wants the page back.
    addEventListener("mousemove", (e) => {
      if (gone) return;
      if (!start) { start = [e.screenX, e.screenY]; return; }
      if (Math.abs(e.screenX - start[0]) + Math.abs(e.screenY - start[1]) < 6) return;
      take();
    });
    for (const t of ["mousedown", "wheel", "keydown", "touchstart"]) addEventListener(t, take, { passive: true });
  }
  window.__cur = (m) => {
    setup();
    gone = false;
    start = null;
    document.documentElement.classList.toggle("rm", reduce());
    if (m.x != null && m.y != null) c.style.transform = `translate(${m.x - 2}px,${m.y - 1}px)`;
    const label = ICON[m.op] || "";
    b.textContent = label;
    b.style.display = label ? "block" : "none";
    if (m.op === "click") {
      clearTimeout(ripT);
      ripT = setTimeout(() => {
        const r = document.createElement("div");
        const t = c.getBoundingClientRect();
        r.className = "r";
        r.style.left = t.left + 2 + "px";
        r.style.top = t.top + 1 + "px";
        document.body.appendChild(r);
        setTimeout(() => r.remove(), 700);
      }, reduce() ? 0 : 380);
    }
  };
  const boot = () => { if (window.__init) window.__cur(window.__init); };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", boot); else boot();
})();
