import { expect } from "bun:test";
import { eventually, suite } from "./harness";

const s = suite();

const rows = (page: import("playwright-core").Page) => page.locator(".switcher .switcher-title");

s.it("Ctrl+K finds a note by part of its name and Enter opens it", async () => {
  await s.sink.note("Switch/Meeting notes.md", "# Meeting notes\n\nAgenda\n");
  await s.sink.note("Switch/Shopping list.md", "# Shopping list\n\nTea\n");
  const page = await s.browser.open("#/notes");
  await page.locator(".note-card").first().waitFor();

  await page.keyboard.press("Control+k");
  const input = page.locator(".switcher input");
  await input.waitFor();
  // Letters in order are enough: "mtg nts" finds "Meeting notes".
  await input.fill("mtg nts");
  await eventually(async () => expect(await rows(page).allInnerTexts()).toEqual(["Meeting notes"]));
  await page.keyboard.press("Enter");

  await eventually(async () => expect(await page.evaluate(() => decodeURIComponent(location.hash))).toBe("#/n/Switch/Meeting notes.md"));
  await page.locator("#note-editor .cm-content").waitFor();
  expect(await page.locator("#note-editor .cm-content").innerText()).toContain("Agenda");
  expect(await page.locator(".switcher").count()).toBe(0);
});

s.it("arrow keys pick between matches, and Escape closes the switcher", async () => {
  await s.sink.note("Switch2/Alpha plan.md", "# Alpha plan\n\nOne\n");
  await s.sink.note("Switch2/Alpha notes.md", "# Alpha notes\n\nTwo\n");
  const page = await s.browser.open("#/notes");
  await page.locator(".note-card").first().waitFor();

  await page.keyboard.press("Control+k");
  await page.locator(".switcher input").fill("alpha");
  await eventually(async () => expect(await rows(page).count()).toBe(2));
  const first = (await rows(page).first().innerText());
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  // The second row, not the first, was opened.
  const second = ["Alpha plan", "Alpha notes"].find((t) => t !== first)!;
  await eventually(async () => expect(await page.evaluate(() => decodeURIComponent(location.hash))).toBe(`#/n/Switch2/${second}.md`));

  await page.keyboard.press("Control+k");
  await page.locator(".switcher input").waitFor();
  await page.keyboard.press("Escape");
  await eventually(async () => expect(await page.locator(".switcher").count()).toBe(0));
});

s.it("Shift+Enter with no match makes a new note with that name", async () => {
  const page = await s.browser.open("#/notes");
  await page.locator("#notes:not([hidden])").waitFor();
  await page.keyboard.press("Control+k");
  await page.locator(".switcher input").fill("Brand new idea");
  await eventually(async () => expect(await page.locator(".switcher-empty").count()).toBe(1));
  await page.keyboard.press("Shift+Enter");

  await eventually(async () => expect(s.sink.read("Brand new idea.md")).toBe("# Brand new idea\n\n"));
  await eventually(async () => expect(await page.evaluate(() => decodeURIComponent(location.hash))).toBe("#/n/Brand new idea.md"));
});
