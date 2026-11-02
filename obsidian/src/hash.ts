export type Bytes = string | ArrayBuffer;

export async function sha256Bytes(data: Bytes): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/** Same as the server's hash: sha256 of the text as UTF-8, or of the file's bytes, in hex. */
export async function sha256(data: Bytes): Promise<string> {
  return [...(await sha256Bytes(data))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const randomString = (bytes = 32) => base64url(crypto.getRandomValues(new Uint8Array(bytes)));
