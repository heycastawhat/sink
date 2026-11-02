import { expect, test } from "bun:test";
import { s256 } from "../../server/src/auth";
import { exchangeCode } from "../src/api";
import { base64url, randomString, sha256, sha256Bytes } from "../src/hash";

test("the sign-in challenge is what the server computes from the verifier, in the shape it accepts", async () => {
  const verifier = randomString(32);
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const challenge = base64url(await sha256Bytes(verifier));
  expect(challenge).toBe(s256(verifier));
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(randomString(32)).not.toBe(verifier);
});

test("hashes match the server's, for text (as UTF-8) and for bytes", async () => {
  const { sha256: server } = await import("../../server/src/notes");
  for (const text of ["", "# Héllo ✓\n", "line\r\nbreaks"]) expect(await sha256(text)).toBe(server(text));
  const bytes = new Uint8Array([0, 255, 1, 2]);
  expect(await sha256(bytes.buffer)).toBe(server(bytes));
});

test("the hand-back code is swapped for a token, or refused", async () => {
  const seen: unknown[] = [];
  const http = (status: number, body: unknown) => async (req: { url: string; body?: string | ArrayBuffer }) => {
    seen.push([req.url, JSON.parse(req.body as string)]);
    return { status, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0) };
  };
  expect(await exchangeCode("https://sink.test", "the-code", "the-verifier", http(200, { ok: true, token: "sink_abc" }))).toBe("sink_abc");
  expect(seen).toEqual([["https://sink.test/api/auth/oidc/exchange", { code: "the-code", verifier: "the-verifier" }]]);
  await expect(exchangeCode("https://sink.test", "x", "y", http(400, { error: "invalid or expired code" }))).rejects.toThrow("expired or invalid");
});
