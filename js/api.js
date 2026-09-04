/**
 * BookScan Metadata API Service
 * Dual-provider fetcher: Open Library (Primary) -> Google Books (Fallback)
 */

import { normalizeIsbn } from './db.js';

/**
 * Fetch with timeout using AbortController
 * @param {string} url 
 * @param {number} timeoutMs 
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, timeoutMs = 7000) {
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
 * @param {string} isbn 
 * @returns {Promise<Object|null>}
 */
async function fetchOpenLibrary(isbn) {
  const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
  try {
    const response = await fetchWithTimeout(url, 6000);
    if (!response.ok) return null;

    const data = await response.json();
    const key = `ISBN:${isbn}`;
    const bookData = data[key];

    if (!bookData || !bookData.title) {
      return null;
    }

    // Extract Authors
    const authors = Array.isArray(bookData.authors)
      ? bookData.authors.map(a => a.name).filter(Boolean)
      : [];

    // Extract Publishers
    const publishers = Array.isArray(bookData.publishers)
      ? bookData.publishers.map(p => p.name).filter(Boolean)
      : [];

    // Extract Cover
    let coverUrl = '';
    if (bookData.cover) {
      coverUrl = bookData.cover.large || bookData.cover.medium || bookData.cover.small || '';
    }

    return {
      isbn,
      title: bookData.title.trim(),
      authors,
      author: authors.join(', ') || 'Unknown Author',
      publisher: publishers.join(', '),
      publishDate: bookData.publish_date || '',
      pages: bookData.number_of_pages || null,
      coverUrl: upgradeToHttps(coverUrl),
      source: 'Open Library'
    };
  } catch (err) {
    console.warn(`[Open Library] Failed for ISBN ${isbn}:`, err.message);
    return null;
  }
}

/**
 * Fetches book metadata from Google Books API
 * @param {string} isbn 
 * @returns {Promise<Object|null>}
 */
async function fetchGoogleBooks(isbn) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
  try {
    const response = await fetchWithTimeout(url, 6000);
    if (!response.ok) return null;

    const data = await response.json();
    if (!data.items || data.items.length === 0) {
      return null;
    }

    const volumeInfo = data.items[0].volumeInfo;
    if (!volumeInfo || !volumeInfo.title) {
      return null;
    }

    // Extract Authors
    const authors = Array.isArray(volumeInfo.authors)
      ? volumeInfo.authors.filter(Boolean)
      : [];

    // Extract Cover
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
    console.warn(`[Google Books] Failed for ISBN ${isbn}:`, err.message);
    return null;
  }
}

/**
 * Main lookup function implementing Dual-Provider Fallback
 * 1. Open Library
 * 2. Google Books
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
