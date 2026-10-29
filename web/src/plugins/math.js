// Math: ```math code blocks render with KaTeX (LaTeX syntax). KaTeX downloads only when a note has one.

export default function setup(sink) {
  sink.codeBlock('math', async (source, el) => {
    const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
    katex.render(source, el, { displayMode: true, throwOnError: false });
  });
  sink.command({
    id: 'math',
    name: 'Equation',
    run: (ctx) => ctx.insert('```math\ne^{i\\pi} + 1 = 0\n```\n'),
  });
}
