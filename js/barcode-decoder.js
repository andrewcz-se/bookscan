import { readBarcodes, prepareZXingModule } from '../vendor/zxing-wasm/reader/index.js';
import { normalizeIsbn } from './isbn.js';

export function prepareDecoder(overrides = {
  locateFile: () => new URL('../vendor/zxing-wasm/reader/zxing_reader.wasm', import.meta.url).href
}) {
  return prepareZXingModule({ overrides, fireImmediately: true });
}

// Recover softened bar edges without thresholding away the narrow white gaps.
// A horizontal unsharp mask is cheap and targets upright book barcodes.
export function sharpenBarcode({ data, width, height }) {
  const output = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const sample = dx => data[(y * width + Math.max(0, Math.min(width - 1, x + dx))) * 4 + c];
        const blur = (sample(-2) + 4 * sample(-1) + 6 * sample(0) + 4 * sample(1) + sample(2)) / 16;
        output[at + c] = data[at + c] + 1.5 * (data[at + c] - blur);
      }
      output[at + 3] = 255;
    }
  }
  return { data: output, width, height };
}

export async function decodeBarcodeFrame(frame) {
  const options = {
    formats: ['EAN13', 'ISBN'], tryHarder: true, tryRotate: true,
    eanAddOnSymbol: 'Ignore', minLineCount: 2, maxNumberOfSymbols: 4,
    returnErrors: false
  };
  const valid = results => results.filter(result => result.isValid).flatMap(result => {
    try { return [normalizeIsbn(result.text)]; } catch { return []; }
  });
  let results = valid(await readBarcodes(frame, options));
  if (results.length) return [...new Set(results)];
  // Dark book covers can dominate the per-line histogram. A second, tighter
  // central crop changes that balance while retaining the original pixels.
  const focused = centerCrop(frame);
  if (!results.length) results = valid(await readBarcodes(focused, options));
  if (!results.length) results = valid(await readBarcodes(sharpenBarcode(focused), options));
  return [...new Set(results)];
}

export function centerCrop({ data, width, height }) {
  const w = Math.max(1, Math.floor(width * .8));
  const h = Math.max(1, Math.floor(height * .65));
  const x = Math.floor((width - w) / 2), y = Math.floor((height - h) / 2);
  const output = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const start = ((y + row) * width + x) * 4;
    output.set(data.subarray(start, start + w * 4), row * w * 4);
  }
  return { data: output, width: w, height: h };
}
