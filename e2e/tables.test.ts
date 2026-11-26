import { expect } from "bun:test";
import type { Page } from "playwright-core";
import { eventually, suite } from "./harness";

const s = suite();

const editor = (page: Page) => page.locator("#note-editor .cm-content");

async function openNote(page: Page, path: string) {
  await page.goto(`${s.sink.url}/#/n/${path}`);
  await editor(page).waitFor();
  await page.locator("#note-status", { hasText: /Edited|Saved/ }).waitFor();
}

/** The cells of the markdown table in `text`, row by row, without the `---` rule line (columns are padded on disk). */
function rows(text: string | null): string[][] {
  return (text ?? "")
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .filter((l) => !/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
}

const TABLE = "# Stock\n\n| Item | Qty |\n| --- | ---: |\n| Apples | 3 |\n| Pears | 12 |\n\nAfter the table\n";

s.it("a markdown table is drawn as a table, with its alignment", async () => {
  await s.sink.note("Tables/Stock.md", TABLE);
  const page = await s.browser.open("#/notes");
  await openNote(page, "Tables/Stock.md");

  await page.locator(".cm-table table").waitFor();
  expect(await page.locator(".cm-table th").allInnerTexts()).toEqual(["Item", "Qty"]);
  expect(await page.locator(".cm-table td").allInnerTexts()).toEqual(["Apples", "3", "Pears", "12"]);
  // The rule line's `---:` right-aligns the column.
  expect(await page.locator(".cm-table td").nth(1).evaluate((el) => getComputedStyle(el).textAlign)).toBe("right");
});

s.it("clicking a cell shows the table's source with the caret in that cell, and edits save", async () => {
  await s.sink.note("Tables/Edit.md", TABLE);
  const page = await s.browser.open("#/notes");
  await openNote(page, "Tables/Edit.md");

  await page.locator(".cm-table td", { hasText: "Pears" }).click();
  // The widget gives way to the markdown, which is what you edit.
  await eventually(async () => expect(await page.locator(".cm-table").count()).toBe(0));
  expect(await page.locator(".cm-table-source").count()).toBeGreaterThan(0);

  await page.keyboard.type("Green ");
  await eventually(async () => expect(rows(s.sink.read("Tables/Edit.md"))).toEqual([["Item", "Qty"], ["Apples", "3"], ["Green Pears", "12"]]));
});

s.it("Tab moves between cells, selecting each, and a new row starts after the last", async () => {
  await s.sink.note("Tables/Tab.md", TABLE);
  const page = await s.browser.open("#/notes");
  await openNote(page, "Tables/Tab.md");

  await page.locator(".cm-table td", { hasText: "Apples" }).click();
  // Tab selects the next cell's text, so typing replaces it.
  await page.keyboard.press("Tab");
  await page.keyboard.type("4");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Pears");
  await page.keyboard.press("Tab");
  await page.keyboard.type("13");
  // Tab from the last cell adds a row.
  await page.keyboard.press("Tab");
  await page.keyboard.type("Plums");
  await page.keyboard.press("Tab");
  await page.keyboard.type("6");
  // Moving to another cell is what lines the pipes up again, so go back one.
  await page.keyboard.press("Shift+Tab");

  await eventually(async () =>
    expect(rows(s.sink.read("Tables/Tab.md"))).toEqual([["Item", "Qty"], ["Apples", "4"], ["Pears", "13"], ["Plums", "6"]]),
  );
  // Padding keeps the pipes lined up in the file, for anyone reading it as text.
  const lines = s.sink.read("Tables/Tab.md")!.split("\n").filter((l) => l.startsWith("|"));
  expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  expect(s.sink.read("Tables/Tab.md")).toContain("After the table");
});

s.it("typing a | header | line and pressing Enter makes a table", async () => {
  await s.sink.note("Tables/New.md", "# Scores\n\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "Tables/New.md");
  await editor(page).click();
  await page.keyboard.press("Control+End");

  await page.keyboard.type("| Name | Score |");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ada");
  await page.keyboard.press("Tab");
  await page.keyboard.type("10");

  await eventually(async () => expect(rows(s.sink.read("Tables/New.md"))).toEqual([["Name", "Score"], ["Ada", "10"]]));
  expect(s.sink.read("Tables/New.md")!.split("\n").some((l) => /^\|\s*-{3,}\s*\|\s*-{3,}\s*\|$/.test(l))).toBe(true);
});

// BUG: the toolbar sits inside the note page's scroll area but outside .cm-content, so pressing a button reaches the
// handler in notes.js that sends clicks on "the empty page below the text" to the end of the note. The caret leaves the
// table, it turns back into a widget, and the button never gets its click. (Stopping the toolbar's mousedown from
// bubbling makes this pass.) Turn this into a plain `it` when that's fixed.
s.it.failing("the toolbar adds rows and columns at the caret", async () => {
  await s.sink.note("Tables/Tools.md", "# Tools\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "Tables/Tools.md");

  await page.locator(".cm-table td", { hasText: "1" }).click();
  const tool = (label: string) => page.locator(`.cm-table-tools button[aria-label="${label}"]`);
  await tool("Add row below").click();
  await eventually(async () => expect(rows(s.sink.read("Tables/Tools.md"))).toEqual([["A", "B"], ["1", "2"], ["", ""]]), 2_000);

  await tool("Add column right").click();
  await eventually(async () => expect(rows(s.sink.read("Tables/Tools.md"))).toEqual([["A", "", "B"], ["1", "", "2"], ["", "", ""]]));
});

s.it("pasting spreadsheet cells makes a table", async () => {
  await s.sink.note("Tables/Paste.md", "# Sheet\n\n");
  const page = await s.browser.open("#/notes");
  await openNote(page, "Tables/Paste.md");
  await editor(page).click();
  await page.keyboard.press("Control+End");

  // Tab-separated rows, the way Sheets and Excel put a selection on the clipboard.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "Month\tSpend\nJan\t100\nFeb\t120");
    document.querySelector("#note-editor .cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });

  await eventually(async () => expect(rows(s.sink.read("Tables/Paste.md"))).toEqual([["Month", "Spend"], ["Jan", "100"], ["Feb", "120"]]));
});
