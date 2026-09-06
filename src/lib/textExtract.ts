export function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^./]+$/, "");
}
