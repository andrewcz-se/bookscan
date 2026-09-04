/**
 * BookScan Main Application Controller
 */

import { 
  addOrIncrementBook, 
  updateBook, 
  deleteBook, 
  getBook, 
  getBooks, 
  getCatalogStats,
  normalizeIsbn 
} from './db.js';
import { lookupIsbn } from './api.js';
import BookScanner from './scanner.js';
import { exportToCsv, exportToJson, importFromJsonFile } from './export-import.js';

// Application State
const state = {
  activeStatus: 'all',
  searchQuery: '',
  sortBy: 'created_desc',
  editingBookId: null,
  isScannerCollapsed: false,
  isProcessingScan: false
};

// Scanner instance
let scanner = null;

/**
 * Toast Notification Helper
 */
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bgClasses = {
    success: 'bg-emerald-600 text-white border-emerald-500',
    warning: 'bg-amber-600 text-white border-amber-500',
    error: 'bg-rose-600 text-white border-rose-500',
    info: 'bg-slate-800 text-white border-slate-700'
  };

  const icons = {
    success: `<svg class="w-5 h-5 flex-shrink-0 text-emerald-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
    warning: `<svg class="w-5 h-5 flex-shrink-0 text-amber-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`,
    error: `<svg class="w-5 h-5 flex-shrink-0 text-rose-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`,
    info: `<svg class="w-5 h-5 flex-shrink-0 text-sky-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`
  };

  toast.className = `flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium transition-all duration-300 transform translate-y-2 opacity-0 ${bgClasses[type] || bgClasses.info}`;
  toast.innerHTML = `
    ${icons[type] || icons.info}
    <span class="flex-1">${message}</span>
  `;

  container.appendChild(toast);

  // Trigger entry animation
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Updates UI badge counts and statistics
 */
async function refreshStats() {
  const stats = await getCatalogStats();
  const counterEl = document.getElementById('catalog-counter-badge');
  if (counterEl) {
    counterEl.textContent = `${stats.totalBooks} book${stats.totalBooks === 1 ? '' : 's'} cataloged`;
  }

  // Update filter pill counts if present
  const allCount = document.getElementById('count-all');
  const unreadCount = document.getElementById('count-unread');
  const readingCount = document.getElementById('count-reading');
  const finishedCount = document.getElementById('count-finished');

  if (allCount) allCount.textContent = stats.totalBooks;
  if (unreadCount) unreadCount.textContent = stats.unread;
  if (readingCount) readingCount.textContent = stats.reading;
  if (finishedCount) finishedCount.textContent = stats.finished;
}

/**
 * Render star icons for rating display
 */
function renderRatingStars(rating = 0) {
  let stars = '';
  for (let i = 1; i <= 5; i++) {
    if (i <= rating) {
      stars += `<svg class="w-4 h-4 text-amber-400 fill-current" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>`;
    } else {
      stars += `<svg class="w-4 h-4 text-slate-600 fill-current" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>`;
    }
  }
  return stars;
}

/**
 * Render Status badge
 */
function renderStatusBadge(status = 'Unread') {
  const s = status.toLowerCase();
  if (s === 'finished') {
    return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Finished</span>`;
  }
  if (s === 'reading') {
    return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">Reading</span>`;
  }
  return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/10 text-slate-400 border border-slate-500/20">Unread</span>`;
}

/**
 * Render the Catalog List
 */
async function renderCatalog() {
  const container = document.getElementById('catalog-list');
  const emptyState = document.getElementById('catalog-empty-state');
  if (!container) return;

  const books = await getBooks({
    status: state.activeStatus,
    search: state.searchQuery,
    sortBy: state.sortBy
  });

  await refreshStats();

  if (books.length === 0) {
    container.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }

  if (emptyState) emptyState.classList.add('hidden');

  container.innerHTML = books.map(book => {
    const coverHtml = book.coverUrl
      ? `<img src="${book.coverUrl}" alt="${book.title}" class="w-16 h-24 object-cover rounded-lg shadow-md bg-slate-800 flex-shrink-0" onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'w-16 h-24 rounded-lg bg-slate-800 flex items-center justify-center text-slate-500 text-xs text-center p-1 border border-slate-700\\'>📖 No Cover</div>';" />`
      : `<div class="w-16 h-24 rounded-lg bg-slate-800 flex items-center justify-center text-slate-500 text-xs text-center p-1 border border-slate-700 flex-shrink-0">📖 No Cover</div>`;

    const copiesBadge = (book.copiesCount && book.copiesCount > 1)
      ? `<span class="px-2 py-0.5 rounded-md text-xs font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30">x${book.copiesCount} copies</span>`
      : '';

    const locationBadge = book.location
      ? `<span class="inline-flex items-center gap-1 text-xs text-slate-400 bg-slate-800/80 px-2 py-0.5 rounded-md border border-slate-700/60 truncate max-w-[140px]" title="${book.location}">
           <svg class="w-3 h-3 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
           <span class="truncate">${book.location}</span>
         </span>`
      : '';

    return `
      <div class="book-card group bg-slate-800/60 hover:bg-slate-800 border border-slate-700/70 hover:border-slate-600 rounded-2xl p-4 transition-all duration-200 shadow-sm flex flex-col sm:flex-row gap-4 relative cursor-pointer" data-id="${book.id}">
        <!-- Cover -->
        <div class="flex sm:flex-col items-start justify-center">
          ${coverHtml}
        </div>

        <!-- Book Info -->
        <div class="flex-1 min-w-0 flex flex-col justify-between">
          <div>
            <div class="flex items-start justify-between gap-2">
              <h3 class="text-base font-bold text-slate-100 group-hover:text-sky-300 transition-colors line-clamp-2">${book.title}</h3>
              <div class="flex items-center gap-1 flex-shrink-0">
                ${copiesBadge}
                ${renderStatusBadge(book.status)}
              </div>
            </div>

            <p class="text-sm font-medium text-slate-300 mt-1">${book.author || 'Unknown Author'}</p>
            
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-slate-400">
              ${book.publishDate ? `<span>📅 ${book.publishDate}</span>` : ''}
              ${book.pages ? `<span>📄 ${book.pages} p.</span>` : ''}
              ${book.isbn ? `<span class="font-mono text-slate-400">ISBN: ${book.isbn}</span>` : ''}
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2 mt-3 pt-3 border-t border-slate-700/50">
            <div class="flex items-center gap-2">
              <div class="flex items-center">${renderRatingStars(book.rating)}</div>
              ${locationBadge}
            </div>

            <div class="flex items-center gap-2">
              <button type="button" class="btn-edit-book text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-slate-700/80 hover:bg-slate-600 text-slate-200 transition-colors flex items-center gap-1" data-id="${book.id}">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                Edit
              </button>
              <button type="button" class="btn-delete-book text-xs font-semibold p-1.5 rounded-lg hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 transition-colors" data-id="${book.id}" title="Remove Book">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Wire card click events
  container.querySelectorAll('.book-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't open if clicked delete button
      if (e.target.closest('.btn-delete-book')) return;
      const id = parseInt(card.dataset.id, 10);
      openEditModal(id);
    });
  });

  container.querySelectorAll('.btn-delete-book').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const book = await getBook(id);
      if (book && confirm(`Remove "${book.title}" from your catalog?`)) {
        await deleteBook(id);
        showToast(`Removed "${book.title}"`, 'warning');
        renderCatalog();
      }
    });
  });
}

/**
 * Handle incoming barcode or manual ISBN
 */
async function processIsbn(rawIsbn) {
  const cleanIsbn = normalizeIsbn(rawIsbn);
  if (!cleanIsbn) {
    showToast('Please provide an ISBN to lookup.', 'warning');
    return;
  }

  showToast(`Looking up ISBN: ${cleanIsbn}...`, 'info', 2000);

  try {
    const lookup = await lookupIsbn(cleanIsbn);

    if (lookup.found) {
      const result = await addOrIncrementBook(lookup.book);
      if (result.isDuplicate) {
        showToast(`Already in your library! Added copy #${result.book.copiesCount}`, 'info');
      } else {
        showToast(`Added "${result.book.title}" via ${lookup.provider}!`, 'success');
      }
      await renderCatalog();
    } else {
      // Prompt user with manual entry modal
      showToast(`No metadata found for ISBN ${cleanIsbn}. Enter details below.`, 'warning', 4000);
      openManualModal(cleanIsbn);
    }
  } catch (err) {
    console.error('Error processing ISBN:', err);
    showToast(err.message || 'Lookup failed. Try manual entry.', 'error');
  }
}

/**
 * Modal Management: Edit Book
 */
async function openEditModal(id) {
  const book = await getBook(id);
  if (!book) return;

  state.editingBookId = id;
  const modal = document.getElementById('edit-modal');
  
  // Fill inputs
  document.getElementById('edit-title').value = book.title || '';
  document.getElementById('edit-author').value = book.author || '';
  document.getElementById('edit-isbn').value = book.isbn || '';
  document.getElementById('edit-publisher').value = book.publisher || '';
  document.getElementById('edit-year').value = book.publishDate || '';
  document.getElementById('edit-pages').value = book.pages || '';
  document.getElementById('edit-status').value = book.status || 'Unread';
  document.getElementById('edit-location').value = book.location || '';
  document.getElementById('edit-copies').value = book.copiesCount || 1;
  document.getElementById('edit-notes').value = book.notes || '';
  document.getElementById('edit-cover').value = book.coverUrl || '';

  // Rating stars
  setRatingPickerValue('edit-rating-picker', book.rating || 0);

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeEditModal() {
  const modal = document.getElementById('edit-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  state.editingBookId = null;
}

/**
 * Modal Management: Manual Entry
 */
function openManualModal(isbn = '') {
  const modal = document.getElementById('manual-modal');
  document.getElementById('manual-isbn').value = isbn;
  document.getElementById('manual-title').value = '';
  document.getElementById('manual-author').value = '';
  document.getElementById('manual-publisher').value = '';
  document.getElementById('manual-year').value = '';
  document.getElementById('manual-status').value = 'Unread';
  document.getElementById('manual-location').value = '';
  document.getElementById('manual-notes').value = '';
  setRatingPickerValue('manual-rating-picker', 0);

  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeManualModal() {
  const modal = document.getElementById('manual-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

/**
 * Modal Management: Export & Backup
 */
function openBackupModal() {
  const modal = document.getElementById('backup-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeBackupModal() {
  const modal = document.getElementById('backup-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

/**
 * Interactive Star Rating Picker Helper
 */
function setupRatingPicker(pickerId, hiddenInputId) {
  const picker = document.getElementById(pickerId);
  const hiddenInput = document.getElementById(hiddenInputId);
  if (!picker || !hiddenInput) return;

  const stars = picker.querySelectorAll('.star-btn');
  stars.forEach((star, idx) => {
    star.addEventListener('click', () => {
      const val = idx + 1;
      const current = parseInt(hiddenInput.value, 10) || 0;
      const finalVal = current === val ? 0 : val; // toggle off if clicked same
      setRatingPickerValue(pickerId, finalVal);
    });
  });
}

function setRatingPickerValue(pickerId, val) {
  const picker = document.getElementById(pickerId);
  if (!picker) return;
  const hiddenInput = picker.querySelector('input[type="hidden"]');
  if (hiddenInput) hiddenInput.value = val;

  const stars = picker.querySelectorAll('.star-btn svg');
  stars.forEach((svg, idx) => {
    if (idx < val) {
      svg.classList.add('text-amber-400');
      svg.classList.remove('text-slate-600');
    } else {
      svg.classList.remove('text-amber-400');
      svg.classList.add('text-slate-600');
    }
  });
}

/**
 * Initialize Camera Scanner
 */
function initScanner() {
  scanner = new BookScanner({
    elementId: 'reader',
    onScanSuccess: async (decodedText) => {
      await processIsbn(decodedText);
    },
    onStatusChange: (status, err) => {
      const statusIndicator = document.getElementById('camera-status-indicator');
      const startBtn = document.getElementById('btn-start-camera');
      const stopBtn = document.getElementById('btn-stop-camera');
      const torchBtn = document.getElementById('btn-toggle-torch');

      if (status === 'active') {
        if (statusIndicator) statusIndicator.textContent = 'Ready — point at an ISBN barcode';
        if (startBtn) startBtn.classList.add('hidden');
        if (stopBtn) stopBtn.classList.remove('hidden');
        if (torchBtn && scanner.hasFlashlight) torchBtn.classList.remove('hidden');
      } else if (status === 'starting') {
        if (statusIndicator) statusIndicator.textContent = 'Starting rear camera…';
      } else {
        if (statusIndicator) statusIndicator.textContent = 'Camera idle';
        if (startBtn) startBtn.classList.remove('hidden');
        if (stopBtn) stopBtn.classList.add('hidden');
        if (torchBtn) torchBtn.classList.add('hidden');
      }

      if (status === 'error') {
        const message = typeof err === 'string' ? err : err?.message;
        showToast('Camera error: ' + (message || 'Check camera permission and try again.'), 'error');
      }
    }
  });
}

/**
 * Wire all DOM events
 */
function setupEventListeners() {
  // Scanner controls
  const startBtn = document.getElementById('btn-start-camera');
  const stopBtn = document.getElementById('btn-stop-camera');
  const torchBtn = document.getElementById('btn-toggle-torch');
  const toggleCollapseBtn = document.getElementById('btn-toggle-scanner-view');
  const scannerSection = document.getElementById('scanner-section');

  if (startBtn) {
    startBtn.addEventListener('click', () => {
      scanner.start().catch(() => {});
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      scanner.stop();
    });
  }

  if (torchBtn) {
    torchBtn.addEventListener('click', async () => {
      const isOn = await scanner.toggleFlashlight();
      torchBtn.classList.toggle('text-amber-400', isOn);
      torchBtn.classList.toggle('bg-amber-400/20', isOn);
    });
  }

  if (toggleCollapseBtn && scannerSection) {
    toggleCollapseBtn.addEventListener('click', () => {
      state.isScannerCollapsed = !state.isScannerCollapsed;
      scannerSection.classList.toggle('hidden', state.isScannerCollapsed);
      toggleCollapseBtn.querySelector('span').textContent = state.isScannerCollapsed ? 'Show Camera' : 'Hide Camera';
    });
  }

  // Manual ISBN input
  const manualSearchForm = document.getElementById('manual-isbn-form');
  const manualInput = document.getElementById('manual-isbn-input');
  if (manualSearchForm && manualInput) {
    manualSearchForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = manualInput.value.trim();
      if (code) {
        await processIsbn(code);
        manualInput.value = '';
      }
    });
  }

  // Search & Filter
  const searchInput = document.getElementById('catalog-search-input');
  if (searchInput) {
    let debounceTimer = null;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.searchQuery = e.target.value;
        renderCatalog();
      }, 200);
    });
  }

  // Status Filter Tabs
  document.querySelectorAll('.filter-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab-btn').forEach(b => {
        b.classList.remove('bg-sky-500', 'text-white', 'shadow-sm');
        b.classList.add('text-slate-400', 'hover:text-slate-200');
      });
      btn.classList.add('bg-sky-500', 'text-white', 'shadow-sm');
      btn.classList.remove('text-slate-400', 'hover:text-slate-200');

      state.activeStatus = btn.dataset.status;
      renderCatalog();
    });
  });

  // Sort dropdown
  const sortSelect = document.getElementById('catalog-sort-select');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      renderCatalog();
    });
  }

  // Quick Action Buttons
  const btnExportCsv = document.getElementById('btn-quick-export-csv');
  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', async () => {
      try {
        await exportToCsv();
        showToast('CSV exported successfully!', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const btnOpenBackup = document.getElementById('btn-open-backup-modal');
  if (btnOpenBackup) {
    btnOpenBackup.addEventListener('click', openBackupModal);
  }

  const btnOpenManual = document.getElementById('btn-open-manual-entry');
  if (btnOpenManual) {
    btnOpenManual.addEventListener('click', () => openManualModal(''));
  }

  // Edit Modal Form Save
  const editForm = document.getElementById('edit-book-form');
  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.editingBookId) return;

      const updates = {
        title: document.getElementById('edit-title').value.trim(),
        author: document.getElementById('edit-author').value.trim(),
        isbn: document.getElementById('edit-isbn').value.trim(),
        publisher: document.getElementById('edit-publisher').value.trim(),
        publishDate: document.getElementById('edit-year').value.trim(),
        pages: document.getElementById('edit-pages').value ? parseInt(document.getElementById('edit-pages').value, 10) : null,
        status: document.getElementById('edit-status').value,
        location: document.getElementById('edit-location').value.trim(),
        copiesCount: parseInt(document.getElementById('edit-copies').value, 10) || 1,
        rating: parseInt(document.getElementById('edit-rating-value').value, 10) || 0,
        notes: document.getElementById('edit-notes').value.trim(),
        coverUrl: document.getElementById('edit-cover').value.trim()
      };

      await updateBook(state.editingBookId, updates);
      showToast('Book updated successfully!', 'success');
      closeEditModal();
      renderCatalog();
    });
  }

  const btnCloseEdit = document.getElementById('btn-close-edit-modal');
  if (btnCloseEdit) btnCloseEdit.addEventListener('click', closeEditModal);

  // Manual Entry Form Save
  const manualForm = document.getElementById('manual-entry-form');
  if (manualForm) {
    manualForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const bookData = {
        title: document.getElementById('manual-title').value.trim() || 'Untitled Book',
        author: document.getElementById('manual-author').value.trim(),
        isbn: document.getElementById('manual-isbn').value.trim(),
        publisher: document.getElementById('manual-publisher').value.trim(),
        publishDate: document.getElementById('manual-year').value.trim(),
        status: document.getElementById('manual-status').value,
        location: document.getElementById('manual-location').value.trim(),
        rating: parseInt(document.getElementById('manual-rating-value').value, 10) || 0,
        notes: document.getElementById('manual-notes').value.trim()
      };

      await addOrIncrementBook(bookData);
      showToast(`Added "${bookData.title}" to catalog!`, 'success');
      closeManualModal();
      renderCatalog();
    });
  }

  const btnCloseManual = document.getElementById('btn-close-manual-modal');
  if (btnCloseManual) btnCloseManual.addEventListener('click', closeManualModal);

  // Close modals when clicking backdrop
  [
    { modalId: 'edit-modal', closeFn: closeEditModal },
    { modalId: 'manual-modal', closeFn: closeManualModal },
    { modalId: 'backup-modal', closeFn: closeBackupModal }
  ].forEach(({ modalId, closeFn }) => {
    const modalEl = document.getElementById(modalId);
    if (modalEl) {
      modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
          closeFn();
        }
      });
    }
  });

  // Backup Modal Actions
  const btnCloseBackup = document.getElementById('btn-close-backup-modal');
  if (btnCloseBackup) btnCloseBackup.addEventListener('click', closeBackupModal);

  const btnBackupJson = document.getElementById('btn-export-json');
  if (btnBackupJson) {
    btnBackupJson.addEventListener('click', async () => {
      try {
        await exportToJson();
        showToast('JSON backup exported!', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const fileInput = document.getElementById('import-json-file');
  const btnImportJson = document.getElementById('btn-trigger-import');
  const chkReplace = document.getElementById('import-replace-checkbox');

  if (btnImportJson && fileInput) {
    btnImportJson.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const replace = chkReplace ? chkReplace.checked : false;
      if (replace && !confirm('WARNING: This will replace your entire local library with the backup file. Continue?')) {
        fileInput.value = '';
        return;
      }

      try {
        showToast('Importing catalog...', 'info');
        const res = await importFromJsonFile(file, replace);
        showToast(`Successfully imported ${res.imported} books!`, 'success');
        fileInput.value = '';
        closeBackupModal();
        renderCatalog();
      } catch (err) {
        showToast(err.message, 'error');
        fileInput.value = '';
      }
    });
  }

  // Rating pickers setup
  setupRatingPicker('edit-rating-picker', 'edit-rating-value');
  setupRatingPicker('manual-rating-picker', 'manual-rating-value');
}

/**
 * Bootstrap Application
 */
async function initApp() {
  setupEventListeners();
  initScanner();
  await renderCatalog();
}

// Start on DOMContentLoaded
window.addEventListener('DOMContentLoaded', initApp);
