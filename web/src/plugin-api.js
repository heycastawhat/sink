// The client half of Sink's plugins: what a plugin's client.js (or a built-in in src/plugins/) can add to the
// editor and the notes grid. Shared by the web app and the Android editor page.
//
//   export default function setup(sink) {
//     sink.codeBlock('chart', (source, el, { dark }) => { el.textContent = source; });  // ```chart blocks
//     sink.command({ id: 'hello', name: 'Insert a greeting', run: (ctx) => ctx.insert('Hello!') });  // type /hello
//     sink.gridAction({ id: 'random', label: 'Random note', icon: 'casino', run: (ctx) => ctx.openNote('Ideas.md') });
//     const res = await sink.api('thing', { method: 'POST' });  // your server routes at /api/plugins/<id>/thing
//   }

export const registry = {
  /** lang -> { render(source, el, { dark }), plugin } */
  codeBlocks: new Map(),
  /** { id, name, description?, run(ctx), plugin } */
  commands: [],
  /** { id, label, icon, run(ctx), plugin } (web grid only) */
  gridActions: [],
};

const listeners = new Set();
/** Called when plugins add something the UI shows (grid buttons). */
export const onRegistryChange = (fn) => listeners.add(fn);
const changed = () => listeners.forEach((fn) => fn());

function contextFor(id, host) {
  return {
    id,
    codeBlock(lang, render) {
      registry.codeBlocks.set(String(lang).toLowerCase(), { render, plugin: id });
    },
    command(cmd) {
      registry.commands.push({ ...cmd, plugin: id });
    },
    gridAction(action) {
      registry.gridActions.push({ ...action, plugin: id });
      changed();
    },
    /** fetch() against this plugin's server routes, signed in. */
    api: (path, init) => host.fetch(`/api/plugins/${id}/${String(path).replace(/^\/+/, '')}`, init),
    dark: () => host.dark(),
  };
}

const loaded = new Set();

/**
 * Loads every enabled plugin's client part. `host` adapts this to the page:
 *   list()        -> [{ id, bundled_client, client, styles }] from GET /api/plugins
 *   url(path)     -> where /plugins/<id>/<file> is fetched from
 *   fetch, dark
 * `bundled` maps built-in ids to their setup functions. A plugin that fails is skipped, not fatal.
 */
export async function loadPlugins(host, bundled) {
  let list = [];
  try {
    list = await host.list();
  } catch (err) {
    console.warn('[plugins] list failed:', err);
  }
  for (const p of list) {
    if (loaded.has(p.id)) continue;
    loaded.add(p.id);
    try {
      if (p.styles) {
        const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: host.url(p.styles) });
        document.head.append(link);
      }
      const setup = p.bundled_client ? bundled[p.id] : p.client ? (await import(/* @vite-ignore */ host.url(p.client))).default : null;
      if (setup) await setup(contextFor(p.id, host));
    } catch (err) {
      console.warn(`[plugins] ${p.id} failed to load:`, err);
    }
  }
}
