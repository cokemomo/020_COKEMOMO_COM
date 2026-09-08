"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { generateVariants, LONG_EDGE_TIERS } = require("./images");
const { addEntry, updateEntry, findEntry, deleteEntry } = require("./diaryData");
const { regenerateStaticFragment } = require("./staticFragment");
const { commitFiles, git } = require("./git");
const { saveOriginal, findOriginal, removeOriginals } = require("./originals");

const DEFAULT_ALT = "Fotografía del diario.";

function tzOffsetString() {
  const offMin = -new Date().getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// "2026-09-02" (de un <input type=date>, sin hora — asi lo pidio Coke) -> ISO
function toISO(dateOnly) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly || "");
  if (!m) throw new Error("Fecha inválida: " + dateOnly);
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00${tzOffsetString()}`;
}

function mkTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:[^;]+;base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error("dataUrl inválido");
  return Buffer.from(m[1], "base64");
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Publica una entrada nueva. Todo o nada: si algo falla en cualquier punto,
 * lo generado en staging/temp se borra y el repositorio real (diary/media,
 * diary/data, diary/index.html, y los originales) no se ha tocado todavía —
 * solo se escribe ahi cuando TODAS las fotos ya se generaron con exito.
 *
 * Solo hay un texto por entrada (el pie, que acompaña a la fecha); el `alt`
 * de cada imagen se deriva de ese mismo texto — ya no hay un campo aparte
 * en la interfaz para eso.
 */
async function publishEntry(repoRoot, { date, text, images }) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("Hace falta al menos una foto.");
  }
  const missingCrop = images.findIndex((img) => !img.orientation || !img.crop);
  if (missingCrop !== -1) {
    throw new Error(`Falta encuadrar la foto ${missingCrop + 1} (elige horizontal o vertical y ajusta el marco).`);
  }

  const iso = toISO(date);
  const [y, mo, d] = iso.slice(0, 10).split("-");
  const id = `${y}-${mo}-${d}-0000-${crypto.randomBytes(2).toString("hex")}`;
  const entryText = (text || "").trim();
  const altText = entryText || DEFAULT_ALT;

  const tmpDir = mkTemp("diary-publish-");
  const stagingDir = path.join(tmpDir, "out");
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const entryImages = [];
    for (let i = 0; i < images.length; i++) {
      const original = path.join(tmpDir, `orig-${i}${path.extname(images[i].filename || "") || ".jpg"}`);
      fs.writeFileSync(original, dataUrlToBuffer(images[i].dataUrl));

      const baseId = images.length === 1 ? id : `${id}-${i + 1}`;
      const orientation = images[i].orientation;
      const crop = { ...images[i].crop, orientation };
      const { width, height, files } = await generateVariants(original, stagingDir, baseId, crop);

      entryImages.push({ baseId, width, height, files, originalTemp: original, orientation, crop: images[i].crop });
    }

    // Todas las fotos generadas sin fallos: ahora si se escribe en el repo
    // (y en los originales, fuera del repo).
    const mediaDir = path.join(repoRoot, "diary", "media", y, mo);
    fs.mkdirSync(mediaDir, { recursive: true });

    const movedFiles = [];
    const savedOriginals = [];
    const jsonImages = entryImages.map((img, i) => {
      const srcset = LONG_EDGE_TIERS.slice().reverse().map((tier) => {
        const fname = tier === 2400 ? `${img.baseId}.jpg` : `${img.baseId}-${tier}.jpg`;
        const dest = path.join(mediaDir, fname);
        fs.copyFileSync(img.files[tier], dest);
        movedFiles.push(dest);
        return { w: tier, src: `/diary/media/${y}/${mo}/${fname}` };
      });
      savedOriginals.push(saveOriginal(repoRoot, id, i, img.originalTemp));
      return {
        src: srcset.find((s) => s.w === 2400).src,
        srcset,
        width: img.width,
        height: img.height,
        alt: altText,
        // No lo usa la web publica: es solo para que el subidor pueda
        // reabrir el gestor de encuadre desde donde se quedo.
        orientation: img.orientation,
        crop: img.crop,
      };
    });

    const entry = { id, date: iso, text: entryText, images: jsonImages };

    let year;
    try {
      year = addEntry(repoRoot, entry);
      regenerateStaticFragment(repoRoot);
    } catch (e) {
      // JSON o fragmento estatico fallaron: deshacer TODO lo ya escrito en
      // el repo real, para que un fallo aqui no deje el sitio a medias.
      if (year) deleteEntry(repoRoot, id);
      movedFiles.forEach((f) => fs.rmSync(f, { force: true }));
      removeOriginals(repoRoot, id);
      throw e;
    }

    const yearFilePath = path.relative(repoRoot, path.join(repoRoot, "diary", "data", `${year}.json`));
    const yearsFilePath = path.relative(repoRoot, path.join(repoRoot, "diary", "data", "years.json"));
    const indexPath = path.relative(repoRoot, path.join(repoRoot, "diary", "index.html"));
    const relMedia = movedFiles.map((f) => path.relative(repoRoot, f));

    const hash = await commitFiles(
      repoRoot,
      [yearFilePath, yearsFilePath, indexPath, ...relMedia],
      `diary: ${y}-${mo}-${d}`
    );

    return { id, commit: hash };
  } finally {
    rmrf(tmpDir);
  }
}

/**
 * Edita una entrada existente: el texto (y con él, el alt de todas sus
 * fotos, que se deriva del texto) y, opcionalmente, reencuadra alguna de
 * sus fotos de nuevo. El reencuadre parte siempre del original guardado en
 * su día — si esa entrada se publicó antes de que esto existiera, no hay
 * original y no se puede reencuadrar.
 *
 * `crops`: [{ index, orientation, cx, cy, cw, ch }, ...] — solo hace falta
 * incluir las fotos que cambian de encuadre.
 */
async function editEntry(repoRoot, id, { text, crops }) {
  const found = findEntry(repoRoot, id);
  if (!found) throw new Error("No existe esa entrada: " + id);

  const entryText = typeof text === "string" ? text.trim() : found.entry.text;
  const altText = entryText || DEFAULT_ALT;
  const [y, mo] = found.entry.date.split("-");
  const mediaDir = path.join(repoRoot, "diary", "media", y, mo);

  let images = found.entry.images.map((img) => ({ ...img, alt: altText }));
  const changedMediaFiles = []; // hay que añadirlos al commit, o la web publica se queda con la foto vieja

  if (Array.isArray(crops) && crops.length) {
    const tmpDir = mkTemp("diary-recrop-");
    try {
      for (const c of crops) {
        const i = c.index;
        if (i == null || i < 0 || i >= images.length) continue;

        const original = findOriginal(repoRoot, id, i);
        if (!original) {
          throw new Error(
            `No hay original guardado para la foto ${i + 1}: esta entrada se publicó antes de que se pudiera reencuadrar, así que no se puede recortar de nuevo sin perder calidad.`
          );
        }

        const baseId = images.length === 1 ? id : `${id}-${i + 1}`;
        const stagingDir = path.join(tmpDir, String(i));
        fs.mkdirSync(stagingDir, { recursive: true });
        const cropObj = { cx: c.cx, cy: c.cy, cw: c.cw, ch: c.ch, orientation: c.orientation };
        const { width, height, files } = await generateVariants(original, stagingDir, baseId, cropObj);

        const srcset = LONG_EDGE_TIERS.slice().reverse().map((tier) => {
          const fname = tier === 2400 ? `${baseId}.jpg` : `${baseId}-${tier}.jpg`;
          const dest = path.join(mediaDir, fname);
          fs.copyFileSync(files[tier], dest); // mismo nombre de siempre: sobrescribe en el sitio, sin huérfanos
          changedMediaFiles.push(dest);
          return { w: tier, src: `/diary/media/${y}/${mo}/${fname}` };
        });

        images[i] = {
          src: srcset.find((s) => s.w === 2400).src,
          srcset, width, height, alt: altText,
          orientation: c.orientation,
          crop: { cx: c.cx, cy: c.cy, cw: c.cw, ch: c.ch },
        };
      }
    } catch (e) {
      // Un recorte a mitad de una entrada con varias fotos pudo dejar
      // alguna imagen ya sobrescrita en disco pero sin commitear — se
      // devuelve esa foto a como estaba en el último commit real.
      if (changedMediaFiles.length) {
        await git(repoRoot, ["checkout", "--", ...changedMediaFiles.map((f) => path.relative(repoRoot, f))]).catch(() => {});
      }
      throw e;
    } finally {
      rmrf(tmpDir);
    }
  }

  const updated = updateEntry(repoRoot, id, { text: entryText, images });
  regenerateStaticFragment(repoRoot);

  const yearFilePath = path.relative(repoRoot, path.join(repoRoot, "diary", "data", `${y}.json`));
  const indexPath = path.relative(repoRoot, path.join(repoRoot, "diary", "index.html"));
  const relMedia = changedMediaFiles.map((f) => path.relative(repoRoot, f));
  const hash = await commitFiles(repoRoot, [yearFilePath, indexPath, ...relMedia], `diary: editar ${id}`);
  return { id, commit: hash };
}

/**
 * Borra una entrada, sus ficheros de imagen y su original guardado.
 */
async function removeEntry(repoRoot, id) {
  const removed = deleteEntry(repoRoot, id);
  if (!removed) throw new Error("No existe esa entrada: " + id);

  const files = [];
  for (const img of removed.images) {
    for (const s of img.srcset) {
      files.push(path.join(repoRoot, s.src.replace(/^\//, "")));
    }
  }
  files.forEach((f) => fs.rmSync(f, { force: true }));
  removeOriginals(repoRoot, id);

  regenerateStaticFragment(repoRoot);

  const [y] = removed.date.split("-");
  const yearFilePath = path.relative(repoRoot, path.join(repoRoot, "diary", "data", `${y}.json`));
  const indexPath = path.relative(repoRoot, path.join(repoRoot, "diary", "index.html"));
  const relFiles = files.map((f) => path.relative(repoRoot, f));
  const hash = await commitFiles(
    repoRoot,
    [yearFilePath, indexPath, ...relFiles],
    `diary: borrar ${id}`
  );
  return { id, commit: hash };
}

module.exports = { publishEntry, editEntry, removeEntry, toISO };
