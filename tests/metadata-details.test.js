import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupMetadata, descriptionText, normalizeSubjects } from '../js/metadata.js';
import { buildCsv } from '../js/csv.js';
import { insertBook } from '../js/db.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const isbn = '9780141439518';
function responses(items) {
  const calls = [];
  return { calls, fetcher: async url => {
    calls.push(url);
    const item = items.shift();
    if (item instanceof Error) throw item;
    return { ok: true, json: async () => item };
  } };
}

test('Troubles ISBN 9780006540465 gets subjects from Books and its description from the linked work', async () => {
  // Relevant fields from the public Open Library records, checked 2026-09-13.
  // The ISBN route points to a different catalog edition; follow the Books key.
  const troubleIsbn = '9780006540465';
  const mock = responses([
    { [`ISBN:${troubleIsbn}`]: { key: '/books/OL18522379M', title: 'Troubles', authors: [{ name: 'James Gordon Farrell' }], publish_date: '1984', publishers: [{ name: 'Fontana' }], number_of_pages: 445, subjects: [{ name: 'World War, 1914-1918' }, { name: 'Fiction' }, { name: 'Hotels' }] } },
    { key: '/books/OL18522379M', title: 'Troubles', works: [{ key: '/works/OL2694533W' }] },
    { key: '/works/OL2694533W', description: { type: '/type/text', value: '1919: After surviving the Great War, Major Brendan Archer makes his way to Ireland.' } }
  ]);
  const book = await lookupMetadata(troubleIsbn, mock);
  assert.equal(mock.calls[1], 'https://openlibrary.org/books/OL18522379M.json');
  assert.equal(mock.calls[2], 'https://openlibrary.org/works/OL2694533W.json');
  assert.equal(book.title, 'Troubles');
  assert.equal(book.publisher, 'Fontana');
  assert.equal(book.number_of_pages, 445);
  assert.deepEqual(book.subjects, ['World War, 1914-1918', 'Fiction', 'Hotels']);
  assert.match(book.description, /Major Brendan Archer/);
  assert.equal(book.binding, '');
  assert.equal(book.edition, '');
});

test('Open Library preserves subjects and fetches binding and edition from the matching edition', async () => {
  const mock = responses([
    { [`ISBN:${isbn}`]: { title: 'Book', key: '/books/OL123M', subjects: [{ name: 'Fiction' }, { name: 'History, Modern' }] } },
    { description: { value: 'An edition summary.' }, physical_format: 'Paperback', edition_name: '2nd revised edition', works: [{ key: '/works/OL456W' }] }
  ]);
  const book = await lookupMetadata(isbn, mock);
  assert.equal(mock.calls[1], 'https://openlibrary.org/books/OL123M.json');
  assert.equal(mock.calls.length, 2);
  assert.equal(book.description, 'An edition summary.');
  assert.deepEqual(book.subjects, ['Fiction', 'History, Modern']);
  assert.equal(book.binding, 'Paperback');
  assert.equal(book.edition, '2nd revised edition');
  assert.equal('editionKey' in book, false);
});

test('missing edition summary and subjects are filled from its linked work only', async () => {
  const mock = responses([
    { [`ISBN:${isbn}`]: { title: 'Book' } },
    { physical_format: 'Hardcover', edition_name: 'First edition', works: [{ key: '/works/OL456W' }] },
    { description: 'Work summary', subjects: ['Fiction', 'Fiction', '  Classics '], physical_format: 'Wrong binding', edition_name: 'Wrong edition' }
  ]);
  const book = await lookupMetadata(isbn, mock);
  assert.equal(mock.calls[1], `https://openlibrary.org/isbn/${isbn}.json`);
  assert.equal(mock.calls[2], 'https://openlibrary.org/works/OL456W.json');
  assert.equal(book.description, 'Work summary');
  assert.deepEqual(book.subjects, ['Fiction', 'Classics']);
  assert.equal(book.binding, 'Hardcover');
  assert.equal(book.edition, 'First edition');
});

test('Search can fill a work description even if the ISBN edition lookup fails', async () => {
  const mock = responses([{}, { docs: [{ title: 'Search result', key: '/works/OL456W', subject: ['Fiction'], physical_format: ['Hardcover', 'Paperback'] }] }, new Error('Unavailable'), { description: { value: 'Work summary' } }]);
  const book = await lookupMetadata(isbn, mock);
  assert.match(mock.calls[1], /,subject/);
  assert.equal(book.source, 'Open Library Search');
  assert.equal(book.description, 'Work summary');
  assert.deepEqual(book.subjects, ['Fiction']);
  assert.equal(book.binding, '');
  assert.equal(book.edition, '');
  assert.equal('workKey' in book, false);
});

test('optional detail timeouts keep the initial match and do not trigger Google fallback', async () => {
  let calls = 0, aborted = false;
  const book = await lookupMetadata(isbn, { timeoutMs: 10, fetcher: (url, { signal }) => {
    if (++calls === 1) return Promise.resolve({ ok: true, json: async () => ({ [`ISBN:${isbn}`]: { title: 'Saved despite timeout', subjects: [{ name: 'Fiction' }] } }) });
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('Timeout')); }));
  } });
  assert.equal(aborted, true);
  assert.equal(calls, 2);
  assert.equal(book.title, 'Saved despite timeout');
  assert.deepEqual(book.subjects, ['Fiction']);
  assert.equal(book.description, '');
});

test('malformed detail values and unsafe linked work paths leave optional fields empty', async () => {
  const mock = responses([{ [`ISBN:${isbn}`]: { title: 'Book', subjects: [null, 9, {}], key: 'https://example.org/private' } }, { description: { value: {} }, physical_format: {}, edition_name: [], works: [{ key: '//example.org/works/OL456W' }] }]);
  const book = await lookupMetadata(isbn, mock);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1], `https://openlibrary.org/isbn/${isbn}.json`);
  assert.equal(book.description, '');
  assert.deepEqual(book.subjects, []);
  assert.equal(book.binding, '');
  assert.equal(book.edition, '');
});

test('Google categories and HTML summaries are saved without treating printType as binding', async () => {
  const mock = responses([{}, {}, { items: [{ volumeInfo: { title: 'Google book', description: '<p>A <b>story</b> &amp; more.</p><p>Second line.</p>', categories: ['Fiction', 'Classics'], printType: 'BOOK' } }] }]);
  const book = await lookupMetadata(isbn, mock);
  assert.equal(mock.calls.length, 3);
  assert.equal(book.description, 'A story & more.\nSecond line.');
  assert.deepEqual(book.subjects, ['Fiction', 'Classics']);
  assert.equal(book.binding, '');
  assert.equal(book.edition, '');
});

test('description conversion handles text objects, HTML entities and invalid numeric entities', () => {
  assert.equal(descriptionText({ value: 'Résumé\nAnother line' }), 'Résumé\nAnother line');
  assert.equal(descriptionText('<script>alert(1)</script><style>p{}</style>Hi<br>It&#39;s &#x1F4DA; &quot;good&quot;'), 'Hi\nIt\'s 📚 "good"');
  assert.equal(descriptionText('&#99999999;'), '&#99999999;');
  assert.equal(descriptionText(null), '');
  assert.deepEqual(normalizeSubjects(' History, Modern\nFiction\n\nFiction '), ['History, Modern', 'Fiction']);
});

test('additional fields survive insertion and export, including multiline subjects and old books', async () => {
  const db = { books: { where: () => ({ equals: () => ({ first: async () => null }) }), add: async () => 1 }, transaction: async (mode, table, callback) => callback() };
  const { book } = await insertBook(db, { isbn, title: 'Book', description: 'Résumé, "quoted"\nLine 2', subjects: ['History, Modern', 'Fiction'], binding: 'Paperback', edition: '2nd edition' });
  const csv = buildCsv([book, { isbn: '9791090636071', title: 'Old book' }]);
  assert.ok(csv.includes('"Description","Subjects","Binding","Edition"'));
  assert.ok(csv.includes('"Résumé, ""quoted""\nLine 2","History, Modern\nFiction","Paperback","2nd edition"'));
  assert.ok(csv.includes('"Old book"'));
  const { book: manual } = await insertBook(db, { isbn, title: 'Manual' });
  assert.equal(manual.description, '');
  assert.deepEqual(manual.subjects, []);
  assert.equal(manual.binding, '');
  assert.equal(manual.edition, '');
});

test('editor opens old records, saves new details, reopens them, and allows clearing', async () => {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, focus() {}, setAttribute() {}, removeAttribute() {}, append() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const document = { getElementById: get, readyState: 'loading', addEventListener() {}, dispatchEvent() {}, activeElement: null, body: get('body'), querySelector: selector => selector.includes('rating') ? null : get(selector), querySelectorAll: () => [], createElement: () => get('toast') };
  let stored = { id: 1, isbn, title: 'Existing book', notes: 'Keep my notes' };
  const context = vm.createContext({ document, normalizeSubjects, Event, console, setTimeout: () => 0 });
  const source = (await readFile(new URL('../js/app.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  vm.runInContext(source, context);
  context.testDb = { books: { update: async (id, book) => { stored = structuredClone(book); return 1; } } };
  vm.runInContext('db = testDb; scanner = { suspend() {} };', context);
  context.savedBook = stored;
  vm.runInContext('openModal(savedBook)', context);
  for (const key of ['description', 'subjects', 'binding', 'edition']) assert.equal(get(`book-${key}`).value, '');
  get('book-description').value = 'A summary\nWith two lines';
  get('book-subjects').value = 'History, Modern\nFiction';
  get('book-binding').value = 'Paperback';
  get('book-edition').value = 'Second edition';
  await vm.runInContext('saveBook({ preventDefault() {} })', context);
  assert.equal(stored.description, 'A summary\nWith two lines');
  assert.deepEqual(stored.subjects, ['History, Modern', 'Fiction']);
  assert.equal(stored.binding, 'Paperback');
  assert.equal(stored.edition, 'Second edition');
  assert.equal(stored.notes, 'Keep my notes');
  context.savedBook = stored;
  vm.runInContext('openModal(savedBook)', context);
  assert.equal(get('book-subjects').value, 'History, Modern\nFiction');
  assert.equal(get('book-binding').value, 'Paperback');
  for (const key of ['description', 'subjects', 'binding', 'edition']) get(`book-${key}`).value = '';
  await vm.runInContext('saveBook({ preventDefault() {} })', context);
  assert.equal(stored.description, '');
  assert.deepEqual(stored.subjects, []);
  assert.equal(stored.binding, '');
  assert.equal(stored.edition, '');
});
