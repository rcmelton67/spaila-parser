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

function humanizeApiDetail(detail, fallback = "Spaila API request failed.") {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        const field = Array.isArray(item?.loc) ? item.loc[item.loc.length - 1] : "";
        const message = String(item?.msg || "").trim();
        if (field === "password" && /at least 8|minimum|short/i.test(message)) {
          return "Enter a password with at least 8 characters.";
        }
        if (field === "email") return "Enter a valid email address.";
        return message;
      })
      .filter(Boolean);
    if (messages.length) return [...new Set(messages)].join(" ");
  }
  if (detail && typeof detail === "object") {
    return detail.message || detail.error || detail.detail || fallback;
  }
  return fallback;
}

export function createApiClient({ baseUrl = "", fetchImpl } = {}) {
  const resolvedBase = resolveApiBase(baseUrl);
  const requestFetch = fetchImpl || globalThis.fetch;
  if (typeof requestFetch !== "function") {
    throw new Error("Fetch API is not available for the Spaila API client.");
  }

  async function request(path, options = {}) {
    const response = await requestFetch(`${resolvedBase}${path}`, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.detail || payload?.error;
      const message = humanizeApiDetail(detail, `Spaila API request failed: ${response.status}`);
      const error = new Error(message);
      error.status = response.status;
      error.detail = detail;
      throw error;
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
    delete: (path, options = {}) => request(path, { ...options, method: "DELETE" }),
  };
}
