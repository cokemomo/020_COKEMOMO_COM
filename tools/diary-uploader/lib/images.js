"use strict";
const path = require("path");
const sharp = require("sharp");
const { copyMetadataExceptGPS } = require("./exif");

const LONG_EDGE_TIERS = [2400, 1600, 800]; // lado largo del marco, px
const QUALITY = 86;

// Proporción ancho/alto de cada marco. Horizontal y vertical son recíprocas
// (3:2 y 2:3) a propósito: a la misma anchura de columna, la vertical sale
// más alta — es justo lo que pidió Coke, y coincide con sus dos primeras
// fotos reales (8640x5760 y 5760x8640), que ya son exactamente estas
// proporciones sin recortar nada.
const FRAME_RATIO = { h: 3 / 2, v: 2 / 3 };

function tierDims(tier, ratio) {
  return ratio >= 1
    ? { w: tier, h: Math.round(tier / ratio) }
    : { w: Math.round(tier * ratio), h: tier };
}

/**
 * Genera las 3 variantes de una foto ya encuadrada por el usuario.
 *
 * `crop` son fracciones (0-1) de la imagen YA ROTADA según su EXIF —
 * sharp(...).rotate().metadata() NO refleja el giro (comprobado: sigue
 * dando las dimensiones del archivo tal cual), así que aquí se procesa la
 * imagen una vez para obtener las dimensiones reales, y se reusa ese
 * resultado ya rotado para las 3 variantes en vez de rehacer el giro 3 veces.
 *
 * @param {{orientation:'h'|'v', cx:number, cy:number, cw:number, ch:number}} crop
 */
async function generateVariants(originalPath, stagingDir, baseId, crop) {
  if (!crop || !crop.orientation) throw new Error("Falta el encuadre de la foto.");
  const ratio = FRAME_RATIO[crop.orientation];
  if (!ratio) throw new Error("Orientación de encuadre inválida: " + crop.orientation);

  const { data: rotated, info } = await sharp(originalPath).rotate().toBuffer({ resolveWithObject: true });
  const rw = info.width, rh = info.height;

  const left = Math.max(0, Math.min(rw - 1, Math.round(crop.cx * rw)));
  const top = Math.max(0, Math.min(rh - 1, Math.round(crop.cy * rh)));
  const width = Math.max(1, Math.min(rw - left, Math.round(crop.cw * rw)));
  const height = Math.max(1, Math.min(rh - top, Math.round(crop.ch * rh)));

  const files = {};
  let full = null;

  for (const tier of LONG_EDGE_TIERS) {
    const { w, h } = tierDims(tier, ratio);
    const outPath = path.join(stagingDir, tier === 2400 ? `${baseId}.jpg` : `${baseId}-${tier}.jpg`);

    // El recorte ya tiene exactamente la proporción del marco (lo construye
    // así la interfaz), así que "fill" a las medidas fijas del nivel no
    // deforma nada — solo redimensiona.
    await sharp(rotated)
      .extract({ left, top, width, height })
      .resize({ width: w, height: h, fit: "fill" })
      .toColorspace("srgb")
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toFile(outPath);

    await copyMetadataExceptGPS(originalPath, outPath);

    files[tier] = outPath;
    if (tier === 2400) full = { width: w, height: h };
  }

  return { width: full.width, height: full.height, files };
}

module.exports = { generateVariants, LONG_EDGE_TIERS, FRAME_RATIO, tierDims };
