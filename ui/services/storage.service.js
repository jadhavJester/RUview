// Client-side persistence helper for Custom Room GLTF/GLB models using IndexedDB
// and alignment configuration parameters using localStorage.

const DB_NAME = 'RuViewSensingDB';
const DB_VERSION = 1;
const STORE_NAME = 'room_models';
const MODEL_KEY = 'custom_room_glb';
const CONFIG_KEY = 'custom_room_config';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export const StorageService = {
  // Store GLB/GLTF ArrayBuffer in IndexedDB
  async saveRoomModel(arrayBuffer) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(arrayBuffer, MODEL_KEY);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  },

  // Retrieve GLB/GLTF ArrayBuffer from IndexedDB
  async getRoomModel() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(MODEL_KEY);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  },

  // Clear GLB/GLTF model from IndexedDB
  async clearRoomModel() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(MODEL_KEY);

      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  },

  // Save transformation configuration (position, scale, rotation) in localStorage
  saveModelConfig(config) {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      return true;
    } catch (e) {
      console.error('[Storage] Error saving model config:', e);
      return false;
    }
  },

  // Retrieve transformation configuration from localStorage
  getModelConfig() {
    try {
      const data = localStorage.getItem(CONFIG_KEY);
      if (data) {
        return JSON.parse(data);
      }
    } catch (e) {
      console.error('[Storage] Error reading model config:', e);
    }
    // Default values
    return {
      scale: 1.0,
      posX: 0.0,
      posY: 0.0,
      posZ: 0.0,
      rotX: 0.0,
      rotY: 0.0,
      rotZ: 0.0
    };
  }
};
