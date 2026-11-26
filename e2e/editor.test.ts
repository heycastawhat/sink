import { expect } from "bun:test";
import type { Page } from "playwright-core";
import { eventually, suite } from "./harness";

const s = suite();

// A 1×1 PNG: small, but a real image the server checks by its bytes and the browser decodes.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const editor = (page: Page) => page.locator("#note-editor .cm-content");

/** Opens a note and puts the caret at the end of it, ready to type. */
async function openNote(page: Page, path: string) {
  await page.goto(`${s.sink.url}/#/n/${path}`);
  await editor(page).waitFor();
  await page.locator("#note-status", { hasText: /Edited|Saved/ }).waitFor();
  await editor(page).click();
  await page.keyboard.press("Control+End");
}

s.it("typing autosaves to the note's file", async () => {
  await s.sink.note("Editor/Typing.md", "# Typing\n\nFirst line\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "Editor/Typing.md");

  await page.keyboard.type("Second line");
  await eventually(async () => expect(s.sink.read("Editor/Typing.md")).toBe("# Typing\n\nFirst line\nSecond line"));
  await eventually(async () => expect(await page.locator("#note-status").innerText()).toBe("Saved"));
});

s.it("the editor is live preview: headings and bold show formatted, with the markup hidden off the caret's line", async () => {
  await s.sink.note("Editor/Preview.md", "# Big title\n\nSome **bold** words\n\nThe caret goes here\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "Editor/Preview.md");

  expect(await page.locator(".cm-h1").count()).toBe(1);
  const bold = page.locator(".cm-line span", { hasText: /^bold$/ });
  expect(Number(await bold.evaluate((el) => getComputedStyle(el).fontWeight))).toBeGreaterThanOrEqual(600);
  // The asterisks are part of the text but hidden while the caret is on another line.
  const line = page.locator(".cm-line", { hasText: "Some" });
  expect(await line.evaluate((el) => (el as HTMLElement).innerText)).toBe("Some bold words");
  await line.click();
  await eventually(async () => expect(await line.evaluate((el) => (el as HTMLElement).innerText)).toBe("Some **bold** words"));
});

s.it("a new note starts as a draft and becomes a file once it has text", async () => {
  const page = await s.browser.open("#/new?folder=Editor%2FDrafts");
  await editor(page).waitFor();
  expect(s.sink.files().filter((f) => f.startsWith("Editor/Drafts/"))).toEqual([]);

  await page.keyboard.type("# Shopping run");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Batteries");
  // Named after its heading. (How many blank lines Enter leaves after a heading isn't what's being tested.)
  await eventually(async () => expect(s.sink.read("Editor/Drafts/Shopping run.md")).toMatch(/^# Shopping run\n+Batteries$/));
  expect(s.sink.files().filter((f) => f.startsWith("Editor/Drafts/"))).toEqual(["Editor/Drafts/Shopping run.md"]);
});

s.it("typing a todo makes a checkbox, and ticking it writes [x] to the file", async () => {
  await s.sink.note("Editor/Tasks.md", "# Tasks\n\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "Editor/Tasks.md");

  await page.keyboard.type("- [ ] buy milk");
  await page.keyboard.press("Enter");
  await page.keyboard.type("water the plants");
  // Enter on a todo continues the list with a new box.
  await eventually(async () => expect(await page.locator(".cm-task").count()).toBe(2));
  await eventually(async () => expect(s.sink.read("Editor/Tasks.md")).toBe("# Tasks\n\n- [ ] buy milk\n- [ ] water the plants"));

  await page.locator(".cm-task").first().click();
  await eventually(async () => expect(s.sink.read("Editor/Tasks.md")).toBe("# Tasks\n\n- [x] buy milk\n- [ ] water the plants"));
  expect(await page.locator(".cm-task-done").count()).toBe(1);
  expect(await page.locator(".cm-task").first().isChecked()).toBe(true);
});

s.it("pasting an image file uploads it to attachments/ and embeds it in the note", async () => {
  await s.sink.note("Editor/Images.md", "# Images\n\nA photo:\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "Editor/Images.md");

  // The same event a browser fires for Ctrl+V with an image on the clipboard (a screenshot, a copied picture).
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    document.querySelector("#note-editor .cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);

  await eventually(async () => expect(s.sink.files().filter((f) => f.startsWith("attachments/"))).toHaveLength(1));
  const [attachment] = s.sink.files().filter((f) => f.startsWith("attachments/"));
  const name = attachment!.split("/").pop()!;
  expect(name.endsWith(".png")).toBe(true);
  const saved = await eventually(async () => {
    const text = s.sink.read("Editor/Images.md")!;
    expect(text).toContain(`![[${name}]]`);
    return text;
  });
  expect(saved.startsWith("# Images\n\nA photo:\n")).toBe(true);

  // Drawn as a picture (not left as `![[…]]` text), and the server serves back what was pasted.
  await eventually(async () => expect(await page.locator(".cm-embed img").count()).toBe(1));
  await eventually(async () => expect(await page.locator(".cm-embed img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1));
  expect((await s.sink.api(`/notes/attachment?name=${encodeURIComponent(name)}`)).length).toBeGreaterThan(0);
});
