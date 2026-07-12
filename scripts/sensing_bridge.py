"""
sensing_bridge.py — RuView Sensing Bridge v2

Listens on two UDP ports:
  - Port 5005: edge_vitals binary packets from ESP32 CSI collector
  - Port 5006: wifi_scan JSON packets from ESP32 WiFi scanner (new)

Also polls the router for per-client RSSI every 2 seconds (best-effort).
Combines both data sources, does 2-anchor trilateration, and broadcasts
structured JSON over a raw WebSocket server on port 3000.

---------------------------------------------------------------------------
SETUP — Edit the values in the CONFIG section below to match your room:

  ESP32_POS   : (x, z) in metres, where you placed the ESP32 in the room
  ROUTER_POS  : (x, z) in metres, where your router is placed
  ROOM_W/D    : rough room dimensions (used to bound trilateration results)

  ROUTER_IP   : your router's LAN IP (usually 192.168.1.1 or 192.168.0.1)
  ROUTER_USER / ROUTER_PASS : router admin credentials (for RSSI polling)

To register device names, edit scripts/devices.json ONCE your phone's MAC
appears in the console output.

MAC Randomization warning:
  Modern phones randomize their MAC by default. Turn it OFF:
    iOS:     Settings > WiFi > (i) next to network > Private Address: OFF
    Android: WiFi > (gear icon) > Privacy > Use device MAC
---------------------------------------------------------------------------
"""

import socket
import struct
import json
import hashlib
import base64
import threading
import time
import math
import os
import urllib.request
import urllib.error
from collections import deque

# ==========================================================================
# CONFIG — Edit this section to match your physical room layout
# ==========================================================================

# Physical positions (x, z) in metres inside the room.
# Put (0, 0) where you want the room "origin" to be — e.g. a corner.
ESP32_POS   = (0.0, 0.0)    # ESP32 node position in the room
ROUTER_POS  = (4.0, 3.5)    # Router position (diagonal corner from ESP32)

# Room bounding box in metres (used to clamp trilateration results)
ROOM_W = 5.0   # room width  (x axis)
ROOM_D = 4.5   # room depth  (z axis)

# Network config
UDP_IP      = "0.0.0.0"
UDP_PORT_CSI   = 5005    # ESP32 CSI edge_vitals packets
UDP_PORT_SCAN  = 5006    # ESP32 wifi_scan packets (new)
WS_IP       = "127.0.0.1"
WS_PORT     = 3000

# Router RSSI polling — set your router's admin IP and credentials.
# Leave ROUTER_IP empty ("") to disable router polling.
ROUTER_IP   = "192.168.1.1"
ROUTER_USER = "admin"
ROUTER_PASS = "admin"

# Path loss exponent (n): 2.0 = free space, 2.5-3.5 = typical indoor
# A higher value means RSSI drops faster with distance (more walls/furniture)
PATH_LOSS_N   = 2.7
# Calibrated TX power at 1 metre (dBm) — typical WiFi device ~-40 to -50
TX_POWER_1M   = -45.0

# Devices file — maps MAC → {name, icon}
DEVICES_FILE = os.path.join(os.path.dirname(__file__), "devices.json")

# ==========================================================================
# Globals
# ==========================================================================

clients      = set()
clients_lock = threading.Lock()

# Device registry: MAC (uppercase, colon-separated) → dict
device_registry = {}    # e.g. "AA:BB:CC:DD:EE:FF" → {"name": "User", "icon": "person"}
registry_lock   = threading.Lock()

# Scanner state: MAC → {rssi_esp32, rssi_router, last_seen, x, z, name}
tracked_devices = {}
tracked_lock    = threading.Lock()

# Last CSI vitals from ESP32
last_vitals = {}
vitals_lock = threading.Lock()

# Router client RSSI table: MAC → rssi (int)
router_rssi_table = {}
router_rssi_lock  = threading.Lock()

# ==========================================================================
# Device registry helpers
# ==========================================================================

def load_device_registry():
    global device_registry
    try:
        with open(DEVICES_FILE, "r") as f:
            data = json.load(f)
        devices = data.get("devices", [])
        with registry_lock:
            device_registry = {
                d["mac"].upper(): d
                for d in devices if "mac" in d
            }
        print(f"[Registry] Loaded {len(device_registry)} known devices")
    except FileNotFoundError:
        print("[Registry] devices.json not found — starting empty")
    except Exception as e:
        print(f"[Registry] Load error: {e}")

def save_device_registry():
    try:
        with registry_lock:
            devices = list(device_registry.values())
        data = {
            "__comment": "Map MAC addresses to friendly names. Disable MAC randomization on phone first!",
            "devices": devices
        }
        with open(DEVICES_FILE, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"[Registry] Save error: {e}")

# ==========================================================================
# WebSocket helpers (raw, no dependencies)
# ==========================================================================

def make_ws_frame(message):
    data = message.encode("utf-8")
    length = len(data)
    frame = bytearray([0x81])
    if length <= 125:
        frame.append(length)
    elif length <= 65535:
        frame.append(126)
        frame.extend(struct.pack("!H", length))
    else:
        frame.append(127)
        frame.extend(struct.pack("!Q", length))
    frame.extend(data)
    return frame

def broadcast(json_str):
    frame = make_ws_frame(json_str)
    with clients_lock:
        dead = []
        for conn in clients:
            try:
                conn.sendall(frame)
            except Exception:
                dead.append(conn)
        for conn in dead:
            clients.discard(conn)
            try:
                conn.close()
            except Exception:
                pass

def ws_client_handler(conn, addr):
    print(f"[WS] Client connected: {addr}")
    try:
        request = conn.recv(4096).decode("utf-8", errors="ignore")
        if not request:
            return
        for line in request.split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
                accept = base64.b64encode(
                    hashlib.sha1(
                        (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
                    ).digest()
                ).decode()
                response = (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                )
                conn.sendall(response.encode())
                with clients_lock:
                    clients.add(conn)
                # Keep alive — wait for client close
                while True:
                    data = conn.recv(1024)
                    if not data:
                        break
                return
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
    except Exception:
        pass
    finally:
        with clients_lock:
            clients.discard(conn)
        try:
            conn.close()
        except Exception:
            pass
    print(f"[WS] Client disconnected: {addr}")

def ws_server_thread():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((WS_IP, WS_PORT))
    srv.listen(10)
    print(f"[WS] Listening on ws://{WS_IP}:{WS_PORT}")
    while True:
        try:
            conn, addr = srv.accept()
            threading.Thread(target=ws_client_handler, args=(conn, addr), daemon=True).start()
        except Exception as e:
            print(f"[WS] Accept error: {e}")

# ==========================================================================
# RSSI → Distance conversion
# ==========================================================================

def rssi_to_distance(rssi_dbm, path_loss_n=None, tx_power=None):
    """Free-space path loss model: d = 10^((TxPower - RSSI) / (10 * n))"""
    n  = path_loss_n if path_loss_n is not None else PATH_LOSS_N
    tp = tx_power    if tx_power    is not None else TX_POWER_1M
    exponent = (tp - rssi_dbm) / (10.0 * n)
    d = 10.0 ** exponent
    # Clamp: minimum 0.3m (noise floor), maximum diagonal of room
    max_d = math.sqrt(ROOM_W**2 + ROOM_D**2) * 1.2
    return max(0.3, min(max_d, d))

# ==========================================================================
# 2-Anchor Trilateration
# ==========================================================================

def trilaterate_2anchor(d1, anchor1, d2, anchor2):
    """
    Given distances d1, d2 from two anchors, return the most probable (x, z)
    inside the room.

    Two circles intersect at 0, 1 or 2 points.
    We compute the midpoint-on-radical-axis as a fallback, and for 2-intersection
    we pick whichever point is closer to room centre.
    """
    ax, az = anchor1
    bx, bz = anchor2
    dx = bx - ax
    dz = bz - az
    dist_ab = math.sqrt(dx*dx + dz*dz)

    if dist_ab < 0.01:
        # Anchors are co-located — can't trilaterate, return anchor midpoint
        return (ax + bx) / 2, (az + bz) / 2, 0.3

    # Signed distance from anchor1 along the line AB to the radical axis
    a_coeff = (d1*d1 - d2*d2 + dist_ab*dist_ab) / (2.0 * dist_ab)

    discriminant = d1*d1 - a_coeff*a_coeff
    if discriminant < 0:
        discriminant = 0.0   # circles don't intersect — use nearest point on radical axis

    h = math.sqrt(discriminant)  # perpendicular offset from radical axis

    # Unit vectors
    ux = dx / dist_ab
    uz = dz / dist_ab
    # Perpendicular unit vector (2D rotation by 90°)
    px = -uz
    pz =  ux

    # Radical axis midpoint
    mx = ax + a_coeff * ux
    mz = az + a_coeff * uz

    if h < 0.01:
        # Single intersection or tangent
        candidates = [(mx, mz)]
    else:
        candidates = [
            (mx + h * px, mz + h * pz),
            (mx - h * px, mz - h * pz),
        ]

    # Score: prefer points inside room bounds
    room_cx = ROOM_W / 2
    room_cz = ROOM_D / 2

    def score(p):
        x, z = p
        # Distance from room centre (prefer centre)
        dist_centre = math.sqrt((x - room_cx)**2 + (z - room_cz)**2)
        # Penalty for being outside room
        out = 0
        if x < 0 or x > ROOM_W: out += 5
        if z < 0 or z > ROOM_D: out += 5
        return dist_centre + out

    best = min(candidates, key=score)
    x = max(0.0, min(ROOM_W, best[0]))
    z = max(0.0, min(ROOM_D, best[1]))

    # Confidence: how well d1+d2 is consistent with the anchor separation
    consistency = 1.0 - abs(dist_ab - (d1 + d2)) / (dist_ab + 1e-6)
    confidence  = max(0.1, min(0.99, consistency))

    return x, z, confidence

# ==========================================================================
# Router RSSI polling
# ==========================================================================

def _try_tplink_rssi():
    """TP-Link Archer: POST to /cgi-bin/luci/;stok=.../admin/wireless"""
    # This is a best-effort heuristic — not all TP-Link models expose this
    url = f"http://{ROUTER_IP}/cgi-bin/luci"
    try:
        req = urllib.request.Request(
            url,
            data=b'{"method":"get","params":{"name":"wireless.sta_info"}}',
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            result = {}
            for sta in data.get("result", {}).get("data", {}).get("sta_list", []):
                mac  = sta.get("mac", "").upper()
                rssi = sta.get("rssi", None)
                if mac and rssi is not None:
                    result[mac] = int(rssi)
            return result
    except Exception:
        return {}

def _try_asus_rssi():
    """ASUS routers: /appGet.cgi?hook=get_clientlist()"""
    import urllib.parse
    url = f"http://{ROUTER_IP}/appGet.cgi?hook=get_clientlist()"
    try:
        password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        password_mgr.add_password(None, url, ROUTER_USER, ROUTER_PASS)
        handler  = urllib.request.HTTPBasicAuthHandler(password_mgr)
        opener   = urllib.request.build_opener(handler)
        with opener.open(url, timeout=2) as resp:
            raw  = resp.read().decode("utf-8", errors="ignore")
            data = json.loads(raw)
            result = {}
            for mac, info in data.get("get_clientlist", {}).items():
                rssi = info.get("rssi", None)
                if rssi is not None:
                    result[mac.upper()] = int(rssi)
            return result
    except Exception:
        return {}

def _try_openwrt_rssi():
    """OpenWRT: /cgi-bin/luci/rpc/sys → iwinfo"""
    url = f"http://{ROUTER_IP}/cgi-bin/luci/rpc/sys"
    try:
        payload = json.dumps({"id": 1, "method": "exec", "params": ["iwinfo wlan0 assoclist"]})
        req = urllib.request.Request(
            url, data=payload.encode(), method="POST",
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read())
            output = data.get("result", "")
            result = {}
            lines = output.splitlines()
            current_mac = None
            for line in lines:
                line = line.strip()
                if ":" in line and line[2] == ":" and len(line) == 17:
                    current_mac = line.upper()
                elif "Signal:" in line and current_mac:
                    try:
                        rssi = int(line.split("Signal:")[1].split()[0].replace("dBm", ""))
                        result[current_mac] = rssi
                    except Exception:
                        pass
            return result
    except Exception:
        return {}

def router_rssi_poller():
    """Background thread: try multiple router APIs, update router_rssi_table."""
    if not ROUTER_IP:
        print("[Router] ROUTER_IP not set — router RSSI polling disabled (single-anchor mode)")
        return

    print(f"[Router] Polling {ROUTER_IP} for client RSSI...")
    methods = [_try_asus_rssi, _try_tplink_rssi, _try_openwrt_rssi]
    working_method = None

    while True:
        table = {}

        if working_method:
            table = working_method()
        else:
            for method in methods:
                table = method()
                if table:
                    working_method = method
                    print(f"[Router] Found {len(table)} clients via {method.__name__}")
                    break

        if not table and working_method is None:
            # All methods failed — print once and slow down retries
            print(f"[Router] Could not poll router RSSI (unsupported model). "
                  f"Running in single-anchor mode. Will retry in 30s.")
            time.sleep(30)
            continue

        with router_rssi_lock:
            router_rssi_table.clear()
            router_rssi_table.update(table)

        time.sleep(2)  # poll every 2 seconds

# ==========================================================================
# CSI edge_vitals UDP receiver (port 5005)
# ==========================================================================

def csi_udp_receiver():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((UDP_IP, UDP_PORT_CSI))
    print(f"[CSI-UDP] Listening on port {UDP_PORT_CSI}")

    while True:
        try:
            data, addr = sock.recvfrom(1024)
            if len(data) == 32:
                unpacked = struct.unpack("<IBBHIbB2sffII", data)
                magic = unpacked[0]
                if magic != 0xC5110002:
                    continue

                node_id     = unpacked[1]
                flags       = unpacked[2]
                br_raw      = unpacked[3]
                hr_raw      = unpacked[4]
                rssi        = unpacked[5]
                n_persons   = unpacked[6]
                motion_energy  = unpacked[8]
                presence_score = unpacked[9]
                timestamp_ms   = unpacked[10]

                presence = bool(flags & 0x01)
                motion   = bool(flags & 0x04)
                hr_bpm   = hr_raw / 10000.0
                br_bpm   = br_raw / 100.0

                msg = {
                    "msg_type":        "edge_vitals",
                    "presence":        presence,
                    "motion":          motion,
                    "presence_score":  presence_score,
                    "rssi":            rssi,
                    "n_persons":       n_persons,
                    "motion_energy":   motion_energy,
                    "heartrate_bpm":   hr_bpm,
                    "breathing_rate_bpm": br_bpm,
                    "node_id":         node_id,
                    "timestamp_ms":    timestamp_ms
                }

                with vitals_lock:
                    last_vitals.update(msg)

                broadcast(json.dumps(msg))
                print(f"[CSI] Node {node_id}: presence={presence} motion={motion} "
                      f"persons={n_persons} rssi={rssi}dBm "
                      f"HR={hr_bpm:.1f} BR={br_bpm:.1f}")

        except Exception as e:
            print(f"[CSI-UDP] Error: {e}")
            time.sleep(0.1)

# ==========================================================================
# WiFi scanner UDP receiver (port 5006) + trilateration
# ==========================================================================

# Smoothed RSSI per device per anchor (EMA)
_rssi_smooth_esp = {}   # mac → float
_rssi_smooth_rtr = {}   # mac → float
SMOOTH_ALPHA = 0.3      # 0=no update, 1=instant (keep ~0.25–0.4)

def _ema(prev, new_val, alpha=SMOOTH_ALPHA):
    if prev is None:
        return float(new_val)
    return prev + alpha * (new_val - prev)

def scan_udp_receiver():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((UDP_IP, UDP_PORT_SCAN))
    print(f"[SCAN-UDP] Listening on port {UDP_PORT_SCAN}")

    while True:
        try:
            data, addr = sock.recvfrom(4096)
            msg = json.loads(data.decode("utf-8"))
            if msg.get("msg_type") != "wifi_scan":
                continue

            devices_raw = msg.get("devices", [])
            now_ms = int(time.time() * 1000)

            # Grab latest router RSSI snapshot
            with router_rssi_lock:
                rtr_snapshot = dict(router_rssi_table)

            device_list = []

            for dev in devices_raw:
                mac   = dev.get("mac", "").upper()
                rssi_esp = dev.get("rssi", -100)
                count    = dev.get("count", 1)

                if not mac or count < 2:
                    # Skip devices seen only once (likely noise/stray packets)
                    continue

                # Smooth ESP32 RSSI
                _rssi_smooth_esp[mac] = _ema(_rssi_smooth_esp.get(mac), rssi_esp)

                # Router RSSI
                rssi_rtr = rtr_snapshot.get(mac)
                if rssi_rtr is not None:
                    _rssi_smooth_rtr[mac] = _ema(_rssi_smooth_rtr.get(mac), rssi_rtr)

                smooth_esp = _rssi_smooth_esp[mac]
                smooth_rtr = _rssi_smooth_rtr.get(mac)

                # Trilateration
                d_esp = rssi_to_distance(smooth_esp)
                if smooth_rtr is not None:
                    d_rtr = rssi_to_distance(smooth_rtr)
                    x, z, confidence = trilaterate_2anchor(
                        d_esp, ESP32_POS, d_rtr, ROUTER_POS
                    )
                    anchor_mode = "2-anchor"
                else:
                    # Single-anchor fallback: place on a circle around ESP32
                    # We use the room centre as the angular bias
                    d = d_esp
                    cx, cz = ROOM_W / 2, ROOM_D / 2
                    ex, ez = ESP32_POS
                    angle  = math.atan2(cz - ez, cx - ex)
                    x = ex + d * math.cos(angle)
                    z = ez + d * math.sin(angle)
                    x = max(0.0, min(ROOM_W, x))
                    z = max(0.0, min(ROOM_D, z))
                    confidence = 0.4
                    anchor_mode = "1-anchor"

                # Look up name from registry
                with registry_lock:
                    info = device_registry.get(mac, {})
                name = info.get("name", mac)
                icon = info.get("icon", "smartphone")

                # Update tracked state
                with tracked_lock:
                    tracked_devices[mac] = {
                        "mac":          mac,
                        "name":         name,
                        "icon":         icon,
                        "rssi_esp32":   int(smooth_esp),
                        "rssi_router":  int(smooth_rtr) if smooth_rtr else None,
                        "dist_esp32":   round(d_esp, 2),
                        "x":            round(x, 3),
                        "z":            round(z, 3),
                        "confidence":   round(confidence, 3),
                        "anchor_mode":  anchor_mode,
                        "last_seen_ms": now_ms
                    }

                device_list.append(tracked_devices[mac])
                print(f"[SCAN] {name} ({mac}): esp={int(smooth_esp)}dBm "
                      f"d={d_esp:.1f}m x={x:.1f} z={z:.1f} [{anchor_mode}]")

                # Auto-register unknown devices (so they appear in UI)
                with registry_lock:
                    if mac not in device_registry:
                        device_registry[mac] = {
                            "mac":  mac,
                            "name": mac,          # default name = MAC until user labels it
                            "icon": "smartphone"
                        }
                        print(f"[Registry] New device: {mac} — open Device Manager to name it")
                        save_device_registry()

            # Broadcast device positions to WebSocket clients
            if device_list:
                out = json.dumps({
                    "msg_type":  "device_positions",
                    "timestamp": now_ms,
                    "devices":   device_list
                })
                broadcast(out)

        except Exception as e:
            print(f"[SCAN-UDP] Error: {e}")
            time.sleep(0.1)

# ==========================================================================
# Periodic device_positions broadcast (keeps UI alive even between scans)
# ==========================================================================

def position_broadcast_thread():
    """Broadcast the latest known positions every 500ms so the UI doesn't
    freeze between 1-second scan windows."""
    while True:
        time.sleep(0.5)
        now_ms = int(time.time() * 1000)
        stale_cutoff = now_ms - 5000  # remove devices not seen in 5 seconds

        with tracked_lock:
            active = [d for d in tracked_devices.values()
                      if d["last_seen_ms"] > stale_cutoff]

        if active:
            broadcast(json.dumps({
                "msg_type":  "device_positions",
                "timestamp": now_ms,
                "devices":   active
            }))

# ==========================================================================
# Entry point
# ==========================================================================

if __name__ == "__main__":
    print("=" * 60)
    print(" RuView Sensing Bridge v2 — Smartphone WiFi Tracking")
    print("=" * 60)
    print(f" ESP32  anchor : {ESP32_POS}")
    print(f" Router anchor : {ROUTER_POS}")
    print(f" Room bounds   : {ROOM_W}m x {ROOM_D}m")
    print(f" Router IP     : {ROUTER_IP or '(disabled)'}")
    print("=" * 60)

    load_device_registry()

    # WebSocket server
    threading.Thread(target=ws_server_thread, daemon=True).start()

    # Router RSSI poller
    threading.Thread(target=router_rssi_poller, daemon=True).start()

    # Position broadcast keepalive
    threading.Thread(target=position_broadcast_thread, daemon=True).start()

    # WiFi scan receiver (port 5006)
    threading.Thread(target=scan_udp_receiver, daemon=True).start()

    # CSI edge_vitals receiver (port 5005) — runs on main thread
    csi_udp_receiver()
