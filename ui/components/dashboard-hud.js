// Dashboard HUD Overlay - WiFi DensePose 3D Visualization
// Connection status, FPS counter, detection confidence, person count, sensing mode

export class DashboardHUD {
  constructor(container) {
    this.container = typeof container === 'string'
      ? document.getElementById(container)
      : container;

    // State
    this.state = {
      connectionStatus: 'disconnected', // connected, disconnected, connecting, error
      isRealData: false,
      fps: 0,
      confidence: 0,
      personCount: 0,
      sensingMode: 'Mock',    // CSI, RSSI, Mock
      latency: 0,
      messageCount: 0,
      uptime: 0,
      heartRate: 0,
      breathingRate: 0
    };

    this._fpsFrames = [];
    this._lastFpsUpdate = 0;

    // Callback pointers for custom 3D model interaction
    this.onModelUpload = null;
    this.onTransformChange = null;
    this.onClearModel = null;

    this._build();
    this._bindEvents();
  }

  _build() {
    // Create HUD overlay container
    this.hudElement = document.createElement('div');
    this.hudElement.id = 'viz-hud';
    this.hudElement.innerHTML = `
      <style>
        #viz-hud {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          pointer-events: none;
          z-index: 100;
          font-family: 'Courier New', 'Consolas', monospace;
          color: #88ccff;
        }

        /* Data source banner */
        .hud-banner {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          text-align: center;
          padding: 6px 0;
          font-size: 14px;
          font-weight: bold;
          letter-spacing: 3px;
          text-transform: uppercase;
          z-index: 110;
        }
        .hud-banner.mock {
          background: linear-gradient(90deg, rgba(180,100,0,0.85) 0%, rgba(200,120,0,0.85) 50%, rgba(180,100,0,0.85) 100%);
          color: #fff;
          border-bottom: 2px solid #ff8800;
        }
        .hud-banner.real {
          background: linear-gradient(90deg, rgba(0,120,60,0.85) 0%, rgba(0,160,80,0.85) 50%, rgba(0,120,60,0.85) 100%);
          color: #fff;
          border-bottom: 2px solid #00ff66;
          animation: pulse-green 2s ease-in-out infinite;
        }
        @keyframes pulse-green {
          0%, 100% { border-bottom-color: #00ff66; }
          50% { border-bottom-color: #00cc44; }
        }

        /* Top-left: connection info */
        .hud-top-left {
          position: absolute;
          top: 40px;
          left: 12px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .hud-row {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          line-height: 1.4;
        }
        .hud-label {
          color: #5588aa;
          min-width: 65px;
          text-transform: uppercase;
          font-size: 9px;
          letter-spacing: 1px;
        }
        .hud-value {
          color: #aaddff;
          font-weight: bold;
          font-size: 12px;
        }

        /* Status dot */
        .hud-status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
          margin-right: 4px;
        }
        .hud-status-dot.connected {
          background: #00ff66;
          box-shadow: 0 0 6px #00ff66;
        }
        .hud-status-dot.disconnected {
          background: #666;
        }
        .hud-status-dot.connecting {
          background: #ffaa00;
          box-shadow: 0 0 6px #ffaa00;
          animation: blink 1s infinite;
        }
        .hud-status-dot.error {
          background: #ff3344;
          box-shadow: 0 0 6px #ff3344;
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }

        /* Top-right: performance */
        .hud-top-right {
          position: absolute;
          top: 40px;
          right: 12px;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
        }
        .hud-fps {
          font-size: 22px;
          font-weight: bold;
          color: #00ff88;
          line-height: 1;
        }
        .hud-fps.low { color: #ff4444; }
        .hud-fps.mid { color: #ffaa00; }
        .hud-fps.high { color: #00ff88; }

        /* Bottom-left: detection info */
        .hud-bottom-left {
          position: absolute;
          bottom: 12px;
          left: 12px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .hud-person-count {
          font-size: 28px;
          font-weight: bold;
          line-height: 1;
        }
        .hud-confidence-bar {
          width: 120px;
          height: 6px;
          background: rgba(20, 30, 50, 0.8);
          border: 1px solid #223344;
          border-radius: 3px;
          overflow: hidden;
        }
        .hud-confidence-fill {
          height: 100%;
          border-radius: 3px;
          transition: width 0.3s ease, background 0.3s ease;
        }

        /* Bottom-right: sensing mode */
        .hud-bottom-right {
          position: absolute;
          bottom: 12px;
          right: 12px;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 4px;
        }
        .hud-mode-badge {
          padding: 3px 10px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: bold;
          letter-spacing: 1px;
          text-transform: uppercase;
        }
        .hud-mode-badge.csi {
          background: rgba(0, 100, 200, 0.7);
          border: 1px solid #0088ff;
          color: #aaddff;
        }
        .hud-mode-badge.rssi {
          background: rgba(100, 0, 200, 0.7);
          border: 1px solid #8800ff;
          color: #ddaaff;
        }
        .hud-mode-badge.mock {
          background: rgba(120, 80, 0, 0.7);
          border: 1px solid #ff8800;
          color: #ffddaa;
        }

        /* Corner brackets decoration */
        .hud-corner {
          position: absolute;
          width: 20px;
          height: 20px;
          border-color: rgba(100, 150, 200, 0.3);
          border-style: solid;
        }
        .hud-corner.tl { top: 36px; left: 4px; border-width: 1px 0 0 1px; }
        .hud-corner.tr { top: 36px; right: 4px; border-width: 1px 1px 0 0; }
        .hud-corner.bl { bottom: 4px; left: 4px; border-width: 0 0 1px 1px; }
        .hud-corner.br { bottom: 4px; right: 4px; border-width: 0 1px 1px 0; }

        /* Controls hint */
        .hud-controls-hint {
          position: absolute;
          bottom: 50px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 10px;
          color: #445566;
          text-align: center;
          opacity: 0.6;
        }

        /* Navigation tabs switcher */
        .hud-nav-tabs {
          position: absolute;
          top: 40px;
          left: 50%;
          transform: translateX(-50%);
          display: flex;
          gap: 6px;
          background: rgba(13, 17, 33, 0.85);
          border: 1px solid rgba(0, 242, 254, 0.2);
          border-radius: 10px;
          padding: 3px;
          pointer-events: auto !important;
          z-index: 220;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .hud-nav-tabs * {
          pointer-events: auto !important;
        }
        .hud-nav-tab {
          padding: 6px 14px;
          font-size: 10px;
          font-family: 'Space Grotesk', sans-serif;
          color: #8a99ad;
          background: transparent;
          border: none;
          border-radius: 7px;
          cursor: pointer;
          font-weight: bold;
          text-transform: uppercase;
          letter-spacing: 1px;
          transition: all 0.25s ease;
        }
        .hud-nav-tab.active {
          color: #00ff88;
          background: rgba(0, 255, 136, 0.15);
          border: 1px solid rgba(0, 255, 136, 0.25);
        }
        .hud-nav-tab:hover:not(.active) {
          color: #fff;
          background: rgba(255, 255, 255, 0.05);
        }

        /* Settings panel styling */
        .hud-settings-toggle {
          position: absolute;
          top: 90px;
          right: 12px;
          width: 30px;
          height: 30px;
          background: rgba(13, 17, 33, 0.8);
          border: 1px solid rgba(0, 242, 254, 0.2);
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #8a99ad;
          cursor: pointer;
          pointer-events: auto !important;
          z-index: 210;
          transition: all 0.25s ease;
        }
        .hud-settings-toggle:hover {
          color: #00f2fe;
          border-color: rgba(0, 242, 254, 0.4);
          box-shadow: 0 0 10px rgba(0, 242, 254, 0.2);
        }
        .hud-settings-toggle * {
          pointer-events: none;
        }
        .hud-settings-panel {
          position: absolute;
          top: 130px;
          right: 12px;
          width: 250px;
          background: rgba(10, 14, 28, 0.95);
          border: 1px solid rgba(0, 242, 254, 0.2);
          border-radius: 12px;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          pointer-events: none;
          opacity: 0;
          transform: translateY(-10px);
          transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
          z-index: 210;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .hud-settings-panel.active {
          opacity: 1;
          transform: translateY(0);
          pointer-events: auto !important;
        }
        .hud-settings-panel * {
          pointer-events: auto;
        }
        .hud-form-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
      </style>

      <!-- Data source banner -->
      <div class="hud-banner mock" id="hud-banner">MOCK DATA</div>

      <!-- Navigation Tab Switcher -->
      <div class="hud-nav-tabs">
        <button class="hud-nav-tab" onclick="window.location.href='tracker.html' + window.location.search">2D Radar</button>
        <button class="hud-nav-tab active">3D Room</button>
      </div>

      <!-- Corner decorations -->
      <div class="hud-corner tl"></div>
      <div class="hud-corner tr"></div>
      <div class="hud-corner bl"></div>
      <div class="hud-corner br"></div>

      <!-- Top-left: connection info -->
      <div class="hud-top-left">
        <div class="hud-row">
          <span class="hud-status-dot disconnected" id="hud-status-dot"></span>
          <span class="hud-value" id="hud-conn-status">Disconnected</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Latency</span>
          <span class="hud-value" id="hud-latency">-- ms</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Messages</span>
          <span class="hud-value" id="hud-msg-count">0</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Uptime</span>
          <span class="hud-value" id="hud-uptime">0s</span>
        </div>
      </div>

      <!-- Top-right: FPS -->
      <div class="hud-top-right">
        <div class="hud-fps high" id="hud-fps">-- FPS</div>
        <div class="hud-row">
          <span class="hud-label">Frame</span>
          <span class="hud-value" id="hud-frame-time">-- ms</span>
        </div>
      </div>

      <!-- Bottom-left: detection info -->
      <div class="hud-bottom-left">
        <div class="hud-row">
          <span class="hud-label">Persons</span>
          <span class="hud-person-count hud-value" id="hud-person-count">0</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Confidence</span>
          <span class="hud-value" id="hud-confidence">0%</span>
        </div>
        <div class="hud-confidence-bar">
          <div class="hud-confidence-fill" id="hud-confidence-fill" style="width: 0%; background: #334455;"></div>
        </div>
        <div class="hud-row" style="margin-top: 8px;">
          <span class="hud-label">Heart Rate</span>
          <span class="hud-value" id="hud-heartrate">-- bpm</span>
        </div>
        <div class="hud-row">
          <span class="hud-label">Breathing</span>
          <span class="hud-value" id="hud-breathing">-- bpm</span>
        </div>
      </div>

      <!-- Bottom-right: sensing mode -->
      <div class="hud-bottom-right">
        <div class="hud-mode-badge mock" id="hud-mode-badge">MOCK</div>
        <div class="hud-row" style="margin-top: 4px;">
          <span class="hud-label">WiFi DensePose</span>
        </div>
      </div>

      <!-- Controls hint -->
      <div class="hud-controls-hint">
        Drag to orbit | Scroll to zoom | Right-click to pan
      </div>

      <!-- Settings Panel Toggle Button -->
      <div class="hud-settings-toggle" id="hud-settings-toggle" title="Digital Twin Settings">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </div>

      <!-- Settings Panel -->
      <div class="hud-settings-panel" id="hud-settings-panel">
        <div style="font-size: 11px; font-weight: bold; color: #00f2fe; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; margin-bottom: 4px; font-family: 'Space Grotesk', sans-serif;">
          3D Digital Twin Settings
        </div>
        
        <!-- File upload -->
        <div class="hud-form-group">
          <label style="font-size: 9px; color: #5588aa; text-transform: uppercase; display: block; margin-bottom: 4px; font-family: 'Space Grotesk', sans-serif;">Upload Room Model (.glb)</label>
          <input type="file" id="hud-model-input" accept=".glb,.gltf" style="display: none;">
          <button id="hud-upload-btn" style="width: 100%; padding: 8px; font-size: 10px; font-family: inherit; font-weight: bold; background: rgba(0, 242, 254, 0.1); border: 1px solid rgba(0, 242, 254, 0.3); border-radius: 6px; color: #00f2fe; cursor: pointer; transition: all 0.2s;">
            CHOOSE MESH FILE
          </button>
          <div id="hud-model-status" style="font-size: 9px; color: #445566; margin-top: 4px; text-align: center;">No custom model loaded</div>
        </div>

        <!-- Sliders -->
        <div class="hud-form-group">
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #5588aa; margin-bottom: 2px;">
            <span>SCALE</span>
            <span id="hud-val-scale" style="color: #aaddff; font-weight: bold;">1.00x</span>
          </div>
          <input type="range" id="hud-slide-scale" min="0.1" max="5" step="0.05" value="1.0" style="width: 100%; accent-color: #00f2fe; cursor: pointer;">
        </div>

        <div class="hud-form-group">
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #5588aa; margin-bottom: 2px;">
            <span>POSITION X</span>
            <span id="hud-val-posX" style="color: #aaddff; font-weight: bold;">0.0m</span>
          </div>
          <input type="range" id="hud-slide-posX" min="-10" max="10" step="0.1" value="0.0" style="width: 100%; accent-color: #00f2fe; cursor: pointer;">
        </div>

        <div class="hud-form-group">
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #5588aa; margin-bottom: 2px;">
            <span>POSITION Y</span>
            <span id="hud-val-posY" style="color: #aaddff; font-weight: bold;">0.0m</span>
          </div>
          <input type="range" id="hud-slide-posY" min="-5" max="5" step="0.1" value="0.0" style="width: 100%; accent-color: #00f2fe; cursor: pointer;">
        </div>

        <div class="hud-form-group">
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #5588aa; margin-bottom: 2px;">
            <span>POSITION Z</span>
            <span id="hud-val-posZ" style="color: #aaddff; font-weight: bold;">0.0m</span>
          </div>
          <input type="range" id="hud-slide-posZ" min="-10" max="10" step="0.1" value="0.0" style="width: 100%; accent-color: #00f2fe; cursor: pointer;">
        </div>

        <div class="hud-form-group">
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #5588aa; margin-bottom: 2px;">
            <span>ROTATION X (PITCH)</span>
            <span id="hud-val-rotX" style="color: #aaddff; font-weight: bold;">0°</span>
          </div>
          <input type="range" id="hud-slide-rotX" min="-180" max="180" step="1" value="0" style="width: 100%; accent-color: #00f2fe; cursor: pointer;">
        </div>

        <div class="hud-form-group">
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #5588aa; margin-bottom: 2px;">
            <span>ROTATION Y (YAW)</span>
            <span id="hud-val-rotY" style="color: #aaddff; font-weight: bold;">0°</span>
          </div>
          <input type="range" id="hud-slide-rotY" min="0" max="360" step="1" value="0" style="width: 100%; accent-color: #00f2fe; cursor: pointer;">
        </div>

        <div class="hud-form-group">
          <div style="display: flex; justify-content: space-between; font-size: 9px; color: #5588aa; margin-bottom: 2px;">
            <span>ROTATION Z (ROLL)</span>
            <span id="hud-val-rotZ" style="color: #aaddff; font-weight: bold;">0°</span>
          </div>
          <input type="range" id="hud-slide-rotZ" min="-180" max="180" step="1" value="0" style="width: 100%; accent-color: #00f2fe; cursor: pointer;">
        </div>

        <!-- Actions -->
        <div style="display: flex; gap: 8px; margin-top: 4px;">
          <button id="hud-reset-btn" style="flex: 1; padding: 6px; font-size: 9px; font-family: inherit; font-weight: bold; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #8a99ad; cursor: pointer; transition: all 0.2s;">
            RESET ALIGN
          </button>
          <button id="hud-clear-btn" style="flex: 1; padding: 6px; font-size: 9px; font-family: inherit; font-weight: bold; background: rgba(239, 68, 68, 0.05); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 4px; color: #ef4444; cursor: pointer; transition: all 0.2s;">
            REMOVE SCAN
          </button>
        </div>
      </div>
    `;

    this.container.style.position = 'relative';
    this.container.appendChild(this.hudElement);

    // Cache DOM references
    this._els = {
      banner: this.hudElement.querySelector('#hud-banner'),
      statusDot: this.hudElement.querySelector('#hud-status-dot'),
      connStatus: this.hudElement.querySelector('#hud-conn-status'),
      latency: this.hudElement.querySelector('#hud-latency'),
      msgCount: this.hudElement.querySelector('#hud-msg-count'),
      uptime: this.hudElement.querySelector('#hud-uptime'),
      fps: this.hudElement.querySelector('#hud-fps'),
      frameTime: this.hudElement.querySelector('#hud-frame-time'),
      personCount: this.hudElement.querySelector('#hud-person-count'),
      confidence: this.hudElement.querySelector('#hud-confidence'),
      confidenceFill: this.hudElement.querySelector('#hud-confidence-fill'),
      modeBadge: this.hudElement.querySelector('#hud-mode-badge'),
      heartrate: this.hudElement.querySelector('#hud-heartrate'),
      breathing: this.hudElement.querySelector('#hud-breathing')
    };
  }

  // Update state from external data
  updateState(newState) {
    Object.assign(this.state, newState);
    this._render();
  }

  // Track FPS - call each frame
  tickFPS() {
    const now = performance.now();
    this._fpsFrames.push(now);

    // Keep only last second of frames
    while (this._fpsFrames.length > 0 && this._fpsFrames[0] < now - 1000) {
      this._fpsFrames.shift();
    }

    // Update FPS display at most 4 times per second
    if (now - this._lastFpsUpdate > 250) {
      this.state.fps = this._fpsFrames.length;
      const frameTime = this._fpsFrames.length > 1
        ? (now - this._fpsFrames[0]) / (this._fpsFrames.length - 1)
        : 0;
      this._lastFpsUpdate = now;

      // Update FPS elements
      this._els.fps.textContent = `${this.state.fps} FPS`;
      this._els.fps.className = 'hud-fps ' + (
        this.state.fps >= 50 ? 'high' : this.state.fps >= 25 ? 'mid' : 'low'
      );
      this._els.frameTime.textContent = `${frameTime.toFixed(1)} ms`;
    }
  }

  _render() {
    const { state } = this;

    // Banner
    if (state.isRealData) {
      this._els.banner.textContent = 'REAL DATA - LIVE STREAM';
      this._els.banner.className = 'hud-banner real';
    } else {
      this._els.banner.textContent = 'MOCK DATA - DEMO MODE';
      this._els.banner.className = 'hud-banner mock';
    }

    // Connection status
    this._els.statusDot.className = `hud-status-dot ${state.connectionStatus}`;
    const statusText = {
      connected: 'Connected',
      disconnected: 'Disconnected',
      connecting: 'Connecting...',
      error: 'Error'
    };
    this._els.connStatus.textContent = statusText[state.connectionStatus] || 'Unknown';

    // Latency
    this._els.latency.textContent = state.latency > 0 ? `${state.latency.toFixed(0)} ms` : '-- ms';

    // Messages
    this._els.msgCount.textContent = state.messageCount.toLocaleString();

    // Uptime
    const uptimeSec = Math.floor(state.uptime);
    if (uptimeSec < 60) {
      this._els.uptime.textContent = `${uptimeSec}s`;
    } else if (uptimeSec < 3600) {
      this._els.uptime.textContent = `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`;
    } else {
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      this._els.uptime.textContent = `${h}h ${m}m`;
    }

    // Person count
    this._els.personCount.textContent = state.personCount;
    this._els.personCount.style.color = state.personCount > 0 ? '#00ff88' : '#556677';

    // Confidence
    const confPct = (state.confidence * 100).toFixed(1);
    this._els.confidence.textContent = `${confPct}%`;
    this._els.confidenceFill.style.width = `${state.confidence * 100}%`;
    // Color temperature: red (low) -> yellow (mid) -> green (high)
    const confHue = state.confidence * 120; // 0=red, 60=yellow, 120=green
    this._els.confidenceFill.style.background = `hsl(${confHue}, 100%, 45%)`;

    // Sensing mode
    const modeLower = (state.sensingMode || 'Mock').toLowerCase();
    this._els.modeBadge.textContent = state.sensingMode.toUpperCase();
    this._els.modeBadge.className = `hud-mode-badge ${modeLower}`;

    // Vitals
    if (state.heartRate > 0) {
      this._els.heartrate.textContent = `${state.heartRate.toFixed(1)} bpm`;
      this._els.heartrate.style.color = '#ff3366'; // heartbeat pink
    } else {
      this._els.heartrate.textContent = '-- bpm';
      this._els.heartrate.style.color = '#556677';
    }

    if (state.breathingRate > 0) {
      this._els.breathing.textContent = `${state.breathingRate.toFixed(1)} bpm`;
      this._els.breathing.style.color = '#33ccff'; // breathing blue
    } else {
      this._els.breathing.textContent = '-- bpm';
      this._els.breathing.style.color = '#556677';
    }
  }

  _bindEvents() {
    const toggle = this.hudElement.querySelector('#hud-settings-toggle');
    const panel = this.hudElement.querySelector('#hud-settings-panel');
    const uploadBtn = this.hudElement.querySelector('#hud-upload-btn');
    const fileInput = this.hudElement.querySelector('#hud-model-input');
    const resetBtn = this.hudElement.querySelector('#hud-reset-btn');
    const clearBtn = this.hudElement.querySelector('#hud-clear-btn');
    const statusText = this.hudElement.querySelector('#hud-model-status');

    // Toggle settings panel
    toggle.addEventListener('click', () => {
      panel.classList.toggle('active');
    });

    // File input trigger
    uploadBtn.addEventListener('click', () => fileInput.click());

    // File selection
    fileInput.addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file) return;

      statusText.textContent = 'Loading ' + file.name + '...';
      uploadBtn.disabled = true;

      try {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const arrayBuffer = e.target.result;
          if (this.onModelUpload) {
            await this.onModelUpload(arrayBuffer, file.name);
          }
          statusText.textContent = 'Active: ' + file.name;
          statusText.style.color = '#00ff88';
          uploadBtn.disabled = false;
          // Reset slider UI values to defaults
          this.setSliders({ scale: 1.0, posX: 0.0, posY: 0.0, posZ: 0.0, rotX: 0.0, rotY: 0.0, rotZ: 0.0 });
        };
        reader.readAsArrayBuffer(file);
      } catch (err) {
        console.error('[HUD] Upload error:', err);
        statusText.textContent = 'Load failed';
        statusText.style.color = '#ff3344';
        uploadBtn.disabled = false;
      }
    });

    // Slider inputs
    const sliders = ['scale', 'posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'];
    const updateTransform = () => {
      const config = {
        scale: parseFloat(this.hudElement.querySelector('#hud-slide-scale').value),
        posX: parseFloat(this.hudElement.querySelector('#hud-slide-posX').value),
        posY: parseFloat(this.hudElement.querySelector('#hud-slide-posY').value),
        posZ: parseFloat(this.hudElement.querySelector('#hud-slide-posZ').value),
        rotX: parseFloat(this.hudElement.querySelector('#hud-slide-rotX').value),
        rotY: parseFloat(this.hudElement.querySelector('#hud-slide-rotY').value),
        rotZ: parseFloat(this.hudElement.querySelector('#hud-slide-rotZ').value)
      };

      // Update text indicators
      this.hudElement.querySelector('#hud-val-scale').textContent = config.scale.toFixed(2) + 'x';
      this.hudElement.querySelector('#hud-val-posX').textContent = config.posX.toFixed(1) + 'm';
      this.hudElement.querySelector('#hud-val-posY').textContent = config.posY.toFixed(1) + 'm';
      this.hudElement.querySelector('#hud-val-posZ').textContent = config.posZ.toFixed(1) + 'm';
      this.hudElement.querySelector('#hud-val-rotX').textContent = config.rotX + '°';
      this.hudElement.querySelector('#hud-val-rotY').textContent = config.rotY + '°';
      this.hudElement.querySelector('#hud-val-rotZ').textContent = config.rotZ + '°';

      if (this.onTransformChange) {
        this.onTransformChange(config);
      }
    };

    sliders.forEach(id => {
      this.hudElement.querySelector(`#hud-slide-${id}`).addEventListener('input', updateTransform);
    });

    // Reset alignment
    resetBtn.addEventListener('click', () => {
      const defaults = { scale: 1.0, posX: 0.0, posY: 0.0, posZ: 0.0, rotX: 0.0, rotY: 0.0, rotZ: 0.0 };
      this.setSliders(defaults);
      if (this.onTransformChange) {
        this.onTransformChange(defaults);
      }
    });

    // Clear custom model
    clearBtn.addEventListener('click', () => {
      if (this.onClearModel) {
        this.onClearModel();
      }
      statusText.textContent = 'No custom model loaded';
      statusText.style.color = '#445566';
      fileInput.value = '';
    });
  }

  setSliders(config) {
    this.hudElement.querySelector('#hud-slide-scale').value = config.scale;
    this.hudElement.querySelector('#hud-slide-posX').value = config.posX;
    this.hudElement.querySelector('#hud-slide-posY').value = config.posY;
    this.hudElement.querySelector('#hud-slide-posZ').value = config.posZ;
    this.hudElement.querySelector('#hud-slide-rotX').value = config.rotX || 0;
    this.hudElement.querySelector('#hud-slide-rotY').value = config.rotY || 0;
    this.hudElement.querySelector('#hud-slide-rotZ').value = config.rotZ || 0;

    this.hudElement.querySelector('#hud-val-scale').textContent = config.scale.toFixed(2) + 'x';
    this.hudElement.querySelector('#hud-val-posX').textContent = config.posX.toFixed(1) + 'm';
    this.hudElement.querySelector('#hud-val-posY').textContent = config.posY.toFixed(1) + 'm';
    this.hudElement.querySelector('#hud-val-posZ').textContent = config.posZ.toFixed(1) + 'm';
    this.hudElement.querySelector('#hud-val-rotX').textContent = (config.rotX || 0) + '°';
    this.hudElement.querySelector('#hud-val-rotY').textContent = (config.rotY || 0) + '°';
    this.hudElement.querySelector('#hud-val-rotZ').textContent = (config.rotZ || 0) + '°';
  }

  setStatus(text, color) {
    const statusText = this.hudElement.querySelector('#hud-model-status');
    statusText.textContent = text;
    if (color) statusText.style.color = color;
  }

  dispose() {
    if (this.hudElement && this.hudElement.parentNode) {
      this.hudElement.parentNode.removeChild(this.hudElement);
    }
  }
}
