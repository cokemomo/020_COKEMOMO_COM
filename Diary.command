#!/bin/bash
# Doble clic para abrir el subidor local del diario. Resuelve la ruta a si
# mismo, asi que funciona sin importar donde este clonado este repo.
cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules ]; then
  echo "Primera vez: instalando dependencias (sharp)…"
  npm install
fi

npm run diary
