# RuView Room Presence Tracker & ESP32-CSI Node

An interactive, responsive, and mobile-friendly indoor presence and activity tracking system. It integrates browser-based computer vision, manual simulation sandbox capabilities, and ESP32 Channel State Information (CSI) WiFi-sensing hardware.

---

## 🚀 Key Modules

Our custom implementation consists of the following components:

### 1. Dashboard UI (`ui/`)
A premium, dark-themed dashboard built with modern glassmorphism styling, custom typography, and responsive grid layouts.
* **`tracker.html`**: The main interface hosting the tracker application. Includes a live Canvas-based radar, signal strength indicators, real-time vitals graphs, activity logs, and a settings panel.
* **Webcam Motion CV (`ui/components/device-manager.js`)**: An in-browser computer vision pipeline. Using frame-differencing on a canvas element, it tracks motion energy, gates presence states, and estimates proximity based on bounding boxes.
* **Interactive Simulator**: A draggable radar dot sandbox that lets you simulate distance, signal degradation (RSSI), and motion energy in real time without hardware.
* **Services (`ui/services/`)**: Custom services including `pose.service.js` for 3D body model binding, `storage.service.js` for persistent logs, and websocket adapters.

### 2. ESP32 CSI Firmware (`firmware/esp32-csi-node/`)
Extends the ESP32 node logic to collect fine-grained telemetry.
* **`wifi_scanner.c` / `wifi_scanner.h`**: Implements background active scanning, beacon packet inspection, and smart RSSI collection for presence detection.
* **`main.c`**: Orchestrates WiFi scanning, processes signal metrics, and formats serial telemetry output.

### 3. Sensing Bridge (`scripts/`)
* **`sensing_bridge.py`**: A python script that listens to the ESP32's serial telemetry port, filters noise using a rolling window, and broadcasts standard WebSocket telemetry to the frontend.
* **`devices.json`**: Device inventory configuration mapping sensor node IDs to MAC addresses.

---

## 🛠️ Getting Started

### Prerequisites
Make sure Python 3 is installed on your local machine to serve the interface and run the sensing bridge.

### 1. Serving the Dashboard
To run the Web UI locally with ES modules support:
```bash
# Serve the ui folder
python -m http.server 8081 --directory ui
```
Open [http://localhost:8081/tracker.html](http://localhost:8081/tracker.html) in your browser.

### 2. Running in Sandbox or Webcam Mode
1. Click the **Settings Gear** at the top right of the dashboard.
2. Under **Tracking Source**, select:
   * **Interactive Simulator**: Drag the green radar dot around the map to simulate distance/activity.
   * **Webcam Motion CV**: Allow camera access to run the local frame-differencing detector.
3. Click **Save & Connect**.

### 3. Flashing & Running the ESP32 Node
1. Navigate to `firmware/esp32-csi-node`.
2. Configure and flash the project using ESP-IDF:
```bash
idf.py build
idf.py flash monitor
```
3. Once running, connect your ESP32 node via USB and start the bridge to forward data to the web app:
```bash
python scripts/sensing_bridge.py --port COM3
```

---

## 📖 System Guides
For a deep dive into the WebSocket JSON schemas, signal smoothing math, and the theoretical layout for 2D trilateration, read the [System Guide](docs/tracker-app-guide.md).

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
