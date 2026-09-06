import JSZip from "jszip";
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] || "/tmp/evoreader-test.docx";
const mode = process.argv[3] || "headings"; // "headings" | "plain"

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>
</w:styles>`;

function paragraph(text, style) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

const BODY_TEXT =
  "El relojero Tomás siguió reparando mecanismos antiguos mientras el viento agitaba las hojas secas de la plaza. " +
  "Se preguntaba de qué máquina olvidada podría provenir aquel engranaje dorado que nunca había visto.";

let paragraphs;
if (mode === "headings") {
  paragraphs = [
    paragraph("TIERRA", "Heading1"),
    paragraph("Novela de prueba generada sintéticamente."),
    paragraph("Capítulo 1 — El regreso", "Heading1"),
    paragraph(BODY_TEXT),
    paragraph(BODY_TEXT),
    paragraph("Un apartado", "Heading2"),
    paragraph(BODY_TEXT),
    paragraph("Capítulo 2 — La casa", "Heading1"),
    paragraph(BODY_TEXT),
    paragraph("Capítulo 3 — El bosque", "Heading1"),
    paragraph(BODY_TEXT),
  ].join("\n");
} else {
  paragraphs = [paragraph("TIERRA"), paragraph(BODY_TEXT), paragraph(BODY_TEXT), paragraph(BODY_TEXT)].join("\n");
}

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr/>
  </w:body>
</w:document>`;

const zip = new JSZip();
zip.file("[Content_Types].xml", CONTENT_TYPES);
zip.file("_rels/.rels", ROOT_RELS);
zip.file("word/document.xml", DOCUMENT);
zip.file("word/styles.xml", STYLES);
zip.file("word/_rels/document.xml.rels", DOC_RELS);

const content = await zip.generateAsync({ type: "nodebuffer" });
writeFileSync(outPath, content);
console.log(`Wrote ${mode} DOCX to ${outPath} (${(content.length / 1024).toFixed(1)} KB)`);
