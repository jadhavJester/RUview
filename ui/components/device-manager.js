/**
 * device-manager.js
 * Glassmorphic "Device Manager" HUD panel.
 *
 * Shows all detected smartphones with their MAC, name, RSSI, distance,
 * and live X/Z position. Lets the user rename devices, assign icons,
 * and toggle visibility. Persists to localStorage.
 *
 * Usage:
 *   const dm = new DeviceManager();
 *   document.getElementById('viz-container').appendChild(dm.getElement());
 *   // Feed incoming WebSocket message:
 *   dm.handleMessage(msg);   // call this with every device_positions message
 */

export class DeviceManager {
  constructor() {
    this._devices     = new Map(); // mac → device state
    this._visible     = false;
    this._registry    = this._loadRegistry();
    this._onLocate    = null; // callback(mac, x, z) when position updates

    this._el = null;
    this._listEl = null;
    this._toggleBtn = null;

    this._build();
    this._applyStyles();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  getElement()  { return this._el; }

  /** Register a callback that fires whenever device positions update. */
  onLocate(fn)  { this._onLocate = fn; }

  /** Feed a device_positions WebSocket message into the manager. */
  handleMessage(msg) {
    if (msg.msg_type !== 'device_positions') return;
    for (const dev of (msg.devices || [])) {
      const stored = this._registry[dev.mac] || {};
      const merged = {
        ...dev,
        name:    stored.name || dev.name || dev.mac,
        icon:    stored.icon || dev.icon || 'smartphone',
        hidden:  stored.hidden || false,
      };
      this._devices.set(dev.mac, merged);
      if (this._onLocate && !merged.hidden) {
        this._onLocate(dev.mac, dev.x, dev.z, merged);
      }
    }
    this._refreshList();
  }

  show() {
    this._visible = true;
    this._el.classList.add('active');
    this._toggleBtn && this._toggleBtn.classList.add('active');
  }

  hide() {
    this._visible = false;
    this._el.classList.remove('active');
    this._toggleBtn && this._toggleBtn.classList.remove('active');
  }

  toggle() { this._visible ? this.hide() : this.show(); }

  /** Attach a toggle button element that opens/closes this panel. */
  setToggleButton(btn) {
    this._toggleBtn = btn;
    btn.addEventListener('click', () => this.toggle());
  }

  dispose() {
    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
  }

  // ── Build DOM ──────────────────────────────────────────────────────────

  _build() {
    this._el = document.createElement('div');
    this._el.id = 'device-manager-panel';
    this._el.innerHTML = `
      <div class="dm-header">
        <span class="dm-title">📱 DEVICE MANAGER</span>
        <span class="dm-subtitle">Smartphone WiFi Tracking</span>
        <button class="dm-close" id="dm-close-btn">✕</button>
      </div>

      <div class="dm-alert" id="dm-mac-alert">
        ⚠ Enable Static MAC on your phone:<br>
        <b>iOS:</b> Settings › WiFi › ⓘ › Private Address: <b>OFF</b><br>
        <b>Android:</b> WiFi › ⚙ › Privacy › <b>Use device MAC</b>
      </div>

      <div class="dm-anchor-info" id="dm-anchor-info">
        <div class="dm-anchor-dot esp32"></div>ESP32
        <div class="dm-anchor-dot router"></div>Router
        <span id="dm-anchor-mode" class="dm-mode-badge">detecting...</span>
      </div>

      <div class="dm-list-header">
        <span>DETECTED DEVICES</span>
        <span id="dm-device-count">0 devices</span>
      </div>

      <div class="dm-list" id="dm-device-list">
        <div class="dm-empty">Waiting for smartphone signals…<br>
        Make sure the ESP32 firmware is flashed with WiFi scanner.</div>
      </div>
    `;

    document.getElementById('dm-close-btn')?.addEventListener('click', () => this.hide());
    this._listEl = this._el.querySelector('#dm-device-list');
  }

  // ── Render device list ─────────────────────────────────────────────────

  _refreshList() {
    if (!this._listEl) return;

    const countEl = this._el.querySelector('#dm-device-count');
    const modeEl  = this._el.querySelector('#dm-anchor-mode');

    if (this._devices.size === 0) {
      this._listEl.innerHTML = `<div class="dm-empty">Waiting for smartphone signals…</div>`;
      if (countEl) countEl.textContent = '0 devices';
      return;
    }

    if (countEl) countEl.textContent = `${this._devices.size} device${this._devices.size !== 1 ? 's' : ''}`;

    // Show anchor mode from first device
    const firstDev = [...this._devices.values()][0];
    if (modeEl) {
      modeEl.textContent  = firstDev.anchor_mode === '2-anchor' ? '✓ 2-anchor' : '⚠ 1-anchor';
      modeEl.className    = `dm-mode-badge ${firstDev.anchor_mode === '2-anchor' ? 'good' : 'warn'}`;
    }

    this._listEl.innerHTML = [...this._devices.values()].map(dev => `
      <div class="dm-device ${dev.hidden ? 'hidden-dev' : ''}" data-mac="${dev.mac}">
        <div class="dm-device-row1">
          <span class="dm-icon">${this._iconEmoji(dev.icon)}</span>
          <input class="dm-name-input" data-mac="${dev.mac}"
                 value="${this._esc(dev.name)}" placeholder="Device name" />
          <label class="dm-vis-toggle" title="Show/Hide on map">
            <input type="checkbox" class="dm-vis-cb" data-mac="${dev.mac}"
                   ${dev.hidden ? '' : 'checked'} />
            <span class="dm-vis-slider"></span>
          </label>
        </div>
        <div class="dm-device-row2">
          <span class="dm-mac">${dev.mac}</span>
          <span class="dm-signal ${this._signalClass(dev.rssi_esp32)}">
            ${this._signalBars(dev.rssi_esp32)} ${dev.rssi_esp32}dBm
          </span>
        </div>
        <div class="dm-device-row3">
          <span class="dm-pos">
            📍 x=${dev.x?.toFixed(1)}m &nbsp; z=${dev.z?.toFixed(1)}m
          </span>
          <span class="dm-dist">
            📶 ${dev.dist_esp32?.toFixed(1)}m
            ${dev.rssi_router != null ? `| 🛜 ${dev.rssi_router}dBm` : ''}
          </span>
          <span class="dm-conf ${dev.confidence > 0.6 ? 'good' : 'warn'}">
            ${Math.round((dev.confidence || 0) * 100)}% conf
          </span>
        </div>
      </div>
    `).join('');

    // Bind events
    this._listEl.querySelectorAll('.dm-name-input').forEach(inp => {
      inp.addEventListener('change', e => {
        const mac = e.target.dataset.mac;
        this._setName(mac, e.target.value.trim());
      });
    });
    this._listEl.querySelectorAll('.dm-vis-cb').forEach(cb => {
      cb.addEventListener('change', e => {
        const mac = e.target.dataset.mac;
        this._setHidden(mac, !e.target.checked);
      });
    });
  }

  // ── Registry persistence ───────────────────────────────────────────────

  _loadRegistry() {
    try {
      return JSON.parse(localStorage.getItem('ruview_devices') || '{}');
    } catch { return {}; }
  }

  _saveRegistry() {
    try {
      localStorage.setItem('ruview_devices', JSON.stringify(this._registry));
    } catch {}
  }

  _setName(mac, name) {
    if (!name) return;
    this._registry[mac] = { ...(this._registry[mac] || {}), name };
    this._saveRegistry();
    const dev = this._devices.get(mac);
    if (dev) { dev.name = name; this._devices.set(mac, dev); }
  }

  _setHidden(mac, hidden) {
    this._registry[mac] = { ...(this._registry[mac] || {}), hidden };
    this._saveRegistry();
    const dev = this._devices.get(mac);
    if (dev) { dev.hidden = hidden; this._devices.set(mac, dev); }
    this._refreshList();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _iconEmoji(icon) {
    const map = { smartphone: '📱', person: '🧑', laptop: '💻', tablet: '📟' };
    return map[icon] || '📱';
  }

  _signalClass(rssi) {
    if (rssi >= -55) return 'sig-strong';
    if (rssi >= -70) return 'sig-medium';
    return 'sig-weak';
  }

  _signalBars(rssi) {
    if (rssi >= -55) return '▂▄▆█';
    if (rssi >= -70) return '▂▄▆░';
    if (rssi >= -80) return '▂▄░░';
    return '▂░░░';
  }

  _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  }

  // ── Styles ─────────────────────────────────────────────────────────────

  _applyStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #device-manager-panel {
        position: absolute;
        top: 130px;
        left: 12px;
        width: 310px;
        max-height: 70vh;
        background: rgba(8, 12, 24, 0.96);
        border: 1px solid rgba(0, 242, 254, 0.2);
        border-radius: 14px;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0;
        pointer-events: auto;
        z-index: 220;
        box-shadow: 0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(0,242,254,0.05);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        opacity: 0;
        transform: translateX(-10px);
        transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
        overflow: hidden;
        font-family: 'Space Grotesk', 'Courier New', monospace;
      }
      #device-manager-panel.active {
        opacity: 1;
        transform: translateX(0);
      }
      .dm-header {
        padding: 14px 14px 10px;
        border-bottom: 1px solid rgba(0,242,254,0.1);
        display: flex;
        flex-direction: column;
        gap: 2px;
        position: relative;
      }
      .dm-title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: #00f2fe;
      }
      .dm-subtitle {
        font-size: 9px;
        color: #445566;
        letter-spacing: 1px;
      }
      .dm-close {
        position: absolute;
        top: 10px;
        right: 12px;
        background: none;
        border: none;
        color: #556677;
        font-size: 14px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        transition: color 0.2s, background 0.2s;
      }
      .dm-close:hover { color: #ff4466; background: rgba(255,68,102,0.1); }

      .dm-alert {
        margin: 10px 12px;
        padding: 8px 10px;
        background: rgba(255, 160, 0, 0.08);
        border: 1px solid rgba(255,160,0,0.25);
        border-radius: 8px;
        font-size: 9.5px;
        line-height: 1.5;
        color: #cc9900;
      }
      .dm-anchor-info {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 14px;
        font-size: 9px;
        color: #556677;
        border-bottom: 1px solid rgba(255,255,255,0.04);
      }
      .dm-anchor-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        display: inline-block;
      }
      .dm-anchor-dot.esp32  { background: #00ff88; box-shadow: 0 0 6px #00ff88; }
      .dm-anchor-dot.router { background: #00aaff; box-shadow: 0 0 6px #00aaff; }
      .dm-mode-badge {
        margin-left: auto;
        font-size: 9px;
        padding: 2px 7px;
        border-radius: 4px;
        font-weight: 700;
        letter-spacing: 1px;
      }
      .dm-mode-badge.good { background: rgba(0,255,136,0.15); color: #00ff88; border: 1px solid #00ff88; }
      .dm-mode-badge.warn { background: rgba(255,160,0,0.15); color: #ffaa00; border: 1px solid #ffaa00; }

      .dm-list-header {
        display: flex;
        justify-content: space-between;
        padding: 8px 14px 6px;
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 1.5px;
        text-transform: uppercase;
        color: #445566;
      }
      #dm-device-count { color: #00f2fe; }

      .dm-list {
        overflow-y: auto;
        flex: 1;
        padding: 4px 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 45vh;
        scrollbar-width: thin;
        scrollbar-color: rgba(0,242,254,0.2) transparent;
      }
      .dm-empty {
        padding: 20px;
        text-align: center;
        color: #334455;
        font-size: 11px;
        line-height: 1.6;
      }
      .dm-device {
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(0,242,254,0.1);
        border-radius: 10px;
        padding: 9px 10px;
        display: flex;
        flex-direction: column;
        gap: 5px;
        transition: border-color 0.2s, background 0.2s;
      }
      .dm-device:hover { border-color: rgba(0,242,254,0.25); background: rgba(0,242,254,0.04); }
      .dm-device.hidden-dev { opacity: 0.4; }

      .dm-device-row1 {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .dm-icon { font-size: 16px; }
      .dm-name-input {
        flex: 1;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(0,242,254,0.15);
        border-radius: 5px;
        color: #ccddee;
        font-size: 11px;
        padding: 3px 7px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.2s;
      }
      .dm-name-input:focus { border-color: rgba(0,242,254,0.5); }

      /* Toggle switch */
      .dm-vis-toggle { position: relative; width: 30px; height: 16px; cursor: pointer; flex-shrink: 0; }
      .dm-vis-toggle input { opacity: 0; width: 0; height: 0; }
      .dm-vis-slider {
        position: absolute; inset: 0;
        background: rgba(255,255,255,0.1);
        border-radius: 16px;
        border: 1px solid rgba(0,242,254,0.2);
        transition: background 0.2s;
      }
      .dm-vis-slider::before {
        content: '';
        position: absolute;
        width: 10px; height: 10px;
        left: 2px; top: 2px;
        background: #556677;
        border-radius: 50%;
        transition: transform 0.2s, background 0.2s;
      }
      .dm-vis-toggle input:checked + .dm-vis-slider { background: rgba(0,255,136,0.15); border-color: #00ff88; }
      .dm-vis-toggle input:checked + .dm-vis-slider::before { transform: translateX(14px); background: #00ff88; }

      .dm-device-row2 {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 9px;
      }
      .dm-mac { color: #334455; font-family: monospace; letter-spacing: 0.5px; }
      .dm-signal { font-weight: 700; font-size: 10px; }
      .dm-signal.sig-strong { color: #00ff88; }
      .dm-signal.sig-medium { color: #ffaa00; }
      .dm-signal.sig-weak   { color: #ff4444; }

      .dm-device-row3 {
        display: flex;
        gap: 8px;
        font-size: 9px;
        color: #556677;
        flex-wrap: wrap;
      }
      .dm-pos   { color: #aaddff; }
      .dm-dist  { color: #779988; }
      .dm-conf.good { color: #00ff88; }
      .dm-conf.warn { color: #ffaa00; }
    `;
    document.head.appendChild(style);
  }
}
