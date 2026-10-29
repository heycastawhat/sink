// Thin wrapper over the Sink REST API. Auth is an httpOnly cookie set at login.

export class Unauthorized extends Error {}

/** A non-2xx reply. `status` and the parsed `body` let callers handle conflicts (409 carries the current note). */
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...options });
  if (res.status === 401) throw new Unauthorized();
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

const p = (path) => `path=${encodeURIComponent(path)}`;

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  me: () => request('/auth/me'),
  health: () => request('/health'),
  plugins: () => request('/plugins'),
  logout: () => request('/auth/logout', { method: 'POST' }),
  tokens: () => request('/auth/tokens'),
  createToken: (name) => request('/auth/tokens', json('POST', { name })),
  revokeToken: (id) => request(`/auth/tokens/${id}`, { method: 'DELETE' }),

  notes: () => request('/notes'),
  searchNotes: (q) => request(`/notes?q=${encodeURIComponent(q)}&limit=100`),
  note: (path) => request(`/notes/file?${p(path)}`),
  saveNote: (path, content, baseHash, init = {}) =>
    request(`/notes/file?${p(path)}`, { ...json('PUT', { content, base_hash: baseHash }), ...init }),
  createNote: (body) => request('/notes', json('POST', body)),
  noteMeta: (path, body) => request(`/notes/meta?${p(path)}`, json('PATCH', body)),
  moveNote: (from, to) => request('/notes/move', json('POST', { from, to })),
  trashNote: (path) => request(`/notes/file?${p(path)}`, { method: 'DELETE' }),
  trash: () => request('/notes/trash'),
  restoreNote: (path) => request('/notes/trash/restore', json('POST', { path })),
  deleteForever: (path) => request(`/notes/trash?${p(path)}`, { method: 'DELETE' }),
  emptyTrash: () => request('/notes/trash?all=true', { method: 'DELETE' }),
  attach: (file) => {
    const form = new FormData();
    form.set('file', file);
    return request('/notes/attachments', { method: 'POST', body: form });
  },
  attachmentUrl: (ref) => `/api/notes/attachment?${ref.includes('/') ? 'path' : 'name'}=${encodeURIComponent(ref)}`,

  todos: (view = 'open') => request(`/todos?view=${view}`),
  addTodo: (body) => request('/todos', json('POST', body)),
  toggleTodo: (t, done) => request('/todos/toggle', json('POST', { path: t.path, line: t.line, raw: t.raw, done })),
};
