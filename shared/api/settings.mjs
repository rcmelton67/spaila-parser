import { API_ENDPOINTS } from "./endpoints.mjs";

export const DEFAULT_WEB_SETTINGS = Object.freeze({
  default_order_scope: "active",
  default_order_sort: "newest",
  order_density: "comfortable",
  show_attachment_previews: true,
  show_completed_tab: true,
  show_inventory_tab: false,
  show_thank_you_shortcut: true,
  archive_default_status: "archived",
});

export const DEFAULT_DATE_CONFIG = Object.freeze({
  format: "short",
  showYear: true,
  flexibleSearch: true,
});

export function normalizeDateConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const format = ["short", "numeric", "iso"].includes(source.format) ? source.format : DEFAULT_DATE_CONFIG.format;
  return {
    ...DEFAULT_DATE_CONFIG,
    ...source,
    format,
    showYear: source.showYear != null ? Boolean(source.showYear) : DEFAULT_DATE_CONFIG.showYear,
    flexibleSearch: source.flexibleSearch != null ? Boolean(source.flexibleSearch) : DEFAULT_DATE_CONFIG.flexibleSearch,
  };
}

export function normalizeWebSettings(value = {}) {
  return {
    ...DEFAULT_WEB_SETTINGS,
    ...value,
    default_order_scope: String(value.default_order_scope || DEFAULT_WEB_SETTINGS.default_order_scope).trim(),
    default_order_sort: String(value.default_order_sort || DEFAULT_WEB_SETTINGS.default_order_sort).trim(),
    order_density: String(value.order_density || DEFAULT_WEB_SETTINGS.order_density).trim(),
    show_attachment_previews: value.show_attachment_previews !== false,
    // Explicit boolean normalisation — SQLite may return 0/1 integers; treat absence as true.
    show_completed_tab: value.show_completed_tab != null ? Boolean(value.show_completed_tab) : true,
    show_inventory_tab: value.show_inventory_tab != null ? Boolean(value.show_inventory_tab) : false,
    show_thank_you_shortcut: value.show_thank_you_shortcut != null ? Boolean(value.show_thank_you_shortcut) : true,
    archive_default_status: String(value.archive_default_status || DEFAULT_WEB_SETTINGS.archive_default_status).trim(),
  };
}

export function createSettingsApi(apiClient) {
  return {
    async getWebSettings() {
      return normalizeWebSettings(await apiClient.get(API_ENDPOINTS.webSettings));
    },
    async updateWebSettings(patch = {}) {
      return normalizeWebSettings(await apiClient.patch(API_ENDPOINTS.webSettings, patch));
    },
    async getDateConfig() {
      return normalizeDateConfig(await apiClient.get(API_ENDPOINTS.dateConfig));
    },
    async updateDateConfig(patch = {}) {
      return normalizeDateConfig(await apiClient.patch(API_ENDPOINTS.dateConfig, patch));
    },
  };
}
