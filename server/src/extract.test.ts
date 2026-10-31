import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDb } from "./db";
import { Vault } from "./notes";
import { extractText, extractTools } from "./extract";

// "Warranty card" in Helvetica; pdftotext rebuilds the missing xref table.
const pdf = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 50]/Contents 4 0 R/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>endobj
4 0 obj<</Length 41>>stream
BT /F1 12 Tf 10 20 Td (Warranty card) Tj ET
endstream endobj
trailer<</Root 1 0 R>>
%%EOF
`;
// "PLUMBER" in black on white, 300x80, 1-bit.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAASwAAABQAQAAAACLkXXWAAABfklEQVRIx+3UQW6EIBQGYIwLZjEpRyA9CWfpPZpqwsJrabyI3oClC8LrgwejMExnFt200cRkEr8I/O8fGbxyGXayk53sDzDHWjAAC8DsWoAGetbByBiwJmesS6whJogxlTOFzBBznvHIZM4kMe0YsRZvz8SRyU3Qop7ZBgZcWOMzbnnGbMkmmD2DNmOOJ3bp7DuyJTKdMeDppJdu+whM/wa7qmfMEDMrPq7uTSSm3VUie3YE7d7ksh4CeczWCVlb3duemxDrGmbaYz3KeMMUDLHZM0msGJYR6aSRicCK0VNDaNEhsDayokhqZ4PPrQknxbrmDG5MDz6QMbK8vXxnszjEu8k8t9tfJjLThdycuGcUyJox/ogtkhgNq8a6e1Y0xBtiRk4/sfQ2ow57w6bUGH+BbYoSCLlFttwfYcM+JTbGWlaYFVYk1kdmumJRxj7ZKP3PKbTDf2qq7AsnTW/zRSK2qWJRLA1+/RLj4YtUZ0sDianIrNzZK9fJTvb/2TddwJRQXzsimAAAAABJRU5ErkJggg==",
  "base64",
);

function makeVault() {
  const dir = mkdtempSync(join(tmpdir(), "sink-extract-"));
  const db = openDb(":memory:");
  const vault = new Vault(db, dir);
  const calls: string[] = [];
  // Stub: a file's "text" is whatever the test wrote into it. .gif has no tool, so it's asked again every pass.
  vault.extractor = async (abs) => {
    if (abs.endsWith(".gif")) return null;
    calls.push(basename(abs));
    return Bun.file(abs).text();
  };
  mkdirSync(join(dir, "attachments"));
  return { dir, db, vault, calls };
}

describe("attachment text", () => {
  test("search finds notes by the text of the PDFs and images they embed", async () => {
    const { dir, db, vault, calls } = makeVault();
    writeFileSync(join(dir, "attachments/receipt.pdf"), "plumber invoice for the kitchen tap");
    writeFileSync(join(dir, "attachments/Whiteboard.png"), "sprint goals plumber");
    writeFileSync(join(dir, "attachments/anim.gif"), "plumber");
    writeFileSync(join(dir, "Tap.md"), "# Tap\n\n![[receipt.pdf]]\n");
    writeFileSync(join(dir, "Meeting.md"), "# Meeting\n\n![[attachments/Whiteboard.png|300]]\n");
    writeFileSync(join(dir, "Plumbing.md"), "# Plumbing\n\nCall the plumber. ![[receipt.pdf]]\n");
    await vault.scan();
    await vault.indexAttachments();
    expect(calls.sort()).toEqual(["Whiteboard.png", "receipt.pdf"]);

    const hits = vault.search(`"plumber"*`, 20);
    // The note's own text first; a note isn't listed twice for its attachment.
    expect(hits.map((h) => h.path)).toEqual(["Plumbing.md", expect.any(String), expect.any(String)]);
    const tap = hits.find((h) => h.path === "Tap.md")!;
    expect(tap.attachment).toBe("attachments/receipt.pdf");
    expect(tap.snippet).toBe("receipt.pdf: [plumber] invoice for the kitchen tap");
    expect(hits.find((h) => h.path === "Meeting.md")?.attachment).toBe("attachments/Whiteboard.png");
    expect(vault.search(`"goals"*`, 20).map((h) => h.path)).toEqual(["Meeting.md"]);
    expect(vault.search(`"plumber"*`, 1)).toHaveLength(1);

    // Unchanged files aren't read again on a rescan, nor when the notes index is rebuilt from scratch.
    db.exec("DELETE FROM notes");
    await vault.scan();
    await vault.indexAttachments();
    expect(calls).toHaveLength(2);
    expect(vault.search(`"goals"*`, 20).map((h) => h.path)).toEqual(["Meeting.md"]);

    // A changed file is read again; a removed one drops out.
    writeFileSync(join(dir, "attachments/Whiteboard.png"), "retro actions");
    rmSync(join(dir, "attachments/receipt.pdf"));
    await vault.scan();
    await vault.indexAttachments();
    expect(calls).toHaveLength(3);
    expect(vault.search(`"goals"*`, 20)).toEqual([]);
    expect(vault.search(`"retro"*`, 20).map((h) => h.path)).toEqual(["Meeting.md"]);
    expect(vault.search(`"invoice"*`, 20)).toEqual([]);
  });

  test("an upload is read in the background, without holding up the save", async () => {
    const { dir, vault } = makeVault();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vault.extractor = async (abs) => (await gate, Bun.file(abs).text());
    const path = await vault.saveAttachment("scan.jpg", new TextEncoder().encode("boarding pass"));
    // The save didn't wait for extraction.
    await vault.write("Trip.md", `# Trip\n\n![[${basename(path)}]]\n`, null);
    expect(vault.search(`"boarding"*`, 20)).toEqual([]);
    release();
    await vault.indexAttachments();
    expect(vault.search(`"boarding"*`, 20).map((h) => h.path)).toEqual(["Trip.md"]);
    rmSync(dir, { recursive: true });
  });

  test.skipIf(!extractTools.includes("pdf"))("pdftotext reads a PDF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sink-extract-"));
    writeFileSync(join(dir, "a.pdf"), pdf);
    expect(await extractText(join(dir, "a.pdf"))).toBe("Warranty card");
  });

  test.skipIf(!extractTools.includes("ocr"))("tesseract reads an image", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sink-extract-"));
    writeFileSync(join(dir, "a.png"), png);
    expect(await extractText(join(dir, "a.png"))).toBe("PLUMBER");
  });
});
