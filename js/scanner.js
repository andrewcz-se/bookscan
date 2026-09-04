/**
 * BookScan Camera Scanner Module
 * Powered by Html5Qrcode
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
    this.isPaused = false;
    this.audioContext = null;
    this.hasFlashlight = false;
    this.isFlashlightOn = false;
    this.pauseTimeout = null;
  }

  /**
   * Initializes Web Audio synthesizer for pleasant scan sound
   */
  initAudio() {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioContext = new AudioCtx();
      }
    }
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
  }

  /**
   * Play a clean, modern two-tone success chime
   */
  playSuccessSound() {
    try {
      this.initAudio();
      if (!this.audioContext) return;

      const now = this.audioContext.currentTime;
      
      // Tone 1: 587 Hz (D5)
      const osc1 = this.audioContext.createOscillator();
      const gain1 = this.audioContext.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.15, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc1.connect(gain1);
      gain1.connect(this.audioContext.destination);
      osc1.start(now);
      osc1.stop(now + 0.12);

      // Tone 2: 880 Hz (A5)
      const osc2 = this.audioContext.createOscillator();
      const gain2 = this.audioContext.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.08);
      gain2.gain.setValueAtTime(0.2, now + 0.08);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc2.connect(gain2);
      gain2.connect(this.audioContext.destination);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.28);
    } catch (e) {
      console.warn('Audio feedback error:', e);
    }
  }

  /**
   * Trigger hardware haptic feedback vibration
   */
  triggerHaptics() {
    try {
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(100);
      }
    } catch (e) {
      // Ignored if device doesn't support or disallows vibration
    }
  }

  /**
   * Start camera with rear facingMode & continuous scanning
   */
  async start() {
    if (this.isScanning) return;

    // Ensure audio context is ready on user gesture
    this.initAudio();

    if (!this.html5QrCode) {
      // Html5Qrcode is loaded globally via CDN
      const formats = (typeof Html5QrcodeSupportedFormats !== 'undefined') ? [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.QR_CODE
      ] : undefined;

      const opts = { verbose: false };
      if (formats) {
        opts.formatsToSupport = formats;
      }

      this.html5QrCode = new Html5Qrcode(this.elementId, opts);
    }

    const config = {
      fps: 15,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        return {
          width: Math.floor(minEdge * 0.85),
          height: Math.floor(minEdge * 0.55)
        };
      },
      aspectRatio: 1.333334,
      disableFlip: false
    };

    try {
      this.notifyStatus('starting');
      
      // Request rear camera explicitly with environment facingMode
      await this.html5QrCode.start(
        { facingMode: 'environment' },
        config,
        (decodedText, decodedResult) => this.handleScanSuccess(decodedText, decodedResult),
        (errorMessage) => {
          // Standard frame-by-frame non-match; do not spam logs
        }
      );

      this.isScanning = true;
      this.isPaused = false;
      this.applyIosVideoFixes();
      await this.checkFlashlightSupport();
      this.notifyStatus('active');
    } catch (err) {
      console.error('Failed to start scanner:', err);
      this.isScanning = false;
      this.notifyStatus('error', err);
      throw err;
    }
  }

  /**
   * Apply playsinline attributes to video element for iOS Safari compatibility
   */
  applyIosVideoFixes() {
    const video = document.querySelector(`#${this.elementId} video`);
    if (video) {
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.playsInline = true;
      video.muted = true;
    }
  }

  /**
   * Checks if the device video track supports torch/flashlight
   */
  async checkFlashlightSupport() {
    try {
      const track = this.getVideoTrack();
      if (track) {
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        this.hasFlashlight = !!capabilities.torch;
      } else {
        this.hasFlashlight = false;
      }
    } catch (e) {
      this.hasFlashlight = false;
    }
  }

  /**
   * Toggles camera torch / flashlight
   */
  async toggleFlashlight() {
    if (!this.hasFlashlight || !this.isScanning) return false;
    try {
      const track = this.getVideoTrack();
      if (track) {
        this.isFlashlightOn = !this.isFlashlightOn;
        await track.applyConstraints({
          advanced: [{ torch: this.isFlashlightOn }]
        });
        return this.isFlashlightOn;
      }
    } catch (e) {
      console.warn('Torch toggle failed:', e);
      this.isFlashlightOn = false;
    }
    return false;
  }

  /**
   * Helper to retrieve active media stream video track
   */
  getVideoTrack() {
    const video = document.querySelector(`#${this.elementId} video`);
    if (video && video.srcObject && video.srcObject.getVideoTracks) {
      return video.srcObject.getVideoTracks()[0];
    }
    return null;
  }

  /**
   * Handles continuous scanning with 2-second pause and checkmark overlay
   */
  async handleScanSuccess(decodedText, decodedResult) {
    if (this.isPaused || !this.isScanning) return;

    // Pause continuous scan
    this.isPaused = true;
    try {
      this.html5QrCode.pause(true);
    } catch (e) {
      // Html5Qrcode pause
    }

    // Play feedback
    this.playSuccessSound();
    this.triggerHaptics();

    // Show visual checkmark & notify listeners
    this.showSuccessOverlay();

    if (this.onScanSuccess) {
      try {
        await this.onScanSuccess(decodedText, decodedResult);
      } catch (err) {
        console.error('Scan handler error:', err);
      }
    }

    // Continuous Scan Loop: automatically resume scanning after 2 seconds
    clearTimeout(this.pauseTimeout);
    this.pauseTimeout = setTimeout(() => {
      this.hideSuccessOverlay();
      if (this.isScanning) {
        try {
          this.html5QrCode.resume();
        } catch (e) {
          // Ignore resume issues if stopped
        }
        this.isPaused = false;
      }
    }, 2000);
  }

  /**
   * Show visual checkmark overlay
   */
  showSuccessOverlay() {
    const overlay = document.getElementById('scan-success-overlay');
    if (overlay) {
      overlay.classList.remove('hidden');
      overlay.classList.add('flex');
    }
  }

  /**
   * Hide visual checkmark overlay
   */
  hideSuccessOverlay() {
    const overlay = document.getElementById('scan-success-overlay');
    if (overlay) {
      overlay.classList.add('hidden');
      overlay.classList.remove('flex');
    }
  }

  /**
   * Stop scanner and release camera hardware
   */
  async stop() {
    clearTimeout(this.pauseTimeout);
    this.hideSuccessOverlay();
    
    if (this.html5QrCode && this.isScanning) {
      try {
        if (this.isFlashlightOn) {
          await this.toggleFlashlight();
        }
        await this.html5QrCode.stop();
        this.html5QrCode.clear();
      } catch (err) {
        console.warn('Error while stopping scanner:', err);
      }
    }

    this.isScanning = false;
    this.isPaused = false;
    this.isFlashlightOn = false;
    this.notifyStatus('stopped');
  }

  notifyStatus(status, data) {
    if (this.onStatusChange) {
      this.onStatusChange(status, data);
    }
  }
}

export default BookScanner;
