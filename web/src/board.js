// Excalidraw boards, stored as `.excalidraw.md` in the format of Obsidian's Excalidraw plugin, so the same file
// opens in both. Loaded on demand: React and Excalidraw only download when a board is opened.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import LZString from 'lz-string';

const DEFAULT_FRONTMATTER = '---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n';
const BANNER =
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'";

/** An empty board file. */
export function emptyBoard() {
  return serialize(DEFAULT_FRONTMATTER, { elements: [], appState: {}, files: {} }, new Map());
}

/** Reads the scene out of a board file. Handles the plugin's compressed and plain JSON blocks. */
export function parseBoard(text) {
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(text)?.[0] ?? DEFAULT_FRONTMATTER;
  // From the `# Drawing` heading when there is one, so a json block quoted earlier isn't taken; else the whole file.
  const from = Math.max(0, text.search(/^#+ Drawing\s*$/m));
  const block = /```(compressed-json|json)\r?\n([\s\S]*?)\r?\n```/.exec(text.slice(from));
  let scene = { elements: [], appState: {}, files: {} };
  if (block) {
    const raw = block[1] === 'compressed-json' ? LZString.decompressFromBase64(block[2].replace(/\s+/g, '')) : block[2];
    try {
      scene = { ...scene, ...JSON.parse(raw) };
    } catch {
      throw new Error("This board's drawing data is damaged");
    }
  }
  // `## Embedded Files` lines: `<fileId>: [[image.png]]`
  const files = new Map();
  const section = /^#+ Embedded [Ff]iles\s*$([\s\S]*?)(?=^#+ |^%%)/m.exec(text);
  for (const m of (section?.[1] ?? '').matchAll(/^([\w-]+):\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gm)) files.set(m[1], m[2]);
  return { frontmatter, scene, files };
}

function serialize(frontmatter, scene, files) {
  const texts = scene.elements
    .filter((e) => e.type === 'text' && !e.isDeleted)
    .map((e) => `${(e.originalText ?? e.text).replace(/\n/g, ' ')} ^${e.id}`)
    .join('\n\n');
  const embedded = [...files].map(([id, name]) => `${id}: [[${name}]]`).join('\n');
  return [
    frontmatter.trimEnd(),
    BANNER,
    '',
    '',
    '# Excalidraw Data',
    '',
    '## Text Elements',
    texts ? `${texts}\n` : '',
    ...(embedded ? ['## Embedded Files', `${embedded}\n`] : []),
    '%%',
    '## Drawing',
    '```json',
    JSON.stringify(scene, null, '\t'),
    '```',
    '%%',
    '',
  ].join('\n');
}

const dataUrlOf = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/**
 * Mounts a board editor. Returns the same shape as the text editor (getText / setText / destroy), so the note screen
 * saves boards exactly like notes: hash-checked, autosaved, conflict-safe.
 *  attachmentUrl(name) -> url     to load embedded images
 *  upload(file) -> {path}         to store new images in attachments/
 */
export function createBoard({ parent, text, onChange, attachmentUrl, upload, onError, dark }) {
  let { frontmatter, scene, files } = parseBoard(text);
  let api = null;
  let cached = text;
  let stale = false;
  let lastVersion = sceneVersion(scene.elements);
  const uploading = new Set();

  const loadFiles = async (map) => {
    const loaded = [];
    for (const [id, name] of map) {
      try {
        const res = await fetch(attachmentUrl(name), { credentials: 'same-origin' });
        if (!res.ok) continue;
        const blob = await res.blob();
        loaded.push({ id, mimeType: blob.type || 'image/png', dataURL: await dataUrlOf(blob), created: Date.now() });
      } catch {}
    }
    if (loaded.length) api?.addFiles(loaded);
  };

  // New images dropped or pasted onto the board become vault attachments, then get listed in the file.
  const storeNewFiles = async (sceneFiles) => {
    for (const [id, f] of Object.entries(sceneFiles ?? {})) {
      if (files.has(id) || uploading.has(id)) continue;
      uploading.add(id);
      try {
        const blob = await (await fetch(f.dataURL)).blob();
        const ext = (f.mimeType.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        const { path } = await upload(new File([blob], `Pasted Image ${id.slice(0, 8)}.${ext}`, { type: f.mimeType }));
        files.set(id, path.split('/').pop());
        stale = true;
        onChange?.();
      } catch (err) {
        onError?.(err);
      } finally {
        uploading.delete(id);
      }
    }
  };

  const root = createRoot(parent);
  root.render(
    React.createElement(
      'div',
      { style: { position: 'absolute', inset: 0 } },
      React.createElement(Excalidraw, {
        excalidrawAPI: (a) => {
          api = a;
          loadFiles(files);
        },
        initialData: { elements: scene.elements, appState: { ...scene.appState, collaborators: undefined }, files: {}, scrollToContent: true },
        theme: dark ? 'dark' : 'light',
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true } } },
        onChange: (elements, appState, sceneFiles) => {
          // Excalidraw calls this on every pointer move; only element edits count as changes.
          const v = sceneVersion(elements);
          if (v !== lastVersion) {
            lastVersion = v;
            stale = true;
            onChange?.();
          }
          storeNewFiles(sceneFiles);
        },
      }),
    ),
  );

  return {
    getText() {
      if (stale && api) {
        const json = JSON.parse(serializeAsJSON(api.getSceneElements(), api.getAppState(), {}, 'local'));
        // Images live in attachments/, not inline as data URLs.
        json.files = {};
        cached = serialize(frontmatter, json, files);
        stale = false;
      }
      return cached;
    },
    setText(next) {
      ({ frontmatter, scene, files } = parseBoard(next));
      cached = next;
      stale = false;
      lastVersion = sceneVersion(scene.elements);
      api?.updateScene({ elements: scene.elements });
      loadFiles(files);
    },
    focus() {},
    goToLine() {},
    destroy() {
      root.unmount();
    },
  };
}

function sceneVersion(elements) {
  let v = 0;
  for (const e of elements) v = (v * 31 + (e.version ?? 0) + (e.isDeleted ? 7 : 0)) | 0;
  return `${elements.length}:${v}`;
}
