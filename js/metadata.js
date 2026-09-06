import { normalizeIsbn, toIsbn10 } from './isbn.js';

const names = (items) => Array.isArray(items) ? items.map(x => typeof x === 'string' ? x : x?.name).filter(Boolean).join(', ') : '';
const str = (value) => value == null ? '' : String(value);
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
        return book && { title: book.title, authors: names(book.authors), publish_date: str(book.publish_date), publisher: names(book.publishers?.slice(0, 1)), number_of_pages: pages(book.number_of_pages), cover: safeCover(book.cover?.medium || book.cover?.large) };
      }
    },
    {
      name: 'Open Library Search',
      url: `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&fields=key,title,author_name,first_publish_year,publish_year,publisher,number_of_pages_median,cover_i`,
      parse: data => {
        const book = data?.docs?.[0];
        return book && { title: book.title, authors: names(book.author_name), publish_date: str(book.publish_year?.[0] || book.first_publish_year), publisher: book.publisher?.[0] || 'Unknown', number_of_pages: pages(book.number_of_pages_median), cover: book.cover_i ? safeCover(`https://covers.openlibrary.org/b/id/${encodeURIComponent(book.cover_i)}-M.jpg`) : null };
      }
    },
    {
      name: 'Google Books',
      url: `https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`,
      parse: data => {
        const book = data?.items?.[0]?.volumeInfo;
        return book && { title: book.title, authors: names(book.authors), publish_date: str(book.publishedDate), publisher: str(book.publisher), number_of_pages: pages(book.pageCount), cover: safeCover(book.imageLinks?.thumbnail) };
      }
    }
  ];
  for (const tier of tiers) {
    onTier(tier.name);
    try {
      const result = tier.parse(await json(tier.url, fetcher, timeoutMs));
      if (typeof result?.title === 'string' && result.title.trim()) return { ...result, title: result.title.trim(), source: tier.name };
    } catch { /* Network errors, malformed JSON, and rate limits all use the next tier. */ }
  }
  return null;
}
