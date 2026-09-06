# EvoReader

App web móvil extremadamente simple: carga un libro (EPUB, PDF, DOCX, TXT o Markdown) desde tu
dispositivo y escúchalo narrado con la voz nativa del navegador (`speechSynthesis`), navegando
por capítulos cuando el libro los tiene.

Todo ocurre en el navegador: el texto se extrae localmente y el libro, sus capítulos, la
posición, la velocidad y la voz elegida se guardan en IndexedDB del dispositivo. No hay backend,
ni login, ni analítica.

## Desarrollo

```bash
npm install
npm run dev
```

## Build y gates

```bash
npm run lint
npm run test
npm run build
```

## Arquitectura del Reader Core

Los libros se procesan e importan de forma incremental (página a página para PDF, sección a
sección para EPUB) y se guardan en IndexedDB con un modelo normalizado (`books` / `sections` /
`chunks` / `covers` / `files`) en vez de un único blob con todo el texto — ver `src/lib/db.ts`.
Esto permite libros muy grandes sin mantener todo el texto en memoria, reanudar una importación
interrumpida (PDF/EPUB) sin reprocesar nada ya confirmado, y empezar a narrar antes de que
termine de importarse todo el libro.

Cada formato tiene su propio importador, orquestados por `src/lib/bookImport.ts`:

- `src/lib/pdfImport.ts` — extracción página a página + detección conservadora de capítulos
  (`src/lib/chapterHeuristics.ts`) + miniatura de portada.
- `src/lib/epubImport.ts` — ZIP (vía `jszip`) + OPF/NCX/nav (vía `DOMParser`, sin dependencia de
  parser EPUB dedicado), procesado por spine, sección a sección, con portada real si el EPUB la
  declara.
- `src/lib/docxImport.ts` — usa los estilos Heading 1/2/3 de Word (que Mammoth ya convierte a
  `<h1>/<h2>/<h3>`) como capítulos/secciones.
- `src/lib/textImport.ts` — TXT (mismas heurísticas de capítulo que PDF) y Markdown (`#`/`##`/`###`).

`SpeechController` (`src/lib/speechController.ts`) no mantiene el libro en memoria: pide cada
chunk bajo demanda a IndexedDB y entra en estado `buffering` si el chunk todavía no fue
importado — así Play puede arrancar mientras un libro grande sigue procesándose, y saltar de
capítulo (`goToChunk`) es solo otro salto de índice.

`scripts/gen-test-pdf.mjs`, `gen-test-pdf-chapters.mjs`, `gen-test-epub.mjs` y `gen-test-docx.mjs`
generan fixtures sintéticos (sin contenido de terceros) para probar todo esto localmente con
libros de cualquier tamaño y estructura.

## Deploy (GitHub Pages)

```bash
npm run deploy
```

Compila con el `base` correcto, publica `dist/` en la rama `gh-pages` (conservando los assets de
deploys anteriores para evitar version-skew) y queda disponible en
`https://<usuario>.github.io/evo-reader/`.
