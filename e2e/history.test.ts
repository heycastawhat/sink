import { expect } from "bun:test";
import type { Page } from "playwright-core";
import { eventually, suite } from "./harness";

const s = suite();

const editor = (page: Page) => page.locator("#note-editor .cm-content");

async function openNote(page: Page, path: string) {
  await page.goto(`${s.sink.url}/#/n/${path}`);
  await editor(page).waitFor();
  await page.locator("#note-status", { hasText: /Edited|Saved/ }).waitFor();
  await editor(page).click();
  await page.keyboard.press("Control+End");
}

async function openHistory(page: Page) {
  await page.locator("#note-more").click();
  await page.locator("#note-history").click();
  const dialog = page.locator(".version-dialog");
  await dialog.waitFor();
  return dialog;
}

s.it("a note with no edits has no earlier versions", async () => {
  await s.sink.note("History/Fresh.md", "# Fresh\n\nNever edited\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "History/Fresh.md");
  const dialog = await openHistory(page);
  expect(await dialog.locator(".version-empty").innerText()).toContain("No earlier versions");
  expect(await dialog.locator(".version-row").count()).toBe(0);
});

s.it("editing keeps the old text as a version, which can be read, compared and restored", async () => {
  await s.sink.note("History/Essay.md", "# Essay\n\nFirst draft\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "History/Essay.md");

  await page.keyboard.type("Second thoughts");
  await eventually(async () => expect(s.sink.read("History/Essay.md")).toContain("Second thoughts"));
  await eventually(async () => expect(await page.locator("#note-status").innerText()).toBe("Saved"));

  const dialog = await openHistory(page);
  await eventually(async () => expect(await dialog.locator(".version-row").count()).toBe(1));
  expect(await dialog.locator(".version-row .version-preview").innerText()).toContain("First draft");

  // Opening a version shows what changed since (added text marked), then the plain text of that version.
  await dialog.locator(".version-row").click();
  const changes = dialog.locator(".version-changes");
  await changes.waitFor({ state: "visible" });
  expect(await changes.locator('[data-op="+"]').allInnerTexts()).toContain("Second thoughts");
  await dialog.locator("[data-mode]").click();
  expect(await dialog.locator(".version-text").innerText()).toBe("# Essay\n\nFirst draft\n");

  await dialog.locator("[data-ok]").click();
  await dialog.waitFor({ state: "detached" });
  // Restoring puts the old text back in the editor and the file, without the later words.
  await eventually(async () => expect(s.sink.read("History/Essay.md")).toBe("# Essay\n\nFirst draft\n"));
  expect(await editor(page).innerText()).not.toContain("Second thoughts");

  // What was replaced is kept too, so restoring can't lose anything.
  const again = await openHistory(page);
  await eventually(async () => expect(await again.locator(".version-row").count()).toBe(2));
  expect(await again.locator(".version-row .version-preview").first().innerText()).toContain("Second thoughts");
});
