import { useEffect, useRef } from "react";

const COLS = 63;
const ROWS = 28;
const SHINE = 5;
const START = 0.5;
const PASS = 2;
const HALF = 5;
const LEAN = 0.9;
const SOLID = "8dbqpPYOo0";
const PALETTE = [
  "#0b0d24", "#f9f9fb", "#4391e9", "#7054e6", "#d7d7ea", "#3fd4f8",
  "#35375e", "#8d8aa5", "#606271", "#fbfbfc", "#85b8f1", "#a290ef",
  "#e5e5f1", "#82e3fa", "#7c7d96", "#b5b3c5", "#b6b6bd", "#fdfdfe",
  "#c7def8", "#d4ccf8", "#f3f3f9", "#c5f2fd", "#c2c3cf", "#dddce4",
  "#4852c7", "#f9f9fb", "#4391e9", "#7054e6", "#d7d7ea", "#3fd4f8",
  "#565999", "#8d8aa5", "#888fdb", "#fbfbfc", "#85b8f1", "#a290ef",
  "#e5e5f1", "#82e3fa", "#9193bd", "#b5b3c5", "#c8cbee", "#fdfdfe",
  "#c7def8", "#d4ccf8", "#f3f3f9", "#c5f2fd", "#cccde0", "#dddce4",
];
const MONO = `
                       .qq__             .__.
                       '8888qq_     __p88PYYYP8qq_,
                        d8888888q__pP"'"""""^Y- '"Yq_,
                        '888888888P'          "^o_  "8q,
                         '888888"      _,.__q____     "8p,
                       _p8P888P'     ~P\\p8888888888qq_  "8_
                 __  _pP'_pq88q_,     q8888888888888888q_,8p
                 ""_q8'q888888888,   p88888888888888888888p8|
     q888888888P  q8"'|8888888888b  q88888888888888888888p88|
         .__ppq_  8p)pq88888888888 q888888888888888888888888'
          """""'  _8q888888888888P 88888888888888888888888qP
       ._pppppq__q8""88888888888P  888888888888888888888888'
     _p88888888/YP"q8q_'"Y888P"'  ,"8888888888888888888888"
   ___""""8888888qpqpp88q__'"O8pq_)( "8888888888888888888P
  "YYY'   .q8888888888"""""8q_,"'"8q_,  ""88888888888888P
          '888888888P      '888q_ d888qq__  '""Y8888P\\8"
        ___ '""88888q__    _888888P'"888888pqqq___pp8"'
        '"'  .  '"88888q)_p88Y8P"'____"YPP"_88Y8(_q888q_
            "Y"   8888888"'qp,_pp888P"^8q,_8888P"8888888,
                   "YPP"_p888888P\\p8"_pq/8"O88b  q888888'
                  \\p._p888888888b8P'q888\\8' '"8q__888""
                   _p8888888PY""88__pq__8"      '""'
                   q888888P"  .8888888P"
                   "88P"'     '8888888"
            _,._qpqqqqpp-      '""""'
                ''""""""YYYYPPPPPPPPPYY^
`.slice(1);
const ART = `
                       .qq__             .__.
                       '8888qq_     __p88888888qq_,
                        d8888888q__p888888888888888q_,
                        '88888888888888888888888888888q,
                         '888888888888888888888888888888p,
                       _p888888888888888888888888888888888_
                 __  _p888888888888888888888888888888888888p
                 ""_q888888888888888888888888888888888888888|
     q888888888P  q88888888888888888888888888888888888888888|
         .__ppq_  888888888888888888888888888888888888888888'
          """""'  _8888888888888888888888888888888888888888P
       ._ppqqqq__q88888888888888888888888888888888888888888'
     _p888888888888888888888888888888888888888888888888888"
   ___""""88888888888888888888888888888888888888888888888P
  "YYY'   .q88888888888888888888888888888888888888888888P
          '88888888888888888888888888888888888888888888"
        ___ '""88888888888888888888888888888888888888"'
        '"'  .  '"888888888888888888888888888888(_q888q_
            "Y"   8888888"'q8888888888888888888888888888,
                   "YPP"_p8888888888888888"O888888888888'
                  \\p._p8888888888888888888' '"8888888""
                   _p8888888PY""888888888"      '""'
                   q888888P"  .8888888P"
                   "88P"'     '8888888"
            _,._qpqqqqpp-      '""""'
                ''""""""YYYYPPPPPPPPPYY^
`.slice(1);
const INK = `
                       00000             0000
                       00666000     000000000000000
                        000066600000011111111111110000
                        00520000001111111111111111111000
                         002300011111111111111111111111000
                       000000004411111410030000000001111100
                 33  001444000041111111000000000000000001100
                 33000140000000301111006000000000000000300100
     55522222222  0041400055500500110000000050000000000034000
         3333333  0444400055500030110000000555000000000003000
          333333  000440005550060110000000555500000055500000
       00000400000044000000000004110000000222000000022000000
     000333344440144441110000044411100000003000000033300000
   3300000000334444444444111100044411100000000000003300000
  33333   00000000000011111004411104411111000000000000000
          0000000000111111110000440000001111111100060000
        522 0000000001111441066000014000000001111110000
        522  3  0000000044000000111114400144040000000000
            333   000000000004444444411111104001100000000
                   00000000000044100114440000004440000000
                  6600000000000440014444400 00044440000
                   00300300000000044444100      0000
                   030000000  0000000000
                   000000     000000000
            0000000000000      000000
                000000000000000000000000
`.slice(1);

const pad = (art: string) => art.split("\n").map((line) => line.padEnd(COLS));
const mono = pad(MONO);
const art = pad(ART);
const ink = pad(INK);
const n = PALETTE.length / 6;
let lo = Infinity;
let hi = -Infinity;
for (const pic of [mono, art]) {
  pic.forEach((line, y) => {
    for (let x = 0; x < COLS; x++) if (line[x] !== " ") {
      lo = Math.min(lo, x + LEAN * y);
      hi = Math.max(hi, x + LEAN * y);
    }
  });
}
const span = hi - lo + 2 * HALF;

function frame(t: number): { ch: string; color: string }[][] {
  const every = Math.max(SHINE, PASS + 0.5);
  const since = t - START;
  const at = since >= 0 ? lo - HALF + (span * (since % every)) / PASS : -Infinity;
  const rows: { ch: string; color: string }[][] = [];
  for (let y = 0; y < ROWS; y++) {
    const row: { ch: string; color: string }[] = [];
    for (let x = 0; x < COLS; x++) {
      let ch = art[y][x];
      let color = "transparent";
      if (ch !== " ") {
        const d = Math.abs(x + LEAN * y - at);
        let k = d < HALF ? 1 - d / HALF : 0;
        k = k * k * (3 - 2 * k);
        if (k > 0.55 && SOLID.includes(ch)) ch = "/";
        const idx = 3 * n + (k > 0.6 ? 2 : k > 0.25 ? 1 : 0) * n + parseInt(ink[y][x], 36);
        color = PALETTE[idx] ?? "#d7d7ea";
      }
      row.push({ ch, color });
    }
    rows.push(row);
  }
  return rows;
}

/** ASCII logo with a glint that crosses it every few seconds. */
export function LogoMark() {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const t0 = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      const rows = frame((now - t0) / 1000);
      el.replaceChildren(...rows.map((row) => {
        const line = document.createElement("div");
        for (const cell of row) {
          if (cell.ch === " ") { line.append(cell.ch); continue; }
          const s = document.createElement("span");
          s.textContent = cell.ch;
          s.style.color = cell.color;
          line.append(s);
        }
        return line;
      }));
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <pre ref={ref} className="logo-ascii" aria-hidden="true" />;
}
