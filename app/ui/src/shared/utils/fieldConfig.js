/**
 * Canonical field definitions for the whole app.
 *
 * fixed: true  → label is locked
 *
 * defaultVisibleInOrders  → default column visibility in the Active orders sheet
 * defaultVisibleInParser  → default field visibility in the parser panel
 * defaultPaletteEnabled   → default "apply row color to this cell" toggle
 * defaultHighlightEnabled → default cell-level highlight (independent of price palette)
 * defaultHighlightColor   → hex color for the highlight (null = none)
 *
 * Names are SHARED — one label used everywhere.
 */
export const FIELD_DEFS = [
  // key                      label                    fixed   orders   parser   palette   hlEnabled  hlColor
  { key: "order_number",   defaultLabel: "Order #",          fixed: false, defaultVisibleInOrders: true,  defaultVisibleInParser: true,  defaultPaletteEnabled: false, defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 100 },
  { key: "buyer_name",     defaultLabel: "Buyer Name",       fixed: false, defaultVisibleInOrders: true,  defaultVisibleInParser: true,  defaultPaletteEnabled: true,  defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 160 },
  { key: "price",          defaultLabel: "Price",            fixed: false, defaultVisibleInOrders: true,  defaultVisibleInParser: true,  defaultPaletteEnabled: true,  defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 75  },
  { key: "quantity",       defaultLabel: "Qty",              fixed: false, defaultVisibleInOrders: true,  defaultVisibleInParser: true,  defaultPaletteEnabled: false, defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 50  },
  { key: "custom_1",       defaultLabel: "Line 1",           fixed: false, defaultVisibleInOrders: true,  defaultVisibleInParser: true,  defaultPaletteEnabled: true,  defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 140 },
  { key: "custom_2",       defaultLabel: "Line 2",           fixed: false, defaultVisibleInOrders: true,  defaultVisibleInParser: true,  defaultPaletteEnabled: true,  defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 140 },
  { key: "custom_3",       defaultLabel: "Line 3",           fixed: false, defaultVisibleInOrders: true,  defaultVisibleInParser: true,  defaultPaletteEnabled: true,  defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 140 },
  { key: "custom_4",       defaultLabel: "Line 4",           fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true,  defaultPaletteEnabled: true,  defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 140 },
  { key: "custom_5",       defaultLabel: "Line 5",           fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true,  defaultPaletteEnabled: true,  defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 140 },
  { key: "custom_6",       defaultLabel: "Line 6",           fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true,  defaultPaletteEnabled: true,  defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 140 },
  { key: "shipping_address", defaultLabel: "Shipping Address", fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true, defaultPaletteEnabled: false, defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 160 },
  { key: "order_date",     defaultLabel: "Order Date",       fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true,  defaultPaletteEnabled: false, defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 90  },
  { key: "ship_by",        defaultLabel: "Ship By",          fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true,  defaultPaletteEnabled: false, defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 90  },
  { key: "buyer_email",    defaultLabel: "Buyer Email",      fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true,  defaultPaletteEnabled: false, defaultHighlightEnabled: false, defaultHighlightColor: null,      defaultWidth: 150 },
  { key: "gift_message",   defaultLabel: "Gift Message",     fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true,  defaultPaletteEnabled: false, defaultHighlightEnabled: true,  defaultHighlightColor: "#fca5a5"             },
  { key: "order_notes",    defaultLabel: "Order Notes",      fixed: false, defaultVisibleInOrders: false, defaultVisibleInParser: true,  defaultPaletteEnabled: false, defaultHighlightEnabled: false, defaultHighlightColor: null               },
];

/**
 * The field key that acts as the "type" field in the price list.
 * Its label is read from fieldConfig so renaming it propagates everywhere.
 */
export const PRICE_TYPE_FIELD_KEY = "custom_6";

/**
 * Given a CSS hex color string (e.g. "#7f1d1d" or "#fff"), return
 * "#ffffff" if the background is dark or "#1a1a1a" if it is light.
 * Handles 3-digit and 6-digit hex; falls back to dark text on error.
 */
export function contrastColor(hex) {
  try {
    if (!hex || typeof hex !== "string") return "#1a1a1a";
    const clean = hex.replace(/^#/, "").trim();
    // Expand 3-digit → 6-digit
    const full = clean.length === 3
      ? clean.split("").map((c) => c + c).join("")
      : clean;
    if (full.length !== 6) return "#1a1a1a";
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    // Perceived luminance (ITU-R BT.601)
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? "#1a1a1a" : "#ffffff";
  } catch {
    return "#1a1a1a";
  }
}

const STORAGE_KEY = "spaila_field_config";

/** Read persisted config from localStorage, merged with defaults. */
export function loadFieldConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return FIELD_DEFS.map((def) => {
      const s = saved[def.key] ?? {};
      return {
        key:               def.key,
        label:             s.label             ?? def.defaultLabel,
        fixed:             def.fixed,
        visibleInOrders:   s.visibleInOrders   ?? s.visible ?? def.defaultVisibleInOrders,
        visibleInParser:   s.visibleInParser   ?? def.defaultVisibleInParser,
        paletteEnabled:    s.paletteEnabled    ?? def.defaultPaletteEnabled,
        highlight: {
          enabled: s.highlight?.enabled ?? def.defaultHighlightEnabled,
          color:   s.highlight?.color   ?? def.defaultHighlightColor ?? null,
        },
        defaultWidth:      def.defaultWidth ?? null,
      };
    });
  } catch {
    return FIELD_DEFS.map((def) => ({
      key: def.key, label: def.defaultLabel, fixed: def.fixed,
      visibleInOrders: def.defaultVisibleInOrders,
      visibleInParser: def.defaultVisibleInParser,
      paletteEnabled:  def.defaultPaletteEnabled,
      highlight: {
        enabled: def.defaultHighlightEnabled,
        color:   def.defaultHighlightColor ?? null,
      },
      defaultWidth: def.defaultWidth ?? null,
    }));
  }
}

/** Build a key → label lookup for quick access. */
export function buildLabelMap(config) {
  return Object.fromEntries(config.map((f) => [f.key, f.label]));
}

/** Persist config changes and notify all components via a custom event. */
export function saveFieldConfig(config) {
  const payload = {};
  for (const f of config) {
    payload[f.key] = {
      label:           f.label,
      visibleInOrders: f.visibleInOrders,
      visibleInParser: f.visibleInParser,
      paletteEnabled:  f.paletteEnabled,
      highlight: {
        enabled: f.highlight?.enabled ?? false,
        color:   f.highlight?.color   ?? null,
      },
    };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  window.dispatchEvent(new CustomEvent("spaila:fieldconfig"));
}

// ── Price list ─────────────────────────────────────────────────────────────
const PRICE_LIST_KEY = "spaila_price_list";

/**
 * A price rule: { id, price, typeValue, color }
 *   id        — stable React key
 *   price     — string like "35" or "35.00"
 *   typeValue — label shown in the "type" column (e.g. "Heart")
 *   color     — hex background color (e.g. "#ffb3c1")
 */
export function loadPriceList() {
  try {
    const raw = localStorage.getItem(PRICE_LIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function savePriceList(list) {
  localStorage.setItem(PRICE_LIST_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent("spaila:pricelist"));
}

/**
 * Given a price string, find the matching rule.
 * Comparison is numeric so "35" === "35.00".
 */
export function matchPriceRule(priceStr, priceList) {
  if (!priceStr || !priceList?.length) return null;
  const num = parseFloat(String(priceStr).replace(/[^0-9.]/g, ""));
  if (isNaN(num)) return null;
  return priceList.find((r) => {
    const rNum = parseFloat(String(r.price).replace(/[^0-9.]/g, ""));
    return !isNaN(rNum) && Math.abs(rNum - num) < 0.001;
  }) ?? null;
}

// ── Status column ────────────────────────────────────────────────────────
const STATUS_CONFIG_KEY    = "spaila_status_config";
const ORDER_STATUSES_KEY   = "spaila_order_statuses";

export const DEFAULT_STATUS_CONFIG = {
  enabled:     true,
  columnLabel: "Status",
  states: [
    { key: "pending",  label: "Pending",  color: "#fef3c7" },
    { key: "sent",     label: "Sent",     color: "#dbeafe" },
    { key: "approved", label: "Approved", color: "#d1fae5" },
  ],
};

export function loadStatusConfig() {
  try {
    const raw = localStorage.getItem(STATUS_CONFIG_KEY);
    if (!raw) return structuredClone(DEFAULT_STATUS_CONFIG);
    const saved = JSON.parse(raw);
    // Merge with defaults so new fields are always present
    return {
      ...DEFAULT_STATUS_CONFIG,
      ...saved,
      states: saved.states ?? DEFAULT_STATUS_CONFIG.states,
    };
  } catch {
    return structuredClone(DEFAULT_STATUS_CONFIG);
  }
}

export function saveStatusConfig(config) {
  localStorage.setItem(STATUS_CONFIG_KEY, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent("spaila:statusconfig"));
}

/** Returns {orderId: statusKey} map for all orders. */
export function loadOrderStatuses() {
  try {
    const raw = localStorage.getItem(ORDER_STATUSES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Persist a single order's status change without rewriting everything. */
export function setOrderStatus(orderId, statusKey) {
  const map = loadOrderStatuses();
  if (statusKey == null) {
    delete map[String(orderId)];
  } else {
    map[String(orderId)] = statusKey;
  }
  localStorage.setItem(ORDER_STATUSES_KEY, JSON.stringify(map));
}

// ── Column order ──────────────────────────────────────────────────────────
const COL_ORDER_KEY = "spaila_column_order";

/**
 * Virtual column keys managed outside FIELD_DEFS.
 * Default order: status → order_info → … field keys …
 */
const VIRTUAL_COLUMN_KEYS = ["status", "order_info"];
const ALL_COLUMN_KEYS = [...VIRTUAL_COLUMN_KEYS, ...FIELD_DEFS.map((d) => d.key)];

export function defaultColumnOrder() {
  return [...ALL_COLUMN_KEYS];
}

export function loadColumnOrder() {
  try {
    const raw = localStorage.getItem(COL_ORDER_KEY);
    if (!raw) return defaultColumnOrder();
    const saved = JSON.parse(raw);

    // Keep only still-valid keys in the order the user set
    let valid = saved.filter((k) => ALL_COLUMN_KEYS.includes(k));

    // Auto-insert missing virtual columns at their default positions
    if (!valid.includes("status")) valid.unshift("status");
    if (!valid.includes("order_info")) {
      const afterIdx = valid.indexOf("status");
      valid.splice(afterIdx + 1, 0, "order_info");
    }

    // Append any new FIELD_DEF keys at the end
    const missingFields = FIELD_DEFS.map((d) => d.key).filter((k) => !valid.includes(k));
    return [...valid, ...missingFields];
  } catch {
    return defaultColumnOrder();
  }
}

export function saveColumnOrder(order) {
  localStorage.setItem(COL_ORDER_KEY, JSON.stringify(order));
}

// ── Parser field order ────────────────────────────────────────────────────
const PARSER_FIELD_ORDER_KEY = "spaila_parser_field_order";

const _PARSER_ORDER_SECTION = ["buyer_name", "shipping_address", "order_number", "quantity", "order_date", "ship_by", "buyer_email"];
const _PARSER_ITEM_SECTION  = ["price", "custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6", "order_notes"];
const _ALL_PARSER_KEYS = [..._PARSER_ORDER_SECTION, ..._PARSER_ITEM_SECTION];

export const PARSER_ORDER_SECTION_KEYS = new Set(_PARSER_ORDER_SECTION);
export const PARSER_ITEM_SECTION_KEYS  = new Set(_PARSER_ITEM_SECTION);

export function defaultParserFieldOrder() {
  return [..._ALL_PARSER_KEYS];
}

export function loadParserFieldOrder() {
  try {
    const raw = localStorage.getItem(PARSER_FIELD_ORDER_KEY);
    if (!raw) return defaultParserFieldOrder();
    const saved = JSON.parse(raw);
    const valid   = saved.filter((k) => _ALL_PARSER_KEYS.includes(k));
    const missing = _ALL_PARSER_KEYS.filter((k) => !valid.includes(k));
    return [...valid, ...missing];
  } catch {
    return defaultParserFieldOrder();
  }
}

export function saveParserFieldOrder(order) {
  localStorage.setItem(PARSER_FIELD_ORDER_KEY, JSON.stringify(order));
  window.dispatchEvent(new CustomEvent("spaila:parserfieldorder"));
}

// ── View config ───────────────────────────────────────────────────────────
const VIEW_CONFIG_KEY = "spaila_view_config";

/**
 * Field groupings for the "View → Searchable Fields" UI.
 * key must match a FIELD_DEFS entry.
 */
export const SEARCH_FIELD_GROUPS = [
  {
    label: "Core",
    keys: ["order_number", "buyer_name", "price", "quantity"],
  },
  {
    label: "Details",
    keys: ["custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6", "order_date", "ship_by"],
  },
  {
    label: "System",
    keys: ["buyer_email", "shipping_address", "gift_message", "order_notes"],
  },
];

const ALL_SEARCHABLE_KEYS = SEARCH_FIELD_GROUPS.flatMap((g) => g.keys);

/** Defaults: most core + detail fields on, system off. */
const DEFAULT_SEARCHABLE = Object.fromEntries(
  ALL_SEARCHABLE_KEYS.map((k) => [k, ["order_number", "buyer_name", "custom_1", "custom_2", "custom_3"].includes(k)])
);

export const DEFAULT_VIEW_CONFIG = {
  searchableFields: { ...DEFAULT_SEARCHABLE },
  includeOrderInfo: true,
  defaultSort: { field: "order_date", direction: "desc" },
  showCompleted: true,
  showInventoryTab: false,
  groupMultiItem: false,
  searchMode: "smart",
};

export function loadViewConfig() {
  try {
    const raw = localStorage.getItem(VIEW_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_VIEW_CONFIG, searchableFields: { ...DEFAULT_VIEW_CONFIG.searchableFields } };
    const saved = JSON.parse(raw);
    return {
      ...DEFAULT_VIEW_CONFIG,
      ...saved,
      searchableFields: {
        ...DEFAULT_VIEW_CONFIG.searchableFields,
        ...(saved.searchableFields ?? {}),
      },
      defaultSort: {
        ...DEFAULT_VIEW_CONFIG.defaultSort,
        ...(saved.defaultSort ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_VIEW_CONFIG, searchableFields: { ...DEFAULT_VIEW_CONFIG.searchableFields } };
  }
}

export function saveViewConfig(config) {
  localStorage.setItem(VIEW_CONFIG_KEY, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent("spaila:viewconfig"));
}

// ── Date config ───────────────────────────────────────────────────────────

const DATE_CONFIG_KEY = "spaila_date_config";

export const DEFAULT_DATE_CONFIG = {
  format:         "short",  // "short" | "numeric" | "iso"
  showYear:       true,
  flexibleSearch: true,
};

export function loadDateConfig() {
  try {
    const raw = localStorage.getItem(DATE_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_DATE_CONFIG };
    return { ...DEFAULT_DATE_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_DATE_CONFIG };
  }
}

export function saveDateConfig(config) {
  localStorage.setItem(DATE_CONFIG_KEY, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent("spaila:dateconfig"));
}

/** Keys of fields whose values should be treated as dates. */
export const DATE_FIELD_KEYS = new Set(["order_date", "ship_by"]);

// ── Archive config ─────────────────────────────────────────────────────────

const ARCHIVE_CONFIG_KEY = "spaila_archive_config";

export const DEFAULT_ARCHIVE_CONFIG = {
  enabled:       false,
  afterValue:    30,
  afterUnit:     "days",   // "days" | "weeks" | "months"
  archiveFolder: "",       // absolute path chosen by user
};

export function loadArchiveConfig() {
  try {
    const raw = localStorage.getItem(ARCHIVE_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_ARCHIVE_CONFIG };
    return { ...DEFAULT_ARCHIVE_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_ARCHIVE_CONFIG };
  }
}

export function saveArchiveConfig(config) {
  localStorage.setItem(ARCHIVE_CONFIG_KEY, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent("spaila:archiveconfig"));
}

// ── Documents config ───────────────────────────────────────────────────────

const DOCUMENTS_CONFIG_KEY = "spaila_documents_config";

export const DEFAULT_DOCUMENTS_CONFIG = {
  letterheadPath: "",   // absolute path to letterhead PDF
  letterheadName: "",   // original filename for display
  thankYouPath:   "",   // absolute path to thank-you letter
  thankYouName:   "",   // original filename for display
  // Gift message text overlay position on the letterhead
  giftTextX:        72,    // points from left edge (~1 inch)
  giftTextY:        500,   // points from bottom edge
  giftTextMaxWidth: 450,   // max width before wrapping
  giftTextFontSize: 12,    // font size in points
  giftTextColor:    "#000000", // hex color
};

export function loadDocumentsConfig() {
  try {
    const raw = localStorage.getItem(DOCUMENTS_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_DOCUMENTS_CONFIG };
    return { ...DEFAULT_DOCUMENTS_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_DOCUMENTS_CONFIG };
  }
}

export function saveDocumentsConfig(config) {
  localStorage.setItem(DOCUMENTS_CONFIG_KEY, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent("spaila:documentsconfig"));
}

// ── Shop / identity config ─────────────────────────────────────────────────

const SHOP_CONFIG_KEY = "spaila_shop_config";

export const DEFAULT_SHOP_CONFIG = {
  shopName:   "",
  saveFolder: "",   // absolute path chosen by user for manual saves/exports
};

export function loadShopConfig() {
  try {
    const raw = localStorage.getItem(SHOP_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_SHOP_CONFIG };
    return { ...DEFAULT_SHOP_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SHOP_CONFIG };
  }
}

export function saveShopConfig(config) {
  localStorage.setItem(SHOP_CONFIG_KEY, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent("spaila:shopconfig"));
}

// ── Email templates ────────────────────────────────────────────────────────

const EMAIL_TEMPLATES_KEY = "spaila_email_templates";

/**
 * condition: null (matches everything / default)
 *   | { type: "field_exists",  field }
 *   | { type: "field_equals",  field, value }
 *   | { type: "numeric",       field, operator: ">"|"<"|">="|"<="|"=="|"!=", value }
 *
 * attachment_mode: "none" | "images" | "extension"
 */
export const DEFAULT_EMAIL_TEMPLATES = [
  {
    id: "default",
    name: "Default",
    subject_template: "Order {order_number}",
    body_template:
      "Hi {buyer_name},\n\nThank you for your order!\n\nOrder: {order_number}\nDate: {order_date}\nShip by: {ship_by}\n\nBest regards",
    condition: null,
    attachment_mode: "none",
    attachment_extensions: [],
  },
];

export function loadEmailTemplates() {
  try {
    const raw = localStorage.getItem(EMAIL_TEMPLATES_KEY);
    if (!raw) return DEFAULT_EMAIL_TEMPLATES.map((t) => ({ ...t }));
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_EMAIL_TEMPLATES.map((t) => ({ ...t }));
  } catch {
    return DEFAULT_EMAIL_TEMPLATES.map((t) => ({ ...t }));
  }
}

export function saveEmailTemplates(templates) {
  localStorage.setItem(EMAIL_TEMPLATES_KEY, JSON.stringify(templates));
  window.dispatchEvent(new CustomEvent("spaila:emailtemplates"));
}

/** Evaluate a single template's condition against an order row. */
export function evalEmailCondition(condition, row) {
  if (!condition) return true; // null = matches everything (default)
  const { type, field, operator, value } = condition;
  const fieldVal = row[field];
  if (type === "field_exists") {
    return fieldVal !== null && fieldVal !== undefined && fieldVal !== "";
  }
  if (type === "field_equals") {
    return String(fieldVal ?? "").toLowerCase() === String(value ?? "").toLowerCase();
  }
  if (type === "numeric") {
    const num = parseFloat(fieldVal);
    const cmp = parseFloat(value);
    if (isNaN(num) || isNaN(cmp)) return false;
    if (operator === ">")  return num >  cmp;
    if (operator === "<")  return num <  cmp;
    if (operator === ">=") return num >= cmp;
    if (operator === "<=") return num <= cmp;
    if (operator === "==") return num === cmp;
    if (operator === "!=") return num !== cmp;
  }
  return false;
}

/** Select the first matching template; last resort is the first template with no condition. */
export function selectEmailTemplate(templates, row) {
  for (const t of templates) {
    if (evalEmailCondition(t.condition, row)) return t;
  }
  return templates.find((t) => !t.condition) ?? templates[templates.length - 1];
}

/** Replace {field} tokens in a string. Returns { text, warnings }.
 *  Pass an optional labelMap (key → displayName) so warnings use human-readable names. */
export function renderEmailTemplate(tmpl, row, labelMap = {}) {
  const warnings = [];
  const text = tmpl.replace(/\{(\w+)\}/g, (_match, key) => {
    const v = row[key];
    if (v === null || v === undefined || v === "") {
      const label = labelMap[key] || key;
      warnings.push(`Missing "${label}"`);
      return "";
    }
    return String(v);
  });
  return { text, warnings };
}

/** All field keys usable as {variables} in templates. */
export const EMAIL_VARIABLE_KEYS = [
  "order_number", "buyer_name", "buyer_email", "order_date", "ship_by",
  "price", "quantity", "shipping_address", "platform",
  "custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6",
  "order_notes", "gift_message",
];

const _MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const _MONTHS_LONG  = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** Parse a date string safely — avoids UTC-shift for bare YYYY-MM-DD strings. */
function _parseDate(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    const [y, m, d] = String(raw).split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a date value using the user's date config.
 * Returns "—" for empty/unparseable input.
 */
export function formatDate(raw, config = DEFAULT_DATE_CONFIG) {
  if (!raw) return "—";
  const date = _parseDate(raw);
  if (!date) return String(raw); // unparseable — show as-is

  const { format = "short", showYear = true } = config;

  if (format === "iso") {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  if (format === "numeric") {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return showYear ? `${m}/${d}/${date.getFullYear()}` : `${m}/${d}`;
  }

  // "short" — abbreviated month name
  const abbr = _MONTHS_SHORT[date.getMonth()];
  const day  = date.getDate();
  return showYear ? `${abbr} ${day}, ${date.getFullYear()}` : `${abbr} ${day}`;
}

/**
 * Return all recognisable string variants of a date value for flexible search.
 * All values are lower-cased for comparison.
 */
export function generateDateVariants(raw) {
  if (!raw) return [];
  const date = _parseDate(raw);
  if (!date) return [String(raw).toLowerCase()];

  const y   = date.getFullYear();
  const mIdx = date.getMonth();
  const d   = date.getDate();
  const mm  = String(mIdx + 1).padStart(2, "0");
  const dd  = String(d).padStart(2, "0");
  const short = _MONTHS_SHORT[mIdx].toLowerCase();
  const long  = _MONTHS_LONG[mIdx].toLowerCase();

  return [
    `${y}-${mm}-${dd}`,           // 2026-04-13
    `${mm}/${dd}/${y}`,           // 04/13/2026
    `${mm}/${dd}`,                // 04/13
    `${short} ${d}`,              // apr 13
    `${short} ${d}, ${y}`,        // apr 13, 2026
    `${short} ${d} ${y}`,         // apr 13 2026
    `${long} ${d}`,               // april 13
    `${long} ${d}, ${y}`,         // april 13, 2026
    `${long} ${d} ${y}`,          // april 13 2026
    String(y),                    // 2026 alone
  ];
}
