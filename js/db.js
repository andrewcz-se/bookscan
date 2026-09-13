export function createDatabase(DexieClass) {
  const db = new DexieClass('BookscanCatalog');
  db.version(1).stores({ books: '++id,&isbn,createdAt,status,location,title,authors' });
  return db;
}

/** Unique ISBN plus a transaction handles simultaneous scans and multiple tabs. */
export async function insertBook(db, book) {
  return db.transaction('rw', db.books, async () => {
    const existing = await db.books.where('isbn').equals(book.isbn).first();
    if (existing) return { book: existing, duplicate: true };
    const stamp = new Date().toISOString();
    const record = { status: 'To Read', location: '', rating: null, notes: '', description: '', subjects: [], binding: '', edition: '', ...book, createdAt: stamp, updatedAt: stamp };
    const id = await db.books.add(record);
    return { book: { ...record, id }, duplicate: false };
  });
}
