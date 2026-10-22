import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

const ALLOWED = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["heif", "image/heif"],
  ["gif", "image/gif"],
]);

const THUMB_WIDTH = 480;

export type StoredImage = {
  imagePath: string;
  thumbPath: string;
  mime: string;
  width: number;
  height: number;
};

export class MediaStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  path(relative: string): string {
    return join(this.dir, relative);
  }

  /** Validates the bytes are a real image, stores the original plus a webp thumbnail. */
  async save(id: string, bytes: Uint8Array): Promise<StoredImage> {
    const meta = await sharp(bytes).metadata();
    const mime = meta.format ? ALLOWED.get(meta.format) : undefined;
    if (!mime || !meta.width || !meta.height) throw new MediaError("unsupported image");

    const ext = meta.format === "jpeg" ? "jpg" : meta.format!;
    const imagePath = `${id}.${ext}`;
    const thumbPath = `${id}.thumb.webp`;

    await Bun.write(this.path(imagePath), bytes);
    await sharp(bytes)
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(this.path(thumbPath));

    return { imagePath, thumbPath, mime, width: meta.width, height: meta.height };
  }

  /** Downscaled JPEG for sending to a vision model; keeps token cost low. */
  async forModel(imagePath: string, maxPx: number): Promise<string> {
    const buf = await sharp(this.path(imagePath))
      .rotate()
      .resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  }

  async remove(...paths: string[]) {
    await Promise.all(paths.map((p) => unlink(this.path(p)).catch(() => {})));
  }
}

export class MediaError extends Error {}
