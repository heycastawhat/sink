import { builtinModules } from "node:module";
import { copyFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

async function build() {
  const out = await Bun.build({
    entrypoints: ["main.ts"],
    outdir: ".",
    target: "browser",
    // Obsidian loads main.js as a CommonJS module and provides these itself.
    format: "cjs",
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
    minify: !watch,
    sourcemap: watch ? "inline" : "none",
  });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    process.exit(1);
  }
  console.log(`built main.js (${(out.outputs[0]!.size / 1024).toFixed(1)} kB)`);
}

await build();
if (watch) {
  const { watch: fsWatch } = await import("node:fs");
  let timer: ReturnType<typeof setTimeout>;
  fsWatch(".", { recursive: true }, (_, file) => {
    if (!file || file.startsWith("node_modules") || file === "main.js") return;
    clearTimeout(timer);
    timer = setTimeout(() => void build(), 100);
  });
}
