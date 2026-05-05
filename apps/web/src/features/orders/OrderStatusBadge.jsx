import React from "react";

function contrastColor(hex) {
  try {
    if (!hex || typeof hex !== "string") return "#1a1a1a";
    const clean = hex.replace(/^#/, "").trim();
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    if (full.length !== 6) return "#1a1a1a";
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? "#1a1a1a" : "#ffffff";
  } catch {
    return "#1a1a1a";
  }
}

function findState(states, raw) {
  if (!Array.isArray(states) || !states.length || !raw) return null;
  const trimmed = String(raw).trim();
  return (
    states.find((s) => String(s.key) === trimmed)
    || states.find((s) => String(s.key).toLowerCase() === trimmed.toLowerCase())
    || null
  );
}

function legacyToneAndLabel(normalized) {
  const label = normalized.replace(/_/g, " ") || "—";
  const tone = normalized === "completed" || normalized === "complete" || normalized === "done"
    ? "green"
    : normalized === "archived"
      ? "slate"
      : normalized === "in_progress"
        ? "blue"
        : normalized === "not_started"
          ? "slate"
          : normalized === "pending"
            ? "amber"
            : "slate";
  return { label, tone };
}

/**
 * @param {string} [itemStatus] — Per-line-item workflow value from the API (same meaning as desktop picker).
 * @param {object|null} [statusConfig] — Shared layout.status (enabled, columnLabel, states).
 * @param {string} [unsetLabel] — Pill text when itemStatus is empty.
 * @param {string|null} [fallbackOrderStatus] — If set, used only when itemStatus is empty (e.g. order detail hero).
 */
export default function OrderStatusBadge({
  itemStatus = "",
  statusConfig = null,
  unsetLabel = "Status",
  fallbackOrderStatus = null,
}) {
  const workflow = String(itemStatus ?? "").trim();
  const fallback = fallbackOrderStatus != null ? String(fallbackOrderStatus ?? "").trim() : "";
  const rawForDisplay = workflow || fallback;

  if (!workflow && !fallback) {
    return (
      <span
        className="status-badge status-badge-unset"
        style={{
          background: "transparent",
          color: "#9ca3af",
          border: "1px solid #d1d5db",
          fontWeight: 600,
          textTransform: "none",
        }}
      >
        {unsetLabel || "Status"}
      </span>
    );
  }

  const states = statusConfig?.states;
  const match = findState(states, workflow || rawForDisplay);
  if (match) {
    const bg = match.color || "#e5e7eb";
    const fg = contrastColor(bg);
    return (
      <span
        className="status-badge status-badge-custom"
        style={{
          background: bg,
          color: fg,
          border: `1px solid ${fg === "#ffffff" ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.12)"}`,
        }}
      >
        {match.label || rawForDisplay}
      </span>
    );
  }

  const normalized = rawForDisplay.toLowerCase();
  const { label, tone } = legacyToneAndLabel(normalized);
  return <span className={`status-badge status-badge-${tone}`}>{label}</span>;
}
