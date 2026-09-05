import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// GH_PAGES=1 npm run build -> serves from /evo-reader/ (GitHub Pages project site)
const base = process.env.GH_PAGES ? "/evo-reader/" : "/";

export default defineConfig({
  base,
  build: {
    // Conservative baseline so esbuild transpiles any newer syntax that
    // older/partial iOS WebKit builds don't support, instead of shipping it as-is.
    target: ["es2020", "safari14"],
    // pdfjs-dist and mammoth are intentionally bundled into the single main
    // chunk (no dynamic import()) to avoid fetching a separate content-hashed
    // chunk on demand, which can 404 for a client with the page open across
    // a deploy. One larger chunk is an acceptable tradeoff for this app.
    chunkSizeWarningLimit: 1500,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png"],
      manifest: {
        id: "/",
        name: "EvoReader",
        short_name: "EvoReader",
        description: "Escucha tus libros PDF, TXT y DOCX narrados en voz alta.",
        theme_color: "#12131a",
        background_color: "#12131a",
        display: "standalone",
        orientation: "portrait",
        start_url: base,
        scope: base,
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
      },
    }),
  ],
});
