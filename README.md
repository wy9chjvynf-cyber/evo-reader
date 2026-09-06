# EvoReader

App web móvil extremadamente simple: carga un libro (PDF, TXT o DOCX) desde tu dispositivo y escúchalo narrado con la voz nativa del navegador (`speechSynthesis`).

Todo ocurre en el navegador: el texto se extrae localmente y el libro, la posición, la velocidad y la voz elegida se guardan en IndexedDB del dispositivo. No hay backend, ni login, ni analítica.

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

Los libros se procesan e importan de forma incremental (página a página para PDF) y se
guardan en IndexedDB con un modelo normalizado (`books` / `sections` / `chunks`) en vez de un
único blob con todo el texto — ver `src/lib/db.ts`, `src/lib/pdfImport.ts` y
`src/lib/bookImport.ts`. Esto permite libros muy grandes sin mantener todo el texto en memoria,
reanudar una importación interrumpida, y empezar a narrar antes de que termine de importarse
todo el libro. `scripts/gen-test-pdf.mjs <páginas> <ruta>` genera PDFs de prueba de cualquier
tamaño para probar esto localmente.

## Deploy (GitHub Pages)

```bash
npm run deploy
```

Compila con el `base` correcto, publica `dist/` en la rama `gh-pages` y queda disponible en
`https://<usuario>.github.io/evo-reader/`.
