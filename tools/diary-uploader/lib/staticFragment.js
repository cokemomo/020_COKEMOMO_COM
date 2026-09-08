"use strict";
const fs = require("fs");
const path = require("path");
const { listRecent } = require("./diaryData");

const START = "<!-- DIARY_STATIC_START -->";
const END = "<!-- DIARY_STATIC_END -->";
const STATIC_COUNT = 6; // cuantas entradas quedan visibles sin JavaScript

// Lee año/mes/dia directamente del ISO guardado (sin pasar por Date+TZ local)
// para que el HTML estatico diga siempre exactamente la fecha que hay en el
// JSON, sin depender de en que huso horario corra el proceso de Node.
function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error("fecha invalida: " + iso);
  const [, y, mo, d] = m.map((s, i) => (i === 0 ? s : Number(s)));
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}
function monthKey({ y, mo }) {
  return `${y}-${String(mo).padStart(2, "0")}`;
}
function dateLabel(p) {
  return `${p.d}/${p.mo}/${p.y}`; // numerico, sin ceros — "5/5/2025"
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function entryHTML(entry, eagerBudget) {
  const p = parseISO(entry.date);
  const photos = entry.images
    .map((img) => {
      const srcset = img.srcset.map((s) => `${s.src} ${s.w}w`).join(",\n                         ");
      // Las 1-2 primeras imagenes del tramo (arriba del todo, se ven nada
      // mas entrar) van eager+fetchpriority — el resto lazy. Sin esto todo
      // el primer pantallazo esperaba a que el navegador decidiera cargarlo.
      // eagerBudget es un objeto (no un numero) para que el contador se
      // comparta entre llamadas a esta funcion, no se reinicie en cada una.
      const loadAttrs = eagerBudget.n > 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
      if (eagerBudget.n > 0) eagerBudget.n--;
      return `        <figure class="d-photo">
          <button class="d-frame" type="button" data-full="${esc(img.src)}" aria-label="Ampliar: ${esc(img.alt)}">
            <img src="${esc((img.srcset.find((s) => s.w === 1600) || img.srcset[img.srcset.length - 1]).src)}"
                 srcset="${srcset}"
                 sizes="(max-width: 900px) 100vw, 720px"
                 width="${img.width}" height="${img.height}"
                 alt="${esc(img.alt)}"
                 ${loadAttrs} decoding="async">
          </button>
        </figure>`;
    })
    .join("\n");
  // Una sola línea: fecha | texto (si lo hay). Sin texto, solo la fecha —
  // sin el separador colgando.
  const line = entry.text
    ? `<span class="d-date">${dateLabel(p)}</span><span class="d-sep"> | </span><span class="d-text">${esc(entry.text)}</span>`
    : `<span class="d-date">${dateLabel(p)}</span>`;
  return `      <article class="d-entry" data-entry-id="${esc(entry.id)}" data-date="${esc(entry.date)}">
${photos}
        <p class="d-meta">${line}</p>
      </article>`;
}

function buildFragment(entries) {
  const chunks = [];
  let lastMonth = null;
  const eagerBudget = { n: 2 }; // las 1-2 primeras imagenes del tramo entero
  for (const entry of entries) {
    const p = parseISO(entry.date);
    const key = monthKey(p);
    if (key !== lastMonth) {
      // Sin texto visible: es solo el ancla a la que salta el indice lateral
      // de meses, ya no un rotulo entre las fotos.
      chunks.push(`      <p class="d-month-sep" data-month="${key}" aria-hidden="true"></p>`);
      lastMonth = key;
    }
    chunks.push(entryHTML(entry, eagerBudget));
  }
  return chunks.join("\n\n");
}

/**
 * Regenera todo lo que hay entre las marcas DIARY_STATIC_START/END en
 * diary/index.html con las N entradas mas recientes. Se llama tras cada
 * publicacion, edicion o borrado — es la unica forma de que el primer tramo
 * (visible sin JavaScript) no se quede desactualizado.
 */
function regenerateStaticFragment(repoRoot) {
  const indexPath = path.join(repoRoot, "diary", "index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  const startIdx = html.indexOf(START);
  const endIdx = html.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error("No se encuentran las marcas DIARY_STATIC_START/END en diary/index.html");
  }
  const recent = listRecent(repoRoot, STATIC_COUNT);
  const body = recent.length ? buildFragment(recent) + "\n      " : "";
  const next =
    html.slice(0, startIdx + START.length) + "\n" + body + html.slice(endIdx);
  fs.writeFileSync(indexPath, next, "utf8");
}

module.exports = { regenerateStaticFragment, buildFragment, STATIC_COUNT };
