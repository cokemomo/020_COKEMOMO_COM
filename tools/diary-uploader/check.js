#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const { readYears, readYear } = require("./lib/diaryData");

const REPO_ROOT = process.env.DIARY_REPO_ROOT || path.resolve(__dirname, "..", "..");
const MEDIA_ROOT = path.join(REPO_ROOT, "diary", "media");

function walk(dir) {
  let out = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) out = out.concat(walk(p));
    else if (name.isFile() && p.toLowerCase().endsWith(".jpg")) out.push(p);
  }
  return out;
}

function main() {
  const problems = [];
  const referenced = new Set();

  const { years } = readYears(REPO_ROOT);
  if (!years.length) {
    console.log("diary:check — no hay años listados en diary/data/years.json (nada que comprobar).");
    process.exit(0);
  }

  for (const year of years) {
    const data = readYear(REPO_ROOT, year);
    for (const entry of data.entries) {
      if (!entry.id) problems.push(`${year}.json: hay una entrada sin id.`);
      if (!entry.images || !entry.images.length) {
        problems.push(`${entry.id || "?"}: no tiene ninguna imagen.`);
        continue;
      }
      entry.images.forEach((img, i) => {
        if (!img.alt || !img.alt.trim()) {
          problems.push(`${entry.id}: la imagen ${i + 1} no tiene alt.`);
        }
        const all = [img.src, ...(img.srcset || []).map((s) => s.src)];
        for (const src of all) {
          const abs = path.join(REPO_ROOT, src.replace(/^\//, ""));
          referenced.add(abs);
          if (!fs.existsSync(abs)) {
            problems.push(`${entry.id}: falta el fichero ${src}`);
          }
        }
      });
    }
  }

  if (fs.existsSync(MEDIA_ROOT)) {
    for (const file of walk(MEDIA_ROOT)) {
      if (!referenced.has(file)) {
        problems.push(`huérfano en disco, ninguna entrada lo referencia: ${path.relative(REPO_ROOT, file)}`);
      }
    }
  }

  if (problems.length) {
    console.log(`diary:check — ${problems.length} problema(s):\n`);
    problems.forEach((p) => console.log("  · " + p));
    process.exit(1);
  }

  console.log("diary:check — todo en orden.");
  process.exit(0);
}

main();
