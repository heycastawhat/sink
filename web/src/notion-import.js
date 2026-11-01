// Import from Notion: its "Markdown & CSV" export zip, read in the browser and saved as notes through the normal API.
// Everything lands under a "Notion" folder in the same tree, without the IDs Notion adds to every name. Links
// between pages become [[wikilinks]], images and files become attachments, a database becomes a note with its
// table (each row linking to the row's page) and its rows' properties become their pages' frontmatter. Running it
// again skips pages already imported (same path).

import { api } from './api.js';
import { fileNameFor, readZip, yamlString } from './keep-import.js';

const ID = /\s+[0-9a-f]{32}$/i;

/** A name from the export ("Plans 1a2b…3c4d.md", "Tasks 5e6f…_all.csv") as Sink names it ("Plans", "Tasks"). */
const cleanName = (seg) => fileNameFor(seg.replace(/(_all)?\.(md|csv)$/i, '').replace(ID, ''));

const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);

/** `a/b/../c d.png` -> `a/c d.png`: a link's target relative to the page that has it. */
function resolvePath(dir, href) {
  const out = [];
  for (const part of (dir + href).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/**
 * Where each page and database in the export goes: export path -> { folder, name, path } (path is the vault path
 * without ".md", as a wikilink wants it). Pages that clean up to the same name are numbered as the server would.
 */
export function planNotion(names) {
  // A database exports as "X.csv" and often "X_all.csv" too (every row, not just the default view's): use one.
  const csvs = new Set(names.filter((n) => /\.csv$/i.test(n)));
  const files = names.filter((n) => /\.md$/i.test(n) || (csvs.has(n) && (/_all\.csv$/i.test(n) || !csvs.has(n.replace(/\.csv$/i, '_all.csv')))));
  const targets = new Map();
  const seen = new Map();
  for (const src of files.sort()) {
    const parts = src.split('/');
    const folder = ['Notion', ...parts.slice(0, -1).map(cleanName)].join('/');
    const base = `${folder}/${cleanName(parts.at(-1))}`;
    const nth = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), nth + 1);
    const name = cleanName(parts.at(-1)) + (nth ? ` ${nth}` : '');
    targets.set(src, { folder, name, path: `${folder}/${name}` });
  }
  return targets;
}

/** Notion's export sometimes wraps everything in one "Export-<id>" folder; that folder isn't part of the tree. */
function stripWrapper(entries) {
  const tops = new Set([...entries.keys()].map((n) => n.split('/')[0]));
  const [top] = tops;
  if (tops.size !== 1 || !/^Export-[\w-]+$/i.test(top)) return entries;
  return new Map([...entries].map(([n, read]) => [n.slice(top.length + 1), read]));
}

/** RFC 4180 CSV, as Notion writes it (quoted fields may hold commas, quotes and newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') cell += text[i++];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

/**
 * Rewrites a page's links: to other pages and databases as [[wikilinks]], to files in the export through
 * `files(src)` (which returns the embed for an uploaded file, or null). Web links stay as they are.
 */
export function rewriteLinks(text, src, targets, files) {
  return text.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (all, bang, label, href) => {
    if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#')) return all;
    let target;
    try {
      target = resolvePath(dirOf(src), decodeURIComponent(href));
    } catch {
      return all;
    }
    const page = targets.get(target) ?? targets.get(target.replace(/\.csv$/i, '_all.csv'));
    // With the path, so it can't mean another note of the same name; the link text stays what Notion showed.
    if (page) return `[[${page.path}|${label.replace(/[[\]|]/g, '') || page.name}]]`;
    return files(target) ?? all;
  });
}

/** A database row's page: "# Title" then "Key: value" lines, which become frontmatter. */
export function propertiesToFrontmatter(text) {
  const m = /^(# .*\r?\n)\r?\n((?:[^\n:]{1,80}: .*\r?\n)+)/.exec(text);
  if (!m) return text;
  const front = m[2]
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf(': ');
      const key = line.slice(0, at).trim();
      return `${/^[\w -]+$/.test(key) ? key : JSON.stringify(key)}: ${yamlString(line.slice(at + 2).trim())}`;
    });
  return `---\n${front.join('\n')}\n---\n${m[1]}${text.slice(m[0].length)}`;
}

/** A database's CSV as a note: a markdown table whose first column links to each row's page. */
export function csvToMarkdown(csv, src, targets) {
  const [head, ...rows] = parseCsv(csv).filter((r) => r.some((c) => c.trim()));
  if (!head) return '';
  // Row pages live in a folder named like the CSV ("Tasks abc123/Write report def456.md").
  const rowsDir = src.replace(/(_all)?\.csv$/i, '/');
  const rowPages = new Map();
  for (const [path, t] of targets) {
    if (path.startsWith(rowsDir) && !path.slice(rowsDir.length).includes('/')) rowPages.set(cleanName(path.slice(rowsDir.length)), t);
  }
  const cell = (s) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
  const line = (cells) => `| ${cells.join(' | ')} |`;
  const body = rows.map((r) => {
    const page = rowPages.get(fileNameFor(r[0] ?? ''));
    const first = page ? `[[${page.path}\\|${cell(r[0])}]]` : cell(r[0] ?? '');
    return line([first, ...head.slice(1).map((_, i) => cell(r[i + 1] ?? ''))]);
  });
  return `# ${cleanName(src.split('/').pop())}\n\n${[line(head.map(cell)), line(head.map(() => '---')), ...body].join('\n')}\n`;
}

/**
 * Imports a Notion export zip. `progress(done, total)` is called as it goes. Returns how
 * many notes were imported, skipped as already there, and failed.
 */
export async function importNotion(files, progress = () => {}) {
  let entries = await readZip(files[0]);
  // A big workspace exports as a zip of zips ("Export-…-Part-1.zip").
  for (const [name, read] of [...entries]) {
    if (!/\.zip$/i.test(name)) continue;
    entries.delete(name);
    for (const [inner, readInner] of await readZip(new Blob([await read()]))) entries.set(inner, readInner);
  }
  entries = stripWrapper(entries);
  const targets = planNotion([...entries.keys()]);
  const csvSources = new Set([...targets.keys()].filter((n) => /\.csv$/i.test(n)));
  const rowDirs = [...csvSources].map((n) => n.replace(/(_all)?\.csv$/i, '/'));

  const { notes: existing } = await api.notes();
  const have = new Set(existing.map((n) => n.path.toLowerCase()));
  const result = { imported: 0, skipped: 0, failed: 0 };
  const text = new TextDecoder();
  // The same image can appear on several pages: upload it once.
  const uploaded = new Map();
  let done = 0;
  for (const [src, t] of targets) {
    progress(done++, targets.size);
    if (have.has(`${t.path}.md`.toLowerCase())) {
      result.skipped++;
      continue;
    }
    try {
      const raw = text.decode(await entries.get(src)());
      let content;
      if (csvSources.has(src)) content = csvToMarkdown(raw, src, targets);
      else {
        // Upload what the page links to first, so the rewrite below can swap in the embeds.
        for (const m of raw.matchAll(/\]\(([^)\s]+)\)/g)) {
          let file;
          try {
            file = resolvePath(dirOf(src), decodeURIComponent(m[1]));
          } catch {
            continue;
          }
          if (uploaded.has(file) || !entries.has(file) || /\.(md|csv)$/i.test(file)) continue;
          const bytes = await entries.get(file)();
          uploaded.set(file, (await api.attach(new File([bytes], file.split('/').pop()))).embed);
        }
        content = rewriteLinks(raw, src, targets, (file) => uploaded.get(file) ?? null);
        if (rowDirs.some((d) => src.startsWith(d))) content = propertiesToFrontmatter(content);
      }
      await api.createNote({ folder: t.folder, title: t.name, content });
      result.imported++;
    } catch {
      result.failed++;
    }
  }
  progress(targets.size, targets.size);
  return result;
}
