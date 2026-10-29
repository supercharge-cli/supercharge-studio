import { desktopIcons } from "./iconsDesktop";

/** Tiny inline SVG icon set (stroke icons, 24×24 grid). Desktop-only icons live in iconsDesktop.ts; the mobile build swaps that file for an empty stub. */
const P: Record<string, string> = {
  ...desktopIcons,
  plus: "M12 5v14M5 12h14",
  photo: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M16 10a1.5 1.5 0 1 0 0-.1",
  chevronRight: "m9 18 6-6-6-6",
  chevronDown: "m6 9 6 6 6-6",
  panelLeft: "M3 4h18v16H3zM9 4v16",
  panelRight: "M3 4h18v16H3zM15 4v16",
  code: "m8 7-5 5 5 5M16 7l5 5-5 5",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4Z",
  stop: "M6 6h12v12H6z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20",
  tool: "M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z",
  x: "M18 6 6 18M6 6l12 12",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  check: "M20 6 9 17l-5-5",
  server: "M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01",
  phone: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM11 18h2",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  compose: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4ZM4 4h7",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6",
  qr: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3z",
  laptop: "M4 5h16v11H4zM2 19h20",
  arrowLeft: "M19 12H5M12 19l-7-7 7-7",
};

export function Icon({ name, size = 16, title, className }: { name: keyof typeof P | string; size?: number; title?: string; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name] ?? P.x} />
    </svg>
  );
}
