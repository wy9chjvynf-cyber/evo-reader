/** Downscales an image Blob to a small JPEG thumbnail — covers never need to be full resolution. */
export async function resizeImageBlobToJpeg(blob: Blob, maxWidth: number, quality = 0.82): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo generar la portada.");
    ctx.drawImage(bitmap, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("No se pudo generar la portada."))), "image/jpeg", quality);
    });
  } finally {
    bitmap.close();
  }
}
