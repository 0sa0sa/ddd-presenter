/** Browser downloads shared by the board and architecture exports (SVG / PNG / draw.io / Mermaid). */

/** A file name without characters file systems reject. */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").trim() || "export";
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Rasterizes an SVG (at most 2× and 8000 px on the long side) and downloads it as PNG. */
export function downloadSvgAsPng(svg: string, fileName: string): void {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  img.onload = () => {
    const scale = Math.min(2, 8000 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((png) => png && downloadBlob(png, fileName), "image/png");
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

/** Copies text to the clipboard (falls back to a hidden textarea where the async API is unavailable). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
