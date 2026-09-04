/**
 * BookScan Camera Scanner Module
 * Powered by Html5Qrcode with hardware-accelerated BarcodeDetector and multi-camera support
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
    this.availableCameras = [];
    this.currentCameraIndex = 0;
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

    this.initAudio();

    if (!this.html5QrCode) {
      // Formats optimized for book barcodes (EAN-13, EAN-8, UPC, Code 128)
      const formats = (typeof Html5QrcodeSupportedFormats !== 'undefined') ? [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.QR_CODE
      ] : undefined;

      // Enable native hardware BarcodeDetector (iOS 17+ & Android Chrome) for sub-100ms decoding
      const opts = {
        verbose: false,
        experimentalFeatures: {
          useBarCodeDetectorIfSupported: true
        }
      };

      if (formats) {
        opts.formatsToSupport = formats;
      }

      this.html5QrCode = new Html5Qrcode(this.elementId, opts);
    }

    // Wide rectangular scan box tailored for 1D ISBN barcodes
    const config = {
      fps: 10,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const width = Math.min(Math.floor(viewfinderWidth * 0.94), 480);
        const height = Math.min(Math.floor(viewfinderHeight * 0.65), 240);
        return { width, height };
      },
      aspectRatio: 1.333334,
      disableFlip: false,
      videoConstraints: {
        facingMode: 'environment',
        focusMode: 'continuous',
        width: { min: 640, ideal: 1280, max: 1920 },
        height: { min: 480, ideal: 720, max: 1080 }
      }
    };

    try {
      this.notifyStatus('starting');

      // Discover cameras
      let cameraConfig = { facingMode: 'environment' };
      try {
        const cameras = await Html5Qrcode.getCameras();
        if (cameras && cameras.length > 0) {
          this.availableCameras = cameras;

          // Filter for rear/back cameras
          const backCameras = cameras.filter(c => {
            const label = (c.label || '').toLowerCase();
            return label.includes('back') || label.includes('rear') || label.includes('environment');
          });

          if (backCameras.length > 0) {
            // Avoid ultra-wide lenses (fixed focus) in favor of standard wide main lens
            const standardBack = backCameras.find(c => {
              const label = (c.label || '').toLowerCase();
              return !label.includes('ultra') && !label.includes('0.5');
            }) || backCameras[0];

            this.currentCameraIndex = cameras.findIndex(c => c.id === standardBack.id);
            cameraConfig = standardBack.id;
          }
        }
      } catch (e) {
        console.warn('Camera enumeration error, falling back to facingMode constraint:', e);
      }
      
      // Start camera stream
      try {
        await this.html5QrCode.start(
          cameraConfig,
          config,
          (decodedText, decodedResult) => this.handleScanSuccess(decodedText, decodedResult),
          (errorMessage) => {
            // Frame non-match
          }
        );
      } catch (firstErr) {
        console.warn('Initial camera start failed, retrying with basic constraints:', firstErr);
        // Fallback to basic facingMode constraint if camera ID / advanced constraints failed
        await this.html5QrCode.start(
          { facingMode: 'environment' },
          { fps: 10, aspectRatio: 1.333334 },
          (decodedText, decodedResult) => this.handleScanSuccess(decodedText, decodedResult),
          () => {}
        );
      }

      this.isScanning = true;
      this.isPaused = false;
      this.applyIosVideoFixes();
      await this.applyContinuousFocus();
      await this.checkFlashlightSupport();
      this.setupTapToFocus();
      this.notifyStatus('active', { 
        cameraCount: this.availableCameras.length,
        hasMultipleCameras: this.availableCameras.length > 1 
      });
    } catch (err) {
      console.error('Failed to start scanner:', err);
      this.isScanning = false;
      this.notifyStatus('error', err);
      throw err;
    }
  }

  /**
   * Switch between available cameras (e.g. multi-lens phones)
   */
  async switchCamera() {
    if (!this.isScanning || this.availableCameras.length <= 1) return;
    this.currentCameraIndex = (this.currentCameraIndex + 1) % this.availableCameras.length;
    const nextCamera = this.availableCameras[this.currentCameraIndex];
    
    await this.stop();
    await this.start();
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
   * Enforces continuous autofocus on the active camera video track
   */
  async applyContinuousFocus() {
    try {
      const track = this.getVideoTrack();
      if (track && track.applyConstraints) {
        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        const advanced = [];
        if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
          advanced.push({ focusMode: 'continuous' });
        }
        if (capabilities.exposureMode && capabilities.exposureMode.includes('continuous')) {
          advanced.push({ exposureMode: 'continuous' });
        }
        if (advanced.length > 0) {
          await track.applyConstraints({ advanced });
        }
      }
    } catch (e) {
      console.warn('Continuous focus constraint not supported on this device:', e);
    }
  }

  /**
   * Setup tap-to-refocus on camera preview
   */
  setupTapToFocus() {
    const container = document.getElementById(this.elementId);
    if (container && !container._hasTapFocusListener) {
      container._hasTapFocusListener = true;
      container.addEventListener('click', async () => {
        await this.applyContinuousFocus();
      });
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
