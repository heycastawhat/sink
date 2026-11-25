import { expect, test } from 'bun:test';
import { fetchImage, imageSource, pastedHtmlImage, pasteHtmlImage } from './paste-image.js';

const clip = ({ html = '', text = '', files = [] }) => ({
  files,
  getData: (type) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
});
const event = (data) => ({ clipboardData: data, prevented: false, preventDefault() { this.prevented = true; } });
const png = (type = 'image/png') => new Blob([new Uint8Array([137, 80, 78, 71])], { type });
const respond = (blob, status = 200) => async () => new Response(blob, { status });
const settle = () => new Promise((resolve) => setTimeout(resolve));

test('the first <img>’s address is read from the HTML a browser puts on the clipboard', () => {
  expect(imageSource('<meta charset="utf-8"><img src="https://example.com/a/cat.png?x=1&amp;y=2" alt="cat">')).toBe('https://example.com/a/cat.png?x=1&y=2');
  expect(imageSource("<p>hi</p><IMG alt=x SRC='http://example.com/b.jpg'>")).toBe('http://example.com/b.jpg');
  expect(imageSource('<img src=https://example.com/c.gif>')).toBe('https://example.com/c.gif');
  expect(imageSource('<img src="data:image/png;base64,iVBORw0=">')).toBe('data:image/png;base64,iVBORw0=');
});

test('addresses a browser here can’t use are ignored', () => {
  expect(imageSource('<img src="/relative.png">')).toBeNull();
  expect(imageSource('<img src="blob:https://example.com/1234">')).toBeNull();
  expect(imageSource('<img src="javascript:alert(1)">')).toBeNull();
  expect(imageSource('<img src="data:text/html,hi">')).toBeNull();
  expect(imageSource('<img alt="no source">')).toBeNull();
  expect(imageSource('<p>just text</p>')).toBeNull();
  expect(imageSource('')).toBeNull();
});

test('only an image with no file and no text of its own is taken over', () => {
  const html = '<img src="https://example.com/cat.png">';
  expect(pastedHtmlImage(clip({ html }))).toBe('https://example.com/cat.png');
  expect(pastedHtmlImage(clip({ html, text: '  \n' }))).toBe('https://example.com/cat.png');
  // A file means the existing path; text beside the image means a copied passage.
  expect(pastedHtmlImage(clip({ html, files: [new File([png()], 'image.png')] }))).toBeNull();
  expect(pastedHtmlImage(clip({ html, text: 'A cat, photographed' }))).toBeNull();
  expect(pastedHtmlImage(null)).toBeNull();
});

test('the image is fetched without cookies or a referrer, and named for what the bytes are', async () => {
  let init;
  const file = await fetchImage('https://example.com/photos/My%20Cat?size=big', async (url, i) => ((init = i), respond(png('image/jpeg'))()));
  expect(init).toEqual({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  expect([file.name, file.type]).toEqual(['My Cat.jpg', 'image/jpeg']);
  expect((await fetchImage('https://example.com/a/cat.webp', respond(png('image/webp')))).name).toBe('cat.webp');
  expect((await fetchImage('data:image/png;base64,iVBORw0=', respond(png()))).name).toBe('image.png');
  expect((await fetchImage('https://example.com/', respond(png('image/svg+xml')))).name).toBe('image.svg');
});

test('a data: image is decoded without fetching it, which the page’s CSP would refuse', async () => {
  const never = async () => { throw new Error('fetched'); };
  const file = await fetchImage('data:image/png;base64,iVBORw0KGgo=', never);
  expect([file.name, file.type]).toEqual(['image.png', 'image/png']);
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const svg = await fetchImage('data:image/svg+xml,%3Csvg%2F%3E', never);
  expect([svg.name, await svg.text()]).toEqual(['image.svg', '<svg/>']);
  await expect(fetchImage('data:text/html;base64,aGk=', never)).rejects.toThrow('image');
});

test('when fetch is refused the image is drawn through a canvas instead, saved as PNG', async () => {
  const refused = async () => { throw new TypeError('Failed to fetch'); };
  const drawn = [];
  const draw = async (src) => (drawn.push(src), png('image/png'));
  const file = await fetchImage('https://example.com/photos/cat.jpg', refused, draw);
  expect(drawn).toEqual(['https://example.com/photos/cat.jpg']);
  // Named for what the bytes are now, since the server goes by the extension.
  expect([file.name, file.type]).toEqual(['cat.png', 'image/png']);
  expect((await fetchImage('https://example.com/my.cat.jpeg', refused, draw)).name).toBe('my.cat.png');
  // If that fails too, the fetch's own error is what's reported.
  await expect(fetchImage('https://example.com/x.gif', refused, async () => { throw new Error('tainted'); })).rejects.toThrow('Failed to fetch');
});

test('something that isn’t an image, or fails to load, is an error', async () => {
  await expect(fetchImage('https://example.com/x', respond(new Blob(['<html>'], { type: 'text/html' })))).rejects.toThrow('image');
  await expect(fetchImage('https://example.com/x', respond(png(), 404))).rejects.toThrow('404');
  await expect(fetchImage('https://example.com/x', async () => { throw new TypeError('Failed to fetch'); })).rejects.toThrow('Failed to fetch');
});

test('a pasted web image is uploaded and its embed inserted', async () => {
  const uploaded = [];
  const inserted = [];
  const e = event(clip({ html: '<img src="https://example.com/cat.png">' }));
  const taken = pasteHtmlImage(e, {
    uploadFile: async (file) => (uploaded.push(file), '![[cat.png]]'),
    insert: (text) => inserted.push(text),
    fetchFn: respond(png()),
  });
  expect(taken).toBe(true);
  expect(e.prevented).toBe(true);
  await settle();
  expect(uploaded.map((f) => [f.name, f.type])).toEqual([['cat.png', 'image/png']]);
  expect(inserted).toEqual(['![[cat.png]]']);
});

test('when the image can’t be fetched its address goes in as a markdown image, with no error', async () => {
  const inserted = [];
  const errors = [];
  let uploads = 0;
  pasteHtmlImage(event(clip({ html: '<img src="https://example.com/a b/cat (1).png">' })), {
    uploadFile: async () => (uploads++, 'unused'),
    insert: (text) => inserted.push(text),
    onError: (err) => errors.push(err),
    fetchFn: async () => { throw new TypeError('Failed to fetch'); },
  });
  await settle();
  expect(inserted).toEqual(['![](https://example.com/a%20b/cat%20%281%29.png)']);
  expect([uploads, errors]).toEqual([0, []]);
});

test('when the upload fails the error is reported and the address goes in instead', async () => {
  const inserted = [];
  const errors = [];
  pasteHtmlImage(event(clip({ html: '<img src="https://example.com/cat.png">' })), {
    uploadFile: async () => { throw new Error('Upload failed'); },
    insert: (text) => inserted.push(text),
    onError: (err) => errors.push(err.message),
    fetchFn: respond(png()),
  });
  await settle();
  expect(errors).toEqual(['Upload failed']);
  expect(inserted).toEqual(['![](https://example.com/cat.png)']);
});

test('a failed data: image leaves nothing behind rather than the picture’s bytes as text', async () => {
  const inserted = [];
  pasteHtmlImage(event(clip({ html: '<img src="data:image/png;base64,iVBORw0=">' })), {
    uploadFile: async () => { throw new Error('Upload failed'); },
    insert: (text) => inserted.push(text),
    fetchFn: respond(png()),
  });
  await settle();
  expect(inserted).toEqual([]);
});

test('anything else is left to the editor, and so is a paste where nothing can upload', () => {
  const e = event(clip({ html: '<p>hello</p>', text: 'hello' }));
  expect(pasteHtmlImage(e, { uploadFile: async () => '', insert() {} })).toBe(false);
  expect(e.prevented).toBe(false);
  const image = event(clip({ html: '<img src="https://example.com/cat.png">' }));
  expect(pasteHtmlImage(image, { uploadFile: undefined, insert() {} })).toBe(false);
  expect(image.prevented).toBe(false);
});
