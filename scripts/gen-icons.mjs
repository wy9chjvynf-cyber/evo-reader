import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const svgPath = path.join(root, "icon-source.svg");
const outDir = path.join(root, "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const sizes = [192, 512];
for (const size of sizes) {
  await sharp(svgPath).resize(size, size).png().toFile(path.join(outDir, `icon-${size}.png`));
}
// maskable: add safe-area padding by shrinking content to ~80%
await sharp(svgPath)
  .resize(410, 410)
  .extend({ top: 51, bottom: 51, left: 51, right: 51, background: "#12131a" })
  .png()
  .toFile(path.join(outDir, "icon-maskable-512.png"));

// favicon
await sharp(svgPath).resize(64, 64).png().toFile(path.join(root, "..", "public", "favicon.png"));

console.log("icons generated");
