// Passkey sign-in and invites, with the browser's own WebAuthn JSON helpers (no library).

export const passkeysWork = () => !!window.PublicKeyCredential?.parseRequestOptionsFromJSON;

async function post(path, body) {
  const res = await fetch(`/api/auth/passkey${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Signs in with a passkey on this device; `extra` carries the Android app's hand-back details. Returns where to go. */
export async function signInWithPasskey(extra = {}) {
  const { flow, options } = await post('/login/options', {});
  const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
  return (await post('/login', { flow, response: credential.toJSON(), ...extra })).redirect;
}

export async function inviteName(token) {
  const res = await fetch(`/api/auth/passkey/invite?token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data.name;
}

/** Makes a passkey from an invite, which makes the account and signs it in. Returns where to go. */
export async function acceptInvite(token) {
  const { flow, options } = await post('/register/options', { invite: token });
  const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
  return (await post('/register', { flow, invite: token, response: credential.toJSON() })).redirect;
}
