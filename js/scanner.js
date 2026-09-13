import { normalizeIsbn } from './isbn.js';
import { BarcodeCamera } from './barcode-camera.js';

/** Shared by the guide and the camera-pixel decode region. */
export function scanBox(width, height) {
  return { width: Math.floor(width * .9), height: Math.floor(Math.min(height * .7, width * .48)) };
}

export function preferredCamera(cameras) {
  // Only favor confidently named standard rear lenses. Unknown labels keep the
  // browser's environment choice; never guess based on device enumeration order.
  return cameras.find(c => /^(back|rear) camera$/i.test(c.label?.trim())) ||
    cameras.find(c => /back|rear|environment/i.test(c.label) && /wide|main|standard/i.test(c.label) && !/ultra|tele|dual|triple/i.test(c.label));
}

/** Do not enable camera controls until the stream and decoder are ready. */
export function waitForScannerReady(engine, video, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (engine.isScanning && video?.readyState >= 2 && video.videoWidth > 0 && video.clientWidth > 0) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('Camera permission was granted, but the video did not become ready. Tap Start scanning to retry.'));
      }
    };
    const timer = setInterval(check, 50);
    check();
  });
}

export function cameraErrorMessage(error) {
  const detail = typeof error === 'string' ? error : [error?.name, error?.message].filter(Boolean).join(': ');
  const explanation = /NotAllowed|Permission.*denied/i.test(detail) ? 'Camera access was denied. Allow it in browser settings, or enter an ISBN.' :
    /NotFound|DevicesNotFound/i.test(detail) ? 'No matching camera was found. Select another camera or enter an ISBN.' :
    /NotReadable|TrackStart/i.test(detail) ? 'The camera is busy. Close other apps using it, then try again.' :
    'The scanner could not start. Tap Start scanning to retry, or enter an ISBN.';
  return detail ? `${explanation} Details: ${detail.slice(0, 350)}` : explanation;
}

export class BookScanner {
  constructor({ onScan, toast, createEngine = id => new BarcodeCamera(id) }) {
    this.createEngine = createEngine;
    this.onScan = onScan;
    this.toast = toast;
    this.engine = null;
    this.running = false;
    this.busy = false;
    this.suspended = false;
    this.nextScanAt = 0;
    this.torchOn = false;
    this.reader = document.getElementById('reader');
    this.buttons = ['camera-toggle', 'camera-start'].map(id => document.getElementById(id));
    this.choice = document.getElementById('camera-choice');
    this.torchButton = document.getElementById('torch');
    this.buttons.forEach(button => button.addEventListener('click', () => this.toggle()));
    this.choice.addEventListener('change', () => this.changeCamera());
    this.torchButton.addEventListener('click', () => this.toggleTorch());
    // Apply iOS inline attributes as soon as the library inserts a video, before
    // start() resolves. Do not crop, transform, or mirror the rendered stream.
    this.observer = new MutationObserver(() => this.setInline());
    this.observer.observe(this.reader, { childList: true, subtree: true });
    // Reopen after rotation so the camera can renegotiate portrait/landscape.
    this.viewportWidth = window.innerWidth;
    window.addEventListener('resize', () => {
      if (this.viewportWidth === window.innerWidth) return;
      this.viewportWidth = window.innerWidth;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(async () => {
        if (this.running && !this.busy) {
          const id = this.choice.value || undefined;
          await this.stop();
          await this.start(id);
        }
      }, 350);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.running && !this.busy) this.stop();
    });
    window.addEventListener('pagehide', () => {
      this.engine?.stop();
      this.reader.querySelector('video')?.srcObject?.getTracks().forEach(track => track.stop());
    });
  }

  setInline() {
    this.reader.querySelectorAll('video').forEach(video => {
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.muted = true;
    });
  }

  update(message) {
    this.buttons.forEach(button => { button.disabled = this.busy; });
    this.buttons[0].textContent = this.busy ? 'Please wait…' : this.running ? 'Pause camera' : this.engine ? 'Resume camera' : 'Start camera';
    document.getElementById('camera-idle').hidden = this.running || this.busy;
    document.getElementById('camera-status').textContent = message || (this.running ? '● Ready for the next book' : 'Camera is off');
    this.choice.disabled = this.busy;
  }

  async toggle() {
    if (this.busy) return;
    if (this.running) await this.stop();
    else await this.start(this.choice.value || undefined);
  }

  async start(deviceId) {
    if (this.busy || this.running) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.toast('Camera access needs HTTPS or localhost. You can still enter an ISBN.', 'error');
      return;
    }
    this.busy = true;
    this.runtimeError = null;
    this.update('Opening camera…');
    try {
      let devices = [];
      try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch { /* Device labels are optional. */ }
      // If permission already exposes device labels, choose the main lens before
      // opening it. On first use let Safari select environment; never immediately
      // stop a newly opened stream merely to change lenses.
      const requestedId = deviceId || preferredCamera(devices)?.deviceId;
      if (!this.engine) this.engine = this.createEngine('reader');
      await this.engine.start(requestedId ? { deviceId: { exact: requestedId } } : { facingMode: 'environment' }, {
        fps: 8, qrbox: scanBox
      }, text => this.confirmDetection(text), error => {
        this.runtimeError = error;
        this.toast(error.message || 'Barcode decoding failed. Restart the camera.', 'error');
        void this.stop();
      });
      this.setInline();
      await waitForScannerReady(this.engine, this.reader.querySelector('video'));
      this.running = true;
      try { devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch { /* Current camera still works. */ }
      let currentId = requestedId || '';
      try { currentId = this.engine.getRunningTrackSettings()?.deviceId || currentId; } catch { /* Settings are optional on older browsers. */ }
      this.choice.replaceChildren(...devices.map((device, i) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Camera ${i + 1}`;
        return option;
      }));
      this.choice.value = currentId;
      document.getElementById('camera-choice-label').hidden = devices.length < 2;
      let capabilities = {};
      try { capabilities = this.engine.getRunningTrackCapabilities() || {}; } catch { /* Older Safari. */ }
      // Focus constraints are best effort, with no fixed zoom or resolution that
      // might reject older phones or select a long-focus telephoto lens.
      if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
        try { await this.engine.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* Use native autofocus. */ }
      }
      this.torchButton.hidden = !capabilities.torch;
      this.torchOn = false;
      this.torchButton.textContent = 'Light off';
      this.torchButton.setAttribute('aria-pressed', 'false');
      if (this.suspended) this.engine.pause();
    } catch (error) {
      console.error('Bookscan camera startup failed:', error);
      // The engine may own a stream even when startup never reached `running`.
      // Keep references before stop() removes the video's tracks and DOM node.
      const tracks = this.reader.querySelector('video')?.srcObject?.getTracks() || [];
      try { await this.engine?.stop(); } catch { /* Startup may already have cleaned up. */ }
      tracks.forEach(track => track.stop());
      this.running = false;
      try { this.engine?.clear(); } catch { /* Already cleared. */ }
      this.engine = null; // Never reuse an engine with a failed state transition.
      this.reader.replaceChildren();
      this.torchButton.hidden = true;
      const message = cameraErrorMessage(error);
      document.getElementById('camera-hint').textContent = message;
      this.toast(message, 'error');
    } finally {
      this.busy = false;
      this.update(this.suspended && this.running ? 'Paused while book details are open' : undefined);
      if ((document.hidden || this.runtimeError) && this.running) await this.stop();
    }
  }

  async stop() {
    if (this.busy || !this.running) return;
    this.busy = true;
    this.candidate = null;
    this.update('Pausing camera…');
    try { await this.engine.stop(); }
    catch {
      this.reader.querySelector('video')?.srcObject?.getTracks().forEach(track => track.stop());
      this.engine = null;
    } finally {
      this.running = false;
      this.busy = false;
      this.torchButton.hidden = true;
      this.reader.replaceChildren();
      this.update('Camera paused');
    }
  }

  async changeCamera() {
    const id = this.choice.value;
    if (this.running) { await this.stop(); await this.start(id); }
  }

  suspend(value) {
    this.suspended = value;
    this.candidate = null;
    if (this.running && !this.busy) {
      try {
        if (value) this.engine.pause();
        else { this.nextScanAt = Date.now() + 2000; this.engine.resume(); }
      } catch { /* State may have changed during camera switching. */ }
      this.update(value ? 'Paused while book details are open' : undefined);
    }
  }

  confirmDetection(text) {
    if (this.suspended || this.busy || Date.now() < this.nextScanAt) return;
    let isbn;
    try { isbn = normalizeIsbn(text); } catch { return; }
    const now = Date.now();
    if (this.candidate?.isbn === isbn && now - this.candidate.at < 1000) {
      this.candidate = null;
      this.detect(isbn);
    } else this.candidate = { isbn, at: now };
  }

  detect(text) {
    if (this.suspended || this.busy || Date.now() < this.nextScanAt) return;
    let isbn;
    try { isbn = normalizeIsbn(text); } catch { return; } // Ignore UPCs and invalid checksums.
    // Set synchronously, before any DB or network await, so successive frames
    // cannot enqueue duplicates. The stream stays live and resumes automatically.
    this.nextScanAt = Date.now() + 2000;
    try { navigator.vibrate?.(100); } catch { /* Optional hardware feature. */ }
    this.onScan(isbn);
  }

  async toggleTorch() {
    if (!this.running || this.busy) return;
    this.torchButton.disabled = true;
    try {
      await this.engine.applyVideoConstraints({ advanced: [{ torch: !this.torchOn }] });
      this.torchOn = !this.torchOn;
      this.torchButton.textContent = this.torchOn ? 'Light on' : 'Light off';
      this.torchButton.setAttribute('aria-pressed', String(this.torchOn));
    } catch { this.toast('This camera could not change its light.'); }
    finally { this.torchButton.disabled = false; }
  }
}
