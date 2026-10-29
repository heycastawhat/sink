// Daily notes: a "Today" button on the grid opens today's note (the server makes it from your template),
// and /today, /date and /time in the editor.

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function openToday(sink, ctx) {
  const res = await sink.api('today', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { path } = await res.json();
  ctx.openNote(path);
}

export default function setup(sink) {
  sink.gridAction({ id: 'today', label: "Today's note", icon: 'today', run: (ctx) => openToday(sink, ctx) });
  sink.command({ id: 'today', name: "Link to today's note", run: (ctx) => ctx.insert(`[[${isoDate(new Date())}]]`) });
  sink.command({ id: 'date', name: "Today's date", run: (ctx) => ctx.insert(isoDate(new Date())) });
  sink.command({
    id: 'time',
    name: 'The time now',
    run: (ctx) => ctx.insert(new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })),
  });
}
