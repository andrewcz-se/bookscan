import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { normalizeSubjects } from '../js/metadata.js';

async function editor(lookupMetadata) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', style: {}, focus() {}, setAttribute() {}, removeAttribute() {} });
    return nodes.get(id);
  };
  const document = { getElementById: get, readyState: 'loading', addEventListener() {}, dispatchEvent() {}, activeElement: null, body: get('body'), querySelector: get, querySelectorAll: () => [] };
  const context = vm.createContext({ document, normalizeSubjects, lookupMetadata, navigator: { onLine: true }, Event });
  const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  vm.runInContext('scanner = { suspend() {} }; openModal({ id: 1, isbn: "9780006540465", title: "Troubles", notes: "My notes" });', context);
  return { get, context, run: code => vm.runInContext(code, context) };
}

test('retry fills blank extra fields while preserving all existing values and personal notes', async () => {
  let calledIsbn;
  const h = await editor(async isbn => {
    calledIsbn = isbn;
    return { title: 'Different title', description: 'Retrieved summary', subjects: ['Fiction', 'Hotels'], binding: 'Paperback', edition: 'New label' };
  });
  h.get('book-binding').value = 'My binding';
  h.get('book-edition').value = 'My edition';
  await h.run('refreshDetails()');
  assert.equal(calledIsbn, '9780006540465');
  assert.equal(h.get('book-title').value, 'Troubles');
  assert.equal(h.get('book-notes').value, 'My notes');
  assert.equal(h.get('book-description').value, 'Retrieved summary');
  assert.equal(h.get('book-subjects').value, 'Fiction\nHotels');
  assert.equal(h.get('book-binding').value, 'My binding');
  assert.equal(h.get('book-edition').value, 'My edition');
  assert.match(h.get('metadata-details-status').textContent, /Filled 2 fields\. Save book/);
  assert.equal(h.run('editing.description'), undefined, 'The retry must leave persistent edits to Save book');
});

test('edits made during lookup are preserved and a concurrent retry is ignored', async () => {
  let finish, calls = 0;
  const h = await editor(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = h.run('refreshDetails()');
  h.get('book-description').value = 'Typed while waiting';
  await h.run('refreshDetails()');
  finish({ description: 'Provider summary', subjects: ['Fiction'] });
  await pending;
  assert.equal(calls, 1);
  assert.equal(h.get('book-description').value, 'Typed while waiting');
  assert.equal(h.get('book-subjects').value, 'Fiction');
  assert.equal(h.get('refresh-details').disabled, false);
});

test('closing and opening another book ignores a stale lookup response', async () => {
  let finish;
  const h = await editor(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.run('refreshDetails()');
  h.run('closeModal(); openModal({ id: 2, isbn: "9780141439518", title: "Another book" });');
  finish({ description: 'Wrong book summary', subjects: ['Wrong subjects'] });
  await pending;
  assert.equal(h.get('book-description').value, '');
  assert.equal(h.get('book-subjects').value, '');
  assert.equal(h.get('metadata-details-status').textContent, '');
  assert.equal(h.get('refresh-details').disabled, false);
});

test('unavailable fields, offline mode, and failed requests give usable feedback', async () => {
  let calls = 0;
  const h = await editor(async () => { calls++; return { description: 'Summary', subjects: ['Fiction'], binding: '', edition: '' }; });
  h.context.navigator.onLine = false;
  await h.run('refreshDetails()');
  assert.equal(calls, 0);
  assert.match(h.get('metadata-details-status').textContent, /Connect to the internet/);
  h.context.navigator.onLine = true;
  await h.run('refreshDetails()');
  assert.match(h.get('metadata-details-status').textContent, /No data returned for: binding, edition/);
  h.context.lookupMetadata = async () => { throw new Error('Network failure'); };
  await h.run('refreshDetails()');
  assert.match(h.get('metadata-details-status').textContent, /lookup failed/);
  assert.equal(h.get('book-description').value, 'Summary');
  assert.equal(h.get('refresh-details').disabled, false);
  h.context.lookupMetadata = async () => null;
  await h.run('refreshDetails()');
  assert.match(h.get('metadata-details-status').textContent, /Could not retrieve details/);
});

test('a new offline cache fetches fresh files with reload semantics under the app subpath', async () => {
  const listeners = new Map();
  let localRequests;
  const cache = { addAll: async requests => { localRequests = requests; }, put: async () => {}, add: async () => {} };
  const context = vm.createContext({ URL, Request, self: { registration: { scope: 'https://example.test/bookscan/' }, addEventListener: (name, listener) => listeners.set(name, listener) }, caches: { open: async () => cache }, fetch: async () => ({ ok: true }) });
  vm.runInContext(await readFile(new URL('../sw.js', import.meta.url), 'utf8'), context);
  let installation;
  listeners.get('install')({ waitUntil: promise => { installation = promise; } });
  await installation;
  assert.ok(localRequests.length > 0);
  for (const request of localRequests) {
    assert.equal(request.cache, 'reload');
    assert.ok(request.url.startsWith('https://example.test/bookscan/'));
  }
  assert.ok(localRequests.some(request => request.url.endsWith('/js/metadata.js')));
});
