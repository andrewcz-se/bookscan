/** Validate check digits, then use ISBN-13 as a single identity for both formats. */
export function normalizeIsbn(value) {
  const isbn = String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    const sum = [...isbn].reduce((n, digit, i) => n + (digit === 'X' ? 10 : Number(digit)) * (10 - i), 0);
    if (sum % 11) throw new Error('The ISBN check digit is incorrect. Please check the number.');
    const base = '978' + isbn.slice(0, 9);
    return base + check13(base);
  }
  if (/^97[89]\d{10}$/.test(isbn) && check13(isbn.slice(0, 12)) === Number(isbn[12])) return isbn;
  throw new Error('Enter a valid 10 or 13 digit book ISBN. ISBN-13 begins with 978 or 979.');
}

function check13(base) {
  return (10 - [...base].reduce((n, digit, i) => n + Number(digit) * (i % 2 ? 3 : 1), 0) % 10) % 10;
}

export function toIsbn10(value) {
  const isbn = normalizeIsbn(value);
  if (!isbn.startsWith('978')) return null; // 979 has no ISBN-10 equivalent.
  const base = isbn.slice(3, 12);
  const digit = (11 - [...base].reduce((n, d, i) => n + Number(d) * (10 - i), 0) % 11) % 11;
  return base + (digit === 10 ? 'X' : digit);
}
