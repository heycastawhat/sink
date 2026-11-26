import { expect } from "bun:test";
import type { Page } from "playwright-core";
import { eventually, suite } from "./harness";

const s = suite();

// Every open checkbox in every note is on the Todos list, dated or not (dated ones first), except blank ones.

const row = (page: Page, text: string) => page.locator("#todo-list .todo", { hasText: text });
const openTodos = async (path = "#/todos") => {
  const page = await s.browser.open(path);
  await page.locator("#todos:not([hidden])").waitFor();
  return page;
};

s.it("checkbox todos written in notes show up in the todo list, with their note", async () => {
  await s.sink.note("Todos/Trip.md", "# Trip\n\n- [ ] book the ferry #todo\n- [x] renew passport #todo\n- [ ] pack socks\n- [ ] \n- not a todo\n");
  await s.sink.note("Todos/Home.md", "# Home\n\n- [ ] fix the gate 📅 2031-01-01\n");
  const page = await openTodos();

  await row(page, "book the ferry").waitFor();
  await row(page, "fix the gate").waitFor();
  // Done ones wait under "Show done", and plain bullets never appear.
  expect(await row(page, "renew passport").count()).toBe(0);
  expect(await page.locator("#todo-list").innerText()).not.toContain("not a todo");
  // A plain checkbox is a todo too, listed after the dated ones.
  await row(page, "pack socks").waitFor();
  const listed = await page.locator("#todo-list .todo").allInnerTexts();
  expect(listed.findIndex((t) => t.includes("fix the gate"))).toBeLessThan(listed.findIndex((t) => t.includes("pack socks")));
  // A blank checkbox has nothing to show.
  expect(await page.locator("#todo-list .todo").count()).toBe(3);
  expect(await row(page, "book the ferry").locator(".todo-note").innerText()).toContain("Trip");

  await page.locator("#todo-done-toggle").click();
  await page.locator("#todo-done .todo", { hasText: "renew passport" }).waitFor();
});

s.it("a todo typed in the editor appears in the list", async () => {
  await s.sink.note("Todos/Typed.md", "# Typed\n\n");
  const page = await s.browser.open("#/n/Todos/Typed.md");
  await page.locator("#note-editor .cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("- [ ] call the plumber #todo");
  await eventually(async () => expect(s.sink.read("Todos/Typed.md")).toContain("- [ ] call the plumber #todo"));

  await page.goto(`${s.sink.url}/#/todos`);
  await page.locator("#todos:not([hidden])").waitFor();
  await row(page, "call the plumber").waitFor();
});

s.it("ticking a todo in the list writes [x] into its note and moves it to done", async () => {
  await s.sink.note("Todos/Chores.md", "# Chores\n\n- [ ] take out bins #todo\n- [ ] water ferns #todo\n");
  const page = await openTodos();
  await row(page, "take out bins").locator(".todo-box").click();

  // Done from the list, it gets Obsidian Tasks' completion stamp (✅ and the day).
  await eventually(async () =>
    expect(s.sink.read("Todos/Chores.md")).toMatch(/^# Chores\n\n- \[x\] take out bins #todo ✅ \d{4}-\d{2}-\d{2}\n- \[ \] water ferns #todo\n$/),
  );
  await eventually(async () => expect(await row(page, "take out bins").count()).toBe(0));
  await row(page, "water ferns").waitFor();
});

s.it("ticking a checkbox in the editor takes it off the list", async () => {
  await s.sink.note("Todos/Tick.md", "# Tick\n\n- [ ] send the invoice #todo\n");
  const page = await s.browser.open("#/n/Todos/Tick.md");
  await page.locator("#note-editor .cm-task").click();
  await eventually(async () => expect(s.sink.read("Todos/Tick.md")).toBe("# Tick\n\n- [x] send the invoice #todo\n"));

  await page.goto(`${s.sink.url}/#/todos`);
  await page.locator("#todos:not([hidden])").waitFor();
  await page.locator("#todo-list").waitFor();
  await eventually(async () => expect(await row(page, "send the invoice").count()).toBe(0));
  await page.locator("#todo-done-toggle").click();
  await page.locator("#todo-done .todo", { hasText: "send the invoice" }).waitFor();
});

s.it("adding a todo from the list form saves it as a checkbox in Todo.md", async () => {
  const page = await openTodos();
  await page.locator("#todo-text").fill("pick up the parcel");
  await page.locator("#todo-add").click();

  await row(page, "pick up the parcel").waitFor();
  await eventually(async () => expect(s.sink.read("Todo.md")).toContain("- [ ] pick up the parcel"));
});
