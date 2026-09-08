"use strict";
const fs = require("fs");
const path = require("path");

// Los originales SIN recortar viven fuera de diary/ (ver .gitignore) —
// hacen falta para poder reencuadrar mas tarde sin perder calidad, pero
// nunca deben publicarse: pesan mucho (30+ MB cada uno) y el recorte es una
// decision editorial que no tiene por que quedar publica en el repo.
function originalsDir(repoRoot, entryId) {
  return path.join(repoRoot, "tools", "diary-uploader", "originals", entryId);
}

function saveOriginal(repoRoot, entryId, index, sourcePath) {
  const dir = originalsDir(repoRoot, entryId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(sourcePath) || ".jpg";
  const dest = path.join(dir, `${index}${ext}`);
  fs.copyFileSync(sourcePath, dest);
  return dest;
}

function findOriginal(repoRoot, entryId, index) {
  const dir = originalsDir(repoRoot, entryId);
  if (!fs.existsSync(dir)) return null;
  const match = fs.readdirSync(dir).find((f) => f.startsWith(`${index}.`));
  return match ? path.join(dir, match) : null;
}

function removeOriginals(repoRoot, entryId) {
  fs.rmSync(originalsDir(repoRoot, entryId), { recursive: true, force: true });
}

module.exports = { originalsDir, saveOriginal, findOriginal, removeOriginals };
