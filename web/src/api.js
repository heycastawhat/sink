// Thin wrapper over the Sink REST API. Auth is an httpOnly cookie set at login.

export class Unauthorized extends Error {}

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', ...options });
  if (res.status === 401) throw new Unauthorized();
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  me: () => request('/auth/me'),
  health: () => request('/health'),
  logout: () => request('/auth/logout', { method: 'POST' }),
  tokens: () => request('/auth/tokens'),
  createToken: (name) => request('/auth/tokens', json('POST', { name })),
  revokeToken: (id) => request(`/auth/tokens/${id}`, { method: 'DELETE' }),

  list: (params) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    return request(`/captures?${qs}`);
  },
  get: (id) => request(`/captures/${id}`),
  patch: (id, body) => request(`/captures/${id}`, json('PATCH', body)),
  purge: (id) => request(`/captures/${id}`, { method: 'DELETE' }),
  bulk: (body) => request('/captures/bulk', json('POST', body)),
  reprocess: (id) => request(`/captures/${id}/reprocess`, { method: 'POST' }),
  setAction: (id, state) => request(`/actions/${id}`, json('PATCH', { state })),
  reminders: () => request('/reminders'),
  digest: () => request('/digest'),

  collections: () => request('/collections'),
  createCollection: (name) => request('/collections', json('POST', { name })),
  renameCollection: (id, name) => request(`/collections/${id}`, json('PATCH', { name })),
  deleteCollection: (id) => request(`/collections/${id}`, { method: 'DELETE' }),

  upload: (file, note) => {
    const form = new FormData();
    form.set('image', file);
    form.set('source', 'web');
    if (note) form.set('note', note);
    if (file.lastModified) form.set('captured_at', String(file.lastModified));
    return request('/captures', { method: 'POST', body: form });
  },
};
