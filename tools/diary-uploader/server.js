"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const { proposeDate } = require("./lib/exif");
const { listRecent, findEntry } = require("./lib/diaryData");
const { publishEntry, editEntry, removeEntry } = require("./lib/publish");
const { push } = require("./lib/git");
const { findOriginal } = require("./lib/originals");

// Resuelto respecto al propio script, nunca una ruta absoluta fija — esto
// vive en tools/diary-uploader/, el repo es dos niveles arriba.
const REPO_ROOT = process.env.DIARY_REPO_ROOT || path.resolve(__dirname, "..", "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.DIARY_PORT ? Number(process.env.DIARY_PORT) : 4173;
const HOST = "127.0.0.1"; // NUNCA 0.0.0.0: esta herramienta no es para la red

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    req.on("data", (c) => {
      if (rejected) return;
      size += c.length;
      if (size > maxBytes) {
        rejected = true;
        // req.destroy() aquí cerraba la conexión en seco: el navegador veía
        // "Failed to fetch" en vez de un error legible, porque la respuesta
        // nunca llegaba a escribirse en un socket ya muerto. req.pause()
        // solo deja de leer más datos; la conexión sigue viva para poder
        // responder con un 413 normal.
        req.pause();
        const err = new Error("La foto (o el conjunto de fotos) pesa demasiado para publicarla de una vez.");
        err.statusCode = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

async function readJSONBody(req, maxBytes) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json; charset=utf-8",
};

// Sirve las fotos ya publicadas para las miniaturas de "últimas entradas".
// path.resolve + comprobar el prefijo evita que un "../.." se salga de
// diary/media aunque la URL venga manipulada.
const MEDIA_ROOT = path.join(REPO_ROOT, "diary", "media");
function serveMedia(res, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/diary\/media\//, ""));
  const abs = path.resolve(MEDIA_ROOT, rel);
  if (!abs.startsWith(MEDIA_ROOT + path.sep)) return sendJSON(res, 403, { error: "ruta no permitida" });
  serveStatic(res, abs);
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJSON(res, 404, { error: "no encontrado" });
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// Un dia de fotos sin comprimir en base64 puede pesar bastante — esto es
// solo entre el navegador y este mismo Mac, asi que un limite generoso
// (500 MB) no es un riesgo, es solo para no dejar la memoria sin techo.
const MAX_BODY = 500 * 1024 * 1024;

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  try {
    if (req.method === "GET" && pathname === "/") {
      return serveStatic(res, path.join(PUBLIC_DIR, "index.html"));
    }

    if (req.method === "GET" && pathname.startsWith("/diary/media/")) {
      return serveMedia(res, pathname);
    }

    if (req.method === "GET" && pathname === "/api/entries") {
      const limit = url.searchParams.get("limit");
      return sendJSON(res, 200, { entries: listRecent(REPO_ROOT, limit ? Number(limit) : 20) });
    }

    if (req.method === "POST" && pathname === "/api/exif") {
      const body = await readJSONBody(req, MAX_BODY);
      const fs2 = require("fs");
      const os = require("os");
      const tmp = path.join(os.tmpdir(), `diary-exif-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
      const b64 = /^data:[^;]+;base64,(.+)$/.exec(body.dataUrl || "");
      if (!b64) return sendJSON(res, 400, { error: "dataUrl inválido" });
      fs2.writeFileSync(tmp, Buffer.from(b64[1], "base64"));
      try {
        const proposal = await proposeDate(tmp, body.lastModified);
        return sendJSON(res, 200, proposal);
      } finally {
        fs2.rmSync(tmp, { force: true });
      }
    }

    if (req.method === "POST" && pathname === "/api/publish") {
      const body = await readJSONBody(req, MAX_BODY);
      const result = await publishEntry(REPO_ROOT, body);
      return sendJSON(res, 200, result);
    }

    // Original sin recortar de una foto ya publicada, para poder abrir el
    // gestor de encuadre de nuevo desde "Editar" sin perder calidad.
    const originalMatch = /^\/api\/entries\/([^/]+)\/original\/(\d+)$/.exec(pathname);
    if (req.method === "GET" && originalMatch) {
      const id = decodeURIComponent(originalMatch[1]);
      const index = Number(originalMatch[2]);
      const file = findOriginal(REPO_ROOT, id, index);
      if (!file) {
        return sendJSON(res, 404, {
          error: "No hay original guardado para esta foto (se publicó antes de que se pudiera reencuadrar).",
        });
      }
      return serveStatic(res, file);
    }

    const editMatch = /^\/api\/entries\/([^/]+)$/.exec(pathname);
    if (req.method === "PUT" && editMatch) {
      const body = await readJSONBody(req, MAX_BODY);
      const result = await editEntry(REPO_ROOT, decodeURIComponent(editMatch[1]), body);
      return sendJSON(res, 200, result);
    }

    if (req.method === "DELETE" && editMatch) {
      const body = await readJSONBody(req, MAX_BODY);
      const id = decodeURIComponent(editMatch[1]);
      const found = findEntry(REPO_ROOT, id);
      if (!found) return sendJSON(res, 404, { error: "no existe" });
      // confirmacion escribiendo la fecha, tal y como pide el proyecto —
      // se comprueba tambien en el servidor, no solo en el navegador.
      const day = found.entry.date.slice(0, 10);
      if ((body.confirmDate || "").trim() !== day) {
        return sendJSON(res, 400, { error: `Escribe la fecha exacta (${day}) para confirmar el borrado.` });
      }
      const result = await removeEntry(REPO_ROOT, id);
      return sendJSON(res, 200, result);
    }

    if (req.method === "POST" && pathname === "/api/git/push") {
      const out = await push(REPO_ROOT);
      return sendJSON(res, 200, { ok: true, output: out });
    }

    sendJSON(res, 404, { error: "ruta no encontrada" });
  } catch (err) {
    sendJSON(res, err.statusCode || 500, { error: err.message || String(err) });
  }
}

const server = http.createServer((req, res) => { handle(req, res); });

server.listen(PORT, HOST, () => {
  console.log(`Diario — subidor local en http://${HOST}:${PORT}  (Ctrl+C para parar)`);
});
