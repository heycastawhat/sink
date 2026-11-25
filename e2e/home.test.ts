import { expect } from "bun:test";
import { eventually, suite } from "./harness";

const s = suite();

const cards = (page: import("playwright-core").Page) => page.locator(".note-card");
const paths = (page: import("playwright-core").Page) => cards(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path).sort());

s.it("home shows the notes as a grid of cards with excerpts, and folders as tiles", async () => {
  await s.sink.note("Groceries.md", "# Groceries\n\nOat milk and sourdough\n");
  await s.sink.note("Trips/Lisbon.md", "# Lisbon\n\nBook the tram tour\n");
  const page = await s.browser.open("#/notes");

  await eventually(async () => expect(await paths(page)).toEqual(["Groceries.md", "Trips/Lisbon.md"]));
  const groceries = page.locator('.note-card[data-path="Groceries.md"]');
  expect(await groceries.locator(".note-title").innerText()).toBe("Groceries");
  expect(await groceries.locator(".note-body").innerText()).toContain("Oat milk and sourdough");
  // A note in a folder says where it lives, and the folder is a tile above the grid.
  expect(await page.locator('.note-card[data-path="Trips/Lisbon.md"] .note-folder').innerText()).toContain("Trips");
  expect(await page.locator(".folder-tile .folder-name").allInnerTexts()).toContain("Trips");
});

s.it("a folder tile opens the folder and shows only its notes", async () => {
  await s.sink.note("Garden/Tomatoes.md", "# Tomatoes\n\nWater daily\n");
  await s.sink.note("Garden/Herbs.md", "# Herbs\n\nBasil and mint\n");
  const page = await s.browser.open("#/notes");
  await page.locator(".folder-tile", { hasText: "Garden" }).click();

  await eventually(async () => expect(await page.evaluate(() => location.hash)).toBe("#/notes/Garden"));
  await eventually(async () => expect(await paths(page)).toEqual(["Garden/Herbs.md", "Garden/Tomatoes.md"]));
  expect(await page.locator("#view-title").innerText()).toBe("Garden");
});

s.it("searching narrows the grid to matching notes, and #tag shows exactly the tagged ones", async () => {
  await s.sink.note("Search/Pasta.md", "# Pasta\n\nBoil the zucchini noodles\n");
  await s.sink.note("Search/Bread.md", "# Bread\n\nProof the dough overnight #baking\n");
  await s.sink.note("Search/Cake.md", "# Cake\n\nBake at 180 degrees #baking\n");
  await s.sink.note("Search/Soup.md", "# Soup\n\nMentions baking only in passing\n");
  const page = await s.browser.open("#/notes/Search");
  await eventually(async () => expect(await cards(page).count()).toBe(4));

  await page.locator("#search").fill("zucchini");
  await eventually(async () => expect(await paths(page)).toEqual(["Search/Pasta.md"]));

  // "#baking" is the tag: the note that only says "baking" in its text isn't included.
  await page.locator("#search").fill("#baking");
  await eventually(async () => expect(await paths(page)).toEqual(["Search/Bread.md", "Search/Cake.md"]));

  await page.locator("#search").fill("");
  await eventually(async () => expect(await cards(page).count()).toBe(4));
});

s.it("quick capture: the Take a note box saves a card, and its title is the first line", async () => {
  const page = await s.browser.open("#/notes/Capture");
  await page.locator("#take-body").click();
  await page.locator("#take-body").fill("Renew the passport");
  // Leaving the box saves it.
  await page.locator("#view-title").click();

  await eventually(async () => expect(await paths(page)).toEqual(["Capture/Renew the passport.md"]));
  expect(s.sink.read("Capture/Renew the passport.md")).toBe("# Renew the passport\n");
});

s.it("a card opens its note, and Escape comes back to the grid", async () => {
  await s.sink.note("Open/Recipe.md", "# Recipe\n\nTwo eggs\n");
  const page = await s.browser.open("#/notes/Open");
  await page.locator('.note-card[data-path="Open/Recipe.md"]').click();

  await page.locator("#note-screen:not([hidden])").waitFor();
  await eventually(async () => expect(await page.evaluate(() => location.hash)).toBe("#/n/Open/Recipe.md"));
  await page.locator("#note-editor .cm-content").waitFor();
  expect(await page.locator("#note-editor .cm-content").innerText()).toContain("Two eggs");

  await page.keyboard.press("Escape");
  await page.locator("#note-screen").waitFor({ state: "hidden" });
});

s.it("the page loads without script errors", async () => {
  const page = await s.browser.open("#/notes");
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.reload();
  await page.locator("#notes:not([hidden])").waitFor();
  expect(errors).toEqual([]);
});
