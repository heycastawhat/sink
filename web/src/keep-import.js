// Import from Google Keep: the Keep zip from Google Takeout, read in the browser and saved as notes through the
// normal API. Each Keep note becomes a markdown note in a "Keep" folder ("Keep/Archive" for archived ones), with
// its checklist as `- [ ]` todos, labels as tags, colour and pin as frontmatter, images as attachments and links
// at the end. Trashed notes are skipped, and so is anything already imported (same folder and title).

import { api } from './api.js';

// Keep's colours to Sink's card colours.
const COLORS = {
  RED: 'red',
  ORANGE: 'orange',
  YELLOW: 'yellow',
  GREEN: 'green',
  TEAL: 'teal',
  BLUE: 'blue',
  CERULEAN: 'blue',
  PURPLE: 'purple',
  PINK: 'pink',
  BROWN: 'brown',
  GRAY: 'gray',
};

/**
 * The files in a zip, by name, each read on demand. Handles stored and deflated entries (all Takeout uses) with the
 * browser's own DecompressionStream; no zip64, which only matters past 4 GB.
 */
async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer);
  // End of central directory: the last "PK\5\6" within the final 64 KB (it may be followed by a comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That isn't a zip file");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff) throw new Error('That zip is too big to read here; unzip it and pick the Keep folder instead');
  const names = new TextDecoder();
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('That zip looks damaged');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(buf.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    entries.set(name, async () => {
      // The local header repeats the name and has its own extra field, so the data starts after both.
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`Can't read ${name} (compression ${method})`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  }
  return entries;
}

/** Files picked one by one or as a folder, in the same shape as readZip's. */
function readFiles(files) {
  const entries = new Map();
  for (const f of files) entries.set(f.webkitRelativePath || f.name, async () => new Uint8Array(await f.arrayBuffer()));
  return entries;
}

const yamlString = (s) => (/^[\w .-]+$/.test(s) && !/^(true|false|null|yes|no)$/i.test(s) ? s : JSON.stringify(s));

/** One Keep note (Takeout's JSON) as markdown, without its images. */
export function keepToMarkdown(k) {
  const front = [];
  const tags = (k.labels ?? []).map((l) => String(l.name).trim().replace(/\s+/g, '-')).filter(Boolean);
  if (tags.length) front.push(`tags: [${tags.map(yamlString).join(', ')}]`);
  if (k.isPinned) front.push('pinned: true');
  if (COLORS[k.color]) front.push(`color: ${COLORS[k.color]}`);
  const created = Number(k.createdTimestampUsec) / 1000;
  if (created > 0) front.push(`created: ${new Date(created).toISOString()}`);

  const title = (k.title ?? '').trim();
  const body = [];
  if (title) body.push(`# ${title}`);
  const text = (k.textContent ?? '').trim();
  if (text) body.push(text);
  if (k.listContent?.length) {
    body.push(k.listContent.map((i) => `- [${i.isChecked ? 'x' : ' '}] ${String(i.text ?? '').replace(/\n/g, ' ').trim()}`).join('\n'));
  }
  const links = (k.annotations ?? []).filter((a) => a.url);
  if (links.length) body.push(links.map((a) => `- [${(a.title || a.url).replace(/[[\]]/g, '')}](${a.url})`).join('\n'));

  const content = (front.length ? `---\n${front.join('\n')}\n---\n` : '') + body.join('\n\n') + '\n';
  // Keep notes often have no title: name the file after the first line, as Sink does for its own notes.
  const firstLine = (text || k.listContent?.[0]?.text || 'Untitled').split('\n')[0];
  const name = (title || firstLine).replace(/^[-*+#>\s]+/, '').slice(0, 60).trim() || 'Untitled';
  return { title: name, folder: k.isArchived ? 'Keep/Archive' : 'Keep', content };
}

/**
 * Imports a Takeout zip, or the JSON and image files from an unzipped Keep folder. `progress(done, total)` is
 * called as it goes. Returns how many notes were imported, skipped as already there, and failed.
 */
export async function importKeep(files, progress = () => {}) {
  const entries = files.length === 1 && /\.zip$/i.test(files[0].name) ? await readZip(files[0]) : readFiles(files);
  const notes = [...entries.keys()].filter((n) => /\.json$/i.test(n) && !/Labels\.txt$/i.test(n));
  // Images are found by file name, next to the JSON that mentions them.
  const byName = new Map([...entries.keys()].map((n) => [n.split('/').pop(), n]));
  const { notes: existing } = await api.notes();
  const have = new Set(existing.map((n) => `${n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : ''}\n${n.title}`));
  const result = { imported: 0, skipped: 0, failed: 0 };
  const text = new TextDecoder();
  let done = 0;
  for (const path of notes) {
    progress(done++, notes.length);
    let k;
    try {
      k = JSON.parse(text.decode(await entries.get(path)()));
    } catch {
      continue; // Not a Keep note (Takeout puts other JSON alongside).
    }
    if (typeof k !== 'object' || !k || !('textContent' in k || 'listContent' in k)) continue;
    if (k.isTrashed) continue;
    const note = keepToMarkdown(k);
    if (have.has(`${note.folder}\n${note.title}`)) {
      result.skipped++;
      continue;
    }
    try {
      let content = note.content;
      for (const a of k.attachments ?? []) {
        const file = byName.get(String(a.filePath).split('/').pop());
        if (!file) continue;
        const bytes = await entries.get(file)();
        const { embed } = await api.attach(new File([bytes], a.filePath.split('/').pop(), { type: a.mimetype || '' }));
        content += `\n${embed}\n`;
      }
      await api.createNote({ folder: note.folder, title: note.title, content });
      have.add(`${note.folder}\n${note.title}`);
      result.imported++;
    } catch {
      result.failed++;
    }
  }
  progress(notes.length, notes.length);
  return result;
}
