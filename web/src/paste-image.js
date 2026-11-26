// Copying an image from a web page puts HTML (`<img src="https://…">`) on the clipboard, and in some browsers no
// file with it. The editor only knew files, so such a paste inserted nothing at all. These turn the HTML into a file
// the usual upload path can take.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENTITIES[e]);

/** The `src` of the first `<img>` in pasted HTML, if it's something a browser can fetch (http(s) or a data image). */
export function imageSource(html) {
  const tag = /<img\b[^>]*>/i.exec(html ?? '');
  const src = tag && /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
  const value = src && decode(src[1] ?? src[2] ?? src[3]).trim();
  // Relative or blob: URLs belong to the page they were copied from and mean nothing here.
  return value && /^(https?:\/\/|data:image\/)/i.test(value) ? value : null;
}

/** The image to paste, when the clipboard holds only HTML around one: no file and no text of its own. */
export function pastedHtmlImage(clipboard) {
  if (!clipboard || clipboard.files?.length) return null;
  // Text beside the image (a selection from a page) is a normal paste.
  if (clipboard.getData('text/plain').trim()) return null;
  return imageSource(clipboard.getData('text/html'));
}

const MAX_BYTES = 25 * 1024 * 1024;
const EXTENSION = { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/heic': 'heic' };
const KNOWN = /\.(png|jpe?g|gif|webp|avif|svg|heic)$/i;

/** A data: URL's bytes, decoded by hand: the page's CSP (connect-src 'self') stops fetch() reading one. */
function decodeDataUrl(src) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(src);
  if (!m) throw new Error("that isn't an image");
  const bytes = /;base64/i.test(m[2])
    ? Uint8Array.from(atob(decodeURIComponent(m[3])), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes], { type: m[1] });
}

/**
 * The picture through an <img> and a canvas, as PNG. The CSP lets the page show images from any https site but not
 * fetch() them, and a canvas can be read back only from an image the site allows cross-origin (the same CORS
 * permission a fetch would need). Not for GIFs and SVGs, which a canvas would flatten.
 */
function drawImage(src) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined' || /\.(gif|svg)(?:[?#]|$)/i.test(src)) return reject(new Error("the image couldn't be copied"));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => reject(new Error("the image couldn't be loaded"));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the image couldn't be copied"))), 'image/png');
    };
    img.src = src;
  });
}

/**
 * The image as a File named from its URL; throws if it can't be had (usually the site's CORS) or isn't an image.
 * `fetchFn` and `draw` are the two ways of reading a web image (see drawImage); tests swap them.
 */
export async function fetchImage(src, fetchFn = fetch, draw = drawImage) {
  let blob;
  let recoded = false;
  if (/^data:/i.test(src)) blob = decodeDataUrl(src);
  else {
    try {
      const res = await fetchFn(src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`the image couldn't be fetched (${res.status})`);
      blob = await res.blob();
    } catch (err) {
      // Blocked by the page's CSP or the site's CORS: a canvas may still manage it.
      blob = await draw(src).catch(() => Promise.reject(err));
      recoded = true;
    }
  }
  if (!blob.type.startsWith('image/')) throw new Error("that isn't an image");
  if (blob.size > MAX_BYTES) throw new Error('the image is too large');
  let name = 'image';
  if (!src.startsWith('data:')) {
    try {
      name = decodeURIComponent(new URL(src).pathname.split('/').pop() ?? '') || name;
    } catch {}
  }
  // The server decides the type from the extension, so one the URL lacks (or gets wrong) comes from the bytes.
  const ext = EXTENSION[blob.type] ?? blob.type.slice('image/'.length).replace(/\+.*$/, '');
  if (recoded || !KNOWN.test(name)) name = `${name.replace(KNOWN.test(name) ? KNOWN : /\.[^./]*$/, '')}.${ext}`;
  return new File([blob], name, { type: blob.type });
}

/**
 * A paste of just an image from a web page. Returns false when it isn't one (so the paste goes on as usual); otherwise
 * claims the event and, in the background, uploads the image and inserts what `uploadFile` returns. If it can't
 * (the site refuses to be fetched, the upload fails) the image's address goes in as a markdown image instead, which
 * the editor shows from the web, so a paste never turns into nothing.
 *   insert(text)  puts text at the cursor
 */
export function pasteHtmlImage(e, { uploadFile, insert, onError, fetchFn, draw }) {
  const src = uploadFile && pastedHtmlImage(e.clipboardData);
  if (!src) return false;
  e.preventDefault();
  // A data: image has no address worth keeping (it's the whole picture), so with no upload it's dropped.
  const link = /^data:/i.test(src) ? null : `![](${src.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`;
  (async () => {
    let file;
    try {
      file = await fetchImage(src, fetchFn, draw);
    } catch {
      // Expected for sites that don't allow it, so no error to show; just the link.
      return link && insert(link);
    }
    try {
      insert(await uploadFile(file));
    } catch (err) {
      onError?.(err);
      if (link) insert(link);
    }
  })();
  return true;
}
