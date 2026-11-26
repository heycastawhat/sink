import { z } from "zod";
import { VaultError } from "../notes";
import type { BuiltinPlugin, PluginContext } from "../plugins";
import { localIso } from "../time";

/**
 * Daily notes: today's note at Daily/YYYY-MM-DD.md, made from Templates/Daily.md when there is one
 * ({{date}}, {{time}} and {{title}} are filled in, as in Obsidian's core Templates plugin).
 *   SINK_PLUGIN_DAILY_FOLDER    default Daily
 *   SINK_PLUGIN_DAILY_TEMPLATE  default Templates/Daily.md
 */
export const daily: BuiltinPlugin = {
  id: "daily",
  name: "Daily notes",
  description: "A note for each day, from your template. Adds a Today button and an assistant tool.",
  bundledClient: true,
  setup(sink) {
    const folder = sink.env("FOLDER", "Daily")!.replace(/^\/+|\/+$/g, "");
    const template = sink.env("TEMPLATE", "Templates/Daily.md")!;

    sink.routes.post("/today", async (c) => c.json({ path: await todaysNote(sink, folder, template) }));

    sink.mcpTool(
      "append",
      {
        title: "Add to today's daily note",
        description: "Append text (a line, a todo like '- [ ] call mum', a paragraph) to today's daily note, creating it from the template if needed.",
        inputSchema: { text: z.string().min(1).max(10_000) },
      },
      async ({ text }: { text: string }) => {
        const path = await todaysNote(sink, folder, template);
        for (let attempt = 0; ; attempt++) {
          const note = await sink.vault.read(path);
          try {
            await sink.vault.write(path, `${note.content.replace(/\n*$/, "\n")}${text.trim()}\n`, note.hash);
            return { appended_to: path };
          } catch (err) {
            if (attempt === 0 && err instanceof VaultError && err.status === 409) continue;
            throw err;
          }
        }
      },
    );
  },
};

/** Path of today's note, creating it if it doesn't exist yet. */
export async function todaysNote(sink: Pick<PluginContext, "vault" | "timeZone">, folder: string, template: string): Promise<string> {
  const now = localIso(new Date(), sink.timeZone);
  const date = now.slice(0, 10);
  const path = `${folder ? folder + "/" : ""}${date}.md`;
  try {
    await sink.vault.read(path);
    return path;
  } catch (err) {
    if (!(err instanceof VaultError && err.status === 404)) throw err;
  }
  let content = `# ${date}\n\n`;
  try {
    const t = await sink.vault.read(template);
    content = t.content.replace(/\{\{\s*(date|time|title)(?::[^}]*)?\s*\}\}/g, (_, key: string) =>
      key === "time" ? now.slice(11, 16) : date,
    );
  } catch (err) {
    if (!(err instanceof VaultError && err.status === 404)) throw err;
  }
  try {
    await sink.vault.write(path, content, null);
  } catch (err) {
    // Made by another request a moment ago: that's the one.
    if (!(err instanceof VaultError && err.status === 409)) throw err;
  }
  return path;
}
