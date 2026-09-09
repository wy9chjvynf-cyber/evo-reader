import type { CapacitorConfig } from "@capacitor/cli";

// webDir points at the CAP_BUILD=1 output (see vite.config.ts) — a root-relative
// build distinct from dist/ (GitHub Pages, base "/evo-reader/"), since the iOS
// app serves its bundled web assets from its own root, not a subpath.
const config: CapacitorConfig = {
  appId: "com.evonexus.evoreader",
  appName: "EvoReader",
  webDir: "dist-ios",
};

export default config;
