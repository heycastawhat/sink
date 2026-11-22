// Builds the Chrome extension into dist/: the side panel (which bundles the web app's editor from ../web/src, so run
// `bun install` in web/ first), the background worker, the manifest and icons. Load dist/ unpacked, or zip it for the store.
import { cp, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
// The web app's packages (Material 3 components, fonts, CodeMirror) come from web/node_modules: one copy, one version.
const fromWeb: import("bun").BunPlugin = {
  name: "from-web",
  setup(build) {
    build.onResolve({ filter: /^@(m3e|fontsource-variable)\// }, (args) => ({ path: Bun.resolveSync(args.path, `${import.meta.dir}/../web/src`) }));
  },
};
// The demo (src/demo.js) runs the server's quick-todo and HTML-to-markdown code in the panel. todos.ts also holds the
// todo routes, which need the vault (node:fs); the demo never calls them, so the vault is a stub here.
const fromServer: import("bun").BunPlugin = {
  name: "from-server",
  setup(build) {
    build.onResolve({ filter: /^@mozilla\/readability$/ }, (args) => ({ path: Bun.resolveSync(args.path, `${import.meta.dir}/../server/src`) }));
    build.onResolve({ filter: /^\.\/notes$/ }, (args) =>
      args.importer.endsWith("/server/src/todos.ts") ? { path: `${import.meta.dir}/src/demo-vault-stub.js` } : undefined,
    );
  },
};
const common = { outdir: "dist", plugins: [fromWeb, fromServer], target: "browser", minify: true, naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" } } as const;
const results = [
  // panel.html is copied as it is: Bun's HTML bundling links the wrong chunk once code is split. Splitting is on so
  // code languages load only when a note has that fenced block.
  await Bun.build({ ...common, entrypoints: ["src/panel.js"], splitting: true }),
  // On its own, so the service worker never shares a chunk with the editor.
  await Bun.build({ ...common, entrypoints: ["src/background.js"] }),
];
for (const result of results) {
  if (result.success) continue;
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// Bun's CSS printer drops the quotes in format("woff2-variations"), which isn't a keyword, so Chrome would skip every
// Roboto Flex face and fall back to the system font.
const css = Bun.file("dist/panel.css");
await Bun.write(css, (await css.text()).replaceAll("format(woff2-variations)", 'format("woff2-variations")'));
await cp("src/panel.html", "dist/panel.html");
await cp("manifest.json", "dist/manifest.json");
await cp("icons", "dist/icons", { recursive: true });
console.log(`built ${results.flatMap((r) => r.outputs).length} files into dist/`);
