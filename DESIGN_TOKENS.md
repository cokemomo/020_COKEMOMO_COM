# Tokens de diseño — cokemomo.com

Extraídos leyendo `index.html` (única fuente de estilos: todo el CSS vive inline
en un solo `<style>`, no hay build). Esto es un inventario, no una propuesta:
lo que añada Diary tiene que usar estos valores tal cual, no inventar otros.

## Stack y despliegue

- **Sitio estático puro.** Un `index.html` con CSS y JS inline. Sin framework,
  sin `package.json`, sin bundler.
- **GitHub Pages, build legacy (Jekyll por defecto, sin `_config.yml`).** Sirve
  directo desde `main`, raíz del repo (`source: {branch: main, path: /}`).
  Jekyll excluye por defecto lo que empieza por `.` o `_` — lo hemos usado ya
  para el `.gitignore` y para que `.DS_Store` no se publique.
- **Despliegue = `git push origin main`.** Sin CI. El build de Pages tarda
  ~55 s normalmente; una vez, tras subir un archivo de 9 MB, tardó 323 s. Con
  las 500 imágenes que prevé Diary a máxima escala, esto puede alargarse: cada
  entrada nueva dispara un rebuild completo del sitio, no incremental.
- **Cuenta de git:** `cokemomo` (no `cokemomoMR`) debe estar activa en `gh`
  para poder hacer push a este repo.

## Imágenes existentes

- `assets/img/photos/MAIN.jpg` — hero de portada.
- `assets/img/stories/<story>/PHOTO-N.jpg` — una carpeta por story, numeración
  secuencial. El sitio sondea `PHOTO-1..40` y borra los huecos (no hay manifest).
- Sin variantes de tamaño: se sirve el archivo original en todos los contextos.
- `assets/captions.json` (raíz) y `<story>/captions.json` existen como
  plantilla pero **no se usan**: ninguna de las 6 stories tiene su
  `captions.json`, y el campo queda vacío en producción.
- `assets/styles.css` — huérfano, no está enlazado desde `index.html`.

## Visor / lightbox existente

Hay uno (`#lightbox`), pero **no es reutilizable tal cual** para lo que pide
Diary:

- Siempre entra en modo `direct-zoom`, que **oculta permanentemente** los
  botones prev/next y el pie de foto (existen en el DOM, muertos en CSS).
  Hoy no hay forma de pasar de una foto a otra sin cerrar el visor.
- El gesto es tap-para-zoom-4×-y-pan-con-el-ratón, pensado para una sola
  imagen a pantalla completa, no para "anterior/siguiente dentro de una
  entrada".
- Sin flechas de teclado, sin `tabindex`, sin foco atrapado. Solo `Escape`
  cierra.
- `alt=""` fijo en todas las imágenes de galería.

Diary necesita prev/next reales, teclado y foco — así que la pieza se puede
**compartir visualmente** (mismo fondo, mismo blur, mismo cierre), pero la
lógica de navegación hay que ampliarla, no es un simple `reutilízalo`.

## Color

Un solo modo, oscuro, sin variables de tema claro:

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#121212` | fondo de toda la web |
| `--text-main` | `#e0e0e0` | texto principal |
| `--text-muted` | `#888888` | texto secundario (declarado, sin uso activo hoy) |
| blanco puro | `#fff` / `#e0e0e0` según contexto | texto sobre fondos oscuros (menú, header) |
| grises de UI | `#1a1a1a`, `#333`, `#bbb` | fondos y bordes de menús desplegables |

No hay ningún otro color en el sitio. **Cero acentos, cero azules de enlace.**
Diary no debe introducir ninguno.

## Tipografía

- Familia única: `-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif`.
  No hay tipografía de display distinta para títulos.
- Escala real en uso: `18px` (título de story) · `15px` (subtítulo, itálica) ·
  `13px` (UI: menú, pie de foto del lightbox) · `12px` (footer) · `10px`
  (etiqueta flotante `CLICK TO ZOOM`).
- **Convención de etiqueta pequeña** (la que pide el punto 3 del prompt):
  `text-transform: uppercase; letter-spacing: .04–.05em; font-weight: 500`.
  Se usa en `.story-title` y en la etiqueta `CLICK TO ZOOM` actual. Esto es lo
  que debe seguir el nuevo hover de "click to enlarge", nada inventado.
- Los botones del menú (`HOME`, `STORIES`, `PSILICON FLESH`...) están en
  mayúsculas **tecleadas en el HTML**, no por CSS — dato menor, pero si Diary
  genera etiquetas dinámicas (meses) hay que decidir cuál de los dos caminos
  seguir.

## Idioma de la interfaz

**Toda la interfaz visible está en inglés**, pese a `<html lang="es">`: `HOME`,
`STORIES`, `CLICK TO ZOOM`, `CLICK TO ZOOM OUT`. El prompt pide confirmar
esto — confirmado: el hover "click to enlarge" que pide la Fase 3 encaja
directamente con esta convención, sin traducir.

Esto es distinto del **contenido** de Diary (fechas, texto de las entradas),
que el propio prompt pide en castellano y en minúsculas — no hay conflicto:
chrome del sitio en inglés, contenido editorial en castellano, igual que hoy
conviven "STORIES" (chrome) con las fotos y su significado personal.

## Espaciado, rejilla, radios, bordes

| Token | Valor |
|---|---|
| `--page-max` | `1400px` (ancho máximo de contenido) |
| `--page-pad` | `32px` (18px por debajo de 600px) |
| `--gap` | `32px` (22px por debajo de 600px) |
| `--radius` | `16px` — **usado en `.tile` y `.menu-list`** |
| `--border` | `1px solid rgba(255,255,255,.1)` |
| `--shadow` | `0 18px 40px rgba(0,0,0,.60)` — en tiles y header |

**Importante:** el sitio SÍ usa radio de 16px y sombra en las fotos de las
galerías actuales. El prompt pide explícitamente que Diary vaya **sin marco,
sin sombra, sin radio** — es una desviación deliberada que pide Coke para
tratar la foto como "objeto delicado", no un descuido mío ni del sitio
existente. La aplico tal cual la pide para Diary; no la extiendo al resto.

## Transiciones ya existentes

Nada por debajo de 150 ms, nada por encima de 600 ms:

- `0.2s ease` — opacidad del label flotante `cursor-msg`
- `0.3s` — opacidad de botones de menú al hover
- `0.4s ease` — header al ocultarse, filtro del logo
- `0.6s ease` — fondo del header al cambiar de modo

**No existe ningún uso de `prefers-reduced-motion`** salvo para el grano de
película (añadido esta sesión). Ninguna transición del sitio lo respeta hoy.
Tampoco existe ningún `@media (hover: hover) and (pointer: fine)` — sería la
primera vez que se usa en el sitio.

## Responsive

Dos puntos de ruptura reales, ambos `max-width`:

- **900px** — el grid de fotos pasa de 2 columnas a 1; el lightbox cambia de
  pan-zoom de escritorio a scroll táctil con zoom nativo del navegador.
- **600px** — reduce paddings, logo, gap; oculta el `cursor-msg` (el label de
  "click to zoom" no existe en móvil, ya es la convención actual).

## Rutas ya ocupadas (no tocar / no colisionar)

- `/vkkqv5lzdn/` — juego cifrado, sin enlazar, `noindex`.
- `/o92561mh3d/` — PWA de la calculadora de paella, sin enlazar, `noindex`.
- `/diary` está libre.
