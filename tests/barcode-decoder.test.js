import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { prepareDecoder, decodeBarcodeFrame } from '../js/barcode-decoder.js';
import { ZXING_WASM_SHA256 } from '../vendor/zxing-wasm/reader/index.js';
import { BarcodeCamera, captureRegion } from '../js/barcode-camera.js';
import { BookScanner, scanBox } from '../js/scanner.js';

const wasm = await readFile(new URL('../vendor/zxing-wasm/reader/zxing_reader.wasm', import.meta.url));
await prepareDecoder({ wasmBinary: wasm });

test('vendored WASM matches the JavaScript decoder version', () => {
  assert.equal(createHash('sha256').update(wasm).digest('hex'), ZXING_WASM_SHA256);
});

test('decodes the original screenshot scan region without substituting printed ISBN text', async () => {
  const compressed = await readFile(new URL('./fixtures/IMG_1507-scan-region.rgba.gz', import.meta.url));
  const data = new Uint8ClampedArray(gunzipSync(compressed));
  assert.equal(data.length, 882 * 470 * 4);
  assert.deepEqual(await decodeBarcodeFrame({ data, width: 882, height: 470 }), ['9780333761366']);
});

// Independent EAN encoder for clean, rotated, invalid and non-book cases.
function eanFrame(text, rotate = false) {
  const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const parity = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'][Number(text[0])];
  const bits = '0'.repeat(15) + '101' + [...text.slice(1, 7)].map((d, i) => (parity[i] === 'L' ? L : G)[Number(d)]).join('') +
    '01010' + [...text.slice(7)].map(d => [...L[Number(d)]].map(b => b === '1' ? '0' : '1').join('')).join('') + '101' + '0'.repeat(15);
  const w = bits.length * 3, h = 140;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 20; y < h - 20; y++) for (let x = 0; x < w; x++) {
    if (bits[Math.floor(x / 3)] !== '1') continue;
    const at = (rotate ? (x * h + (h - 1 - y)) : (y * w + x)) * 4;
    data[at] = data[at + 1] = data[at + 2] = 0;
  }
  return { data, width: rotate ? h : w, height: rotate ? w : h };
}

test('reads other 978 and 979 books including a sideways barcode', async () => {
  for (const isbn of ['9780141439518', '9791090636071']) {
    for (const rotated of [false, true]) assert.deepEqual(await decodeBarcodeFrame(eanFrame(isbn, rotated)), [isbn]);
  }
});

test('rejects damaged checksums, ordinary product EANs and blank frames', async () => {
  for (const value of ['9780141439510', '4006381333931']) assert.deepEqual(await decodeBarcodeFrame(eanFrame(value)), []);
  assert.deepEqual(await decodeBarcodeFrame({ width: 300, height: 160, data: new Uint8ClampedArray(300 * 160 * 4).fill(255) }), []);
});

test('phone preview size does not reduce camera-pixel crop resolution', () => {
  const region = captureRegion({ clientWidth: 327, clientHeight: 436, videoWidth: 981, videoHeight: 1308 }, scanBox);
  assert.deepEqual(region, { x: 49, y: 420, width: 882, height: 468, box: { width: 294, height: 156 } });
  for (const [w, h] of [[1920, 1080], [1080, 1920], [640, 480]]) {
    const crop = captureRegion({ clientWidth: 320, clientHeight: 320 * h / w, videoWidth: w, videoHeight: h }, scanBox);
    assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= w && crop.y + crop.height <= h);
  }
});

test('a result must repeat in separate frames; pause and cooldown reject candidates', () => {
  const scans = [];
  const state = { busy: false, suspended: false, nextScanAt: 0, detect: text => scans.push(text) };
  const confirm = text => BookScanner.prototype.confirmDetection.call(state, text);
  confirm('9780333761366');
  assert.deepEqual(scans, []);
  confirm('9780141439518');
  assert.deepEqual(scans, []);
  confirm('9780141439518');
  assert.deepEqual(scans, ['9780141439518']);
  state.suspended = true;
  confirm('9780333761366'); confirm('9780333761366');
  state.suspended = false;
  state.nextScanAt = Date.now() + 2000;
  confirm('9780333761366'); confirm('9780333761366');
  assert.equal(scans.length, 1);
});

test('worker accepts only one frame at a time and discards results across pause/stop', async t => {
  let posted = [], stopped = 0, terminated = 0;
  let worker;
  const context = { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(8 * 4 * 4), width: 8, height: 4 }) };
  const track = { stop: () => stopped++ };
  const video = { readyState: 4, clientWidth: 320, clientHeight: 240, videoWidth: 1280, videoHeight: 960,
    setAttribute() {}, play: async () => {} };
  const doc = { getElementById: () => ({ replaceChildren() {} }), createElement: tag => tag === 'video' ? video :
    tag === 'canvas' ? { getContext: () => context } : { setAttribute() {}, style: {} } };
  const globals = { document: doc, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    Worker: class {
      constructor() { worker = this; queueMicrotask(() => this.onmessage({ data: { type: 'ready' } })); }
      postMessage(data) { posted.push(data); }
      terminate() { terminated++; }
    }
  };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const camera = new BarcodeCamera('reader');
  const scans = [];
  await camera.start({ facingMode: 'environment' }, { fps: 8, qrbox: scanBox }, value => scans.push(value), assert.fail);
  t.after(() => camera.stop());
  camera.capture(); camera.capture();
  assert.equal(posted.length, 1);
  camera.pause(); camera.resume();
  worker.onmessage({ data: { type: 'result', generation: posted[0].generation, texts: ['9780333761366'] } });
  assert.deepEqual(scans, []);
  camera.capture();
  worker.onmessage({ data: { type: 'result', generation: posted[1].generation, texts: ['9780333761366'] } });
  assert.deepEqual(scans, ['9780333761366']);
  await camera.stop();
  worker.onmessage({ data: { type: 'result', generation: posted[1].generation, texts: ['9780333761366'] } });
  assert.equal(scans.length, 1);
  assert.equal(stopped, 1);
  assert.equal(terminated, 1);
  // A permission request can resolve after pagehide has already stopped us.
  let grant;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const pending = camera.start({ facingMode: 'environment' }, { fps: 8, qrbox: scanBox }, assert.fail, assert.fail);
  await camera.stop();
  grant({ getTracks: () => [track] });
  await assert.rejects(pending, /cancelled/);
  assert.equal(camera.isScanning, false);
  assert.equal(stopped, 2);
});
