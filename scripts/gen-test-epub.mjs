import JSZip from "jszip";
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] || "/tmp/evoreader-test.epub";
const chapterCount = Number(process.argv[3] || 3);

const zip = new JSZip();
zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
zip.file(
  "META-INF/container.xml",
  `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
);

const manifestItems = [];
const spineItems = [];
const navItems = [];

for (let i = 1; i <= chapterCount; i++) {
  const id = `chap${i}`;
  const href = `text/chapter${i}.xhtml`;
  manifestItems.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
  spineItems.push(`<itemref idref="${id}"/>`);
  navItems.push(`<li><a href="${href}">Capítulo ${i} — Prueba</a></li>`);
  zip.file(
    `OEBPS/${href}`,
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Capítulo ${i}</title></head>
<body>
<h1>Capítulo ${i} — Prueba</h1>
<p>Este es el contenido narrativo del capítulo ${i}. El relojero Tomás siguió reparando mecanismos antiguos mientras el viento agitaba las hojas secas de la plaza.</p>
<p>Segundo párrafo del capítulo ${i} para asegurar suficiente texto narrable y verificar la fragmentación en oraciones.</p>
</body>
</html>`,
  );
}

zip.file(
  "OEBPS/nav.xhtml",
  `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>TOC</title></head>
<body>
<nav epub:type="toc">
  <ol>
    ${navItems.join("\n    ")}
  </ol>
</nav>
</body>
</html>`,
);

const coverSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#334"/><text x="200" y="300" fill="white" font-size="28" text-anchor="middle">TIERRA</text></svg>`;
const coverPng = await sharp(Buffer.from(coverSvg)).png().toBuffer();
zip.file("OEBPS/cover.png", coverPng);

zip.file(
  "OEBPS/content.opf",
  `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>TIERRA (prueba)</dc:title>
    <dc:creator>Autor de Prueba</dc:creator>
    <dc:language>es</dc:language>
    <dc:identifier id="bookid">urn:uuid:evoreader-test</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
    ${manifestItems.join("\n    ")}
  </manifest>
  <spine>
    ${spineItems.join("\n    ")}
  </spine>
</package>`,
);

const content = await zip.generateAsync({ type: "nodebuffer", mimeType: "application/epub+zip" });
writeFileSync(outPath, content);
console.log(`Wrote ${chapterCount}-chapter EPUB to ${outPath} (${(content.length / 1024).toFixed(1)} KB)`);
