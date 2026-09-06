import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] || "/tmp/evoreader-test-chapters.pdf";

const PARAGRAPH =
  "El relojero Tomás siguió reparando mecanismos antiguos mientras el viento agitaba las hojas secas de la " +
  "plaza, preguntándose de qué máquina olvidada podría provenir aquel engranaje dorado que nunca había visto.";

// page index (0-based) -> heading line to place at the top of that page.
const HEADINGS = {
  0: "CAPÍTULO 1",
  3: "Capítulo 2",
  7: "CAPÍTULO III",
};

const TOTAL_PAGES = 10;

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

for (let p = 0; p < TOTAL_PAGES; p++) {
  const page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - 60;

  const heading = HEADINGS[p];
  if (heading) {
    page.drawText(heading, { x: marginX, y, size: 16, font, color: rgb(0, 0, 0) });
    y -= lineHeight * 2.2;
  }

  const bodyText = `${PARAGRAPH} ${PARAGRAPH}`;
  const lines = wrapText(bodyText, font, fontSize, maxWidth);
  for (const line of lines) {
    if (y < 40) break;
    page.drawText(line, { x: marginX, y, size: fontSize, font, color: rgb(0, 0, 0) });
    y -= lineHeight;
  }
}

const bytes = await doc.save();
writeFileSync(outPath, bytes);
console.log(`Wrote ${TOTAL_PAGES}-page PDF with chapter markers to ${outPath}`);
