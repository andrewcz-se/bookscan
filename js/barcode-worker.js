import { prepareDecoder, decodeBarcodeFrame } from './barcode-decoder.js';

try {
  await prepareDecoder();
  self.postMessage({ type: 'ready' });
} catch (error) {
  self.postMessage({ type: 'error', message: `Barcode decoder could not load: ${error.message}` });
}

self.onmessage = async ({ data }) => {
  try {
    const texts = await decodeBarcodeFrame(data.frame);
    self.postMessage({ type: 'result', generation: data.generation, texts });
  } catch (error) {
    self.postMessage({ type: 'error', message: `Barcode decoding failed: ${error.message}` });
  }
};
