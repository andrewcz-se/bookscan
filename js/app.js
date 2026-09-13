import { normalizeIsbn } from './isbn.js';
import { lookupMetadata, safeCover, normalizeSubjects } from './metadata.js';
import { createDatabase, insertBook } from './db.js';
import { buildCsv, downloadFile } from './csv.js';
import { BookScanner } from './scanner.js';

const $ = id => document.getElementById(id);
let db, scanner, subscription;
let books = [], csvFile = null, editing = null, returnFocus = null;
let processing = false, saving = false, modalOpen = false;
let activeIsbn = '';
const queue = [], pending = new Set();

function updateLookupStatus() {
  $('lookup-status').hidden = !activeIsbn && !queue.length;
  $('lookup-status').textContent = `${activeIsbn ? `Finding details for ${activeIsbn}…` : 'Waiting to look up books.'}${queue.length ? ` ${queue.length} queued.` : ''}`;
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('toasts').append(element);
  while ($('toasts').childElementCount > 3) $('toasts').firstElementChild.remove();
  setTimeout(() => element.remove(), type === 'error' ? 8000 : 4500);
}

function storageError(error) {
  console.error('Bookscan storage error:', error);
  return /quota/i.test(error?.name) ? 'Device storage is full. Export a copy and free some space, then try again.' : 'Could not save or read this device’s catalog. Check browser storage settings and try again.';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function refreshExport() {
  // Precompute outside the click handler. iOS file sharing must begin inside the
  // original user gesture, without an IndexedDB await consuming its activation.
  csvFile = books.length ? new File([buildCsv(books)], `bookscan-${new Date().toISOString().slice(0, 10)}.csv`, { type: 'text/csv;charset=utf-8' }) : null;
  $('export').disabled = !csvFile;
}

function render() {
  $('total-count').textContent = `${books.length} ${books.length === 1 ? 'book' : 'books'}`;
  $('catalog-count').textContent = books.length;
  const query = $('search').value.trim().toLocaleLowerCase();
  const status = $('status-filter').value;
  const filtered = books.filter(book => (!status || book.status === status) &&
    [book.title, book.authors, book.location, ...normalizeSubjects(book.subjects)].some(value => String(value || '').toLocaleLowerCase().includes(query)));
  $('result-count').textContent = books.length ? `${filtered.length} ${filtered.length === 1 ? 'book' : 'books'}${query || status ? ` of ${books.length}` : ' in your catalog'}` : '';
  const fragment = document.createDocumentFragment();
  for (const book of filtered) {
    const card = element('article', 'book-card');
    card.id = `book-${book.id}`;
    const info = element('div', 'book-info');
    info.append(element('h3', '', book.title), element('p', 'book-author', book.authors || 'Unknown author'));
    const year = String(book.publish_date || '').match(/\b\d{4}\b/)?.[0] || book.publish_date;
    const summary = [year, book.number_of_pages ? `${book.number_of_pages} pages` : ''].filter(Boolean).join(' · ');
    if (summary) info.append(element('p', 'book-meta', summary));
    const tags = element('div', 'book-tags');
    tags.append(element('span', `pill ${book.status === 'Reading' ? 'reading' : book.status === 'Finished' ? 'finished' : ''}`, book.status));
    if (book.location) tags.append(element('span', 'pill location', book.location));
    const bottom = element('div', 'card-bottom');
    bottom.append(tags);
    if (book.rating) {
      const rating = element('span', 'card-rating', '★'.repeat(book.rating) + '☆'.repeat(5 - book.rating));
      rating.setAttribute('aria-label', `${book.rating} out of 5 stars`);
      bottom.append(rating);
    }
    const actions = element('div', 'card-actions');
    const edit = element('button', '', 'Edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', `Edit ${book.title}`);
    edit.addEventListener('click', event => { event.stopPropagation(); openModal(book); });
    const remove = element('button', '', 'Delete');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Delete ${book.title}`);
    remove.addEventListener('click', event => { event.stopPropagation(); deleteBook(book); });
    actions.append(edit, remove);
    bottom.append(actions);
    card.append(info, bottom);
    card.addEventListener('click', () => openModal(book));
    fragment.append(card);
  }
  $('book-grid').replaceChildren(fragment);
  $('empty-state').hidden = !!filtered.length;
  $('empty-state').querySelector('h3').textContent = books.length ? 'No books on this shelf… yet.' : 'Your next chapter starts here.';
  $('empty-state').querySelector('p').textContent = books.length ? 'Try a different search or reading status.' : 'Scan your first book or enter its ISBN above. A little order for the stories you love.';
  $('empty-add').textContent = books.length ? 'Clear filters' : 'Add your first book ↑';
}

function highlightBook(book) {
  $('search').value = '';
  $('status-filter').value = '';
  render();
  const card = $(`book-${book.id}`);
  if (!card) return;
  card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  card.classList.add('highlight');
  setTimeout(() => card.classList.remove('highlight'), 2500);
}

async function added(result) {
  // A direct refresh guarantees duplicate highlighting even before liveQuery fires.
  books = await db.books.orderBy('createdAt').reverse().toArray();
  refreshExport();
  render();
  if (result.duplicate) { toast('Book already in your catalog'); highlightBook(result.book); }
  else toast(`Added “${result.book.title}”`, 'success');
}

async function enqueue(value) {
  let isbn;
  try { isbn = normalizeIsbn(value); }
  catch (error) { toast(error.message, 'error'); return; }
  if (pending.has(isbn)) { toast('This ISBN is already being looked up.'); return; }
  if (pending.size >= 12) { toast('Let the current books finish before scanning another.'); return; }
  pending.add(isbn); // Reserve before the database await.
  try {
    const existing = await db.books.where('isbn').equals(isbn).first();
    if (existing) {
      pending.delete(isbn);
      await added({ book: existing, duplicate: true });
      return;
    }
    queue.push(isbn);
    updateLookupStatus();
    toast(`ISBN ${isbn} captured${processing || modalOpen ? ' — queued' : ' — looking up…'}`);
    $('isbn-input').value = '';
    void processQueue();
  } catch (error) { pending.delete(isbn); toast(storageError(error), 'error'); }
}

async function processQueue() {
  if (processing || modalOpen || !queue.length) return;
  processing = true;
  const isbn = queue.shift();
  activeIsbn = isbn;
  updateLookupStatus();
  try {
    const metadata = navigator.onLine ? await lookupMetadata(isbn) : null;
    // If the user began editing during the lookup, hold the result until closing
    // the modal instead of replacing their unsaved edits.
    if (modalOpen) await new Promise(resolve => document.addEventListener('bookscan:modalclosed', resolve, { once: true }));
    if (metadata) await added(await insertBook(db, { isbn, ...metadata }));
    else {
      // Another tab may have saved the ISBN while the waterfall was running.
      const existing = await db.books.where('isbn').equals(isbn).first();
      if (existing) await added({ book: existing, duplicate: true });
      else {
        openModal({ isbn, title: '', authors: '', status: 'To Read', source: 'Manual' });
        await new Promise(resolve => document.addEventListener('bookscan:modalclosed', resolve, { once: true }));
      }
    }
  } catch (error) { toast(storageError(error), 'error'); }
  finally {
    pending.delete(isbn);
    processing = false;
    activeIsbn = '';
    updateLookupStatus();
    void processQueue();
  }
}

function updateBookCover(book) {
  let cover = $('book-cover');
  // An older cached HTML document may load the newer app script. The optional
  // cover must not prevent the existing detail form from opening in that case.
  if (!cover) {
    cover = element('img', 'detail-cover');
    cover.id = 'book-cover';
    cover.width = 88;
    cover.height = 132;
    cover.decoding = 'async';
    cover.referrerPolicy = 'no-referrer';
    const description = $('modal-description');
    const summary = element('div', 'book-detail-summary');
    description.before(summary);
    summary.append(cover, description);
  }
  cover.hidden = !book.id && !book.cover;
  cover.alt = `Cover of ${book.title || 'this book'}`;
  cover.onerror = () => { cover.onerror = null; cover.src = './assets/book-placeholder.svg'; };
  if (!cover.hidden) cover.src = safeCover(book.cover) || './assets/book-placeholder.svg';
  else cover.removeAttribute('src');
}

function openModal(book) {
  if (modalOpen) return;
  $('modal-title').textContent = book.id ? 'A closer look' : 'Add book details';
  $('modal-eyebrow').textContent = book.id ? 'YOUR LIBRARY / EDIT BOOK' : 'ONE MORE DETAIL';
  $('modal-description').textContent = book.id ? `ISBN ${book.isbn} · ${book.source || 'Manual'}${book.source === 'Open Library Search' ? ' · Work-level details; edition may differ.' : ''}` : 'We couldn’t retrieve a match. Add a title and any details you know to save this book.';
  updateBookCover(book);
  const fields = { isbn: 'isbn', title: 'title', authors: 'authors', date: 'publish_date', publisher: 'publisher', pages: 'number_of_pages', description: 'description', binding: 'binding', edition: 'edition', status: 'status', location: 'location', notes: 'notes' };
  for (const [id, key] of Object.entries(fields)) $(`book-${id}`).value = book[key] ?? '';
  $('book-subjects').value = normalizeSubjects(book.subjects).join('\n');
  $('refresh-details').hidden = !book.id;
  $('refresh-details').disabled = false;
  $('metadata-details-status').textContent = '';
  $('book-status').value = book.status || 'To Read';
  document.querySelectorAll('[name="rating"]').forEach(input => { input.checked = Number(input.value) === book.rating; });
  updateStars();
  $('form-error').textContent = '';
  // Commit modal state only after populating the form. A setup error must not
  // leave an invisible modal blocking every subsequent card/Edit click.
  editing = { ...book };
  returnFocus = document.activeElement;
  scanner.suspend(true);
  modalOpen = true;
  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  // aria-hidden also supports Safari versions predating native inert/dialog.
  document.querySelector('main').setAttribute('aria-hidden', 'true');
  document.querySelector('header').setAttribute('aria-hidden', 'true');
  $('book-title').focus();
}

function closeModal() {
  if (!modalOpen || saving) return;
  modalOpen = false;
  editing = null;
  $('modal').hidden = true;
  const cover = $('book-cover');
  if (cover) { cover.onerror = null; cover.removeAttribute('src'); }
  document.body.style.overflow = '';
  document.querySelector('main').removeAttribute('aria-hidden');
  document.querySelector('header').removeAttribute('aria-hidden');
  scanner.suspend(false);
  if (returnFocus?.isConnected && returnFocus !== document.body) returnFocus.focus();
  else $('search').focus();
  document.dispatchEvent(new Event('bookscan:modalclosed'));
  void processQueue();
}

function updateStars() {
  const rating = Number(document.querySelector('[name="rating"]:checked')?.value || 0);
  document.querySelectorAll('#rating-stars label').forEach((label, index) => label.classList.toggle('filled', index < rating));
}

async function refreshDetails() {
  if (!editing || $('refresh-details').disabled) return;
  const target = editing;
  const fields = ['description', 'subjects', 'binding', 'edition'];
  const missing = fields.filter(key => !$(`book-${key}`).value.trim());
  if (!missing.length) {
    $('metadata-details-status').textContent = 'These details are already filled in.';
    return;
  }
  if (!navigator.onLine) {
    $('metadata-details-status').textContent = 'Connect to the internet to look up missing details.';
    return;
  }
  $('refresh-details').disabled = true;
  $('metadata-details-status').textContent = 'Looking up missing details…';
  try {
    const metadata = await lookupMetadata(target.isbn);
    // Closing, saving, or switching books invalidates this form's pending lookup.
    if (editing !== target) return;
    if (!metadata) {
      $('metadata-details-status').textContent = 'Could not retrieve details. Try again when the book services are available.';
      return;
    }
    let filled = 0;
    for (const key of missing) {
      const input = $(`book-${key}`);
      const value = key === 'subjects' ? normalizeSubjects(metadata.subjects).join('\n') : metadata[key];
      // Also preserve anything typed while the request was in flight.
      if (!input.value.trim() && value) { input.value = value; filled++; }
    }
    const remaining = fields.filter(key => !$(`book-${key}`).value.trim());
    $('metadata-details-status').textContent = filled
      ? `Filled ${filled} ${filled === 1 ? 'field' : 'fields'}. Save book to keep the changes.${remaining.length ? ` No data returned for: ${remaining.join(', ')}. You can enter these manually or retry later.` : ''}`
      : 'No additional details were filled in. The service may have no data or a detail request may have failed; you can enter details manually or retry later.';
  } catch {
    if (editing === target) $('metadata-details-status').textContent = 'The lookup failed. Your edits are preserved; try again later.';
  } finally {
    if (editing === target) $('refresh-details').disabled = false;
  }
}

async function saveBook(event) {
  event.preventDefault();
  if (saving || !editing) return;
  const title = $('book-title').value.trim();
  if (!title) { $('form-error').textContent = 'Please enter a title.'; $('book-title').focus(); return; }
  saving = true;
  $('save-book').disabled = true;
  $('form-error').textContent = '';
  const book = { ...editing, title, authors: $('book-authors').value.trim(), publish_date: $('book-date').value.trim(), publisher: $('book-publisher').value.trim(), number_of_pages: $('book-pages').value ? Number($('book-pages').value) : null, status: $('book-status').value, location: $('book-location').value.trim(), rating: Number(document.querySelector('[name="rating"]:checked')?.value) || null, notes: $('book-notes').value.trim(), updatedAt: new Date().toISOString() };
  book.description = $('book-description').value.trim();
  book.subjects = normalizeSubjects($('book-subjects').value);
  book.binding = $('book-binding').value.trim();
  book.edition = $('book-edition').value.trim();
  try {
    if (book.id) {
      // update() cannot resurrect a record another tab has just deleted.
      const count = await db.books.update(book.id, book);
      if (!count) throw new Error('This book was deleted in another tab. Close this window and scan it again.');
      toast('Book details saved', 'success');
    } else await added(await insertBook(db, book));
    saving = false;
    closeModal();
  } catch (error) { $('form-error').textContent = /deleted in another tab/.test(error.message) ? error.message : storageError(error); }
  finally { saving = false; $('save-book').disabled = false; }
}

async function deleteBook(book) {
  if (!window.confirm(`Delete “${book.title}” from your catalog? This cannot be undone.`)) return;
  try { await db.books.delete(book.id); toast('Book removed from your catalog.'); }
  catch (error) { toast(storageError(error), 'error'); }
}

async function exportCsv() {
  if (!csvFile) return;
  const file = csvFile;
  $('export').disabled = true;
  try {
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      try { await navigator.share({ files: [file] }); return; }
      catch (error) {
        if (error.name === 'AbortError') return; // Cancellation is intentional.
        toast('Sharing is unavailable. Downloading your CSV instead.');
      }
    }
    downloadFile(file);
    toast('CSV download started. On iPhone, find it in Files → Downloads.');
  } catch { toast('Export could not start. Please try again.', 'error'); }
  finally { $('export').disabled = !csvFile; }
}

function connectionStatus() {
  $('connection').textContent = navigator.onLine ? '● Saved on this device' : '● Offline · catalog available';
}

async function init() {
  scanner = new BookScanner({ onScan: enqueue, toast });
  $('isbn-form').addEventListener('submit', event => { event.preventDefault(); void enqueue($('isbn-input').value); });
  $('search').addEventListener('input', render);
  $('status-filter').addEventListener('change', render);
  $('export').addEventListener('click', exportCsv);
  $('book-form').addEventListener('submit', saveBook);
  $('refresh-details').addEventListener('click', refreshDetails);
  ['modal-close', 'modal-cancel'].forEach(id => $(id).addEventListener('click', closeModal));
  $('rating-stars').addEventListener('change', updateStars);
  $('clear-rating').addEventListener('click', () => { document.querySelectorAll('[name="rating"]').forEach(input => { input.checked = false; }); updateStars(); });
  $('empty-add').addEventListener('click', () => {
    if (books.length) { $('search').value = ''; $('status-filter').value = ''; render(); }
    else { $('manual-details').open = true; $('isbn-input').focus(); $('manual-details').scrollIntoView({ block: 'center' }); }
  });
  document.addEventListener('keydown', event => {
    if (!modalOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    if (event.key !== 'Tab') return;
    const focusable = [...$('modal').querySelectorAll('button:not(:disabled), input, select, textarea, [tabindex="0"]')];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  document.addEventListener('focusin', event => {
    if (modalOpen && !$('modal').contains(event.target)) $('modal-close').focus();
  });
  window.addEventListener('online', connectionStatus);
  window.addEventListener('offline', connectionStatus);
  connectionStatus();
  try {
    if (!window.Dexie) throw new Error('The database library did not load. Connect to the internet and reload.');
    db = createDatabase(window.Dexie);
    await db.open();
    books = await db.books.orderBy('createdAt').reverse().toArray();
    refreshExport();
    render();
    subscription = window.Dexie.liveQuery(() => db.books.orderBy('createdAt').reverse().toArray()).subscribe({
      next: data => { books = data; refreshExport(); render(); },
      error: error => { $('system-notice').textContent = storageError(error); $('system-notice').hidden = false; }
    });
    $('lookup-button').disabled = false;
    scanner.update();
  } catch (error) {
    $('system-notice').textContent = window.Dexie ? storageError(error) : error.message;
    $('system-notice').hidden = false;
    // Do not pretend to save in memory when durable storage is unavailable.
    scanner.buttons.forEach(button => { button.disabled = true; });
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try { await navigator.serviceWorker.register('./sw.js'); }
    catch { toast('Offline setup is unavailable. Keep this page online while using it.'); }
  }
}

// Deferred CDN scripts have completed by DOMContentLoaded; ES modules can execute
// before them, so do not assume Dexie exists at module evaluation time.
if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', init, { once: true });
else void init();
