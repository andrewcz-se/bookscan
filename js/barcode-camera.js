/** Map the visible guide to camera pixels, independently of CSS/device scale. */
export function captureRegion(video, scanBox) {
  const width = video.clientWidth, height = video.clientHeight;
  const box = scanBox(width, height);
  const sourceWidth = Math.max(1, Math.floor(box.width / width * video.videoWidth));
  const sourceHeight = Math.max(1, Math.floor(box.height / height * video.videoHeight));
  return {
    x: Math.floor((video.videoWidth - sourceWidth) / 2),
    y: Math.floor((video.videoHeight - sourceHeight) / 2),
    width: sourceWidth, height: sourceHeight, box
  };
}

/** Owns camera acquisition and a single in-flight background decode. */
export class BarcodeCamera {
  constructor(id) {
    this.reader = document.getElementById(id);
    this.isScanning = false;
    this.generation = 0;
  }

  async start(camera, config, onScan, onError) {
    const generation = ++this.generation;
    this.lastVideoTime = undefined;
    this.paused = false;
    this.config = config;
    this.onScan = onScan;
    this.onError = onError;
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', 'true');
    this.video.setAttribute('webkit-playsinline', 'true');
    this.video.muted = true;
    this.video.autoplay = true;
    this.guide = document.createElement('div');
    this.guide.className = 'barcode-guide';
    this.guide.setAttribute('aria-hidden', 'true');
    this.reader.replaceChildren(this.video, this.guide);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        ...camera, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }
      } });
      if (generation !== this.generation) throw new Error('Camera startup was cancelled.');
      this.video.srcObject = this.stream;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Camera video did not start. Please retry.')), 10000);
        this.video.play().then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
      });
      if (generation !== this.generation) throw new Error('Camera startup was cancelled.');
      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!this.context) throw new Error('Camera image processing is unavailable.');
      this.worker = new Worker(new URL('./barcode-worker.js', import.meta.url), { type: 'module' });
      await new Promise((resolve, reject) => {
        this.startReject = reject;
        this.watchdog = setTimeout(() => reject(new Error('Barcode decoder took too long to load. Reload and retry.')), 15000);
        this.worker.onerror = () => this.fail(new Error('Barcode decoder failed. Reload and retry.'));
        this.worker.onmessage = ({ data }) => {
          clearTimeout(this.watchdog);
          if (data.type === 'error') { this.fail(new Error(data.message)); return; }
          if (data.type === 'ready') { this.startReject = null; resolve(); return; }
          this.inFlight = false;
          if (!this.isScanning) return;
          if (!this.paused && data.generation === this.generation) {
            data.texts.forEach(text => this.onScan(text));
          }
          this.schedule();
        };
      });
      if (generation !== this.generation) throw new Error('Camera startup was cancelled.');
      this.isScanning = true;
      this.schedule();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  fail(error) {
    if (this.startReject) { this.startReject(error); this.startReject = null; }
    else if (this.isScanning) this.onError(error);
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.isScanning || this.paused || this.inFlight) return;
    this.timer = setTimeout(() => this.capture(), 1000 / this.config.fps);
  }

  capture() {
    if (!this.isScanning || this.paused || this.inFlight) return;
    const video = this.video;
    if (video.readyState < 2 || !video.videoWidth || !video.clientWidth || !video.clientHeight) {
      this.schedule(); return;
    }
    if (Number.isFinite(video.currentTime) && video.currentTime === this.lastVideoTime) {
      this.schedule(); return;
    }
    this.lastVideoTime = video.currentTime;
    try {
      const region = captureRegion(video, this.config.qrbox);
      this.guide.style.width = `${region.box.width}px`;
      this.guide.style.height = `${region.box.height}px`;
      // Cap unusually large streams, never upscale a low-resolution camera.
      const scale = Math.min(1, 1920 / Math.max(region.width, region.height));
      this.canvas.width = Math.max(1, Math.floor(region.width * scale));
      this.canvas.height = Math.max(1, Math.floor(region.height * scale));
      this.context.drawImage(video, region.x, region.y, region.width, region.height,
        0, 0, this.canvas.width, this.canvas.height);
      const pixels = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
      this.inFlight = true;
      this.watchdog = setTimeout(() => this.fail(new Error('Barcode decoder stopped responding. Restart the camera.')), 10000);
      this.worker.postMessage({ generation: this.generation,
        frame: { data: pixels.data, width: pixels.width, height: pixels.height }
      }, [pixels.data.buffer]);
    } catch (error) { this.fail(error); }
  }

  pause() {
    this.paused = true;
    this.generation++;
    clearTimeout(this.timer);
  }

  resume() { this.paused = false; this.schedule(); }

  async stop() {
    this.isScanning = false;
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    this.startReject?.(new Error('Camera startup was cancelled.'));
    this.startReject = null;
    this.worker?.terminate();
    this.worker = null;
    this.inFlight = false;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }

  clear() { this.reader.replaceChildren(); }
  getRunningTrackSettings() { return this.stream?.getVideoTracks()[0]?.getSettings?.(); }
  getRunningTrackCapabilities() { return this.stream?.getVideoTracks()[0]?.getCapabilities?.(); }
  applyVideoConstraints(constraints) { return this.stream.getVideoTracks()[0].applyConstraints(constraints); }
}
