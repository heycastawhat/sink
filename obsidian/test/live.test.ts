import { describe, expect, test } from "bun:test";
import { Live } from "../src/live";
import { Runner } from "../src/runner";
import { server } from "./helpers";

const until = async (ok: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};

describe("live changes", () => {
  test("a change on the server is heard over the event stream, with the bearer header", async () => {
    const s = server();
    let seenAuth = "";
    let changes = 0;
    const live = new Live({
      url: "https://sink.test/api/events",
      token: () => s.token,
      onChange: () => changes++,
      fetch: (url, init) => {
        seenAuth = init.headers.authorization ?? "";
        return Promise.resolve(s.app.request(new URL(url).pathname, init));
      },
    });
    live.start();
    await until(() => live.mode === "live" && changes === 1);
    expect(seenAuth).toBe(`Bearer ${s.token}`);

    await s.vault.write("Heard.md", "x", null);
    await until(() => changes >= 2);
    live.stop();
  });

  test("where the stream can't be opened it polls instead, and says so", async () => {
    let polls = 0;
    let mode = "";
    const live = new Live({
      url: "https://sink.test/api/events",
      token: () => "t",
      onChange: () => polls++,
      onMode: (m) => (mode = m),
      fetch: () => Promise.reject(new TypeError("blocked by CORS")),
      pollMs: 20,
      retryMs: 5,
    });
    live.start();
    await until(() => mode === "polling" && polls >= 3);
    live.stop();
    const after = polls;
    await new Promise((r) => setTimeout(r, 80));
    expect(polls).toBe(after);
  });

  test("a refused token is a failure to connect too, not an endless busy loop", async () => {
    const s = server();
    let tries = 0;
    const live = new Live({
      url: "https://sink.test/api/events",
      token: () => "sink_nope",
      onChange: () => {},
      fetch: (url, init) => (tries++, Promise.resolve(s.app.request(new URL(url).pathname, init))),
      retryMs: 20,
    });
    live.start();
    await until(() => live.mode === "polling");
    live.stop();
    expect(tries).toBeLessThan(5);
  });

  test("it recovers: polling gives way to the stream once that works", async () => {
    const s = server();
    let works = false;
    const live = new Live({
      url: "https://sink.test/api/events",
      token: () => s.token,
      onChange: () => {},
      fetch: (url, init) => (works ? Promise.resolve(s.app.request(new URL(url).pathname, init)) : Promise.reject(new Error("down"))),
      pollMs: 1000,
      retryMs: 5,
    });
    live.start();
    await until(() => live.mode === "polling");
    works = true;
    await until(() => live.mode === "live");
    live.stop();
  });
});

describe("the sync runner", () => {
  test("asks that arrive together run once, and one at a time", async () => {
    const runs: unknown[] = [];
    let active = 0;
    let overlap = false;
    const runner = new Runner(async (o) => {
      overlap ||= ++active > 1;
      runs.push(o);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
    runner.request(10);
    runner.request(10, { scan: true });
    runner.request(10);
    await until(() => runs.length === 1);
    expect(runs[0]).toEqual({ scan: true, confirmDeletes: undefined });

    // Asks made while one runs (that first run is still going) queue exactly one more, not one each.
    const queued = runner.now();
    runner.request(0);
    runner.request(0);
    await queued;
    await new Promise((r) => setTimeout(r, 60));
    expect(runs.length).toBe(2);
    expect(overlap).toBe(false);
  });

  test("a steady stream of asks still runs, every so often", async () => {
    let runs = 0;
    const runner = new Runner(async () => void runs++, 60);
    const keep = setInterval(() => runner.request(40), 10);
    await until(() => runs >= 1);
    clearInterval(keep);
  });

  test("now() resolves after the run, even if it fails", async () => {
    const runner = new Runner(async () => {
      throw new Error("boom");
    });
    const logged = console.error;
    console.error = () => {};
    await runner.now();
    console.error = logged;
  });
});
