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
npm run build
```

## Deploy (GitHub Pages)

```bash
GH_PAGES=1 npm run build
```

genera `dist/` con el `base` correcto para servirse desde `https://<usuario>.github.io/evo-reader/`.
