/**
 * @file wifi_scanner.h
 * @brief WiFi probe-request / data-frame scanner for smartphone tracking.
 *
 * Runs in parallel with the CSI collector. Uses promiscuous mode to sniff
 * WiFi management and data frames, extracts (MAC, RSSI) pairs, aggregates
 * over a 1-second window, and sends a compact JSON UDP packet to the bridge
 * on port 5006.
 *
 * This allows the bridge to do 2-anchor trilateration using:
 *   - ESP32 RSSI (from this module)
 *   - Router RSSI (polled by the bridge from the router admin API / ARP)
 */

#pragma once
#include "esp_err.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Maximum number of unique devices tracked simultaneously. */
#define WIFI_SCANNER_MAX_DEVICES 16

/** Scan window duration before flushing a UDP report (milliseconds). */
#define WIFI_SCANNER_WINDOW_MS   1000

/**
 * @brief Initialize the WiFi scanner.
 *
 * Must be called AFTER wifi_init_sta() has connected.
 * Registers a promiscuous RX callback and starts a background FreeRTOS
 * task that flushes aggregated RSSI data via UDP every WIFI_SCANNER_WINDOW_MS.
 *
 * @param target_ip   IP of the bridge host (e.g. "192.168.1.100")
 * @param target_port UDP port on the bridge (default: 5006)
 * @return ESP_OK on success.
 */
esp_err_t wifi_scanner_init(const char *target_ip, uint16_t target_port);

/**
 * @brief Stop the scanner and deregister the promiscuous callback.
 */
void wifi_scanner_deinit(void);

#ifdef __cplusplus
}
#endif
