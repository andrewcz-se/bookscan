/**
 * BookScan Export & Import Service
 * Handles CSV generation, JSON backups, and iOS/Android native file sharing
 */

import { getBooks, importBooks } from './db.js';

/**
 * Escapes a field for standard CSV formatting (RFC 4180)
 * @param {string|number|null|undefined} field 
 * @returns {string}
 */
function escapeCsvField(field) {
  if (field === null || field === undefined) return '""';
  const str = String(field);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return `"${str}"`;
}

/**
 * Triggers file download or iOS/Android native Share Sheet
 * @param {Blob} blob 
 * @param {string} fileName 
 * @param {string} mimeType 
 * @returns {Promise<boolean>}
 */
async function triggerFileDownloadOrShare(blob, fileName, mimeType) {
  const file = new File([blob], fileName, { type: mimeType });

  // Try Web Share API for native mobile "Save to Files" / Share sheet
  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: fileName,
        text: 'Your BookScan catalog export'
      });
      return true;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Native share failed, falling back to download link:', err);
      } else {
        // User deliberately cancelled share sheet
        return true;
      }
    }
  }

  // Fallback: Standard browser download link
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = blobUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  }, 500);

  return true;
}

/**
 * Exports the library catalog as a CSV spreadsheet
 * Headers: ISBN, Title, Authors, Publisher, Year, Pages, Status, Location, Rating, Copies, Notes, Date Added
 * @returns {Promise<void>}
 */
export async function exportToCsv() {
  const books = await getBooks({ status: 'all', sortBy: 'created_desc' });

  if (!books.length) {
    throw new Error('Your library is empty. Scan some books before exporting!');
  }

  const headers = [
    'ISBN',
    'Title',
    'Authors',
    'Publisher',
    'Year',
    'Pages',
    'Status',
    'Location',
    'Rating',
    'Copies',
    'Notes',
    'Date Added'
  ];

  const rows = books.map(b => [
    escapeCsvField(b.isbn || ''),
    escapeCsvField(b.title || ''),
    escapeCsvField(b.author || ''),
    escapeCsvField(b.publisher || ''),
    escapeCsvField(b.publishDate || ''),
    escapeCsvField(b.pages || ''),
    escapeCsvField(b.status || 'Unread'),
    escapeCsvField(b.location || ''),
    escapeCsvField(b.rating ? `${b.rating}/5` : ''),
    escapeCsvField(b.copiesCount || 1),
    escapeCsvField(b.notes || ''),
    escapeCsvField(b.createdAt ? new Date(b.createdAt).toLocaleDateString() : '')
  ]);

  // Include UTF-8 Byte Order Mark (BOM) so Excel/iOS Numbers opens non-ASCII characters cleanly
  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const dateStr = new Date().toISOString().split('T')[0];
  const fileName = `bookscan-library-${dateStr}.csv`;

  await triggerFileDownloadOrShare(blob, fileName, 'text/csv');
}

/**
 * Exports the complete database as a structured JSON backup
 * @returns {Promise<void>}
 */
export async function exportToJson() {
  const books = await getBooks({ status: 'all', sortBy: 'created_desc' });

  if (!books.length) {
    throw new Error('Your library is empty. Nothing to export!');
  }

  const exportData = {
    app: 'BookScan',
    version: '1.0.0',
    exportDate: new Date().toISOString(),
    totalBooks: books.length,
    catalog: books
  };

  const jsonStr = JSON.stringify(exportData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
  const dateStr = new Date().toISOString().split('T')[0];
  const fileName = `bookscan-backup-${dateStr}.json`;

  await triggerFileDownloadOrShare(blob, fileName, 'application/json');
}

/**
 * Imports books from an uploaded JSON file
 * @param {File} file 
 * @param {boolean} replaceExisting 
 * @returns {Promise<{imported: number}>}
 */
export async function importFromJsonFile(file, replaceExisting = false) {
  if (!file) {
    throw new Error('Please select a JSON file to import.');
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = async (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        
        // Support both { catalog: [...] } and raw [...] format
        const booksList = Array.isArray(parsed) ? parsed : (parsed.catalog || parsed.books);

        if (!Array.isArray(booksList)) {
          throw new Error('Invalid file format. Expected a JSON array or a BookScan backup.');
        }

        const result = await importBooks(booksList, replaceExisting);
        resolve(result);
      } catch (err) {
        reject(new Error(`Import failed: ${err.message}`));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read the selected backup file.'));
    };

    reader.readAsText(file);
  });
}
