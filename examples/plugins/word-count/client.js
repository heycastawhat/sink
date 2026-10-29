// Loads in the web app and the Android editor. Plain JavaScript module; no build step.
export default function setup(sink) {
  sink.command({
    id: "words",
    name: "Insert this note's word count",
    run(ctx) {
      const count = (ctx.text().match(/[\p{L}\p{N}']+/gu) ?? []).length;
      ctx.insert(`*${count} words*`);
    },
  });

  // ```wordcloud blocks render as a row of the most common words.
  sink.codeBlock("wordcloud", (source, el) => {
    const counts = new Map();
    for (const w of source.toLowerCase().match(/[\p{L}']{4,}/gu) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12);
    el.classList.add("word-cloud");
    for (const [word, n] of top) {
      const span = document.createElement("span");
      span.textContent = word;
      span.style.fontSize = `${0.9 + n * 0.25}em`;
      el.append(span);
    }
  });
}
