"use strict";
const { execFile } = require("child_process");

function git(repoRoot, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoRoot, maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// Solo añade los ficheros que la publicación tocó de verdad — nunca "git add -A".
async function commitFiles(repoRoot, files, message) {
  await git(repoRoot, ["add", "--", ...files]);
  const hash = await git(repoRoot, ["commit", "-m", message]).then(
    () => git(repoRoot, ["rev-parse", "--short", "HEAD"])
  );
  return hash;
}

// El push es SIEMPRE una acción aparte que pide la interfaz de forma
// explícita — nunca automático tras publicar. Así lo pide el proyecto.
async function push(repoRoot) {
  return git(repoRoot, ["push", "origin", "main"]);
}

// Para el indicador de estado de la interfaz: cuantos commits locales no
// estan subidos, y si hay cambios sin comprometer (no deberia pasar nunca
// en uso normal, pero avisa si el propio subidor se queda a medias).
async function status(repoRoot) {
  let ahead = null;
  try {
    ahead = Number(await git(repoRoot, ["rev-list", "--count", "@{u}..HEAD"]));
  } catch (e) {
    ahead = null; // sin upstream configurado: no se puede saber
  }
  const porcelain = await git(repoRoot, ["status", "--porcelain"]);
  return { ahead, dirty: porcelain.length > 0 };
}

module.exports = { git, commitFiles, push, status };
