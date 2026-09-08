"use strict";
const fs = require("fs");
const path = require("path");

const yearFile = (repoRoot, year) => path.join(repoRoot, "diary", "data", `${year}.json`);
const yearsFile = (repoRoot) => path.join(repoRoot, "diary", "data", "years.json");

// Escritura atomica: fichero temporal en el mismo directorio + rename.
// rename es atomico dentro del mismo filesystem, asi que un fallo a mitad
// nunca deja el JSON real a medio escribir.
function writeJSONAtomic(filePath, data) {
  const tmp = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

function readYear(repoRoot, year) {
  return readJSON(yearFile(repoRoot, year), { entries: [] });
}

function writeYear(repoRoot, year, data) {
  fs.mkdirSync(path.dirname(yearFile(repoRoot, year)), { recursive: true });
  writeJSONAtomic(yearFile(repoRoot, year), data);
}

function readYears(repoRoot) {
  return readJSON(yearsFile(repoRoot), { years: [] });
}

function ensureYearListed(repoRoot, year) {
  const data = readYears(repoRoot);
  const y = Number(year);
  if (!data.years.includes(y)) {
    data.years.push(y);
    data.years.sort((a, b) => b - a);
    writeJSONAtomic(yearsFile(repoRoot), data);
  }
}

function yearOf(dateISO) {
  return dateISO.slice(0, 4);
}

function addEntry(repoRoot, entry) {
  const year = yearOf(entry.date);
  const data = readYear(repoRoot, year);
  data.entries.push(entry);
  writeYear(repoRoot, year, data);
  ensureYearListed(repoRoot, year);
  return year;
}

// Busca una entrada por id recorriendo los años listados (mas nuevo primero).
function findEntry(repoRoot, id) {
  const { years } = readYears(repoRoot);
  for (const year of years) {
    const data = readYear(repoRoot, year);
    const idx = data.entries.findIndex((e) => e.id === id);
    if (idx !== -1) return { year, data, idx, entry: data.entries[idx] };
  }
  return null;
}

function updateEntry(repoRoot, id, patch) {
  const found = findEntry(repoRoot, id);
  if (!found) return null;
  const updated = { ...found.entry, ...patch, id: found.entry.id }; // el id nunca cambia
  found.data.entries[found.idx] = updated;
  writeYear(repoRoot, found.year, found.data);
  return updated;
}

function deleteEntry(repoRoot, id) {
  const found = findEntry(repoRoot, id);
  if (!found) return null;
  found.data.entries.splice(found.idx, 1);
  writeYear(repoRoot, found.year, found.data);
  return found.entry;
}

function listRecent(repoRoot, limit) {
  const { years } = readYears(repoRoot);
  const out = [];
  for (const year of years) {
    const data = readYear(repoRoot, year);
    out.push(...data.entries);
  }
  out.sort((a, b) => new Date(b.date) - new Date(a.date));
  return typeof limit === "number" ? out.slice(0, limit) : out;
}

module.exports = {
  readYear, writeYear, readYears, ensureYearListed,
  addEntry, findEntry, updateEntry, deleteEntry, listRecent,
  yearFile, yearsFile,
};
