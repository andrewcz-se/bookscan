import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIsbn, toIsbn10 } from '../js/isbn.js';
import { lookupMetadata, safeCover } from '../js/metadata.js';
import { buildCsv, csvCell } from '../js/csv.js';
import { scanBox, preferredCamera, BookScanner } from '../js/scanner.js';
import { insertBook } from '../js/db.js';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

test('ISBN-10/13 share canonical identity; spaces, hyphens and X are accepted', () => {
  assert.equal(normalizeIsbn('0-14-143951-3'), '9780141439518');
  assert.equal(normalizeIsbn(' 978-0-14-143951-8 '), '9780141439518');
  assert.equal(normalizeIsbn('080442957x'), '9780804429573');
  assert.equal(toIsbn10('9780804429573'), '080442957X');
  assert.equal(toIsbn10('9780141439518'), '0141439513');
});

test('979 ISBN stays ISBN-13; damaged numbers and non-book EANs are rejected', () => {
  assert.equal(normalizeIsbn('9791090636071'), '9791090636071');
  assert.equal(toIsbn10('9791090636071'), null);
  for (const value of ['', '9780141439510', '0804429570', '4006381333931', '978letters1234', '123456789012', null]) {
    assert.throws(() => normalizeIsbn(value));
  }
});

test('ISBN conversion round-trips a range of valid check digits', () => {
  for (let n = 0; n < 200; n++) {
    const base = String(100000000 + n * 7919);
    const sum = [...base].reduce((s, d, i) => s + Number(d) * (10 - i), 0);
    const check = (11 - sum % 11) % 11;
    const isbn10 = base + (check === 10 ? 'X' : check);
    assert.equal(toIsbn10(normalizeIsbn(isbn10)), isbn10);
  }
});

function mockFetch(responses) {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (response?.httpError) return { ok: false, status: response.httpError };
    return { ok: true, json: async () => response };
  };
  return { fetcher, calls };
}

test('tier 1 queries both identities and uses ISBN-10-only edition data', async () => {
  const mock = mockFetch([{ 'ISBN:0141439513': { title: 'Pride and Prejudice', authors: [{ name: 'Jane Austen' }], publish_date: '2002', publishers: [{ name: 'Penguin' }], number_of_pages: 480, cover: { medium: 'http://covers.openlibrary.org/b/id/123-M.jpg' } } }]);
  const book = await lookupMetadata('9780141439518', mock);
  assert.equal(mock.calls.length, 2);
  assert.match(mock.calls[0], /ISBN:9780141439518,ISBN:0141439513/);
  assert.equal(book.title, 'Pride and Prejudice');
  assert.equal(book.authors, 'Jane Austen');
  assert.equal(book.publish_date, '2002');
  assert.equal(book.number_of_pages, 480);
  assert.match(book.cover, /^https:/);
});

test('tier 1 prioritizes ISBN-13 edition if both are returned', async () => {
  const mock = mockFetch([{ 'ISBN:9780141439518': { title: 'New edition' }, 'ISBN:0141439513': { title: 'Old edition' } }]);
  assert.equal((await lookupMetadata('0141439513', mock)).title, 'New edition');
});

test('empty tier 1 advances to Search, preserving requested work fields', async () => {
  const mock = mockFetch([{}, { docs: [{ title: 'Book', author_name: ['One', 'Two'], publish_year: [1999, 2001], first_publish_year: 1965, publisher: ['Press'], number_of_pages_median: 245, cover_i: 321 }] }]);
  const result = await lookupMetadata('9780141439518', mock);
  assert.equal(mock.calls.length, 3);
  assert.equal(result.source, 'Open Library Search');
  assert.equal(result.authors, 'One, Two');
  assert.equal(result.publish_date, '1999');
  assert.equal(result.number_of_pages, 245);
  assert.equal(result.cover, 'https://covers.openlibrary.org/b/id/321-M.jpg');
});

test('HTTP and network errors fall through to Google Books', async () => {
  const mock = mockFetch([{ httpError: 429 }, new TypeError('Network error'), { items: [{ volumeInfo: { title: 'Google result', authors: ['Author'], publishedDate: '2004-01', publisher: 'Publisher', pageCount: 300, imageLinks: { thumbnail: 'https://example.org/cover.jpg' } } }] }]);
  const result = await lookupMetadata('9780141439518', mock);
  assert.equal(mock.calls.length, 3);
  assert.equal(result.source, 'Google Books');
  assert.equal(result.publish_date, '2004-01');
  assert.equal(result.number_of_pages, 300);
});

test('missing fields are safe and all misses return manual fallback', async () => {
  assert.equal(await lookupMetadata('9780141439518', mockFetch([{}, { docs: [] }, { items: [] }])), null);
  assert.equal(await lookupMetadata('9780141439518', mockFetch([null, { docs: [{ title: ' ' }] }, {}])), null);
  const result = await lookupMetadata('9791090636071', mockFetch([{ 'ISBN:9791090636071': { title: 'Minimal' } }]));
  assert.equal(result.authors, '');
  assert.equal(result.number_of_pages, null);
});

test('a hanging request is aborted and the next tier succeeds', async () => {
  let count = 0, aborted = false;
  const result = await lookupMetadata('9780141439518', {
    timeoutMs: 10,
    fetcher: (url, { signal }) => {
      if (++count === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('Aborted')); }));
      return Promise.resolve({ ok: true, json: async () => ({ docs: [{ title: 'Recovered' }] }) });
    }
  });
  assert.equal(aborted, true);
  assert.equal(count, 3);
  assert.equal(result.title, 'Recovered');
});

test('malformed JSON advances; invalid ISBN makes no request', async () => {
  let count = 0;
  const result = await lookupMetadata('9780141439518', { fetcher: async () => ({ ok: true, json: async () => { if (++count === 1) throw new SyntaxError(); return { docs: [{ title: 'Valid' }] }; } }) });
  assert.equal(result.title, 'Valid');
  const mock = mockFetch([]);
  await assert.rejects(lookupMetadata('123', mock));
  assert.equal(mock.calls.length, 0);
});

test('covers reject unsafe schemes and upgrade HTTP', () => {
  assert.equal(safeCover('javascript:alert(1)'), null);
  assert.equal(safeCover('data:text/html,unsafe'), null);
  assert.equal(safeCover(null), null);
  assert.equal(safeCover('http://example.org/image'), 'https://example.org/image');
});

test('CSV preserves punctuation, Unicode, multiline notes and null cells', () => {
  const csv = buildCsv([{ isbn: '9780141439518', title: 'Book, "édition"', notes: 'First line\nSecond line', number_of_pages: null }]);
  assert.ok(csv.startsWith('\uFEFF"ISBN","Title"'));
  assert.ok(csv.includes('"Book, ""édition"""'));
  assert.ok(csv.includes('"First line\nSecond line"'));
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csvCell(null), '""');
});

test('CSV neutralizes formulas even after leading whitespace', () => {
  for (const value of ['=HYPERLINK("x")', '+SUM(1)', '-1+2', '@SUM(1)', '\t =cmd', '\r\n+cmd']) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell('9780141439518'), '"9780141439518"');
});

test('scan geometry stays inside the visible video at phone and desktop sizes', () => {
  for (const [width, height] of [[260, 195], [320, 240], [490, 368], [800, 200], [200, 800]]) {
    const box = scanBox(width, height);
    assert.ok(box.width > 0 && box.width <= width);
    assert.ok(box.height > 0 && box.height <= height);
    assert.equal(box.width, Math.floor(width * .9));
  }
});

test('default lens favors standard rear camera without guessing unknown IDs', () => {
  const camera = preferredCamera([{ label: 'Back Triple Camera', deviceId: 'triple' }, { label: 'Back Camera', deviceId: 'main' }, { label: 'Front Camera', deviceId: 'front' }]);
  assert.equal(camera.deviceId, 'main');
  assert.equal(preferredCamera([{ label: 'Back Ultra Wide Camera' }, { label: 'Front Camera' }]), undefined);
  assert.equal(preferredCamera([{ label: 'Camera 0' }, { label: 'Camera 1' }]), undefined);
});

test('scanner ignores invalid barcodes, debounces synchronously and resumes after cooldown', () => {
  const captures = [];
  const state = { suspended: false, busy: false, nextScanAt: 0, onScan: isbn => captures.push(isbn) };
  BookScanner.prototype.detect.call(state, '4006381333931');
  assert.equal(captures.length, 0);
  BookScanner.prototype.detect.call(state, '9780141439518');
  BookScanner.prototype.detect.call(state, '9780141439518');
  BookScanner.prototype.detect.call(state, '9791090636071');
  assert.deepEqual(captures, ['9780141439518']);
  state.nextScanAt = Date.now() - 1;
  BookScanner.prototype.detect.call(state, '9791090636071');
  assert.equal(captures.length, 2);
  state.suspended = true;
  state.nextScanAt = 0;
  BookScanner.prototype.detect.call(state, '9780141439518');
  assert.equal(captures.length, 2);
});

test('insert skips duplicates and applies defaults to a new record', async () => {
  const records = [];
  const db = {
    books: {
      where: key => ({ equals: value => ({ first: async () => records.find(record => record[key] === value) }) }),
      add: async record => { records.push({ ...record, id: records.length + 1 }); return records.length; }
    },
    transaction: async (mode, table, fn) => { assert.equal(mode, 'rw'); return fn(); }
  };
  const first = await insertBook(db, { isbn: '9780141439518', title: 'First' });
  const second = await insertBook(db, { isbn: '9780141439518', title: 'Duplicate' });
  assert.equal(first.duplicate, false);
  assert.equal(first.book.status, 'To Read');
  assert.equal(second.duplicate, true);
  assert.equal(second.book.title, 'First');
  assert.equal(records.length, 1);
});

test('all local HTML, manifest and service worker assets exist for subpath hosting', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const paths = [...html.matchAll(/(?:src|href)="\.\/([^"#]+)"/g)].map(match => match[1]);
  const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  paths.push(...manifest.icons.map(icon => icon.src));
  const worker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const localAssets = worker.match(/const LOCAL = (\[[^;]+\]);/)[1];
  paths.push(...vm.runInNewContext(localAssets));
  for (const path of paths) await access(new URL('../' + path, import.meta.url));
  assert.equal(manifest.scope, './');
  assert.equal(manifest.start_url, './');
});
