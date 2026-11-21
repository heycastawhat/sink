// A native/server replacement can arrive while plugins or a lazy board import are still holding up the editor.
export function deferredEditorText() {
  let pending = null;
  return {
    read(editor, fallback = null) {
      return editor?.getText() ?? pending ?? fallback;
    },
    replace(editor, text) {
      if (editor) editor.setText(text);
      else pending = text;
    },
    take(fallback) {
      const text = pending ?? fallback;
      pending = null;
      return text;
    },
  };
}
