const columns = [
  ['ISBN', 'isbn'], ['Title', 'title'], ['Author', 'authors'], ['Publication date', 'publish_date'],
  ['Publisher', 'publisher'], ['Pages', 'number_of_pages'], ['Reading status', 'status'],
  ['Shelf / Room', 'location'], ['Rating', 'rating'], ['Notes', 'notes'], ['Cover URL', 'cover'],
  ['Metadata source', 'source'], ['Added', 'createdAt'], ['Updated', 'updatedAt'],
  ['Description', 'description'], ['Subjects', 'subjects'], ['Binding', 'binding'], ['Edition', 'edition']
];

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Quoting alone does not prevent spreadsheet formula execution.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

export function buildCsv(books) {
  const rows = [columns.map(([label]) => csvCell(label)).join(',')];
  for (const book of books) rows.push(columns.map(([, key]) => csvCell(key === 'subjects' && Array.isArray(book[key]) ? book[key].join('\n') : book[key])).join(','));
  return '\uFEFF' + rows.join('\r\n') + '\r\n'; // BOM for Excel; CRLF and quoted multiline cells.
}

export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
