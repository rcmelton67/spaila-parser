export const DOCUMENT_ASSET_KEYS = Object.freeze({
  giftTemplate: "gift_template",
  thankYouTemplate: "thank_you_template",
});

export const DEFAULT_DOCUMENTS_CONFIG = Object.freeze({
  gift_template: null,
  thank_you_template: null,
  show_gift_print_icon: true,
  show_thank_you_shortcut: true,
  gift_text_x: 72,
  gift_text_y: 500,
  gift_text_max_width: 450,
  font_size: 12,
  text_color: "#000000",
  future_docs: {},
  layout_version: 1,
});

function normalizeAssetRef(value, assetKey) {
  if (!value || typeof value !== "object") return null;
  const key = String(value.asset_key || assetKey || "").trim();
  const name = String(value.name || "").trim();
  if (!key && !name) return null;
  return {
    asset_key: key,
    name,
    mime_type: String(value.mime_type || "application/pdf").trim(),
    size: Number.isFinite(Number(value.size)) ? Number(value.size) : 0,
    updated_at: String(value.updated_at || "").trim(),
  };
}

function numberOrDefault(value, fallback, min, max) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function normalizeHex(value, fallback = "#000000") {
  const raw = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw.slice(1).split("").map((char) => char + char).join("")}`;
  }
  return fallback;
}

export function normalizeDocumentsConfig(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_DOCUMENTS_CONFIG,
    ...source,
    gift_template: normalizeAssetRef(source.gift_template, DOCUMENT_ASSET_KEYS.giftTemplate),
    thank_you_template: normalizeAssetRef(source.thank_you_template, DOCUMENT_ASSET_KEYS.thankYouTemplate),
    show_gift_print_icon: source.show_gift_print_icon != null ? Boolean(source.show_gift_print_icon) : true,
    show_thank_you_shortcut: source.show_thank_you_shortcut != null ? Boolean(source.show_thank_you_shortcut) : true,
    gift_text_x: numberOrDefault(source.gift_text_x, DEFAULT_DOCUMENTS_CONFIG.gift_text_x, 0, 800),
    gift_text_y: numberOrDefault(source.gift_text_y, DEFAULT_DOCUMENTS_CONFIG.gift_text_y, 0, 1200),
    gift_text_max_width: numberOrDefault(source.gift_text_max_width, DEFAULT_DOCUMENTS_CONFIG.gift_text_max_width, 50, 800),
    font_size: numberOrDefault(source.font_size, DEFAULT_DOCUMENTS_CONFIG.font_size, 6, 72),
    text_color: normalizeHex(source.text_color, DEFAULT_DOCUMENTS_CONFIG.text_color),
    future_docs: source.future_docs && typeof source.future_docs === "object" ? source.future_docs : {},
    layout_version: Number.isFinite(Number(source.layout_version)) ? Number(source.layout_version) : 1,
    updated_at: String(source.updated_at || "").trim(),
  };
}

export function desktopDocumentsToShared(config = {}) {
  return normalizeDocumentsConfig({
    gift_template: config.letterheadName ? { asset_key: DOCUMENT_ASSET_KEYS.giftTemplate, name: config.letterheadName } : null,
    thank_you_template: config.thankYouName ? { asset_key: DOCUMENT_ASSET_KEYS.thankYouTemplate, name: config.thankYouName } : null,
    show_gift_print_icon: config.showPrintIcon !== false,
    show_thank_you_shortcut: config.showThankYouHeaderBtn !== false,
    gift_text_x: config.giftTextX,
    gift_text_y: config.giftTextY,
    gift_text_max_width: config.giftTextMaxWidth,
    font_size: config.giftTextFontSize,
    text_color: config.giftTextColor,
    layout_version: 1,
  });
}

export function sharedDocumentsToDesktop(shared = {}, current = {}) {
  const config = normalizeDocumentsConfig(shared);
  return {
    ...current,
    letterheadName: config.gift_template?.name || current.letterheadName || "",
    thankYouName: config.thank_you_template?.name || current.thankYouName || "",
    showPrintIcon: config.show_gift_print_icon,
    showThankYouHeaderBtn: config.show_thank_you_shortcut,
    giftTextX: config.gift_text_x,
    giftTextY: config.gift_text_y,
    giftTextMaxWidth: config.gift_text_max_width,
    giftTextFontSize: config.font_size,
    giftTextColor: config.text_color,
    sharedUpdatedAt: config.updated_at,
  };
}
