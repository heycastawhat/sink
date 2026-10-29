// Small helpers the web app and the Android editor page share.

/** Text made safe to put in HTML, attribute values included. */
export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The folder a vault path is in ("" at the top level). */
export const folderOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
