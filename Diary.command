#!/bin/bash
# Doble clic para abrir el subidor local del diario. Resuelve la ruta a si
# mismo, asi que funciona sin importar donde este clonado este repo.
cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules ]; then
  echo "Primera vez: instalando dependencias (sharp)…"
  npm install
fi

URL="http://127.0.0.1:4173"

# Si ya estaba abierto de antes (otro doble clic sin cerrar este), no hace
# falta arrancar otro servidor: basta con abrir el navegador.
if curl -s -o /dev/null -m 1 "$URL"; then
  echo "Ya estaba en marcha — abriendo el navegador."
  open "$URL"
  exit 0
fi

# El servidor por si solo no abre el navegador (antes había que ir a mano a
# la URL) — aqui se arranca en segundo plano, se espera a que responda, y
# entonces se abre la pagina sola.
npm run diary &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -s -o /dev/null -m 1 "$URL"; then
    open "$URL"
    break
  fi
  sleep 0.3
done

wait "$SERVER_PID"
