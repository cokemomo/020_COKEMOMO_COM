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
 * fotos, que se deriva del texto), reencuadrar alguna foto, sustituirla por
 * otra distinta, y/o cambiar la fecha.
 *
 * `crops`: [{ index, orientation, cx, cy, cw, ch }, ...] — reencuadra una
 * foto YA publicada, a partir de su original guardado.
 * `replacements`: [{ index, filename, dataUrl, orientation, crop }, ...] —
 * sustituye la foto de esa posición por un archivo nuevo del todo; como al
 * publicar, hace falta encuadrarla.
 * `date`: "AAAA-MM-DD" — si es distinta del día ya guardado, la entrada
 * cambia de identificador (la fecha va codificada en él) y de carpeta si
 * cambia de año o mes. Para poder recolocar sin perder calidad, TODAS las
 * fotos de la entrada tienen que tener su original guardado — si alguna no
 * lo tiene (entradas de antes de que existiera esta función), se rechaza
 * el cambio de fecha explicando por qué, en vez de mover solo unas fotos sí
 * y otras no.
 */
async function editEntry(repoRoot, id, { text, crops, date, replacements }) {
  const found = findEntry(repoRoot, id);
  if (!found) throw new Error("No existe esa entrada: " + id);

  const entryText = typeof text === "string" ? text.trim() : found.entry.text;
  const altText = entryText || DEFAULT_ALT;

  const [origY, origMo] = found.entry.date.split("-");

  let dateChanged = false;
  let newId = id;
  let newDateISO = found.entry.date;
  if (typeof date === "string" && date.trim()) {
    const candidate = toISO(date);
    if (candidate.slice(0, 10) !== found.entry.date.slice(0, 10)) {
      dateChanged = true;
      newDateISO = candidate;
      const [ny, nmo, nd] = newDateISO.slice(0, 10).split("-");
      newId = `${ny}-${nmo}-${nd}-0000-${crypto.randomBytes(2).toString("hex")}`;
    }
  }
  const [y, mo] = newDateISO.split("-");
  const mediaDir = path.join(repoRoot, "diary", "media", y, mo);

  let images = found.entry.images.map((img) => ({ ...img, alt: altText }));
  const replacementByIndex = new Map((replacements || []).map((r) => [r.index, r]));
  const cropByIndex = new Map((crops || []).map((c) => [c.index, c]));

  // Si cambia la fecha, TODAS las fotos se regeneran desde su original en
  // la ubicación nueva — más simple y fiable que andar moviendo/renombrando
  // ficheros ya generados. Por eso hace falta que todas tengan original.
  if (dateChanged) {
    for (let i = 0; i < images.length; i++) {
      if (replacementByIndex.has(i)) continue; // esta trae archivo nuevo, no hace falta el viejo
      if (!findOriginal(repoRoot, id, i)) {
        throw new Error(
          `No se puede cambiar la fecha: la foto ${i + 1} no tiene original guardado (se publicó antes de que existiera esta función), así que no se puede recolocar sin perder calidad.`
        );
      }
    }
  }

  const changedMediaFiles = [];
  const oldMediaFilesToRemove = [];
  const tmpDir = mkTemp("diary-recrop-");

  try {
    for (let i = 0; i < images.length; i++) {
      const replacement = replacementByIndex.get(i);
      const cropSpec = cropByIndex.get(i);
      if (!replacement && !cropSpec && !dateChanged) continue; // esta foto no cambia en nada

      const baseId = images.length === 1 ? newId : `${newId}-${i + 1}`;
      let originalPath, orientation, cropRect;

      if (replacement) {
        if (!replacement.orientation || !replacement.crop) {
          throw new Error(`Falta encuadrar la foto nueva de la posición ${i + 1}.`);
        }
        originalPath = path.join(tmpDir, `new-${i}${path.extname(replacement.filename || "") || ".jpg"}`);
        fs.writeFileSync(originalPath, dataUrlToBuffer(replacement.dataUrl));
        orientation = replacement.orientation;
        cropRect = replacement.crop;
      } else {
        originalPath = findOriginal(repoRoot, id, i);
        if (!originalPath) {
          throw new Error(`No hay original guardado para la foto ${i + 1}: no se puede regenerar sin perder calidad.`);
        }
        if (cropSpec) {
          orientation = cropSpec.orientation;
          cropRect = { cx: cropSpec.cx, cy: cropSpec.cy, cw: cropSpec.cw, ch: cropSpec.ch, adjust: cropSpec.adjust };
        } else {
          // solo cambia la fecha: mismo encuadre de siempre, otra ubicación
          orientation = images[i].orientation;
          cropRect = images[i].crop;
        }
      }

      const stagingDir = path.join(tmpDir, `s${i}`);
      fs.mkdirSync(stagingDir, { recursive: true });
      const { width, height, files } = await generateVariants(originalPath, stagingDir, baseId, { ...cropRect, orientation });

      fs.mkdirSync(mediaDir, { recursive: true });
      const srcset = LONG_EDGE_TIERS.slice().reverse().map((tier) => {
        const fname = tier === 2400 ? `${baseId}.jpg` : `${baseId}-${tier}.jpg`;
        const dest = path.join(mediaDir, fname);
        fs.copyFileSync(files[tier], dest);
        changedMediaFiles.push(dest);
        return { w: tier, src: `/diary/media/${y}/${mo}/${fname}` };
      });

      // El nombre base solo cambia si cambió el id (fecha nueva) — un
      // simple reencuadre o sustitución con la fecha igual sobrescribe en
      // el sitio, como siempre, y no deja nada que limpiar.
      if (dateChanged) {
        for (const s of images[i].srcset) {
          oldMediaFilesToRemove.push(path.join(repoRoot, s.src.replace(/^\//, "")));
        }
      }

      images[i] = { src: srcset.find((s) => s.w === 2400).src, srcset, width, height, alt: altText, orientation, crop: cropRect };

      // El original se guarda bajo el id que corresponda a partir de ahora
      // (nuevo si cambió la fecha, el mismo si no) — así una foto
      // sustituida o una entrada recolocada siguen pudiéndose reencuadrar.
      saveOriginal(repoRoot, newId, i, originalPath);
    }
  } catch (e) {
    // Un fallo a mitad pudo dejar alguna foto ya escrita, sin commitear.
    // Si la fecha cambió, esos ficheros son nuevos (ubicación nueva, aún
    // no están en git): basta con borrarlos. Si la fecha NO cambió, un
    // reencuadre o sustitución sobrescribe en el sitio de siempre — borrar
    // dejaría esa foto sin archivo ninguno; hay que devolverla a como
    // estaba en el último commit real, no borrarla.
    if (dateChanged) {
      changedMediaFiles.forEach((f) => fs.rmSync(f, { force: true }));
    } else if (changedMediaFiles.length) {
      await git(repoRoot, ["checkout", "--", ...changedMediaFiles.map((f) => path.relative(repoRoot, f))]).catch(() => {});
    }
    throw e;
  } finally {
    rmrf(tmpDir);
  }

  oldMediaFilesToRemove.forEach((f) => fs.rmSync(f, { force: true }));
  if (dateChanged && newId !== id) removeOriginals(repoRoot, id); // el id viejo ya no hace falta

  let year;
  if (dateChanged) {
    deleteEntry(repoRoot, id); // solo el JSON — los ficheros ya se han movido arriba
    year = addEntry(repoRoot, { id: newId, date: newDateISO, text: entryText, images });
  } else {
    updateEntry(repoRoot, id, { text: entryText, images });
    year = y;
  }
  regenerateStaticFragment(repoRoot);

  const yearFilePath = path.relative(repoRoot, path.join(repoRoot, "diary", "data", `${year}.json`));
  const indexPath = path.relative(repoRoot, path.join(repoRoot, "diary", "index.html"));
  const relMedia = changedMediaFiles.map((f) => path.relative(repoRoot, f));
  const relRemoved = oldMediaFilesToRemove.map((f) => path.relative(repoRoot, f));
  const files = [yearFilePath, indexPath, ...relMedia, ...relRemoved];
  if (dateChanged && origY !== y) {
    files.push(path.relative(repoRoot, path.join(repoRoot, "diary", "data", `${origY}.json`)));
  }

  const hash = await commitFiles(repoRoot, files, `diary: editar ${dateChanged ? `${id} -> ${newId}` : id}`);
  return { id: newId, commit: hash };
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
