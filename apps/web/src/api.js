import { createApiClient } from "../../../shared/api/client.mjs";
import { createArchiveApi } from "../../../shared/api/archive.mjs";
import { createAttachmentsApi } from "../../../shared/api/attachments.mjs";
import { createOrdersApi } from "../../../shared/api/orders.mjs";
import { createSettingsApi } from "../../../shared/api/settings.mjs";

// ── Diagnostics buffers — used by SupportModal to capture recent failures ────

const _apiFaultBuf = [];
const _promiseRejectBuf = [];
const _consoleErrBuf = [];

/** Log an API failure entry (called by the wrapped client). */
export function _logApiFault(path, status, msg) {
  _apiFaultBuf.push({
    ts: new Date().toISOString(),
    path: String(path || "").slice(0, 200),
    status: status || 0,
    msg: String(msg || "").slice(0, 300),
  });
  if (_apiFaultBuf.length > 25) _apiFaultBuf.shift();
}

/** Read the recent API fault buffer (for support reports). */
export function getApiFaultBuffer() {
  return [..._apiFaultBuf];
}

/** Read the recent promise rejection buffer. */
export function getPromiseRejectBuffer() {
  return [..._promiseRejectBuf];
}

/** Read the recent console error buffer. */
export function getConsoleErrorBuffer() {
  return [..._consoleErrBuf];
}

// Patch console.error once at module load time
if (typeof window !== "undefined") {
  const _origError = console.error.bind(console);
  console.error = (...args) => {
    const msg = String(args[0] || "").slice(0, 300);
    if (msg) {
      _consoleErrBuf.push({ ts: new Date().toISOString(), msg });
      if (_consoleErrBuf.length > 25) _consoleErrBuf.shift();
    }
    _origError(...args);
  };

  // Capture unhandled promise rejections
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event?.reason;
    const msg = (reason instanceof Error ? reason.message : String(reason || "")).slice(0, 300);
    if (msg) {
      _promiseRejectBuf.push({ ts: new Date().toISOString(), msg });
      if (_promiseRejectBuf.length > 20) _promiseRejectBuf.shift();
    }
  });
}

// ── Wrapped API client — instruments failures into diagnostics buffer ────────

function wrapWithDiagnostics(client) {
  const intercept = (method) =>
    async (...args) => {
      try {
        return await client[method](...args);
      } catch (err) {
        _logApiFault(args[0], err?.status, err?.message);
        throw err;
      }
    };
  return {
    ...client,
    get: intercept("get"),
    post: intercept("post"),
    patch: intercept("patch"),
    delete: intercept("delete"),
  };
}

export const api = wrapWithDiagnostics(createApiClient());
export const ordersApi = createOrdersApi(api);
export const archiveApi = createArchiveApi(api);
export const attachmentsApi = createAttachmentsApi(api);
export const settingsApi = createSettingsApi(api);
