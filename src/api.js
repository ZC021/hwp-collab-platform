import { withAppBasePath } from "./base-path.js";

const LEGACY_AUTH_STORAGE_KEYS = [
  "token",
  "user",
  "cookie-session"
].map((suffix) => `rhwp-collab-${suffix}`);
const APP_STORAGE_PREFIXES = ["rhwp-collab-", "hwp-collab-"];

export function getStoredAuth() {
  clearLegacyAuthStorage();
  return { user: null, cookieSession: false };
}

export function storeAuth() {
  clearLegacyAuthStorage();
}

export function clearAuth() {
  clearLegacyAuthStorage();
}

export async function clearLogoutCache() {
  clearAuth();
  clearAppStorage(localStorage);
  try {
    sessionStorage.clear();
  } catch {}
  await Promise.all([clearCacheStorage(), clearAppIndexedDbs()]);
}

function clearAppStorage(storage) {
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && APP_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        keys.push(key);
      }
    }
    for (const key of keys) storage.removeItem(key);
  } catch {}
}

function clearLegacyAuthStorage() {
  try {
    for (const key of LEGACY_AUTH_STORAGE_KEYS) {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    }
  } catch {}
}

async function clearCacheStorage() {
  try {
    if (!globalThis.caches?.keys) return;
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {}
}

async function clearAppIndexedDbs() {
  try {
    if (!globalThis.indexedDB?.databases) return;
    const databases = await indexedDB.databases();
    const names = databases
      .map((database) => database?.name)
      .filter((name) => name && APP_STORAGE_PREFIXES.some((prefix) => name.startsWith(prefix)));
    await Promise.all(names.map(deleteIndexedDb));
  } catch {}
}

function deleteIndexedDb(name) {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(withAppBasePath(path), {
    ...options,
    credentials: "same-origin",
    headers,
    body: options.body && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  const data = text && contentType.includes("application/json") ? JSON.parse(text) : text ? { message: text } : null;
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || response.statusText);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export async function loadFileBuffer(documentId) {
  const response = await fetch(withAppBasePath(`/api/documents/${documentId}/file`), {
    credentials: "same-origin"
  });
  if (!response.ok) {
    throw new Error("file_load_failed");
  }
  return response.arrayBuffer();
}

export async function loadPreviewBlobUrl(documentId) {
  const response = await fetch(withAppBasePath(`/api/documents/${documentId}/preview-html`), {
    credentials: "same-origin"
  });
  if (!response.ok) throw new Error("preview_load_failed");
  const html = await response.text();
  const blob = new Blob([html], { type: "text/html" });
  return URL.createObjectURL(blob);
}

export async function fetchDocumentText(documentId) {
  return api(`/api/documents/${documentId}/text`);
}

export async function searchDocuments(query, limit = 20) {
  if (!query) return { query: "", results: [] };
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return api(`/api/search?${params.toString()}`);
}

export async function fetchCollabStatus(documentId) {
  return api(`/api/documents/${documentId}/collab-status`);
}
