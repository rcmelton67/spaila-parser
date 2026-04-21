/**
 * Canonical field definitions for the orders table.
 * fixed: true  → label cannot be changed and column cannot be hidden
 * fixed: false → user can rename and toggle visibility via Settings
 */
export const FIELD_DEFS = [
  { key: "order_number", defaultLabel: "Order #",  fixed: true,  defaultWidth: 140 },
  { key: "buyer_name",   defaultLabel: "Buyer",    fixed: false, defaultWidth: 220 },
  { key: "price",        defaultLabel: "Price",    fixed: false, defaultWidth: 100 },
  { key: "quantity",     defaultLabel: "Qty",      fixed: false, defaultWidth: 80  },
  { key: "custom_1",     defaultLabel: "Custom 1", fixed: false, defaultWidth: 180 },
  { key: "custom_2",     defaultLabel: "Custom 2", fixed: false, defaultWidth: 180 },
  { key: "custom_3",     defaultLabel: "Custom 3", fixed: false, defaultWidth: 180 },
];

const STORAGE_KEY = "spaila_field_config";

/** Read persisted config from localStorage, merged with defaults. */
export function loadFieldConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return FIELD_DEFS.map((def) => ({
      key:     def.key,
      label:   saved[def.key]?.label   ?? def.defaultLabel,
      visible: saved[def.key]?.visible ?? true,
      fixed:   def.fixed,
      defaultWidth: def.defaultWidth,
    }));
  } catch {
    return FIELD_DEFS.map((def) => ({
      key: def.key, label: def.defaultLabel, visible: true,
      fixed: def.fixed, defaultWidth: def.defaultWidth,
    }));
  }
}

/** Persist config changes and notify other components via a custom event. */
export function saveFieldConfig(config) {
  const payload = {};
  for (const f of config) {
    payload[f.key] = { label: f.label, visible: f.visible };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  window.dispatchEvent(new CustomEvent("spaila:fieldconfig"));
}
