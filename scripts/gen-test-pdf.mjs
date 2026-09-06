import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";

const pages = Number(process.argv[2] || 50);
const outPath = process.argv[3] || `/tmp/evoreader-test-${pages}p.pdf`;

const PARAGRAPH =
  "Capítulo de prueba. Este es un párrafo narrativo generado automáticamente para poblar un libro grande y " +
  "verificar que EvoReader puede procesar cientos de páginas sin mantener todo el texto en memoria a la vez. " +
  "El relojero Tomás siguió reparando mecanismos antiguos mientras el viento agitaba las hojas secas de la " +
  "plaza, preguntándose de qué máquina olvidada podría provenir aquel engranaje dorado que nunca había visto.";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const fontSize = 11;
const lineHeight = fontSize * 1.4;
const marginX = 50;
const pageWidth = 612;
const pageHeight = 792;
const maxWidth = pageWidth - marginX * 2;

function wrapText(text, font, size, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

for (let p = 1; p <= pages; p++) {
  const page = doc.addPage([pageWidth, pageHeight]);
  const text = `Página ${p}. ${PARAGRAPH} ${PARAGRAPH}`;
  const lines = wrapText(text, font, fontSize, maxWidth);
  let y = pageHeight - 60;
  for (const line of lines) {
    if (y < 40) break;
    page.drawText(line, { x: marginX, y, size: fontSize, font, color: rgb(0, 0, 0) });
    y -= lineHeight;
  }
}

const bytes = await doc.save();
writeFileSync(outPath, bytes);
console.log(`Wrote ${pages}-page PDF to ${outPath} (${(bytes.length / 1024).toFixed(0)} KB)`);
