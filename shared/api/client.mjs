import { DEFAULT_LOCAL_API_BASE } from "./endpoints.mjs";

export function resolveApiBase(explicitBase = "") {
  const configured = String(explicitBase || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    const globalBase = String(window.__SPAILA_API_BASE__ || "").trim();
    if (globalBase) return globalBase.replace(/\/+$/, "");
  }
  return DEFAULT_LOCAL_API_BASE;
}

export function createApiClient({ baseUrl = "", fetchImpl } = {}) {
  const resolvedBase = resolveApiBase(baseUrl);
  const requestFetch = fetchImpl || globalThis.fetch;
  if (typeof requestFetch !== "function") {
    throw new Error("Fetch API is not available for the Spaila API client.");
  }

  async function request(path, options = {}) {
    const response = await requestFetch(`${resolvedBase}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.detail || payload?.error || `Spaila API request failed: ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }

  return {
    baseUrl: resolvedBase,
    get: (path, options = {}) => request(path, { ...options, method: "GET" }),
    post: (path, body, options = {}) => request(path, {
      ...options,
      method: "POST",
      body: JSON.stringify(body || {}),
    }),
    patch: (path, body, options = {}) => request(path, {
      ...options,
      method: "PATCH",
      body: JSON.stringify(body || {}),
    }),
  };
}
