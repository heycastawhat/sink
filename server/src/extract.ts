import { extname } from "node:path";

/**
 * Text inside attachments, for search: `pdftotext` (poppler-utils) for PDFs and `tesseract` OCR for images. Plain
 * binaries rather than JS libraries (pdf.js, tesseract.js) because they're one apt package each in the image, much
 * faster, and keep their memory out of the server process. Whichever isn't installed is skipped.
 */
export type Extractor = (abs: string) => Promise<string | null>;

export const EXTRACTABLE = /\.(pdf|png|jpe?g|webp|tiff?|bmp|gif)$/i;
const MAX_TEXT = 200_000;
const tesseract = Bun.which("tesseract");
// Without English data every image would be stored as having no text, and not retried once the data is installed.
const ocr = tesseract && Bun.spawnSync([tesseract, "--list-langs"]).stdout.toString().split(/\s+/).includes("eng") ? tesseract : null;
const tools = { pdf: Bun.which("pdftotext"), ocr };
export const extractTools = Object.entries(tools).flatMap(([k, v]) => (v ? [k] : []));

/** The file's text, "" when it has none or the tool failed, null when there's no tool for this kind of file. */
export const extractText: Extractor = async (abs) => {
  const pdf = extname(abs).toLowerCase() === ".pdf";
  const cmd = pdf ? tools.pdf && [tools.pdf, "-q", abs, "-"] : tools.ocr && [tools.ocr, abs, "stdout"];
  if (!cmd) return null;
  // One OCR thread: this runs in the background and shouldn't take every core from the server.
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: 120_000, env: { ...process.env, OMP_THREAD_LIMIT: "1" } });
  const text = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";
};

const pdftoppm = Bun.which("pdftoppm");

/** Page one of a PDF as a JPEG `width` pixels wide, for its card; null without `pdftoppm` or when it fails. */
export async function pdfThumbnail(abs: string, width = 480): Promise<Uint8Array | null> {
  if (!pdftoppm) return null;
  const proc = Bun.spawn([pdftoppm, "-q", "-jpeg", "-f", "1", "-l", "1", "-singlefile", "-scale-to-x", String(width), "-scale-to-y", "-1", abs], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 30_000,
  });
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  return (await proc.exited) === 0 && bytes.length ? bytes : null;
}
