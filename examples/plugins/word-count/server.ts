// Runs once when Sink starts. `sink` is the whole plugin API (see docs/plugins.md).
export default function setup(sink) {
  const words = (text) => (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;

  // GET /api/plugins/word-count/stats
  sink.routes.get("/stats", async (c) => {
    const { notes } = sink.vault.list();
    let total = 0;
    for (const n of notes) total += words((await sink.vault.read(n.path)).content);
    return c.json({ notes: notes.length, words: total });
  });

  // An assistant tool, offered as "word_count_stats".
  sink.mcpTool("stats", { description: "How many notes and words are in the vault.", inputSchema: {}, readOnly: true }, async () => {
    const { notes } = sink.vault.list();
    return `${notes.length} notes`;
  });

  // React to changes: here, just a log line when a long note is saved.
  sink.on(async (event) => {
    if (event.type !== "note.updated") return;
    const note = await sink.vault.read(event.path);
    if (words(note.content) > 5000) sink.log(`${event.path} is getting long`);
  });
}
