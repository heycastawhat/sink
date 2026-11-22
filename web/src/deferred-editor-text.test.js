import { expect, test } from 'bun:test';
import { deferredEditorText } from './deferred-editor-text.js';

test('a loading board exposes its pending body while metadata is changed', () => {
  const text = deferredEditorText();
  text.replace(null, 'unsynced board');
  expect(text.read(null, 'saved board')).toBe('unsynced board');
  text.replace(null, 'updated frontmatter and unsynced board');
  expect(text.take('stale board')).toBe('updated frontmatter and unsynced board');
  expect(text.read(null, 'next board')).toBe('next board');
});

test('ready empty text wins over a fallback and replacements reach the editor', () => {
  const text = deferredEditorText();
  let value = '';
  const editor = { getText: () => value, setText: (next) => (value = next) };
  expect(text.read(editor, 'old note')).toBe('');
  text.replace(editor, 'new note');
  expect(value).toBe('new note');
  expect(text.read(null)).toBeNull();
});
