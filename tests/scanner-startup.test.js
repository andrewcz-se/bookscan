import test from 'node:test';
import assert from 'node:assert/strict';
import { BookScanner, waitForScannerReady, cameraErrorMessage } from '../js/scanner.js';
import { readFile } from 'node:fs/promises';

function harness(t, { initialDevices = [], devices = [], settingsError = false, startError = null } = {}) {
  const nodes = new Map();
  const node = () => ({ hidden: false, disabled: false, value: '', textContent: '', children: [],
    addEventListener() {}, setAttribute() {}, replaceChildren(...children) { this.children = children; },
    querySelector() { return null; }, querySelectorAll() { return []; } });
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const video = { readyState: 4, videoWidth: 1920, clientWidth: 320, setAttribute() {}, srcObject: { getTracks: () => [{ stop() { stoppedTracks++; } }] } };
  let stoppedTracks = 0, enumerations = 0;
  const reader = get('reader');
  reader.querySelector = () => video;
  reader.querySelectorAll = () => [video];
  const launches = [], engines = [], errors = [];
  class Engine {
    constructor() { this.isScanning = false; this.stops = 0; engines.push(this); }
    async start(constraints) {
      launches.push(constraints);
      if (startError) throw startError;
      this.isScanning = true;
    }
    async stop() { this.stops++; this.isScanning = false; }
    clear() {}
    getRunningTrackSettings() { if (settingsError) throw new Error('getSettings unavailable'); return { deviceId: 'triple' }; }
    getRunningTrackCapabilities() { return null; }
  }
  const globals = {
    window: { innerWidth: 390, isSecureContext: true, Html5Qrcode: Engine, Html5QrcodeSupportedFormats: { EAN_13: 9 }, addEventListener() {} },
    document: { getElementById: get, createElement: node, hidden: false, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia() {}, enumerateDevices: async () => ++enumerations === 1 ? initialDevices : devices } },
    MutationObserver: class { observe() {} }
  };
  for (const [name, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  t.mock.method(console, 'error', () => {});
  const scanner = new BookScanner({ onScan() {}, toast: message => errors.push(message), createEngine: () => new Engine() });
  return { scanner, get, video, launches, engines, errors, tracksStopped: () => stoppedTracks };
}

test('first permission grant keeps the open rear camera instead of restarting for a newly exposed lens', async t => {
  const state = harness(t, { devices: [
    { kind: 'videoinput', label: 'Back Triple Camera', deviceId: 'triple' },
    { kind: 'videoinput', label: 'Back Camera', deviceId: 'main' }
  ] });
  await state.scanner.start();
  assert.deepEqual(state.launches, [{ facingMode: 'environment' }]);
  assert.equal(state.engines[0].stops, 0);
  assert.equal(state.scanner.running, true);
  assert.equal(state.get('camera-choice').value, 'triple');
  assert.deepEqual(state.errors, []);
});

test('known main lens is selected before opening the camera, with no intermediate stream', async t => {
  const state = harness(t, { initialDevices: [{ kind: 'videoinput', label: 'Back Camera', deviceId: 'main' }] });
  await state.scanner.start();
  assert.deepEqual(state.launches, [{ deviceId: { exact: 'main' } }]);
  assert.equal(state.engines[0].stops, 0);
});

test('missing settings and null capabilities cannot tear down a usable camera', async t => {
  const state = harness(t, { settingsError: true });
  await state.scanner.start();
  assert.equal(state.scanner.running, true);
  assert.equal(state.engines[0].stops, 0);
  assert.equal(state.get('torch').hidden, true);
  assert.deepEqual(state.errors, []);
});

test('failed initialization releases the stream and creates a fresh engine on retry', async t => {
  const state = harness(t, { startError: new Error('Video render failed') });
  await state.scanner.start();
  assert.equal(state.scanner.running, false);
  assert.equal(state.scanner.busy, false);
  assert.equal(state.scanner.engine, null);
  assert.equal(state.engines[0].stops, 1);
  assert.equal(state.tracksStopped(), 1);
  assert.match(state.get('camera-hint').textContent, /Video render failed/);
  await state.scanner.start();
  assert.equal(state.engines.length, 2);
});

test('ready wait does not resolve until video and the decode canvas are initialized', async () => {
  const engine = { isScanning: false };
  const video = { readyState: 0, videoWidth: 0, clientWidth: 320 };
  let ready = false;
  const waiting = waitForScannerReady(engine, video, 1000).then(() => { ready = true; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ready, false);
  video.readyState = 4;
  video.videoWidth = 1920;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ready, false);
  engine.isScanning = true;
  await waiting;
  assert.equal(ready, true);
});

test('a video that never plays times out with a useful error', async () => {
  await assert.rejects(waitForScannerReady({ isScanning: false }, { readyState: 0 }, 5), /video did not become ready/);
});

test('error reporting preserves browser details and distinguishes denied permission from a busy camera', () => {
  assert.match(cameraErrorMessage({ name: 'NotAllowedError', message: 'Permission denied' }), /access was denied/);
  assert.match(cameraErrorMessage('NotReadableError: Device in use'), /camera is busy/);
  assert.match(cameraErrorMessage(new TypeError('Cannot remove a null canvas')), /Cannot remove a null canvas/);
});

test('reader remains measurable before video insertion and fixed assets get a new offline cache', async () => {
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  assert.ok(!/#reader:empty\s*\{[^}]*display\s*:\s*none/.test(css));
  const worker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  assert.match(worker, /const CACHE = `\$\{PREFIX\}v5`/);
});
