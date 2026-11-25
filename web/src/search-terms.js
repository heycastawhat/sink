// The words of a search to light up in a note opened from it: the query without `in:Folder`, `#tag` and `is:todo`
// (the same whole-word rules as the server's parseSearch). Lower case, unique; one letter isn't worth lighting up.
export function searchTerms(q) {
  const words = (q ?? '')
    .replace(/(^|\s)(?:in:(?:"[^"]*"|\S+)|is:todo|#[\p{L}\p{N}_/-]+)(?=\s|$)/giu, '$1')
    .match(/[\p{L}\p{N}]+/gu);
  return [...new Set((words ?? []).map((w) => w.toLowerCase()).filter((w) => [...w].length > 1))];
}
