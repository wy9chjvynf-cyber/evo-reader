import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node's own Blob/structuredClone are what real browsers behave like for
    // IndexedDB round-trips; jsdom's Blob loses its methods through fake-
    // indexeddb's structuredClone-based cloning. Files that need `window`
    // (speechController) opt into jsdom individually via a docblock comment.
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    globals: false,
  },
});
