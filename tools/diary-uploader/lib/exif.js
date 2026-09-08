"use strict";
const { execFile } = require("child_process");

function run(args) {
  return new Promise((resolve, reject) => {
    execFile("exiftool", args, { maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

// exiftool da DateTimeOriginal como "YYYY:MM:DD HH:MM:SS" (sin zona).
function parseExifDate(raw) {
  const m = /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/.exec(raw || "");
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return { y, mo, d, h, mi };
}

/**
 * Propone una fecha para la entrada.
 *
 * Los escaneos de pelicula no llevan EXIF de camara, y la fecha del archivo
 * en ese caso es cuando se copio a este Mac, no cuando se hizo la foto — ya
 * paso con las dos primeras entradas del diario. Por eso esto SIEMPRE dice
 * de donde sale la fecha ("exif" o "file"), para que la interfaz lo deje
 * claro y el campo se pueda corregir a mano sin sorpresas.
 *
 * @param {string} filePath - archivo temporal ya escrito en disco
 * @param {number} fallbackMs - File.lastModified del navegador (mtime real
 *   del archivo original en el Mac de Coke, no del temporal del servidor)
 */
async function proposeDate(filePath, fallbackMs) {
  try {
    const out = await run(["-s3", "-DateTimeOriginal", filePath]);
    const d = parseExifDate(out.trim());
    if (d) {
      return {
        source: "exif",
        // formato para <input type="datetime-local">
        value: `${d.y}-${d.mo}-${d.d}T${d.h}:${d.mi}`,
      };
    }
  } catch (e) {
    // sin exiftool o fallo leyendo: caemos al archivo
  }
  const dt = new Date(fallbackMs || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return {
    source: "file",
    value: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
  };
}

/**
 * Copia los metadatos del original al archivo redimensionado, salvo el GPS.
 * sharp no copia metadatos por defecto, asi que la variante llega aqui
 * limpia; esto rellena camara/objetivo/etc. desde el original explicitamente
 * excluyendo GPS:all.
 */
async function copyMetadataExceptGPS(originalPath, targetPath) {
  await run([
    "-TagsFromFile", originalPath,
    "-all:all",
    "--gps:all",
    "-overwrite_original",
    targetPath,
  ]);
}

module.exports = { proposeDate, copyMetadataExceptGPS };
