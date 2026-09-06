import JSZip from "jszip";

export interface EpubChapterSpec {
  id: string;
  href: string;
  title: string;
  body: string;
}

export async function buildTestEpub(opts: {
  title?: string;
  author?: string;
  language?: string;
  chapters: EpubChapterSpec[];
  withCover?: boolean;
}): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );

  const manifestItems: string[] = [];
  const spineItems: string[] = [];
  const navItems: string[] = [];

  for (const ch of opts.chapters) {
    manifestItems.push(`<item id="${ch.id}" href="${ch.href}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${ch.id}"/>`);
    navItems.push(`<li><a href="${ch.href}">${ch.title}</a></li>`);
    zip.file(
      `OEBPS/${ch.href}`,
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${ch.title}</title></head>
<body><h1>${ch.title}</h1><p>${ch.body}</p></body></html>`,
    );
  }

  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>TOC</title></head>
<body><nav epub:type="toc"><ol>${navItems.join("")}</ol></nav></body></html>`,
  );

  let coverManifest = "";
  if (opts.withCover) {
    // 1x1 PNG, valid but tiny — enough to exercise the cover extraction path.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
    zip.file("OEBPS/cover.png", bytes);
    coverManifest = `<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>`;
  }

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${opts.title ?? "Untitled"}</dc:title>
    ${opts.author ? `<dc:creator>${opts.author}</dc:creator>` : ""}
    ${opts.language ? `<dc:language>${opts.language}</dc:language>` : ""}
    <dc:identifier id="bookid">urn:uuid:test</dc:identifier>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${coverManifest}
    ${manifestItems.join("\n    ")}
  </manifest>
  <spine>${spineItems.join("")}</spine>
</package>`,
  );

  return zip.generateAsync({ type: "arraybuffer" });
}

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

export interface DocxParagraphSpec {
  text: string;
  style?: "Heading1" | "Heading2";
}

export async function buildTestDocx(paragraphs: DocxParagraphSpec[]): Promise<ArrayBuffer> {
  const body = paragraphs
    .map((p) => {
      const pPr = p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : "";
      return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${p.text}</w:t></w:r></w:p>`;
    })
    .join("\n");

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}<w:sectPr/></w:body>
</w:document>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", ROOT_RELS);
  zip.file("word/document.xml", document);
  zip.file("word/styles.xml", STYLES);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  return zip.generateAsync({ type: "arraybuffer" });
}
