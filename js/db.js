/**
 * BookScan Database Service
 * Powered by Dexie.js (IndexedDB wrapper)
 */

// Initialize Dexie Database safely (browser or test environment)
let db = null;
if (typeof Dexie !== 'undefined') {
  db = new Dexie('BookCatalogDB');
  db.version(1).stores({
    books: '++id, isbn, title, author, status, rating, location, createdAt, updatedAt'
  });
}

/**
 * Normalizes an ISBN string (removes hyphens, spaces, uppercase X)
 * @param {string} isbn 
 * @returns {string}
 */
export function normalizeIsbn(isbn) {
  if (!isbn) return '';
  return isbn.toString().replace(/[-\s]/g, '').trim().toUpperCase();
}

/**
 * Adds a new book or increments copy count if already indexed
 * @param {Object} bookData 
 * @returns {Promise<{isDuplicate: boolean, book: Object}>}
 */
export async function addOrIncrementBook(bookData) {
  const cleanIsbn = normalizeIsbn(bookData.isbn);
  
  if (cleanIsbn) {
    const existing = await db.books.where('isbn').equals(cleanIsbn).first();
    if (existing) {
      const updatedCopies = (existing.copiesCount || 1) + 1;
      const now = new Date().toISOString();
      await db.books.update(existing.id, {
        copiesCount: updatedCopies,
        updatedAt: now
      });
      const updated = await db.books.get(existing.id);
      return { isDuplicate: true, book: updated };
    }
  }

  const now = new Date().toISOString();
  const authorStr = Array.isArray(bookData.authors) 
    ? bookData.authors.join(', ') 
    : (bookData.author || bookData.authors || 'Unknown Author');

  const newBook = {
    isbn: cleanIsbn || '',
    title: bookData.title?.trim() || 'Untitled Book',
    author: authorStr,
    authors: Array.isArray(bookData.authors) ? bookData.authors : (authorStr ? [authorStr] : []),
    publisher: bookData.publisher || '',
    publishDate: bookData.publishDate || '',
    pages: bookData.pages || null,
    coverUrl: bookData.coverUrl || '',
    status: bookData.status || 'Unread', // Unread, Reading, Finished
    location: bookData.location || '',
    rating: Number(bookData.rating) || 0, // 0 to 5
    notes: bookData.notes || '',
    copiesCount: 1,
    createdAt: now,
    updatedAt: now
  };

  const id = await db.books.add(newBook);
  const created = await db.books.get(id);
  return { isDuplicate: false, book: created };
}

/**
 * Updates metadata for a book by ID
 * @param {number} id 
 * @param {Object} updates 
 * @returns {Promise<Object>}
 */
export async function updateBook(id, updates) {
  const data = {
    ...updates,
    updatedAt: new Date().toISOString()
  };

  if (data.authors && !data.author) {
    data.author = Array.isArray(data.authors) ? data.authors.join(', ') : data.authors;
  } else if (data.author && !data.authors) {
    data.authors = [data.author];
  }

  if (data.isbn) {
    data.isbn = normalizeIsbn(data.isbn);
  }

  await db.books.update(id, data);
  return await db.books.get(id);
}

/**
 * Deletes a book from Dexie
 * @param {number} id 
 * @returns {Promise<void>}
 */
export async function deleteBook(id) {
  return await db.books.delete(id);
}

/**
 * Retrieves a single book by ID
 * @param {number} id 
 * @returns {Promise<Object|undefined>}
 */
export async function getBook(id) {
  return await db.books.get(id);
}

/**
 * Retrieves a book by ISBN
 * @param {string} isbn 
 * @returns {Promise<Object|undefined>}
 */
export async function getBookByIsbn(isbn) {
  const clean = normalizeIsbn(isbn);
  if (!clean) return undefined;
  return await db.books.where('isbn').equals(clean).first();
}

/**
 * Fetches all books filtered and sorted
 * @param {Object} options
 * @param {string} [options.status='all'] - 'all' | 'unread' | 'reading' | 'finished'
 * @param {string} [options.search=''] - query text
 * @param {string} [options.sortBy='created_desc'] - 'created_desc' | 'created_asc' | 'title_asc' | 'rating_desc' | 'author_asc'
 * @returns {Promise<Array<Object>>}
 */
export async function getBooks({ status = 'all', search = '', sortBy = 'created_desc' } = {}) {
  let collection = db.books.toCollection();

  let results = await collection.toArray();

  // Apply Status Filter
  if (status && status.toLowerCase() !== 'all') {
    results = results.filter(b => (b.status || 'Unread').toLowerCase() === status.toLowerCase());
  }

  // Apply Search Filter (Title, Author, ISBN, Location, Notes)
  if (search && search.trim() !== '') {
    const q = search.trim().toLowerCase();
    results = results.filter(b => {
      const matchTitle = (b.title || '').toLowerCase().includes(q);
      const matchAuthor = (b.author || '').toLowerCase().includes(q);
      const matchIsbn = (b.isbn || '').toLowerCase().includes(q);
      const matchLocation = (b.location || '').toLowerCase().includes(q);
      const matchNotes = (b.notes || '').toLowerCase().includes(q);
      return matchTitle || matchAuthor || matchIsbn || matchLocation || matchNotes;
    });
  }

  // Apply Sorting
  results.sort((a, b) => {
    switch (sortBy) {
      case 'created_asc':
        return new Date(a.createdAt) - new Date(b.createdAt);
      case 'title_asc':
        return (a.title || '').localeCompare(b.title || '');
      case 'rating_desc':
        return (b.rating || 0) - (a.rating || 0);
      case 'author_asc':
        return (a.author || '').localeCompare(b.author || '');
      case 'created_desc':
      default:
        return new Date(b.createdAt) - new Date(a.createdAt);
    }
  });

  return results;
}

/**
 * Returns overall statistics for the catalog
 * @returns {Promise<{totalBooks: number, totalCopies: number, unread: number, reading: number, finished: number}>}
 */
export async function getCatalogStats() {
  const allBooks = await db.books.toArray();
  const totalBooks = allBooks.length;
  let totalCopies = 0;
  let unread = 0;
  let reading = 0;
  let finished = 0;

  for (const b of allBooks) {
    totalCopies += (b.copiesCount || 1);
    const s = (b.status || 'Unread').toLowerCase();
    if (s === 'finished') finished++;
    else if (s === 'reading') reading++;
    else unread++;
  }

  return { totalBooks, totalCopies, unread, reading, finished };
}

/**
 * Bulk import books (used for JSON restore)
 * @param {Array<Object>} booksList 
 * @param {boolean} replaceExisting 
 * @returns {Promise<{imported: number}>}
 */
export async function importBooks(booksList, replaceExisting = false) {
  if (!Array.isArray(booksList)) {
    throw new Error('Invalid catalog data format: Expected an array of books.');
  }

  if (replaceExisting) {
    await db.books.clear();
  }

  let count = 0;
  for (const item of booksList) {
    if (!item.title && !item.isbn) continue;
    
    // Clean and validate fields
    const cleanIsbn = normalizeIsbn(item.isbn);
    const now = new Date().toISOString();
    
    // Check if exists
    if (!replaceExisting && cleanIsbn) {
      const existing = await db.books.where('isbn').equals(cleanIsbn).first();
      if (existing) {
        await db.books.update(existing.id, {
          copiesCount: (existing.copiesCount || 1) + (item.copiesCount || 1),
          updatedAt: now
        });
        count++;
        continue;
      }
    }

    const bookRecord = {
      isbn: cleanIsbn,
      title: item.title || 'Untitled Book',
      author: item.author || (Array.isArray(item.authors) ? item.authors.join(', ') : 'Unknown Author'),
      authors: Array.isArray(item.authors) ? item.authors : (item.author ? [item.author] : []),
      publisher: item.publisher || '',
      publishDate: item.publishDate || item.year || '',
      pages: item.pages || null,
      coverUrl: item.coverUrl || '',
      status: item.status || 'Unread',
      location: item.location || '',
      rating: Number(item.rating) || 0,
      notes: item.notes || '',
      copiesCount: Number(item.copiesCount) || 1,
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now
    };

    await db.books.add(bookRecord);
    count++;
  }

  return { imported: count };
}

export { db };
