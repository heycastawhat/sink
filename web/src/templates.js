// Templates: notes in a Templates folder (Obsidian's default), used to start a note ("New → From template") or
// dropped into one (/template). {{title}}, {{date}} and {{time}} are filled in as in Obsidian's core Templates
// plugin, and so is {{date:FORMAT}} (YYYY, M, MM, MMM, MMMM, D, DD, ddd, dddd, H, HH, mm).

const pad = (n) => String(n).padStart(2, '0');

/** Template notes, by name, from the notes list (anything in a top-level Templates folder). */
export const templatesIn = (notes) =>
  notes
    .filter((n) => /^templates\//i.test(n.path) && !/\.excalidraw\.md$/i.test(n.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base', numeric: true }));

function format(d, fmt) {
  const long = (opts) => d.toLocaleDateString(undefined, opts);
  return fmt.replace(/YYYY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm/g, (t) =>
    ({
      YYYY: String(d.getFullYear()),
      MMMM: long({ month: 'long' }),
      MMM: long({ month: 'short' }),
      MM: pad(d.getMonth() + 1),
      M: String(d.getMonth() + 1),
      DD: pad(d.getDate()),
      D: String(d.getDate()),
      dddd: long({ weekday: 'long' }),
      ddd: long({ weekday: 'short' }),
      HH: pad(d.getHours()),
      H: String(d.getHours()),
      mm: pad(d.getMinutes()),
    })[t],
  );
}

/** A template's text with its {{variables}} filled in. */
export function fillTemplate(text, { title = '', now = new Date() } = {}) {
  return text.replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/g, (_, key, fmt) => {
    if (key === 'title') return title;
    if (fmt) return format(now, fmt.trim());
    return key === 'time' ? format(now, 'HH:mm') : format(now, 'YYYY-MM-DD');
  });
}
