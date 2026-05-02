import { API_ENDPOINTS } from "./endpoints.mjs";
import { normalizeArchiveQuery } from "../models/archive.mjs";

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const normalized = String(value ?? "").trim();
    if (normalized) query.set(key, normalized);
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

export function normalizeArchiveResult(row = {}) {
  return {
    archive_id: String(row.archive_id || "").trim(),
    original_order_id: String(row.original_order_id || "").trim(),
    order_number: String(row.order_number || "").trim(),
    buyer_name: String(row.buyer_name || "").trim(),
    buyer_email: String(row.buyer_email || "").trim(),
    shipping_address: String(row.shipping_address || "").trim(),
    pet_name: String(row.pet_name || "").trim(),
    order_date: String(row.order_date || "").trim(),
    archived_at: String(row.archived_at || "").trim(),
    archive_status: String(row.archive_status || "archived").trim() || "archived",
    folder_name: String(row.folder_name || "").trim(),
    product_text: String(row.product_text || "").trim(),
    notes_text: String(row.notes_text || "").trim(),
    conversation_text: String(row.conversation_text || "").trim(),
    match_fields: Array.isArray(row.match_fields) ? row.match_fields : [],
    snippet: String(row.snippet || "").trim(),
  };
}

export function createArchiveApi(apiClient) {
  return {
    async search({ q = "", status = "archived" } = {}) {
      const payload = await apiClient.get(`${API_ENDPOINTS.archiveSearch}${buildQuery({ q: normalizeArchiveQuery(q), status, include_paths: "false" })}`);
      return Array.isArray(payload) ? payload.map(normalizeArchiveResult) : [];
    },
  };
}
