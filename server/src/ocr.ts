// Server-side OCR fallback for uploads that arrive without client OCR (web uploads).
// Android sends ML Kit text, so this only runs when ocr_text is missing.

let available: boolean | undefined;

export async function ocrAvailable(): Promise<boolean> {
  available ??= Bun.which("tesseract") !== null;
  return available;
}

export async function runOcr(path: string): Promise<string | null> {
  if (!(await ocrAvailable())) return null;
  const proc = Bun.spawn(["tesseract", path, "stdout", "-l", "eng", "--psm", "3"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 60_000);
  const text = await new Response(proc.stdout).text();
  clearTimeout(timer);
  if ((await proc.exited) !== 0) return null;
  return text.replace(/\n{3,}/g, "\n\n").trim() || null;
}
