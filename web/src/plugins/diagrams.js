// Diagrams: ```mermaid code blocks render as Mermaid diagrams. Mermaid downloads only when a note has one.

let next = 0;

export default function setup(sink) {
  sink.codeBlock('mermaid', async (source, el, { dark }) => {
    const { default: mermaid } = await import('mermaid');
    // "strict": no scripts or click handlers from the diagram text.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'inherit' });
    const { svg } = await mermaid.render(`sink-mermaid-${next++}`, source);
    el.innerHTML = svg;
  });
  sink.command({
    id: 'mermaid',
    name: 'Diagram',
    run: (ctx) => ctx.insert('```mermaid\nflowchart LR\n  Idea --> Note --> Done\n```\n'),
  });
}
