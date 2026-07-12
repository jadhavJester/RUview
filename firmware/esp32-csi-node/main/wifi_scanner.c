/**
 * @file wifi_scanner.c
 * @brief WiFi probe-request / data-frame scanner for smartphone tracking.
 *
 * Strategy:
 *   1. Register a promiscuous RX callback (runs on the WiFi task context).
 *   2. For every incoming frame, extract source MAC + rx RSSI.
 *   3. Accumulate into a per-MAC RSSI ring buffer (max WIFI_SCANNER_MAX_DEVICES).
 *   4. Every WIFI_SCANNER_WINDOW_MS a background task flushes the window:
 *      computes median RSSI per MAC, serialises to JSON, sends over UDP.
 *
 * The promiscuous callback is kept minimal (just writes into a ring buffer
 * protected by a spinlock) so it never blocks the WiFi driver.
 *
 * NOTE: We filter out frames from our own MAC (loopback) and the AP BSSID
 * to avoid tracking the router itself or our own retransmissions.
 */

#include "wifi_scanner.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_wifi.h"
#include "esp_wifi_types.h"
#include "esp_log.h"
#include "lwip/sockets.h"
#include "lwip/netdb.h"

static const char *TAG = "wifi_scanner";

/* ── Device table ─────────────────────────────────────────────────────────── */

#define RSSI_HISTORY 8  /* ring buffer depth per device */

typedef struct {
    uint8_t  mac[6];
    int8_t   rssi_buf[RSSI_HISTORY];
    uint8_t  rssi_head;
    uint8_t  rssi_count;
    uint32_t pkt_count;   /* packets seen this window */
    bool     active;
} device_entry_t;

static device_entry_t s_devices[WIFI_SCANNER_MAX_DEVICES];
static portMUX_TYPE   s_mux = portMUX_INITIALIZER_UNLOCKED;
static uint8_t        s_own_mac[6];
static uint8_t        s_ap_bssid[6];

/* ── UDP sender state ─────────────────────────────────────────────────────── */

static int      s_sock        = -1;
static char     s_target_ip[64];
static uint16_t s_target_port;

/* ── Task handle ──────────────────────────────────────────────────────────── */
static TaskHandle_t s_flush_task = NULL;

/* ─────────────────────────────────────────────────────────────────────────── */

static bool mac_eq(const uint8_t *a, const uint8_t *b) {
    return memcmp(a, b, 6) == 0;
}

static bool is_multicast(const uint8_t *mac) {
    return mac[0] & 0x01;
}

/** Find or allocate a device slot.  Returns NULL if table is full. */
static device_entry_t *find_or_alloc(const uint8_t *mac) {
    device_entry_t *free_slot = NULL;
    for (int i = 0; i < WIFI_SCANNER_MAX_DEVICES; i++) {
        if (s_devices[i].active && mac_eq(s_devices[i].mac, mac))
            return &s_devices[i];
        if (!s_devices[i].active && !free_slot)
            free_slot = &s_devices[i];
    }
    if (free_slot) {
        memset(free_slot, 0, sizeof(*free_slot));
        memcpy(free_slot->mac, mac, 6);
        free_slot->active = true;
    }
    return free_slot;
}

/* ── Promiscuous callback ─────────────────────────────────────────────────── */

static void IRAM_ATTR promisc_cb(void *buf, wifi_promiscuous_pkt_type_t type) {
    if (type != WIFI_PKT_MGMT && type != WIFI_PKT_DATA) return;

    const wifi_promiscuous_pkt_t *pkt = (wifi_promiscuous_pkt_t *)buf;
    const uint8_t *payload = pkt->payload;
    int8_t rssi = pkt->rx_ctrl.rssi;

    /* IEEE 802.11 frame: bytes 10-15 = Transmitter Address (TA) */
    if (pkt->rx_ctrl.sig_len < 16) return;
    const uint8_t *ta = payload + 10;

    /* Skip multicast, own MAC, AP BSSID */
    if (is_multicast(ta)) return;
    if (mac_eq(ta, s_own_mac)) return;
    if (mac_eq(ta, s_ap_bssid)) return;

    /* Accumulate */
    portENTER_CRITICAL_ISR(&s_mux);
    device_entry_t *dev = find_or_alloc(ta);
    if (dev) {
        dev->rssi_buf[dev->rssi_head] = rssi;
        dev->rssi_head = (dev->rssi_head + 1) % RSSI_HISTORY;
        if (dev->rssi_count < RSSI_HISTORY) dev->rssi_count++;
        dev->pkt_count++;
    }
    portEXIT_CRITICAL_ISR(&s_mux);
}

/* ── RSSI median ──────────────────────────────────────────────────────────── */

static int cmp_i8(const void *a, const void *b) {
    return (int)(*(int8_t *)a) - (int)(*(int8_t *)b);
}

static int8_t median_rssi(device_entry_t *dev) {
    int8_t tmp[RSSI_HISTORY];
    uint8_t n = dev->rssi_count;
    for (uint8_t i = 0; i < n; i++) {
        tmp[i] = dev->rssi_buf[i];
    }
    qsort(tmp, n, sizeof(int8_t), cmp_i8);
    return tmp[n / 2];
}

/* ── UDP helpers ──────────────────────────────────────────────────────────── */

static void udp_send(const char *json, size_t len) {
    if (s_sock < 0) return;
    struct sockaddr_in dest = {
        .sin_family = AF_INET,
        .sin_port   = htons(s_target_port),
    };
    inet_pton(AF_INET, s_target_ip, &dest.sin_addr);
    sendto(s_sock, json, len, 0, (struct sockaddr *)&dest, sizeof(dest));
}

/* ── Flush task ───────────────────────────────────────────────────────────── */

static void flush_task(void *arg) {
    uint8_t node_id = 1;  /* default; can be overridden via NVS */
    /* Try to read node_id from NVS through the already-loaded config.
     * We access the extern g_nvs_config from nvs_config.h if available. */
#ifdef CONFIG_CSI_NODE_ID
    node_id = CONFIG_CSI_NODE_ID;
#endif

    char json[1024];

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(WIFI_SCANNER_WINDOW_MS));

        /* Snapshot the device table under lock */
        device_entry_t snapshot[WIFI_SCANNER_MAX_DEVICES];
        portENTER_CRITICAL(&s_mux);
        memcpy(snapshot, s_devices, sizeof(s_devices));
        /* Reset counts for next window */
        for (int i = 0; i < WIFI_SCANNER_MAX_DEVICES; i++) {
            s_devices[i].rssi_count = 0;
            s_devices[i].rssi_head  = 0;
            s_devices[i].pkt_count  = 0;
        }
        portEXIT_CRITICAL(&s_mux);

        /* Build JSON */
        int pos = snprintf(json, sizeof(json),
            "{\"msg_type\":\"wifi_scan\",\"node_id\":%u,\"timestamp_ms\":%llu,\"devices\":[",
            (unsigned)node_id,
            (unsigned long long)(esp_timer_get_time() / 1000ULL));

        bool first = true;
        int active_count = 0;
        for (int i = 0; i < WIFI_SCANNER_MAX_DEVICES; i++) {
            if (!snapshot[i].active || snapshot[i].rssi_count == 0) continue;
            if (pos >= (int)sizeof(json) - 80) break;  /* safety margin */

            int8_t med = median_rssi(&snapshot[i]);
            const uint8_t *m = snapshot[i].mac;

            pos += snprintf(json + pos, sizeof(json) - pos,
                "%s{\"mac\":\"%02X:%02X:%02X:%02X:%02X:%02X\",\"rssi\":%d,\"count\":%lu}",
                first ? "" : ",",
                m[0], m[1], m[2], m[3], m[4], m[5],
                (int)med,
                (unsigned long)snapshot[i].pkt_count);
            first = false;
            active_count++;
        }

        pos += snprintf(json + pos, sizeof(json) - pos, "]}");

        if (active_count > 0) {
            udp_send(json, pos);
            ESP_LOGD(TAG, "Flushed %d devices: %s", active_count, json);
        }
    }
}

/* ── Public API ───────────────────────────────────────────────────────────── */

esp_err_t wifi_scanner_init(const char *target_ip, uint16_t target_port) {
    strncpy(s_target_ip, target_ip, sizeof(s_target_ip) - 1);
    s_target_port = target_port;

    /* Get own MAC */
    esp_wifi_get_mac(WIFI_IF_STA, s_own_mac);

    /* Get AP BSSID from current association */
    wifi_ap_record_t ap_info;
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        memcpy(s_ap_bssid, ap_info.bssid, 6);
        ESP_LOGI(TAG, "AP BSSID: %02X:%02X:%02X:%02X:%02X:%02X",
                 s_ap_bssid[0], s_ap_bssid[1], s_ap_bssid[2],
                 s_ap_bssid[3], s_ap_bssid[4], s_ap_bssid[5]);
    }

    /* Create UDP socket */
    s_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s_sock < 0) {
        ESP_LOGE(TAG, "Failed to create UDP socket");
        return ESP_FAIL;
    }

    /* Enable promiscuous mode — MGMT + DATA frames */
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));
    wifi_promiscuous_filter_t filter = {
        .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA
    };
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_filter(&filter));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_rx_cb(promisc_cb));

    /* Start flush task on core 0 (WiFi uses core 0, but low priority) */
    BaseType_t rc = xTaskCreatePinnedToCore(
        flush_task, "wifi_scan_flush",
        4096, NULL, 2, &s_flush_task, 0);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "Failed to create flush task");
        esp_wifi_set_promiscuous(false);
        close(s_sock);
        s_sock = -1;
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "WiFi scanner active → %s:%u (MGMT+DATA, window=%d ms)",
             target_ip, (unsigned)target_port, WIFI_SCANNER_WINDOW_MS);
    return ESP_OK;
}

void wifi_scanner_deinit(void) {
    if (s_flush_task) {
        vTaskDelete(s_flush_task);
        s_flush_task = NULL;
    }
    esp_wifi_set_promiscuous(false);
    esp_wifi_set_promiscuous_rx_cb(NULL);
    if (s_sock >= 0) {
        close(s_sock);
        s_sock = -1;
    }
    ESP_LOGI(TAG, "WiFi scanner stopped");
}
