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

// Ajustes fino opcionales — todos neutros por defecto (0 = sin cambio).
// Verificado a mano contra sharp antes de usarlos (gris puro 128,128,128):
//   modulate({brightness:1.3})      -> sube el brillo multiplicando, tal cual
//   modulate({saturation:2})        -> no toca un gris puro (correcto)
//   linear(slope, intercept)        -> intercept=(1-slope)*128 mantiene el punto medio fijo
//   linear([r,g,b],[0,0,0])         -> gana/pierde cada canal por separado (para la temperatura)
function applyAdjustments(pipeline, adjust) {
  if (!adjust) return pipeline;
  const exposure = Number(adjust.exposure) || 0;
  const contrast = Number(adjust.contrast) || 0;
  const saturation = Number(adjust.saturation) || 0;
  const temperature = Number(adjust.temperature) || 0;

  if (exposure || saturation) {
    pipeline = pipeline.modulate({
      brightness: Math.max(0.1, 1 + exposure / 100),
      saturation: Math.max(0, 1 + saturation / 100),
    });
  }
  if (contrast) {
    const c = Math.max(0.1, 1 + contrast / 100);
    pipeline = pipeline.linear(c, (1 - c) * 128);
  }
  if (temperature) {
    const t = Math.max(-1, Math.min(1, temperature / 100));
    pipeline = pipeline.linear([1 + t * 0.25, 1, 1 - t * 0.25], [0, 0, 0]);
  }
  return pipeline;
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
 * @param {{orientation:'h'|'v', cx:number, cy:number, cw:number, ch:number,
 *   adjust?: {exposure:number, contrast:number, saturation:number, temperature:number}}} crop
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

  // Recorte y ajustes se hacen UNA vez sobre un buffer intermedio, y las 3
  // tallas se generan redimensionando ese mismo buffer — así el color sale
  // idéntico en las tres en vez de recalcularlo tres veces por separado.
  let adjustedPipeline = sharp(rotated).extract({ left, top, width, height });
  adjustedPipeline = applyAdjustments(adjustedPipeline, crop.adjust);
  const { data: adjusted } = await adjustedPipeline.toBuffer({ resolveWithObject: true });

  const files = {};
  let full = null;

  for (const tier of LONG_EDGE_TIERS) {
    const { w, h } = tierDims(tier, ratio);
    const outPath = path.join(stagingDir, tier === 2400 ? `${baseId}.jpg` : `${baseId}-${tier}.jpg`);

    // El recorte ya tiene exactamente la proporción del marco (lo construye
    // así la interfaz), así que "fill" a las medidas fijas del nivel no
    // deforma nada — solo redimensiona.
    await sharp(adjusted)
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
