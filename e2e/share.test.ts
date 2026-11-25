import { expect } from "bun:test";
import type { Page } from "playwright-core";
import { eventually, suite } from "./harness";

const s = suite();

const editor = (page: Page) => page.locator("#note-editor .cm-content");

/** Opens a note in the app and its share dialog; resolves with the dialog's locator. */
async function openShare(page: Page, path: string) {
  await page.goto(`${s.sink.url}/#/n/${path}`);
  await editor(page).waitFor();
  await page.locator("#note-share").click();
  const dialog = page.locator(".share-dialog");
  await dialog.waitFor();
  return dialog;
}

/** A visitor with the link and no sign-in, in a browser profile of their own. */
async function visit(url: string): Promise<Page> {
  const page = await s.browser.page(await s.browser.profile(false));
  await page.goto(url);
  return page;
}

s.it("a share link shows the note to someone who isn't signed in, without its frontmatter or other notes", async () => {
  await s.sink.note("Share/Read.md", "---\nsecret: hunter2\n---\n# Trip plan\n\nPack the **tent**\n");
  await s.sink.note("Share/Other.md", "# Other\n\nNot for sharing\n");
  const page = await s.browser.open("#/notes");
  const dialog = await openShare(page, "Share/Read.md");

  await dialog.locator("[data-make]").click();
  await dialog.locator(".share-url").waitFor();
  const url = (await dialog.locator(".share-url").innerText()).trim();
  expect(url.startsWith(`${s.sink.url}/s/`)).toBe(true);
  await dialog.locator("[data-cancel]").click();

  const visitor = await visit(url);
  await visitor.locator("#editor .cm-content").waitFor();
  const text = await visitor.locator("#editor .cm-content").innerText();
  expect(text).toContain("Trip plan");
  expect(text).toContain("Pack the tent");
  expect(text).not.toContain("hunter2");
  // A read-only page: nothing to type into, and no way to the owner's other notes.
  expect(await visitor.locator("#editor .cm-content").getAttribute("contenteditable")).toBe("false");
  expect(await visitor.locator("#share-name").isHidden()).toBe(true);
  expect(await visitor.evaluate(() => document.body.innerText)).not.toContain("Not for sharing");
  expect(await visitor.title()).toBe("Trip plan");
  // The reader's API calls don't carry the owner's session.
  expect((await visitor.request.get(`${s.sink.url}/api/notes`)).status()).toBe(401);
});

s.it("the shared page follows the owner's edits as they happen", async () => {
  await s.sink.note("Share/Live.md", "# Live\n\nBefore\n");
  const page = await s.browser.open("#/notes");
  const dialog = await openShare(page, "Share/Live.md");
  await dialog.locator("[data-make]").click();
  await dialog.locator(".share-url").waitFor();
  const url = (await dialog.locator(".share-url").innerText()).trim();
  await dialog.locator("[data-cancel]").click();

  const visitor = await visit(url);
  await visitor.locator("#editor .cm-content").waitFor();
  await eventually(async () => expect(await visitor.locator("#editor .cm-content").innerText()).toContain("Before"));

  await editor(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Added by the owner");
  await eventually(async () => expect(await visitor.locator("#editor .cm-content").innerText()).toContain("Added by the owner"));
});

s.it("stopping sharing turns the link off", async () => {
  await s.sink.note("Share/Stop.md", "# Stop\n\nShort-lived\n");
  const page = await s.browser.open("#/notes");
  const dialog = await openShare(page, "Share/Stop.md");
  await dialog.locator("[data-make]").click();
  await dialog.locator(".share-url").waitFor();
  const url = (await dialog.locator(".share-url").innerText()).trim();

  await dialog.locator("[data-stop]").click();
  await dialog.locator("[data-make]").waitFor({ state: "visible" });
  await dialog.locator("[data-cancel]").click();

  const visitor = await visit(url);
  await visitor.locator("#share-missing").waitFor({ state: "visible" });
  expect(await visitor.locator("#editor .cm-content").count()).toBe(0);
});

s.it("an editable link asks for a name, and what the visitor types lands in the note", async () => {
  await s.sink.note("Share/Edit.md", "# Edit\n\nOriginal\n");
  const page = await s.browser.open("#/notes");
  const dialog = await openShare(page, "Share/Edit.md");
  await dialog.locator("#share-editable").click();
  await dialog.locator("[data-make]").click();
  await dialog.locator(".share-url").waitFor();
  const url = (await dialog.locator(".share-url").innerText()).trim();
  await dialog.locator("[data-cancel]").click();

  const visitor = await visit(url);
  await visitor.locator("#share-name-input").fill("Sam");
  await visitor.locator("#share-name button[type=submit]").click();
  await eventually(async () => expect(await visitor.locator("#share-status").innerText()).toContain("Editing as Sam"));
  await visitor.locator("#editor .cm-content").click();
  await visitor.keyboard.press("Control+End");
  await visitor.keyboard.type("Sam was here");

  await eventually(async () => expect(s.sink.read("Share/Edit.md")).toContain("Sam was here"));
  expect(s.sink.read("Share/Edit.md")!.startsWith("# Edit\n\nOriginal\n")).toBe(true);
  // And the owner, who has the note open, sees it arrive.
  await eventually(async () => expect(await editor(page).innerText()).toContain("Sam was here"));
});
