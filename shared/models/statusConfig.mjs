/**
 * Shared order status column definition (desktop + web).
 * Mirrors app/ui/src/shared/utils/fieldConfig.js DEFAULT_STATUS_CONFIG.
 */
export const DEFAULT_STATUS_CONFIG = {
  enabled: true,
  columnLabel: "Status",
  states: [
    { key: "pending", label: "Pending", color: "#fef3c7" },
    { key: "sent", label: "Sent", color: "#dbeafe" },
    { key: "approved", label: "Approved", color: "#d1fae5" },
  ],
};

function expandHex3(hex) {
  const h = String(hex || "").replace(/^#/, "").trim();
  if (h.length !== 3) return `#${h}`;
  return `#${h.split("").map((c) => c + c).join("")}`;
}

function isHexColor(value) {
  const v = String(value || "").trim();
  if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)) return false;
  return true;
}

/**
 * Normalize API/local `layout.status` into a safe config object.
 */
export function normalizeStatusConfig(layoutStatus) {
  const base = DEFAULT_STATUS_CONFIG;
  if (!layoutStatus || typeof layoutStatus !== "object") {
    return {
      enabled: base.enabled,
      columnLabel: base.columnLabel,
      states: base.states.map((s) => ({ ...s })),
    };
  }
  const rawStates = Array.isArray(layoutStatus.states) ? layoutStatus.states : null;
  const states = rawStates?.length
    ? rawStates.map((s, i) => {
        const keyRaw = String(s?.key ?? "").trim();
        const key = keyRaw.slice(0, 64) || `state-${i + 1}`;
        const label = String(s?.label ?? "").trim().slice(0, 120) || "State";
        let color = String(s?.color ?? "").trim();
        if (!isHexColor(color)) color = "#e5e7eb";
        else if (color.length === 4) color = expandHex3(color);
        return { key, label, color };
      })
    : base.states.map((s) => ({ ...s }));

  return {
    enabled: layoutStatus.enabled !== false,
    columnLabel: String(layoutStatus.columnLabel ?? "").trim() || base.columnLabel,
    states,
  };
}
