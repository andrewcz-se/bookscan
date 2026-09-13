import { normalizeIsbn, toIsbn10 } from './isbn.js';

const names = (items) => Array.isArray(items) ? items.map(x => typeof x === 'string' ? x : x?.name).filter(Boolean).join(', ') : '';
const str = (value) => value == null ? '' : String(value);
const text = value => typeof value === 'string' ? value.trim() : '';

export function normalizeSubjects(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  return [...new Set(items.map(item => text(typeof item === 'string' ? item : item?.name)).filter(Boolean))];
}

// Providers may return plain text, an Open Library text object, or Google HTML.
// Store plain text only; the editor always displays this through .value.
export function descriptionText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…' };
  return text(typeof value === 'string' ? value : value?.value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (!entity.startsWith('#')) return entities[entity] ?? match;
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    }).replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function safeCover(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.protocol = 'https:';
    return url.href;
  } catch { return null; }
}
const pages = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

async function json(url, fetcher, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function enrichOpenLibrary(result, isbn, fetcher, timeoutMs) {
  const { workKey, editionKey, ...book } = result;
  let linkedWork = workKey;
  try {
    // Fetch the scanned edition, never a random edition from a work search.
    const path = /^\/books\/OL\d+M$/.test(editionKey) ? editionKey : `/isbn/${isbn}`;
    const edition = await json(`https://openlibrary.org${path}.json`, fetcher, timeoutMs);
    book.description ||= descriptionText(edition?.description);
    if (!book.subjects.length) book.subjects = normalizeSubjects(edition?.subjects);
    book.binding = text(edition?.physical_format);
    book.edition = text(edition?.edition_name);
    linkedWork = edition?.works?.[0]?.key || linkedWork;
  } catch { /* Extra details must not discard an otherwise usable match. */ }
  if ((!book.description || !book.subjects.length) && /^\/works\/OL\d+W$/.test(linkedWork)) {
    try {
      const work = await json(`https://openlibrary.org${linkedWork}.json`, fetcher, timeoutMs);
      book.description ||= descriptionText(work?.description);
      if (!book.subjects.length) book.subjects = normalizeSubjects(work?.subjects);
    } catch { /* Keep the edition and any details already available. */ }
  }
  return book;
}

/** Each tier owns its timeout; a miss, bad response, or timeout advances once. */
export async function lookupMetadata(value, { fetcher = globalThis.fetch, timeoutMs = 6500, onTier = () => {} } = {}) {
  const isbn = normalizeIsbn(value);
  const isbn10 = toIsbn10(isbn);
  const keys = [`ISBN:${isbn}`, ...(isbn10 ? [`ISBN:${isbn10}`] : [])];
  const tiers = [
    {
      name: 'Open Library Books',
      url: `https://openlibrary.org/api/books?bibkeys=${keys.join(',')}&format=json&jscmd=data`,
      parse: data => {
        const book = keys.map(k => data?.[k]).find(b => typeof b?.title === 'string' && b.title.trim());
        return book && { title: book.title, authors: names(book.authors), publish_date: str(book.publish_date), publisher: names(book.publishers?.slice(0, 1)), number_of_pages: pages(book.number_of_pages), cover: safeCover(book.cover?.medium || book.cover?.large), description: descriptionText(book.description), subjects: normalizeSubjects(book.subjects), binding: '', edition: '', editionKey: book.key };
      }
    },
    {
      name: 'Open Library Search',
      url: `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&fields=key,title,author_name,first_publish_year,publish_year,publisher,number_of_pages_median,cover_i,subject`,
      parse: data => {
        const book = data?.docs?.[0];
        return book && { title: book.title, authors: names(book.author_name), publish_date: str(book.publish_year?.[0] || book.first_publish_year), publisher: book.publisher?.[0] || 'Unknown', number_of_pages: pages(book.number_of_pages_median), cover: book.cover_i ? safeCover(`https://covers.openlibrary.org/b/id/${encodeURIComponent(book.cover_i)}-M.jpg`) : null, description: '', subjects: normalizeSubjects(book.subject), binding: '', edition: '', workKey: book.key };
      }
    },
    {
      name: 'Google Books',
      url: `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`,
      parse: data => {
        const book = data?.items?.[0]?.volumeInfo;
        return book && { title: book.title, authors: names(book.authors), publish_date: str(book.publishedDate), publisher: str(book.publisher), number_of_pages: pages(book.pageCount), cover: safeCover(book.imageLinks?.thumbnail), description: descriptionText(book.description), subjects: normalizeSubjects(book.categories), binding: '', edition: '' };
      }
    }
  ];
  for (const tier of tiers) {
    onTier(tier.name);
    try {
      const result = tier.parse(await json(tier.url, fetcher, timeoutMs));
      if (typeof result?.title === 'string' && result.title.trim()) {
        const book = tier.name.startsWith('Open Library') ? await enrichOpenLibrary(result, isbn, fetcher, timeoutMs) : result;
        return { ...book, title: result.title.trim(), source: tier.name };
      }
    } catch { /* Network errors, malformed JSON, and rate limits all use the next tier. */ }
  }
  return null;
}
