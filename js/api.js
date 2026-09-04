/**
 * BookScan Metadata API Service
 * Dual-provider fetcher: Open Library (Primary) -> Google Books (Fallback)
 * Enhanced with Search API parity and ISBN-10/ISBN-13 variant resolution
 */

import { normalizeIsbn, getIsbnVariants } from './db.js';

/**
 * Fetch with timeout using AbortController
 * @param {string} url 
 * @param {number} timeoutMs 
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/**
 * Ensures any image URL uses HTTPS to prevent mixed-content blocks
 * @param {string} url 
 * @returns {string}
 */
function upgradeToHttps(url) {
  if (!url) return '';
  if (url.startsWith('http://')) {
    return 'https://' + url.slice(7);
  }
  return url;
}

/**
 * Fetches book metadata from Open Library API
 * Matches openlibrary.org website search using Search API and enriches with Books API
 * @param {string} isbn 
 * @returns {Promise<Object|null>}
 */
async function fetchOpenLibrary(isbn) {
  const cleanIsbn = normalizeIsbn(isbn);
  if (!cleanIsbn) return null;
  const variants = getIsbnVariants(cleanIsbn);

  // 1. Open Library Search API (Matches manual search on openlibrary.org website 1:1)
  let searchResult = null;
  try {
    const searchUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanIsbn)}`;
    const searchRes = await fetchWithTimeout(searchUrl, 8000);
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      if (searchData.numFound > 0 && searchData.docs && searchData.docs.length > 0) {
        const doc = searchData.docs[0];
        const authors = Array.isArray(doc.author_name) ? doc.author_name : [];
        const titleStr = doc.title + (doc.subtitle ? `: ${doc.subtitle}` : '');
        const publisherStr = Array.isArray(doc.publisher) ? doc.publisher[0] : (doc.publisher || '');
        const yearStr = doc.first_publish_year 
          ? String(doc.first_publish_year) 
          : (Array.isArray(doc.publish_date) ? doc.publish_date[0] : '');
        
        let coverUrl = '';
        if (doc.cover_i) {
          coverUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
        } else if (doc.cover_edition_key) {
          coverUrl = `https://covers.openlibrary.org/b/olid/${doc.cover_edition_key}-L.jpg`;
        }

        searchResult = {
          isbn: cleanIsbn,
          title: titleStr.trim(),
          authors,
          author: authors.join(', ') || 'Unknown Author',
          publisher: publisherStr,
          publishDate: yearStr,
          pages: doc.number_of_pages_median || null,
          coverUrl: upgradeToHttps(coverUrl),
          source: 'Open Library'
        };
      }
    }
  } catch (err) {
    console.warn(`[Open Library Search API] ${cleanIsbn}:`, err.message);
  }

  // 2. Query Open Library Books API with each variant to get rich publisher/page details if available
  try {
    for (const v of variants) {
      const booksUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${v}&format=json&jscmd=data`;
      const booksRes = await fetchWithTimeout(booksUrl, 6000);
      if (booksRes.ok) {
        const booksData = await booksRes.json();
        const b = booksData[`ISBN:${v}`];
        if (b && b.title) {
          const authors = Array.isArray(b.authors) ? b.authors.map(a => a.name).filter(Boolean) : [];
          const publishers = Array.isArray(b.publishers) ? b.publishers.map(p => p.name).filter(Boolean) : [];
          let coverUrl = '';
          if (b.cover) {
            coverUrl = b.cover.large || b.cover.medium || b.cover.small || '';
          }

          return {
            isbn: cleanIsbn,
            title: b.title.trim() || (searchResult ? searchResult.title : ''),
            authors: authors.length ? authors : (searchResult ? searchResult.authors : []),
            author: (authors.length ? authors.join(', ') : '') || (searchResult ? searchResult.author : 'Unknown Author'),
            publisher: publishers.join(', ') || (searchResult ? searchResult.publisher : ''),
            publishDate: b.publish_date || (searchResult ? searchResult.publishDate : ''),
            pages: b.number_of_pages || (searchResult ? searchResult.pages : null),
            coverUrl: upgradeToHttps(coverUrl) || (searchResult ? searchResult.coverUrl : ''),
            source: 'Open Library'
          };
        }
      }
    }
  } catch (err) {
    console.warn(`[Open Library Books API] ${cleanIsbn}:`, err.message);
  }

  // If Books API had no match or failed, return the Search API result
  if (searchResult) {
    return searchResult;
  }

  return null;
}

/**
 * Fetches book metadata from Google Books API
 * Tests all ISBN variants (ISBN-13 and ISBN-10)
 * @param {string} isbn 
 * @returns {Promise<Object|null>}
 */
async function fetchGoogleBooks(isbn) {
  const variants = getIsbnVariants(isbn);

  for (const code of variants) {
    const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${code}`;
    try {
      const response = await fetchWithTimeout(url, 6000);
      if (!response.ok) continue;

      const data = await response.json();
      if (!data.items || data.items.length === 0) continue;

      const volumeInfo = data.items[0].volumeInfo;
      if (!volumeInfo || !volumeInfo.title) continue;

      const authors = Array.isArray(volumeInfo.authors)
        ? volumeInfo.authors.filter(Boolean)
        : [];

      let coverUrl = '';
      if (volumeInfo.imageLinks) {
        coverUrl = volumeInfo.imageLinks.thumbnail || 
                   volumeInfo.imageLinks.smallThumbnail || 
                   volumeInfo.imageLinks.medium || 
                   volumeInfo.imageLinks.large || '';
      }

      return {
        isbn,
        title: volumeInfo.title.trim(),
        authors,
        author: authors.join(', ') || 'Unknown Author',
        publisher: volumeInfo.publisher || '',
        publishDate: volumeInfo.publishedDate || '',
        pages: volumeInfo.pageCount || null,
        coverUrl: upgradeToHttps(coverUrl),
        source: 'Google Books'
      };
    } catch (err) {
      console.warn(`[Google Books] Failed for ISBN ${code}:`, err.message);
    }
  }

  return null;
}

/**
 * Main lookup function implementing Dual-Provider Fallback
 * 1. Open Library (Search API parity + Books API with ISBN-10/13 variants)
 * 2. Google Books (with ISBN-10/13 variants)
 * 3. Fallback skeleton for manual entry
 * 
 * @param {string} rawIsbn 
 * @returns {Promise<{found: boolean, book: Object, provider: string}>}
 */
export async function lookupIsbn(rawIsbn) {
  const isbn = normalizeIsbn(rawIsbn);
  if (!isbn) {
    throw new Error('Please enter a valid ISBN code.');
  }

  // 1. Primary: Open Library
  const olResult = await fetchOpenLibrary(isbn);
  if (olResult) {
    return {
      found: true,
      book: olResult,
      provider: 'Open Library'
    };
  }

  // 2. Fallback: Google Books
  const gbResult = await fetchGoogleBooks(isbn);
  if (gbResult) {
    return {
      found: true,
      book: gbResult,
      provider: 'Google Books'
    };
  }

  // 3. No match found on either provider
  return {
    found: false,
    book: {
      isbn,
      title: '',
      authors: [],
      author: '',
      publisher: '',
      publishDate: '',
      pages: null,
      coverUrl: '',
      status: 'Unread',
      location: '',
      rating: 0,
      notes: ''
    },
    provider: 'None'
  };
}
