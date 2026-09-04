/**
 * BookScan camera scanner.
 *
 * Keep the camera policy deliberately small: ask the browser for its default
 * rear camera, scan only Bookland EAN-13 barcodes, and let the phone manage
 * lens selection. This is more reliable than guessing from device labels on
 * multi-camera phones.
 */

class BookScanner {
  constructor({
    elementId = 'reader',
    onScanSuccess,
    onScanError,
    onStatusChange
  } = {}) {
    this.elementId = elementId;
    this.onScanSuccess = onScanSuccess;
    this.onScanError = onScanError;
    this.onStatusChange = onStatusChange;

    this.html5QrCode = null;
    this.isScanning = false;
    this.isStarting = false;
    this.isPaused = false;
    this.audioContext = null;
    this.hasFlashlight = false;
    this.isFlashlightOn = false;
    this.pauseTimeout = null;

    // Confirm a value on two nearby frames. This costs only a fraction of a
    // second at 15 fps and rejects most single-frame misreads.
    this.candidateCode = '';
    this.candidateSeenAt = 0;
    this.lastAcceptedCode = '';
    this.lastAcceptedAt = 0;
  }

  initAudio() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.audioContext = new AudioCtx();
    }
    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }
  }

  playSuccessSound() {
    try {
      this.initAudio();
      if (!this.audioContext) return;

      const now = this.audioContext.currentTime;
      const playTone = (frequency, startsAt, endsAt, volume) => {
        const oscillator = this.audioContext.createOscillator();
        const gain = this.audioContext.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, startsAt);
        gain.gain.setValueAtTime(volume, startsAt);
        gain.gain.exponentialRampToValueAtTime(0.001, endsAt);
        oscillator.connect(gain);
        gain.connect(this.audioContext.destination);
        oscillator.start(startsAt);
        oscillator.stop(endsAt);
      };

      playTone(587.33, now, now + 0.12, 0.15);
      playTone(880, now + 0.08, now + 0.28, 0.2);
    } catch (error) {
      console.warn('Audio feedback error:', error);
    }
  }

  triggerHaptics() {
    try {
      navigator.vibrate?.(80);
    } catch (_) {
      // Vibration is optional and is not supported by iOS Safari.
    }
  }

  createScanner() {
    if (this.html5QrCode) return;

    const options = {
      verbose: false,
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true
      }
    };

    // A printed book ISBN barcode is EAN-13. Restricting the decoder to that
    // one format makes each frame faster and avoids QR/UPC false positives.
    if (typeof Html5QrcodeSupportedFormats !== 'undefined') {
      options.formatsToSupport = [Html5QrcodeSupportedFormats.EAN_13];
    }

    this.html5QrCode = new Html5Qrcode(this.elementId, options);
  }

  getScanConfig(useVideoConstraints = true) {
    const config = {
      fps: 15,
      disableFlip: true,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const width = Math.min(Math.floor(viewfinderWidth * 0.92), 720);
        const height = Math.min(
          Math.max(Math.floor(width * 0.36), 110),
          Math.floor(viewfinderHeight * 0.55)
        );
        return { width, height };
      }
    };

    if (useVideoConstraints) {
      // videoConstraints intentionally owns the complete camera request. In
      // Html5Qrcode it overrides the first start() argument and aspectRatio.
      config.videoConstraints = {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 }
      };
    }

    return config;
  }

  async start() {
    if (this.isScanning || this.isStarting) return;
    this.isStarting = true;
    this.initAudio();
    this.createScanner();
    this.notifyStatus('starting');

    const onSuccess = (decodedText, decodedResult) => {
      this.handleScanSuccess(decodedText, decodedResult);
    };

    try {
      try {
        await this.html5QrCode.start(
          { facingMode: 'environment' },
          this.getScanConfig(true),
          onSuccess,
          () => {}
        );
      } catch (preferredError) {
        console.warn('Preferred camera settings failed; retrying with browser defaults:', preferredError);
        await this.html5QrCode.start(
          { facingMode: 'environment' },
          this.getScanConfig(false),
          onSuccess,
          () => {}
        );
      }

      this.isScanning = true;
      this.isPaused = false;
      this.applyVideoFixes();
      await this.applyContinuousFocus();
      await this.checkFlashlightSupport();
      this.notifyStatus('active');
    } catch (error) {
      console.error('Failed to start scanner:', error);
      this.isScanning = false;
      this.notifyStatus('error', error);
      throw error;
    } finally {
      this.isStarting = false;
    }
  }

  applyVideoFixes() {
    const video = document.querySelector(`#${this.elementId} video`);
    if (!video) return;

    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.playsInline = true;
    video.muted = true;
    video.autoplay = true;
  }

  async applyContinuousFocus() {
    try {
      const track = this.getVideoTrack();
      if (!track?.applyConstraints) return;

      const capabilities = track.getCapabilities?.() || {};
      const advanced = [];
      if (capabilities.focusMode?.includes('continuous')) {
        advanced.push({ focusMode: 'continuous' });
      }
      if (capabilities.exposureMode?.includes('continuous')) {
        advanced.push({ exposureMode: 'continuous' });
      }
      if (advanced.length) await track.applyConstraints({ advanced });
    } catch (error) {
      console.info('Camera manages focus automatically on this device.', error);
    }
  }

  async checkFlashlightSupport() {
    try {
      const capabilities = this.getVideoTrack()?.getCapabilities?.() || {};
      this.hasFlashlight = capabilities.torch === true;
    } catch (_) {
      this.hasFlashlight = false;
    }
  }

  async toggleFlashlight() {
    if (!this.hasFlashlight || !this.isScanning) return false;

    try {
      const track = this.getVideoTrack();
      if (!track) return false;
      const nextState = !this.isFlashlightOn;
      await track.applyConstraints({ advanced: [{ torch: nextState }] });
      this.isFlashlightOn = nextState;
      return nextState;
    } catch (error) {
      console.warn('Torch toggle failed:', error);
      this.isFlashlightOn = false;
      return false;
    }
  }

  getVideoTrack() {
    const video = document.querySelector(`#${this.elementId} video`);
    return video?.srcObject?.getVideoTracks?.()[0] || null;
  }

  normalizeBooklandCode(decodedText) {
    const code = String(decodedText || '').replace(/\D/g, '');
    if (!/^(978|979)\d{10}$/.test(code)) return '';

    let sum = 0;
    for (let index = 0; index < 12; index += 1) {
      sum += Number(code[index]) * (index % 2 === 0 ? 1 : 3);
    }
    const expectedCheckDigit = (10 - (sum % 10)) % 10;
    return expectedCheckDigit === Number(code[12]) ? code : '';
  }

  handleScanSuccess(decodedText, decodedResult) {
    if (this.isPaused || !this.isScanning) return;

    const code = this.normalizeBooklandCode(decodedText);
    if (!code) {
      this.onScanError?.('The detected barcode is not a valid ISBN-13.');
      return;
    }

    const now = Date.now();
    const isConfirmation = code === this.candidateCode && now - this.candidateSeenAt < 1200;
    this.candidateCode = code;
    this.candidateSeenAt = now;
    if (!isConfirmation) return;

    // Do not repeatedly add the same stationary book, but allow the next
    // different book immediately.
    if (code === this.lastAcceptedCode && now - this.lastAcceptedAt < 4000) return;
    this.lastAcceptedCode = code;
    this.lastAcceptedAt = now;
    this.candidateCode = '';

    this.isPaused = true;
    try {
      this.html5QrCode.pause(false);
    } catch (_) {
      // The state guard above still prevents duplicate callbacks.
    }

    this.playSuccessSound();
    this.triggerHaptics();
    this.showSuccessOverlay();

    Promise.resolve(this.onScanSuccess?.(code, decodedResult)).catch((error) => {
      console.error('Scan handler error:', error);
    });

    clearTimeout(this.pauseTimeout);
    this.pauseTimeout = setTimeout(() => {
      this.hideSuccessOverlay();
      if (!this.isScanning) return;
      try {
        this.html5QrCode.resume();
      } catch (_) {
        // The camera may have been stopped while the timer was pending.
      }
      this.isPaused = false;
    }, 900);
  }

  showSuccessOverlay() {
    const overlay = document.getElementById('scan-success-overlay');
    overlay?.classList.remove('hidden');
    overlay?.classList.add('flex');
  }

  hideSuccessOverlay() {
    const overlay = document.getElementById('scan-success-overlay');
    overlay?.classList.add('hidden');
    overlay?.classList.remove('flex');
  }

  async stop() {
    clearTimeout(this.pauseTimeout);
    this.hideSuccessOverlay();

    if (this.html5QrCode && (this.isScanning || this.isStarting)) {
      try {
        if (this.isFlashlightOn) await this.toggleFlashlight();
        await this.html5QrCode.stop();
        this.html5QrCode.clear();
      } catch (error) {
        console.warn('Error while stopping scanner:', error);
      }
    }

    this.isScanning = false;
    this.isStarting = false;
    this.isPaused = false;
    this.isFlashlightOn = false;
    this.hasFlashlight = false;
    this.candidateCode = '';
    this.notifyStatus('stopped');
  }

  notifyStatus(status, data) {
    try {
      this.onStatusChange?.(status, data);
    } catch (error) {
      // UI code must never be able to disable an otherwise working scanner.
      console.error('Scanner status handler error:', error);
    }
  }
}

export default BookScanner;
