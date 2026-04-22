import React from "react";
import {
  loadFieldConfig, saveFieldConfig,
  saveColumnOrder, defaultColumnOrder,
  loadParserFieldOrder, saveParserFieldOrder, defaultParserFieldOrder,
  PARSER_ORDER_SECTION_KEYS, PARSER_ITEM_SECTION_KEYS,
  loadPriceList, savePriceList,
  PRICE_TYPE_FIELD_KEY,
  contrastColor,
  loadStatusConfig, saveStatusConfig, DEFAULT_STATUS_CONFIG,
  loadViewConfig, saveViewConfig, DEFAULT_VIEW_CONFIG, SEARCH_FIELD_GROUPS,
  FIELD_DEFS,
  loadDateConfig, saveDateConfig, DEFAULT_DATE_CONFIG, formatDate,
  loadArchiveConfig, saveArchiveConfig, DEFAULT_ARCHIVE_CONFIG,
  loadEmailTemplates, saveEmailTemplates, DEFAULT_EMAIL_TEMPLATES, EMAIL_VARIABLE_KEYS,
  evalEmailCondition,
  loadShopConfig, saveShopConfig, DEFAULT_SHOP_CONFIG,
  loadDocumentsConfig, saveDocumentsConfig, DEFAULT_DOCUMENTS_CONFIG,
} from "../shared/utils/fieldConfig.js";

function swapItems(arr, i, j) {
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

const TABS = [
  { id: "general",   label: "General"     },
  { id: "orders",    label: "Orders"      },
  { id: "parser",    label: "Parser"      },
  { id: "pricing",   label: "Pricing"     },
  { id: "status",    label: "Status"      },
  { id: "view",      label: "Search/Sort" },
  { id: "dates",     label: "Dates"       },
  { id: "archive",   label: "Archive"     },
  { id: "emails",    label: "Emails"      },
  { id: "documents", label: "Documents"   },
];

/* ── icons ─────────────────────────────────────────────────────────────── */
function EyeIcon({ visible }) {
  return visible ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

/* ── Highlight color swatch picker ──────────────────────────────────────── */
const HIGHLIGHT_PRESETS = [
  { label: "Red",    value: "#fca5a5" },
  { label: "Orange", value: "#fdba74" },
  { label: "Yellow", value: "#fef08a" },
  { label: "Green",  value: "#bbf7d0" },
  { label: "Blue",   value: "#bfdbfe" },
  { label: "Purple", value: "#e9d5ff" },
  { label: "Pink",   value: "#fbcfe8" },
];

function HighlightPicker({ enabled, color, onToggle, onColor, disabled }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      {/* On/off toggle */}
      <button
        onClick={onToggle}
        disabled={disabled}
        title={enabled ? "Disable highlight" : "Enable highlight"}
        style={{
          width: "28px", height: "18px", borderRadius: "999px",
          border: "none", cursor: disabled ? "default" : "pointer",
          background: disabled ? "#e5e7eb" : enabled ? "#2563eb" : "#d1d5db",
          position: "relative", flexShrink: 0, transition: "background 0.15s",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <span style={{
          position: "absolute", top: "2px",
          left: enabled && !disabled ? "12px" : "2px",
          width: "14px", height: "14px", borderRadius: "50%",
          background: "#fff", transition: "left 0.15s", display: "block",
        }} />
      </button>

      {/* Color swatch — only show when enabled */}
      {enabled && !disabled && (
        <div style={{ position: "relative" }}>
          <div style={{
            width: "20px", height: "20px", borderRadius: "4px",
            background: color || "#e5e7eb",
            border: "1px solid rgba(0,0,0,0.15)",
            cursor: "pointer",
            flexShrink: 0,
          }}
            title="Change highlight color"
            onClick={(e) => {
              e.currentTarget.nextSibling.style.display =
                e.currentTarget.nextSibling.style.display === "none" ? "flex" : "none";
            }}
          />
          {/* Preset swatch popover — opens upward to avoid bottom clipping */}
          <div style={{
            display: "none", position: "absolute", bottom: "24px", left: 0,
            zIndex: 200, background: "#fff", border: "1px solid #e5e7eb",
            borderRadius: "6px", padding: "6px", gap: "4px", flexWrap: "wrap",
            boxShadow: "0 -4px 12px rgba(0,0,0,0.12)", width: "110px",
          }}>
            {HIGHLIGHT_PRESETS.map((p) => (
              <div key={p.value}
                title={p.label}
                onClick={(e) => { e.stopPropagation(); onColor(p.value); e.currentTarget.parentNode.style.display = "none"; }}
                style={{
                  width: "20px", height: "20px", borderRadius: "4px",
                  background: p.value, cursor: "pointer",
                  border: color === p.value ? "2px solid #1d4ed8" : "1px solid rgba(0,0,0,0.1)",
                }}
              />
            ))}
            {/* Custom color via native picker */}
            <label title="Custom color"
              style={{ width: "20px", height: "20px", borderRadius: "4px",
                background: "#f3f4f6", border: "1px solid #d1d5db", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: "11px", color: "#6b7280", overflow: "hidden" }}>
              +
              <input type="color" value={color || "#ffffff"}
                onChange={(e) => onColor(e.target.value)}
                style={{ opacity: 0, position: "absolute", width: 0, height: 0 }} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Orders tab: field table with ↑↓ reorder + palette controls ─────────── */
function OrderFieldTable({ fields, localOrder, setLabel, toggleVisible, togglePalette,
  toggleHighlight, setHighlightColor, moveField,
  localStatusConfig, setLocalStatusConfig }) {
  // Build a unified list: "status" virtual entry + real fields
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f]));

  // Synthetic entry for the "status" virtual column
  const statusEntry = {
    key: "status",
    label: localStatusConfig?.columnLabel ?? "Status",
    fixed: false,
    visibleInOrders: localStatusConfig?.enabled ?? true,
    paletteEnabled: false,
    _isStatus: true,
  };

  // Synthetic entry for the "order_info" computed column (label not user-editable)
  const orderInfoEntry = {
    key: "order_info",
    label: "Order Info",
    fixed: true, // label locked — computed column
    visibleInOrders: true,
    paletteEnabled: false,
    _isVirtual: true,
  };

  const orderedFields = [
    ...localOrder.map((k) => {
      if (k === "status")     return statusEntry;
      if (k === "order_info") return orderInfoEntry;
      return fieldMap[k] ?? null;
    }).filter(Boolean),
    // Append any real fields not yet in localOrder
    ...fields.filter((f) => !localOrder.includes(f.key)),
  ];

  return (
    <>
      {/* Column headers */}
      <div style={{
        display: "grid", gridTemplateColumns: "140px 1fr 44px 44px 72px 52px",
        gap: "0 8px", padding: "5px 10px",
        background: "#f3f4f6", borderRadius: "6px 6px 0 0",
        borderBottom: "1px solid #e5e7eb",
        fontSize: "11px", fontWeight: 600, color: "#6b7280",
        letterSpacing: "0.05em", textTransform: "uppercase", alignItems: "center",
      }}>
        <span>System key</span>
        <span>Display name</span>
        <span style={{ textAlign: "center" }} title="Show/hide column">👁</span>
        <span style={{ textAlign: "center" }} title="Apply row color to this cell">🎨</span>
        <span style={{ textAlign: "center" }} title="Highlight cell when populated">Highlight</span>
        <span style={{ textAlign: "center" }}>Order</span>
      </div>

      <div style={{ border: "1px solid #e5e7eb", borderTop: "none", borderRadius: "0 0 6px 6px", overflow: "hidden" }}>
        {orderedFields.map((f, i) => {
          const isVisible = f.visibleInOrders;
          const orderIdx  = localOrder.indexOf(f.key);
          const isFirst   = orderIdx === 0;
          const isLast    = orderIdx === localOrder.length - 1;
          const hlEnabled = f.highlight?.enabled ?? false;
          const hlColor   = f.highlight?.color   ?? null;

          return (
            <div key={f.key} style={{
              display: "grid", gridTemplateColumns: "140px 1fr 44px 44px 72px 52px",
              gap: "0 8px", padding: "8px 10px", alignItems: "center",
              background: i % 2 === 0 ? "#fff" : "#fafafa",
              borderBottom: i < orderedFields.length - 1 ? "1px solid #f3f4f6" : "none",
            }}>
              {/* System key */}
              <div style={{ fontSize: "12px", color: "#9ca3af", fontFamily: "monospace",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.key}
              </div>

              {/* Label — routes to statusConfig for "status"; locked for virtual columns */}
              <input type="text"
                value={f._isStatus ? (localStatusConfig?.columnLabel ?? "Status") : f.label}
                disabled={f.fixed || f._isVirtual}
                onChange={(e) => {
                  if (f._isStatus) {
                    setLocalStatusConfig((p) => ({ ...p, columnLabel: e.target.value }));
                  } else {
                    setLabel(f.key, e.target.value);
                  }
                }}
                style={{
                  padding: "5px 9px", border: "1px solid",
                  borderColor: (f.fixed || f._isVirtual) ? "#e5e7eb" : "#d1d5db",
                  borderRadius: "5px", fontSize: "13px",
                  color: (f.fixed || f._isVirtual) ? "#9ca3af" : "#111",
                  background: (f.fixed || f._isVirtual) ? "#f9fafb" : "#fff",
                  cursor: (f.fixed || f._isVirtual) ? "not-allowed" : "text",
                  outline: "none", width: "100%", boxSizing: "border-box",
                }}
                onFocus={(e) => { if (!f.fixed) e.target.style.borderColor = "#2563eb"; }}
                onBlur={(e)  => { e.target.style.borderColor = f.fixed ? "#e5e7eb" : "#d1d5db"; }}
              />

              {/* Visibility eye — routes to statusConfig.enabled for "status";
                  order_info is always on (remove from columnOrder to hide) */}
              <div style={{ textAlign: "center" }}>
                {f._isVirtual ? (
                  <span style={{ fontSize: "10px", color: "#9ca3af" }} title="Always on — reorder to hide">—</span>
                ) : (
                  <button
                    onClick={() => {
                      if (f._isStatus) {
                        setLocalStatusConfig((p) => ({ ...p, enabled: !p.enabled }));
                      } else {
                        toggleVisible(f.key, "visibleInOrders");
                      }
                    }}
                    title={isVisible ? "Hide column" : "Show column"}
                    style={{ background: "none", border: "none", cursor: "pointer",
                      color: isVisible ? "#2563eb" : "#9ca3af", padding: "3px",
                      display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    <EyeIcon visible={isVisible} />
                  </button>
                )}
              </div>

              {/* Palette toggle — disabled for status + order_info */}
              <div style={{ textAlign: "center" }}>
                <button
                  onClick={() => !f._isStatus && !f._isVirtual && togglePalette(f.key)}
                  disabled={f._isStatus || f._isVirtual}
                  title={
                    f._isStatus  ? "Status uses per-state colors" :
                    f._isVirtual ? "Computed column — no color" :
                    f.paletteEnabled ? "Disable row color for this cell" : "Apply row color to this cell"
                  }
                  style={{ background: "none", border: "none",
                    cursor: (f._isStatus || f._isVirtual) ? "default" : "pointer",
                    padding: "3px", display: "inline-flex", alignItems: "center", justifyContent: "center",
                    opacity: (f._isStatus || f._isVirtual) ? 0.25 : 1 }}>
                  <PaletteIcon active={!f._isStatus && !f._isVirtual && !!f.paletteEnabled} />
                </button>
              </div>

              {/* Highlight toggle + color — disabled for virtual columns */}
              <div style={{ display: "flex", justifyContent: "center" }}>
                <HighlightPicker
                  enabled={hlEnabled}
                  color={hlColor}
                  disabled={f._isVirtual || f._isStatus}
                  onToggle={() => !f._isVirtual && !f._isStatus && toggleHighlight(f.key)}
                  onColor={(c) => !f._isVirtual && !f._isStatus && setHighlightColor(f.key, c)}
                />
              </div>

              {/* Up / Down */}
              <div style={{ display: "flex", gap: "2px", justifyContent: "center" }}>
                <button onClick={() => moveField(orderIdx, -1)} disabled={isFirst} title="Move up"
                  style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: "3px",
                    padding: "2px 5px", cursor: isFirst ? "default" : "pointer",
                    color: isFirst ? "#d1d5db" : "#374151", fontSize: "11px", lineHeight: 1 }}>↑</button>
                <button onClick={() => moveField(orderIdx, 1)} disabled={isLast} title="Move down"
                  style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: "3px",
                    padding: "2px 5px", cursor: isLast ? "default" : "pointer",
                    color: isLast ? "#d1d5db" : "#374151", fontSize: "11px", lineHeight: 1 }}>↓</button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ── shared field table used by both tabs ───────────────────────────────── */
/**
 * visibilityKey: "visibleInOrders" | "visibleInParser"
 * visibilityLabel: human label shown in the column header (e.g. "Visible in Orders")
 */
function FieldTable({ fields, visibilityKey, setLabel, toggleVisible }) {
  return (
    <>
      {/* Column headers */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "150px 1fr 100px 44px",
        gap: "0 12px",
        padding: "5px 10px",
        background: "#f3f4f6",
        borderRadius: "6px 6px 0 0",
        borderBottom: "1px solid #e5e7eb",
        fontSize: "11px",
        fontWeight: 600,
        color: "#6b7280",
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        alignItems: "center",
      }}>
        <span>System key</span>
        <span>Display name</span>
        <span style={{ textAlign: "center" }}>Visible</span>
        <span></span>
      </div>

      <div style={{
        border: "1px solid #e5e7eb",
        borderTop: "none",
        borderRadius: "0 0 6px 6px",
        overflow: "hidden",
      }}>
        {fields.map((f, i) => {
          const isVisible = f[visibilityKey];
          // In the orders tab, fixed fields are always visible and cannot be toggled.
          const canToggle = !(visibilityKey === "visibleInOrders" && f.fixed);

          return (
            <div
              key={f.key}
              style={{
                display: "grid",
                gridTemplateColumns: "150px 1fr 100px 44px",
                gap: "0 12px",
                padding: "8px 10px",
                alignItems: "center",
                background: i % 2 === 0 ? "#fff" : "#fafafa",
                borderBottom: i < fields.length - 1 ? "1px solid #f3f4f6" : "none",
              }}
            >
              {/* System key */}
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#9ca3af", fontFamily: "monospace" }}>
                {f.fixed && <LockIcon />}
                {f.key}
              </div>

              {/* Label — editable in both tabs; changing here updates everywhere */}
              <input
                type="text"
                value={f.label}
                disabled={f.fixed}
                onChange={(e) => setLabel(f.key, e.target.value)}
                style={{
                  padding: "5px 9px",
                  border: "1px solid",
                  borderColor: f.fixed ? "#e5e7eb" : "#d1d5db",
                  borderRadius: "5px",
                  fontSize: "13px",
                  color: f.fixed ? "#9ca3af" : "#111",
                  background: f.fixed ? "#f9fafb" : "#fff",
                  cursor: f.fixed ? "not-allowed" : "text",
                  outline: "none",
                  width: "100%",
                  boxSizing: "border-box",
                }}
                onFocus={(e) => { if (!f.fixed) e.target.style.borderColor = "#2563eb"; }}
                onBlur={(e) => { e.target.style.borderColor = f.fixed ? "#e5e7eb" : "#d1d5db"; }}
              />

              {/* Visibility toggle */}
              <div style={{ textAlign: "center" }}>
                <button
                  onClick={() => canToggle && toggleVisible(f.key, visibilityKey)}
                  disabled={!canToggle}
                  title={!canToggle ? "Always visible" : isVisible ? "Hide" : "Show"}
                  style={{
                    background: "none", border: "none",
                    cursor: canToggle ? "pointer" : "not-allowed",
                    color: !canToggle ? "#d1d5db" : isVisible ? "#2563eb" : "#9ca3af",
                    padding: "4px", borderRadius: "4px",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  <EyeIcon visible={isVisible} />
                </button>
              </div>

              {/* Status */}
              <div style={{ fontSize: "11px", textAlign: "right" }}>
                {!canToggle
                  ? <span style={{ color: "#d1d5db" }}>fixed</span>
                  : isVisible
                    ? <span style={{ color: "#16a34a" }}>on</span>
                    : <span style={{ color: "#dc2626" }}>off</span>
                }
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ── Parser tab: visibility + per-section ↑↓ reorder ───────────────────── */
function ParserFieldTable({ fields, localParserOrder, setLabel, toggleVisible, setLocalParserOrder }) {
  const fieldMap = Object.fromEntries(fields.map((f) => [f.key, f]));

  // Derive ordered sub-lists for each section from localParserOrder
  const orderSectionKeys = localParserOrder.filter((k) => PARSER_ORDER_SECTION_KEYS.has(k));
  const itemSectionKeys  = localParserOrder.filter((k) => PARSER_ITEM_SECTION_KEYS.has(k));

  /** Swap two items inside a section and rebuild the full localParserOrder. */
  function moveInSection(sectionKeys, sectionSet, idx, direction) {
    const target = idx + direction;
    if (target < 0 || target >= sectionKeys.length) return;
    const newSection = swapItems(sectionKeys, idx, target);
    setLocalParserOrder((prev) => {
      let ptr = 0;
      return prev.map((k) => (sectionSet.has(k) ? newSection[ptr++] : k));
    });
  }

  function renderSection(title, sectionKeys, sectionSet) {
    return (
      <>
        {/* Section header */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "150px 1fr 100px 44px 52px",
          gap: "0 8px",
          padding: "5px 10px",
          background: "#f3f4f6",
          borderRadius: "6px 6px 0 0",
          borderBottom: "1px solid #e5e7eb",
          fontSize: "11px", fontWeight: 600, color: "#6b7280",
          letterSpacing: "0.05em", textTransform: "uppercase", alignItems: "center",
        }}>
          <span style={{ color: "#374151", textTransform: "none", fontSize: "11px", fontWeight: 700, letterSpacing: 0 }}>
            {title}
          </span>
          <span>Display name</span>
          <span style={{ textAlign: "center" }}>Visible</span>
          <span></span>
          <span style={{ textAlign: "center" }}>Order</span>
        </div>

        <div style={{ border: "1px solid #e5e7eb", borderTop: "none", borderRadius: "0 0 6px 6px", overflow: "hidden", marginBottom: "16px" }}>
          {sectionKeys.map((key, i) => {
            const f = fieldMap[key];
            if (!f) return null;
            const isVisible = f.visibleInParser;
            const isFirst = i === 0;
            const isLast  = i === sectionKeys.length - 1;
            return (
              <div
                key={key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "150px 1fr 100px 44px 52px",
                  gap: "0 8px",
                  padding: "8px 10px",
                  alignItems: "center",
                  background: i % 2 === 0 ? "#fff" : "#fafafa",
                  borderBottom: i < sectionKeys.length - 1 ? "1px solid #f3f4f6" : "none",
                }}
              >
                {/* System key */}
                <div style={{ fontSize: "12px", color: "#9ca3af", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {key}
                </div>

                {/* Label — editable, shared with all tabs */}
                <input
                  type="text"
                  value={f.label}
                  disabled={f.fixed}
                  onChange={(e) => setLabel(key, e.target.value)}
                  style={{
                    padding: "5px 9px", border: "1px solid",
                    borderColor: f.fixed ? "#e5e7eb" : "#d1d5db",
                    borderRadius: "5px", fontSize: "13px",
                    color: f.fixed ? "#9ca3af" : "#111",
                    background: f.fixed ? "#f9fafb" : "#fff",
                    cursor: f.fixed ? "not-allowed" : "text",
                    outline: "none", width: "100%", boxSizing: "border-box",
                  }}
                  onFocus={(e) => { if (!f.fixed) e.target.style.borderColor = "#2563eb"; }}
                  onBlur={(e) => { e.target.style.borderColor = f.fixed ? "#e5e7eb" : "#d1d5db"; }}
                />

                {/* Visibility toggle */}
                <div style={{ textAlign: "center" }}>
                  <button
                    onClick={() => toggleVisible(key, "visibleInParser")}
                    title={isVisible ? "Hide in parser" : "Show in parser"}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      color: isVisible ? "#2563eb" : "#9ca3af",
                      padding: "4px", borderRadius: "4px",
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <EyeIcon visible={isVisible} />
                  </button>
                </div>

                {/* Status */}
                <div style={{ fontSize: "11px", textAlign: "right" }}>
                  {isVisible
                    ? <span style={{ color: "#16a34a" }}>on</span>
                    : <span style={{ color: "#dc2626" }}>off</span>
                  }
                </div>

                {/* Up / Down */}
                <div style={{ display: "flex", gap: "2px", justifyContent: "center" }}>
                  <button
                    onClick={() => moveInSection(sectionKeys, sectionSet, i, -1)}
                    disabled={isFirst}
                    title="Move up"
                    style={{
                      background: "none", border: "1px solid #e5e7eb", borderRadius: "3px",
                      padding: "2px 5px", cursor: isFirst ? "default" : "pointer",
                      color: isFirst ? "#d1d5db" : "#374151", fontSize: "11px", lineHeight: 1,
                    }}
                  >↑</button>
                  <button
                    onClick={() => moveInSection(sectionKeys, sectionSet, i, 1)}
                    disabled={isLast}
                    title="Move down"
                    style={{
                      background: "none", border: "1px solid #e5e7eb", borderRadius: "3px",
                      padding: "2px 5px", cursor: isLast ? "default" : "pointer",
                      color: isLast ? "#d1d5db" : "#374151", fontSize: "11px", lineHeight: 1,
                    }}
                  >↓</button>
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <>
      {renderSection("Order Details", orderSectionKeys, PARSER_ORDER_SECTION_KEYS)}
      {renderSection("Per-Item Fields", itemSectionKeys, PARSER_ITEM_SECTION_KEYS)}
    </>
  );
}

/* ── Palette icon ───────────────────────────────────────────────────────── */
function PaletteIcon({ active }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke={active ? "#2563eb" : "#d1d5db"} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="8"  cy="10" r="1.5" fill={active ? "#f87171" : "#d1d5db"} stroke="none"/>
      <circle cx="12" cy="7"  r="1.5" fill={active ? "#fbbf24" : "#d1d5db"} stroke="none"/>
      <circle cx="16" cy="10" r="1.5" fill={active ? "#34d399" : "#d1d5db"} stroke="none"/>
      <circle cx="14" cy="15" r="1.5" fill={active ? "#60a5fa" : "#d1d5db"} stroke="none"/>
      <circle cx="10" cy="15" r="1.5" fill={active ? "#c084fc" : "#d1d5db"} stroke="none"/>
    </svg>
  );
}

/* ── Pricing tab ────────────────────────────────────────────────────────── */
function PricingTab({ priceList, setPriceList, typeLabel }) {
  function addRow() {
    const id = Math.random().toString(36).slice(2);
    setPriceList((prev) => [...prev, { id, price: "", typeValue: "", color: "#e8d5f5" }]);
  }

  function del(id) {
    setPriceList((prev) => prev.filter((r) => r.id !== id));
  }

  function update(id, field, value) {
    setPriceList((prev) => prev.map((r) => r.id === id ? { ...r, [field]: value } : r));
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "4px" }}>
        <div style={{ fontSize: "15px", fontWeight: 700, color: "#111" }}>Price List</div>
        <button
          onClick={addRow}
          style={{
            padding: "5px 14px", fontSize: "12px", fontWeight: 600,
            background: "#fff", border: "1px solid #d1d5db",
            borderRadius: "6px", cursor: "pointer", color: "#374151",
          }}
        >+ Add row</button>
      </div>
      <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "16px", lineHeight: 1.6 }}>
        Assign a display color to each price point. The <strong>{typeLabel}</strong> value is
        auto-filled on matching orders and the row receives the chosen color in the Active list.
      </div>

      {priceList.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "#9ca3af", fontSize: "13px",
          border: "1px dashed #e5e7eb", borderRadius: "8px" }}>
          No price rules yet. Click <strong>+ Add row</strong> to create one.
        </div>
      ) : (
        <>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "100px 1fr 54px 60px",
            gap: "0 10px", padding: "5px 10px",
            background: "#f3f4f6", borderRadius: "6px 6px 0 0",
            borderBottom: "1px solid #e5e7eb",
            fontSize: "11px", fontWeight: 600, color: "#6b7280",
            letterSpacing: "0.05em", textTransform: "uppercase", alignItems: "center",
          }}>
            <span>Price</span>
            <span>{typeLabel}</span>
            <span style={{ textAlign: "center" }}>Color</span>
            <span></span>
          </div>

          {/* Rows */}
          <div style={{ border: "1px solid #e5e7eb", borderTop: "none",
            borderRadius: "0 0 6px 6px", overflow: "hidden" }}>
            {priceList.map((row, i) => {
              const rowBg    = row.color || (i % 2 === 0 ? "#fff" : "#fafafa");
              const textColor = contrastColor(rowBg);
              const isDark    = textColor === "#ffffff";

              // Adaptive input / button styles so text is always readable
              const inputStyle = {
                padding: "4px 8px", borderRadius: "5px", fontSize: "13px",
                border: isDark ? "1px solid rgba(255,255,255,0.35)" : "1px solid rgba(0,0,0,0.18)",
                background: isDark ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.7)",
                color: textColor,
                outline: "none", width: "100%", boxSizing: "border-box",
              };

              return (
                <div
                  key={row.id}
                  style={{
                    display: "grid", gridTemplateColumns: "100px 1fr 54px 60px",
                    gap: "0 10px", padding: "8px 10px", alignItems: "center",
                    background: rowBg,
                    borderBottom: i < priceList.length - 1 ? "1px solid rgba(0,0,0,0.08)" : "none",
                    color: textColor,
                  }}
                >
                  {/* Price input */}
                  <input
                    type="text"
                    value={row.price}
                    placeholder="e.g. 35.00"
                    onChange={(e) => update(row.id, "price", e.target.value)}
                    style={{ ...inputStyle, fontWeight: 600 }}
                  />

                  {/* Type value input */}
                  <input
                    type="text"
                    value={row.typeValue}
                    placeholder={`Enter ${typeLabel}…`}
                    onChange={(e) => update(row.id, "typeValue", e.target.value)}
                    style={inputStyle}
                  />

                  {/* Color swatch / picker */}
                  <div style={{ textAlign: "center" }}>
                    <label style={{ position: "relative", display: "inline-block", cursor: "pointer" }}
                      title="Pick row color">
                      <div style={{
                        width: 30, height: 22, borderRadius: "4px",
                        background: row.color,
                        border: isDark ? "2px solid rgba(255,255,255,0.4)" : "2px solid rgba(0,0,0,0.22)",
                        display: "inline-block",
                      }} />
                      <input
                        type="color"
                        value={row.color}
                        onChange={(e) => update(row.id, "color", e.target.value)}
                        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
                      />
                    </label>
                  </div>

                  {/* Delete */}
                  <div style={{ textAlign: "center" }}>
                    <button
                      onClick={() => del(row.id)}
                      style={{
                        padding: "3px 10px", fontSize: "11px", borderRadius: "5px",
                        border: isDark ? "1px solid rgba(255,255,255,0.35)" : "1px solid rgba(0,0,0,0.18)",
                        background: isDark ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.7)",
                        cursor: "pointer", color: textColor,
                      }}
                    >Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

/* ── Status tab ─────────────────────────────────────────────────────────── */
function StatusTab({ config, setConfig }) {
  function addState() {
    const id = Math.random().toString(36).slice(2);
    setConfig((prev) => ({
      ...prev,
      states: [...prev.states, { key: id, label: "New State", color: "#f3f4f6" }],
    }));
  }

  function removeState(key) {
    setConfig((prev) => ({ ...prev, states: prev.states.filter((s) => s.key !== key) }));
  }

  function updateState(key, field, value) {
    setConfig((prev) => ({
      ...prev,
      states: prev.states.map((s) => s.key === key ? { ...s, [field]: value } : s),
    }));
  }

  function moveState(idx, dir) {
    const next = [...config.states];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setConfig((prev) => ({ ...prev, states: next }));
  }

  return (
    <>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "18px" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "2px" }}>
            Order Status
          </div>
          <div style={{ fontSize: "12px", color: "#6b7280" }}>
            Define the status states available for orders. Each order can be set to one state.
          </div>
        </div>
        {/* Enable toggle */}
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", flexShrink: 0 }}>
          <span style={{ fontSize: "12px", color: "#374151", fontWeight: 500 }}>
            {config.enabled ? "Enabled" : "Disabled"}
          </span>
          <div
            onClick={() => setConfig((p) => ({ ...p, enabled: !p.enabled }))}
            style={{
              width: 36, height: 20, borderRadius: 10, cursor: "pointer",
              background: config.enabled ? "#2563eb" : "#d1d5db",
              position: "relative", transition: "background 0.2s",
              flexShrink: 0,
            }}
          >
            <div style={{
              position: "absolute", top: 2,
              left: config.enabled ? 18 : 2,
              width: 16, height: 16, borderRadius: "50%",
              background: "#fff", transition: "left 0.2s",
              boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
            }} />
          </div>
        </label>
      </div>

      {/* Column label */}
      <div style={{ marginBottom: "22px" }}>
        <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "5px" }}>
          Column Label
        </label>
        <input
          type="text"
          value={config.columnLabel}
          onChange={(e) => setConfig((p) => ({ ...p, columnLabel: e.target.value }))}
          style={{
            padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: "6px",
            fontSize: "13px", width: "220px", outline: "none", color: "#111",
          }}
          onFocus={(e) => (e.target.style.borderColor = "#2563eb")}
          onBlur={(e)  => (e.target.style.borderColor = "#d1d5db")}
        />
      </div>

      {/* States list */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "#374151" }}>States</div>
        <button
          onClick={addState}
          style={{
            padding: "4px 12px", fontSize: "12px", fontWeight: 600,
            background: "#fff", border: "1px solid #d1d5db",
            borderRadius: "5px", cursor: "pointer", color: "#374151",
          }}
        >+ Add state</button>
      </div>

      {config.states.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 20px", color: "#9ca3af", fontSize: "13px",
          border: "1px dashed #e5e7eb", borderRadius: "8px" }}>
          No states defined. Click <strong>+ Add state</strong> to create one.
        </div>
      ) : (
        <>
          {/* Column headers */}
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 60px 44px 52px",
            gap: "0 8px", padding: "5px 10px",
            background: "#f3f4f6", borderRadius: "6px 6px 0 0",
            borderBottom: "1px solid #e5e7eb",
            fontSize: "11px", fontWeight: 600, color: "#6b7280",
            letterSpacing: "0.05em", textTransform: "uppercase", alignItems: "center",
          }}>
            <span>State label</span>
            <span style={{ textAlign: "center" }}>Color</span>
            <span></span>
            <span style={{ textAlign: "center" }}>Order</span>
          </div>

          <div style={{ border: "1px solid #e5e7eb", borderTop: "none",
            borderRadius: "0 0 6px 6px", overflow: "hidden" }}>
            {config.states.map((s, i) => {
              const tc = contrastColor(s.color);
              const isDark = tc === "#ffffff";
              return (
                <div key={s.key} style={{
                  display: "grid", gridTemplateColumns: "1fr 60px 44px 52px",
                  gap: "0 8px", padding: "8px 10px", alignItems: "center",
                  background: i % 2 === 0 ? "#fff" : "#fafafa",
                  borderBottom: i < config.states.length - 1 ? "1px solid #f3f4f6" : "none",
                }}>
                  {/* Label input — shows badge preview */}
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{
                      padding: "2px 10px", borderRadius: "999px", fontSize: "12px",
                      fontWeight: 600, background: s.color, color: tc,
                      whiteSpace: "nowrap",
                    }}>
                      {s.label || "—"}
                    </span>
                    <input
                      type="text"
                      value={s.label}
                      onChange={(e) => updateState(s.key, "label", e.target.value)}
                      style={{
                        padding: "4px 8px", border: "1px solid #d1d5db", borderRadius: "5px",
                        fontSize: "13px", outline: "none", flex: 1,
                        color: "#111", background: "#fff",
                      }}
                      onFocus={(e) => (e.target.style.borderColor = "#2563eb")}
                      onBlur={(e)  => (e.target.style.borderColor = "#d1d5db")}
                    />
                  </div>

                  {/* Color picker swatch */}
                  <div style={{ textAlign: "center" }}>
                    <label style={{ position: "relative", display: "inline-block", cursor: "pointer" }}>
                      <div style={{
                        width: 32, height: 22, borderRadius: "5px",
                        background: s.color,
                        border: isDark ? "2px solid rgba(255,255,255,0.4)" : "2px solid rgba(0,0,0,0.22)",
                        display: "inline-block",
                      }} />
                      <input
                        type="color"
                        value={s.color}
                        onChange={(e) => updateState(s.key, "color", e.target.value)}
                        style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
                      />
                    </label>
                  </div>

                  {/* Delete */}
                  <div style={{ textAlign: "center" }}>
                    <button
                      onClick={() => removeState(s.key)}
                      title="Remove state"
                      style={{
                        background: "none", border: "1px solid #e5e7eb", borderRadius: "4px",
                        padding: "2px 7px", cursor: "pointer", fontSize: "12px", color: "#dc2626",
                      }}
                    >✕</button>
                  </div>

                  {/* Up / Down */}
                  <div style={{ display: "flex", gap: "2px", justifyContent: "center" }}>
                    <button onClick={() => moveState(i, -1)} disabled={i === 0}
                      style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: "3px",
                        padding: "2px 5px", cursor: i === 0 ? "default" : "pointer",
                        color: i === 0 ? "#d1d5db" : "#374151", fontSize: "11px", lineHeight: 1 }}>↑</button>
                    <button onClick={() => moveState(i, 1)} disabled={i === config.states.length - 1}
                      style={{ background: "none", border: "1px solid #e5e7eb", borderRadius: "3px",
                        padding: "2px 5px", cursor: i === config.states.length - 1 ? "default" : "pointer",
                        color: i === config.states.length - 1 ? "#d1d5db" : "#374151", fontSize: "11px", lineHeight: 1 }}>↓</button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Live preview strip */}
          <div style={{ marginTop: "16px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {config.states.map((s) => (
              <span key={s.key} style={{
                padding: "3px 12px", borderRadius: "999px", fontSize: "12px",
                fontWeight: 600, background: s.color, color: contrastColor(s.color),
              }}>
                {s.label || "—"}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ── View tab ────────────────────────────────────────────────────────────── */
function ViewTab({ config, setConfig, fields }) {
  // Use live user-defined labels; fall back to FIELD_DEFS defaults if not yet loaded
  const labelMap = Object.fromEntries(
    (fields && fields.length ? fields : FIELD_DEFS.map((d) => ({ key: d.key, label: d.defaultLabel })))
      .map((f) => [f.key, f.label])
  );

  function setSearch(key, val) {
    setConfig((p) => ({ ...p, searchableFields: { ...p.searchableFields, [key]: val } }));
  }
  function setSort(patch) {
    setConfig((p) => ({ ...p, defaultSort: { ...p.defaultSort, ...patch } }));
  }
  function setFlag(key, val) { setConfig((p) => ({ ...p, [key]: val })); }

  const sectionStyle = { marginBottom: "28px" };
  const headStyle = { fontSize: "13px", fontWeight: 700, color: "#111", marginBottom: "10px", display: "block" };
  const rowStyle = { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" };
  const checkStyle = { width: "15px", height: "15px", cursor: "pointer", accentColor: "#2563eb" };
  const labelStyle = { fontSize: "13px", color: "#374151", cursor: "pointer" };
  const mutedStyle = { fontSize: "11px", color: "#9ca3af", marginTop: "-4px", marginBottom: "8px", lineHeight: 1.4 };
  const selectStyle = {
    padding: "5px 9px", border: "1px solid #d1d5db", borderRadius: "5px",
    fontSize: "13px", color: "#111", background: "#fff", cursor: "pointer",
  };
  const divider = { borderTop: "1px solid #f3f4f6", margin: "20px 0" };

  const sortableFields = FIELD_DEFS.filter((d) => d.defaultVisibleInOrders || ["order_date", "ship_by", "buyer_name", "order_number", "price"].includes(d.key));

  return (
    <div>
      {/* ── Searchable Fields ── */}
      <div style={sectionStyle}>
        <span style={headStyle}>Searchable Fields</span>
        <p style={mutedStyle}>Choose which fields are scanned when you type in the search box.</p>

        {SEARCH_FIELD_GROUPS.map((group) => (
          <div key={group.label} style={{ marginBottom: "14px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
              letterSpacing: "0.06em", marginBottom: "6px" }}>{group.label}</div>
            {group.keys.map((key) => {
              const id = `sf_${key}`;
              return (
                <div key={key} style={rowStyle}>
                  <input id={id} type="checkbox" style={checkStyle}
                    checked={!!(config.searchableFields?.[key])}
                    onChange={(e) => setSearch(key, e.target.checked)} />
                  <label htmlFor={id} style={labelStyle}>
                    {labelMap[key] || key}
                  </label>
                </div>
              );
            })}
          </div>
        ))}

        {/* Include Order Info special option */}
        <div style={{ marginTop: "6px", padding: "8px 10px", background: "#f9fafb",
          border: "1px solid #e5e7eb", borderRadius: "6px" }}>
          <div style={rowStyle}>
            <input id="sf_order_info" type="checkbox" style={checkStyle}
              checked={!!config.includeOrderInfo}
              onChange={(e) => setFlag("includeOrderInfo", e.target.checked)} />
            <label htmlFor="sf_order_info" style={labelStyle}>Include Order Info</label>
          </div>
          <p style={{ ...mutedStyle, marginBottom: 0 }}>
            Also searches platform badges, gift flags, and notes text.
          </p>
        </div>
      </div>

      <div style={divider} />

      {/* ── Search Mode ── */}
      <div style={sectionStyle}>
        <span style={headStyle}>Search Mode</span>
        <div style={{ display: "flex", gap: "10px" }}>
          {[{ id: "smart", label: "Smart", desc: "Partial match across selected fields" },
            { id: "exact", label: "Exact", desc: "Strict full-value match" }].map((opt) => (
            <label key={opt.id} style={{
              flex: 1, display: "flex", alignItems: "flex-start", gap: "8px",
              padding: "10px 12px", border: "1px solid",
              borderColor: config.searchMode === opt.id ? "#2563eb" : "#e5e7eb",
              borderRadius: "7px", cursor: "pointer",
              background: config.searchMode === opt.id ? "#eff6ff" : "#fff",
            }}>
              <input type="radio" name="searchMode" value={opt.id}
                checked={config.searchMode === opt.id}
                onChange={() => setFlag("searchMode", opt.id)}
                style={{ marginTop: "2px", accentColor: "#2563eb" }} />
              <div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#111" }}>{opt.label}</div>
                <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "2px" }}>{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div style={divider} />

      {/* ── Default Sort ── */}
      <div style={sectionStyle}>
        <span style={headStyle}>Default Sort</span>
        <p style={mutedStyle}>Applied when orders load or refresh.</p>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "4px" }}>Field</div>
            <select style={selectStyle}
              value={config.defaultSort?.field || "order_date"}
              onChange={(e) => setSort({ field: e.target.value })}>
              {sortableFields.map((f) => (
                <option key={f.key} value={f.key}>{labelMap[f.key] || f.key}</option>
              ))}
            </select>
          </div>
          <div>
            <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "4px" }}>Direction</div>
            <select style={selectStyle}
              value={config.defaultSort?.direction || "desc"}
              onChange={(e) => setSort({ direction: e.target.value })}>
              <option value="asc">Ascending ↑</option>
              <option value="desc">Descending ↓</option>
            </select>
          </div>
        </div>
      </div>

      <div style={divider} />

      {/* ── Visibility ── */}
      <div style={sectionStyle}>
        <span style={headStyle}>Visibility</span>
        {[
          { key: "showCompleted",    label: "Show completed orders",      desc: "Include completed/archived orders in the Active tab" },
          { key: "showInventoryTab", label: 'Show "Inventory Needed" tab', desc: "Surface orders missing personalization fields" },
          { key: "groupMultiItem",   label: "Group multi-item orders",    desc: "Collapse multiple rows into one (coming soon)" },
        ].map(({ key, label, desc }) => (
          <div key={key} style={{ marginBottom: "12px" }}>
            <div style={rowStyle}>
              <input id={`vis_${key}`} type="checkbox" style={checkStyle}
                checked={!!config[key]} disabled={key === "groupMultiItem"}
                onChange={(e) => setFlag(key, e.target.checked)} />
              <label htmlFor={`vis_${key}`} style={{ ...labelStyle, opacity: key === "groupMultiItem" ? 0.5 : 1 }}>
                {label}
                {key === "groupMultiItem" && <span style={{ fontSize: "10px", color: "#9ca3af", marginLeft: "6px" }}>coming soon</span>}
              </label>
            </div>
            <p style={{ ...mutedStyle, marginLeft: "23px" }}>{desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Dates tab ───────────────────────────────────────────────────────────── */
const DATE_FORMAT_OPTIONS = [
  { value: "short",   label: "Short",   example: "Apr 13, 2026"  },
  { value: "numeric", label: "Numeric", example: "04/13/2026"     },
  { value: "iso",     label: "ISO",     example: "2026-04-13"     },
];

function DatesTab({ config, setConfig }) {
  function set(key, val) { setConfig((p) => ({ ...p, [key]: val })); }

  const headStyle = { fontSize: "13px", fontWeight: 700, color: "#111", marginBottom: "10px", display: "block" };
  const mutedStyle = { fontSize: "11px", color: "#9ca3af", marginTop: "2px", lineHeight: 1.4 };
  const rowStyle  = { display: "flex", alignItems: "flex-start", gap: "8px", marginBottom: "10px" };
  const checkStyle = { width: "15px", height: "15px", cursor: "pointer", accentColor: "#2563eb", marginTop: "1px" };
  const divider    = { borderTop: "1px solid #f3f4f6", margin: "20px 0" };

  // Live preview samples
  const previewDates = ["2026-04-13", "2025-12-05"];

  return (
    <div>
      {/* ── Display format ── */}
      <div style={{ marginBottom: "24px" }}>
        <span style={headStyle}>Date Display Format</span>
        <p style={{ ...mutedStyle, marginBottom: "14px" }}>
          Controls how <em>order_date</em> and <em>ship_by</em> appear in the orders table.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {DATE_FORMAT_OPTIONS.map((opt) => (
            <label key={opt.value} style={{
              display: "flex", alignItems: "center", gap: "12px",
              padding: "10px 14px", border: "1px solid",
              borderColor: config.format === opt.value ? "#2563eb" : "#e5e7eb",
              borderRadius: "7px", cursor: "pointer",
              background: config.format === opt.value ? "#eff6ff" : "#fff",
            }}>
              <input type="radio" name="dateFormat" value={opt.value}
                checked={config.format === opt.value}
                onChange={() => set("format", opt.value)}
                style={{ accentColor: "#2563eb" }} />
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: "13px", fontWeight: 600, color: "#111" }}>{opt.label}</span>
                <span style={{ fontSize: "12px", color: "#6b7280", marginLeft: "8px" }}>{opt.example}</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div style={divider} />

      {/* ── Options ── */}
      <div style={{ marginBottom: "24px" }}>
        <span style={headStyle}>Options</span>

        {config.format !== "iso" && (
          <div style={rowStyle}>
            <input id="dc_showYear" type="checkbox" style={checkStyle}
              checked={!!config.showYear}
              onChange={(e) => set("showYear", e.target.checked)} />
            <label htmlFor="dc_showYear" style={{ cursor: "pointer" }}>
              <div style={{ fontSize: "13px", color: "#374151", fontWeight: 500 }}>Always show year</div>
              <div style={mutedStyle}>When off, year is omitted from Short and Numeric formats.</div>
            </label>
          </div>
        )}

        <div style={rowStyle}>
          <input id="dc_flex" type="checkbox" style={checkStyle}
            checked={!!config.flexibleSearch}
            onChange={(e) => set("flexibleSearch", e.target.checked)} />
          <label htmlFor="dc_flex" style={{ cursor: "pointer" }}>
            <div style={{ fontSize: "13px", color: "#374151", fontWeight: 500 }}>Match multiple date formats in search</div>
            <div style={mutedStyle}>Typing "apr 13" matches stored dates regardless of display format.</div>
          </label>
        </div>
      </div>

      <div style={divider} />

      {/* ── Live preview ── */}
      <div>
        <span style={headStyle}>Preview</span>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          {previewDates.map((d) => (
            <div key={d} style={{
              padding: "6px 14px", background: "#f9fafb",
              border: "1px solid #e5e7eb", borderRadius: "6px",
              fontSize: "13px", color: "#111",
            }}>
              <span style={{ color: "#9ca3af", fontSize: "11px", marginRight: "6px" }}>{d}</span>
              {formatDate(d, config)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── EmailsTab ──────────────────────────────────────────────────────────── */
function newTemplateId() {
  return "tpl_" + Math.random().toString(36).slice(2, 10);
}

function EmailsTab({ templates, setTemplates, labelMap, shopConfig, setShopConfig }) {
  const [editingId, setEditingId] = React.useState(null);

  // Track last-focused subject/body field so variable pills know where to insert
  const focusRef = React.useRef({ field: null, el: null, start: 0, end: 0 });

  function onFieldFocus(fieldName, el) {
    focusRef.current = { field: fieldName, el, start: el.selectionStart, end: el.selectionEnd };
  }
  function onFieldSelect(fieldName, el) {
    focusRef.current = { field: fieldName, el, start: el.selectionStart, end: el.selectionEnd };
  }

  function insertVariable(templateId, key) {
    const token = `{${key}}`;
    const { field, el, start, end } = focusRef.current;
    if (!field || !el) {
      // No field focused yet — append to body by default
      updateTemplate(templateId, { body_template: (templates.find((t) => t.id === templateId)?.body_template || "") + token });
      return;
    }
    const t = templates.find((t) => t.id === templateId);
    if (!t) return;
    const current = field === "subject" ? t.subject_template : t.body_template;
    const next = current.slice(0, start) + token + current.slice(end);
    updateTemplate(templateId, field === "subject" ? { subject_template: next } : { body_template: next });
    // Restore focus + move cursor after inserted token
    requestAnimationFrame(() => {
      if (el && document.body.contains(el)) {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
        focusRef.current = { ...focusRef.current, start: pos, end: pos };
      }
    });
  }

  function addTemplate() {
    const id = newTemplateId();
    setTemplates((prev) => [
      ...prev,
      {
        id,
        name: "New Template",
        subject_template: "Order {order_number}",
        body_template: "Hi {buyer_name},\n\n",
        condition: null,
        attachment_mode: "none",
        attachment_extensions: [],
      },
    ]);
    setEditingId(id);
  }

  function deleteTemplate(id) {
    setTemplates((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (!next.find((t) => !t.condition)) {
        // ensure there is always a default (no condition) template
        next.push({ ...DEFAULT_EMAIL_TEMPLATES[0], id: newTemplateId() });
      }
      return next;
    });
    if (editingId === id) setEditingId(null);
  }

  function updateTemplate(id, patch) {
    setTemplates((prev) => prev.map((t) => t.id === id ? { ...t, ...patch } : t));
  }

  function moveUp(idx) {
    if (idx === 0) return;
    setTemplates((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }

  function moveDown(idx) {
    setTemplates((prev) => {
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }

  // Detect shadowing: for each template, check if any earlier template's condition
  // shares the same field (simple heuristic — not full overlap detection)
  function isShadowed(idx) {
    if (idx === 0) return false;
    const t = templates[idx];
    if (!t.condition) return false; // no-condition template can't really be shadowed in a meaningful way
    for (let i = 0; i < idx; i++) {
      const above = templates[i];
      if (!above.condition) return true; // unconditional above = always shadows
      if (above.condition.field === t.condition.field && above.condition.type === t.condition.type) return true;
    }
    return false;
  }

  const inputStyle = {
    width: "100%", padding: "5px 8px", border: "1px solid #d1d5db",
    borderRadius: "4px", fontSize: "12px", boxSizing: "border-box",
  };
  const labelStyle = { fontSize: "11px", color: "#6b7280", marginBottom: "3px", display: "block" };
  const sectionLabel = { fontSize: "11px", fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "8px", display: "block" };

  const CONDITION_HELP = {
    none:         "This template always matches — use it as the fallback at the bottom.",
    field_exists: "Triggers when this field has any value (not empty).",
    field_equals: "Triggers when the field matches exactly (case-insensitive).",
    numeric:      "Triggers based on a number comparison — e.g. quantity > 1 for multi-item orders.",
  };

  function ConditionEditor({ condition, onChange }) {
    const type = condition?.type || "none";
    function setType(t) {
      if (t === "none") { onChange(null); return; }
      onChange({ type: t, field: "buyer_name", operator: ">", value: "" });
    }
    function patch(p) { onChange({ ...condition, ...p }); }
    const field = condition?.field || "buyer_name";
    const fieldOptions = EMAIL_VARIABLE_KEYS.map((k) => (
      <option key={k} value={k}>{labelMap[k] || k}</option>
    ));
    return (
      <div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <select value={type} onChange={(e) => setType(e.target.value)}
            style={{ ...inputStyle, width: "auto", minWidth: 140 }}>
            <option value="none">No condition (default)</option>
            <option value="field_exists">Field exists</option>
            <option value="field_equals">Field equals</option>
            <option value="numeric">Numeric comparison</option>
          </select>
          {type !== "none" && (
            <select value={field} onChange={(e) => patch({ field: e.target.value })}
              style={{ ...inputStyle, width: "auto", minWidth: 120 }}>
              {fieldOptions}
            </select>
          )}
          {type === "field_equals" && (
            <input placeholder="value" value={condition?.value || ""}
              onChange={(e) => patch({ value: e.target.value })}
              style={{ ...inputStyle, width: 120 }} />
          )}
          {type === "numeric" && (
            <>
              <select value={condition?.operator || ">"}
                onChange={(e) => patch({ operator: e.target.value })}
                style={{ ...inputStyle, width: "auto" }}>
                {[">","<",">=","<=","==","!="].map((op) => <option key={op}>{op}</option>)}
              </select>
              <input type="number" placeholder="value" value={condition?.value || ""}
                onChange={(e) => patch({ value: e.target.value })}
                style={{ ...inputStyle, width: 80 }} />
            </>
          )}
        </div>
        {/* Inline help text for selected condition type */}
        <div style={{ fontSize: "11px", color: "#6b7280", marginTop: 5, fontStyle: "italic" }}>
          {CONDITION_HELP[type]}
        </div>
      </div>
    );
  }

  function AttachmentEditor({ mode, extensions, onChange }) {
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={mode} onChange={(e) => onChange({ mode: e.target.value })}
          style={{ ...inputStyle, width: "auto", minWidth: 130 }}>
          <option value="none">No attachments</option>
          <option value="images">Images (.jpg, .png…)</option>
          <option value="extension">Custom extensions</option>
        </select>
        {mode === "extension" && (
          <input
            placeholder="pdf, docx, jpg"
            value={(extensions || []).join(", ")}
            onChange={(e) => onChange({ extensions: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            style={{ ...inputStyle, flex: 1, minWidth: 150 }}
          />
        )}
      </div>
    );
  }

  // Variable pills — shown below subject/body; clicking inserts token at cursor
  function VariablePills({ templateId }) {
    return (
      <div>
        <div style={{ fontSize: "11px", color: "#6b7280", marginBottom: "5px" }}>
          <strong style={{ fontWeight: 700 }}>Insert variable</strong>
          <span style={{ marginLeft: 6, fontStyle: "italic", fontWeight: 400 }}>— click a variable to insert it into your subject or message at the cursor</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
          {EMAIL_VARIABLE_KEYS.map((k) => {
            const customLabel = labelMap[k];
            const display = customLabel && customLabel !== k ? `${customLabel}` : k;
            return (
              <button
                key={k}
                type="button"
                title={`Insert {${k}}`}
                onClick={() => insertVariable(templateId, k)}
                style={{
                  padding: "3px 8px", fontSize: 11,
                  border: "1px solid #c7d2fe",
                  borderRadius: 999,
                  background: "#eef2ff", color: "#4338ca",
                  cursor: "pointer", lineHeight: 1.4,
                  fontFamily: "inherit",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#c7d2fe"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "#eef2ff"; }}
              >
                {display} <span style={{ opacity: 0.6, fontSize: 10 }}>{`{${k}}`}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Warn if a no-condition (default) template is not last
  const defaultIdx = templates.findIndex((t) => !t.condition);
  const defaultNotLast = defaultIdx !== -1 && defaultIdx !== templates.length - 1;

  return (
    <div style={{ padding: "4px 0" }}>

      {/* ── Email icon visibility ── */}
      <div style={{
        background: "#f9fafb", border: "1px solid #e5e7eb",
        borderRadius: "10px", padding: "14px 18px", marginBottom: "16px",
        display: "flex", alignItems: "center", gap: "12px",
      }}>
        <label style={{ position: "relative", display: "inline-block", width: 36, height: 20, flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={shopConfig?.showEmailIcon !== false}
            onChange={(e) => setShopConfig?.((prev) => ({ ...prev, showEmailIcon: e.target.checked }))}
            style={{ opacity: 0, width: 0, height: 0, position: "absolute" }}
          />
          <span style={{
            position: "absolute", inset: 0, borderRadius: 999, cursor: "pointer",
            background: shopConfig?.showEmailIcon !== false ? "#2563eb" : "#d1d5db",
            transition: "background 0.2s",
          }}>
            <span style={{
              position: "absolute", top: 3,
              left: shopConfig?.showEmailIcon !== false ? 19 : 3,
              width: 14, height: 14, borderRadius: "50%", background: "#fff",
              transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
            }} />
          </span>
        </label>
        <span style={{ fontSize: "13px", color: "#374151" }}>
          Show ✉ email icon on buyer name cells
        </span>
      </div>

      {/* ── How it works ── */}
      <div style={{
        background: "#f0f9ff", border: "1px solid #bae6fd",
        borderRadius: "7px", padding: "10px 14px", marginBottom: "14px",
      }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: "#0369a1", marginBottom: 6 }}>
          How it works
        </div>
        <div style={{ fontSize: "12px", color: "#0c4a6e", lineHeight: 1.7 }}>
          Templates are checked <strong>top → bottom</strong>. The <strong>first matching</strong> template is used.<br />
          Use the <strong>▲ ▼ arrows</strong> to change priority.<br />
          The <strong>Default (fallback)</strong> template has no condition and should be <strong>last</strong> — it catches everything that didn't match above.
        </div>
      </div>

      {/* ── Default-not-last warning ── */}
      {defaultNotLast && (
        <div style={{
          background: "#fff7ed", border: "1px solid #fed7aa",
          borderRadius: "6px", padding: "8px 12px", marginBottom: "10px",
          fontSize: "12px", color: "#c2410c",
        }}>
          ⚠ Your <strong>Default (fallback)</strong> template is not at the bottom. Templates below it will never run — move it to the end.
        </div>
      )}

      {/* Template list */}
      {templates.map((t, idx) => {
        const shadowed = isShadowed(idx);
        const isEditing = editingId === t.id;
        const isDefault = !t.condition;

        // Condition summary label
        const condSummary = isDefault
          ? null
          : t.condition
            ? `if ${labelMap[t.condition.field] || t.condition.field} ${
                t.condition.type === "field_exists" ? "exists"
                : t.condition.type === "field_equals" ? `= "${t.condition.value}"`
                : `${t.condition.operator} ${t.condition.value}`}`
            : null;

        return (
          <div key={t.id} style={{
            border: `1px solid ${shadowed ? "#fbbf24" : isDefault ? "#bae6fd" : "#e5e7eb"}`,
            borderRadius: "7px", marginBottom: "8px",
            background: shadowed ? "#fffbeb" : "#fff",
            overflow: "hidden",
          }}>
            {/* Header row */}
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "8px 10px",
              background: isDefault ? "#f0f9ff" : shadowed ? "#fffbeb" : "#f9fafb",
              borderBottom: isEditing ? "1px solid #e5e7eb" : "none",
            }}>
              {/* Priority arrows */}
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }} title="Use arrows to change priority order">
                <button onClick={() => moveUp(idx)} disabled={idx === 0}
                  style={{ padding: "1px 5px", fontSize: 10, border: "1px solid #d1d5db", borderRadius: 3, background: "#fff", cursor: "pointer", opacity: idx === 0 ? 0.3 : 1 }}>▲</button>
                <button onClick={() => moveDown(idx)} disabled={idx === templates.length - 1}
                  style={{ padding: "1px 5px", fontSize: 10, border: "1px solid #d1d5db", borderRadius: 3, background: "#fff", cursor: "pointer", opacity: idx === templates.length - 1 ? 0.3 : 1 }}>▼</button>
              </div>

              {/* Priority badge */}
              <span style={{
                fontSize: 10, fontWeight: 700, color: "#6b7280",
                background: "#e5e7eb", borderRadius: 999, padding: "1px 7px", flexShrink: 0,
              }}>#{idx + 1}</span>

              {/* Name + default badge */}
              <span style={{ fontSize: "13px", fontWeight: 600, color: "#111", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.name}
                {isDefault && (
                  <span style={{
                    marginLeft: 7, fontSize: 10, fontWeight: 600,
                    color: "#0369a1", background: "#e0f2fe",
                    borderRadius: 999, padding: "1px 7px",
                  }}>Default (fallback)</span>
                )}
              </span>

              {/* Condition summary */}
              {condSummary && (
                <span style={{ fontSize: "11px", color: "#6b7280", flexShrink: 0, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  title={condSummary}>
                  {condSummary}
                </span>
              )}

              {/* Shadow warning */}
              {shadowed && (
                <span
                  title="This template will never run because a template above it always matches first. Move it higher, or change the template above it."
                  style={{ fontSize: 11, color: "#d97706", flexShrink: 0, cursor: "help" }}>
                  ⚠ shadowed
                </span>
              )}

              {/* Edit / Delete */}
              <button onClick={() => setEditingId(isEditing ? null : t.id)}
                style={{ padding: "3px 10px", fontSize: 11, border: "1px solid #d1d5db", borderRadius: 4, background: isEditing ? "#eff6ff" : "#fff", cursor: "pointer", flexShrink: 0 }}>
                {isEditing ? "Close" : "Edit"}
              </button>
              <button onClick={() => deleteTemplate(t.id)}
                style={{ padding: "3px 8px", fontSize: 11, border: "1px solid #fca5a5", borderRadius: 4, color: "#dc2626", background: "#fff", cursor: "pointer", flexShrink: 0 }}>✕</button>
            </div>

            {/* Shadowed inline explanation (expanded) */}
            {shadowed && isEditing && (
              <div style={{
                background: "#fffbeb", borderBottom: "1px solid #fde68a",
                padding: "7px 14px", fontSize: "11px", color: "#92400e",
              }}>
                ⚠ <strong>This template will never run</strong> because a template above it always matches first. Move it higher using ▲, or add a more specific condition.
              </div>
            )}

            {/* Editor */}
            {isEditing && (
              <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Name */}
                <div>
                  <label style={labelStyle}>Template name</label>
                  <input value={t.name} onChange={(e) => updateTemplate(t.id, { name: e.target.value })} style={inputStyle} />
                </div>

                {/* Condition */}
                <div>
                  <label style={labelStyle}>Condition (when to use this template)</label>
                  <ConditionEditor
                    condition={t.condition}
                    onChange={(c) => updateTemplate(t.id, { condition: c })}
                  />
                </div>

                {/* Subject */}
                <div>
                  <label style={labelStyle}>Subject</label>
                  <input
                    value={t.subject_template}
                    onChange={(e) => updateTemplate(t.id, { subject_template: e.target.value })}
                    onFocus={(e) => onFieldFocus("subject", e.target)}
                    onSelect={(e) => onFieldSelect("subject", e.target)}
                    onClick={(e) => onFieldSelect("subject", e.target)}
                    onKeyUp={(e) => onFieldSelect("subject", e.target)}
                    style={inputStyle}
                  />
                </div>

                {/* Body */}
                <div>
                  <label style={labelStyle}>Body</label>
                  <textarea
                    value={t.body_template}
                    onChange={(e) => updateTemplate(t.id, { body_template: e.target.value })}
                    onFocus={(e) => onFieldFocus("body", e.target)}
                    onSelect={(e) => onFieldSelect("body", e.target)}
                    onClick={(e) => onFieldSelect("body", e.target)}
                    onKeyUp={(e) => onFieldSelect("body", e.target)}
                    rows={7}
                    style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
                  />
                </div>

                {/* Clickable variable pills */}
                <VariablePills templateId={t.id} />

                {/* Attachments */}
                <div>
                  <label style={labelStyle}>Attachments</label>
                  <AttachmentEditor
                    mode={t.attachment_mode}
                    extensions={t.attachment_extensions}
                    onChange={({ mode, extensions }) => updateTemplate(t.id, {
                      ...(mode !== undefined ? { attachment_mode: mode } : {}),
                      ...(extensions !== undefined ? { attachment_extensions: extensions } : {}),
                    })}
                  />
                </div>
              </div>
            )}
          </div>
        );
      })}

      <button onClick={addTemplate} style={{
        marginTop: 4, width: "100%", padding: "8px",
        border: "1px dashed #9ca3af", borderRadius: "6px",
        background: "none", color: "#6b7280", fontSize: "13px", cursor: "pointer",
      }}>+ Add Template</button>
    </div>
  );
}

/* ── ArchiveTab ─────────────────────────────────────────────────────────── */
function ArchiveTab({ config, setConfig }) {
  const set = (patch) => setConfig((p) => ({ ...p, ...patch }));

  async function pickFolder() {
    const result = await window.parserApp?.pickFolder?.();
    if (result && !result.canceled && result.path) {
      set({ archiveFolder: result.path });
    }
  }

  const sectionStyle = { marginBottom: "28px" };
  const headStyle    = { fontSize: "13px", fontWeight: 700, color: "#111", display: "block", marginBottom: "6px" };
  const mutedStyle   = { fontSize: "12px", color: "#6b7280", marginTop: "2px", marginBottom: "10px", lineHeight: 1.5 };
  const rowStyle     = { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" };
  const selectStyle  = {
    padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: "5px",
    fontSize: "13px", background: "#fff", cursor: "pointer",
  };
  const numInput = {
    width: "64px", padding: "5px 8px", border: "1px solid #d1d5db",
    borderRadius: "5px", fontSize: "13px", textAlign: "center",
  };
  const pathBox = {
    flex: 1, padding: "6px 10px", border: "1px solid #d1d5db", borderRadius: "5px",
    fontSize: "12px", color: "#374151", background: "#f9fafb",
    fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    minWidth: 0,
  };
  const browseBtn = {
    padding: "5px 14px", border: "1px solid #d1d5db", borderRadius: "5px",
    background: "#fff", fontSize: "12px", cursor: "pointer", flexShrink: 0,
  };

  return (
    <div style={{ padding: "4px 0" }}>

      {/* Enable toggle */}
      <div style={sectionStyle}>
        <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            style={{ width: 16, height: 16, cursor: "pointer" }}
          />
          <span style={{ fontSize: "13px", fontWeight: 600, color: "#111" }}>
            Enable auto-archive
          </span>
        </label>
        <p style={{ ...mutedStyle, marginTop: "6px", marginLeft: "26px" }}>
          Automatically move completed orders to the archive folder after the specified time.
        </p>
      </div>

      {/* Time rule */}
      <div style={{ ...sectionStyle, opacity: config.enabled ? 1 : 0.45, pointerEvents: config.enabled ? "auto" : "none" }}>
        <span style={headStyle}>Auto-archive after</span>
        <div style={rowStyle}>
          <input
            type="number"
            min={1}
            max={365}
            value={config.afterValue}
            onChange={(e) => set({ afterValue: Math.max(1, parseInt(e.target.value) || 1) })}
            style={numInput}
          />
          <select
            value={config.afterUnit}
            onChange={(e) => set({ afterUnit: e.target.value })}
            style={selectStyle}
          >
            <option value="days">Days</option>
            <option value="weeks">Weeks</option>
            <option value="months">Months</option>
          </select>
          <span style={{ fontSize: "13px", color: "#6b7280" }}>after order date</span>
        </div>
        <p style={mutedStyle}>
          {config.afterValue} {config.afterUnit} after order date the order will be moved to the archive folder.
        </p>
      </div>

      {/* Archive folder */}
      <div style={{ ...sectionStyle, opacity: config.enabled ? 1 : 0.45, pointerEvents: config.enabled ? "auto" : "none" }}>
        <span style={headStyle}>Archive folder</span>
        <p style={mutedStyle}>Choose where archived orders are stored on your computer.</p>
        <div style={rowStyle}>
          <div style={pathBox} title={config.archiveFolder || "No folder selected"}>
            {config.archiveFolder || <span style={{ color: "#9ca3af", fontFamily: "inherit" }}>No folder selected</span>}
          </div>
          <button onClick={pickFolder} style={browseBtn}>Browse…</button>
          {config.archiveFolder && (
            <button
              onClick={() => set({ archiveFolder: "" })}
              title="Clear folder"
              style={{ ...browseBtn, color: "#dc2626", borderColor: "#fca5a5" }}
            >✕</button>
          )}
        </div>
        {config.enabled && !config.archiveFolder && (
          <p style={{ ...mutedStyle, color: "#dc2626", marginTop: "8px" }}>
            ⚠ Auto-archive is enabled but no folder is selected.
          </p>
        )}
      </div>

    </div>
  );
}

/* ── Documents tab ──────────────────────────────────────────────────────── */
function DocumentsTab({ config, setConfig }) {
  async function pickFile(field, nameField, title, filters) {
    const result = await window.parserApp?.pickFile?.({ title, filters });
    if (!result || result.canceled) return;
    setConfig((prev) => ({ ...prev, [field]: result.path, [nameField]: result.name }));
  }

  function clearFile(field, nameField) {
    setConfig((prev) => ({ ...prev, [field]: "", [nameField]: "" }));
  }

  const uploadFilters = [
    { name: "PDF Files", extensions: ["pdf"] },
  ];

  const sectionStyle = {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "20px 24px",
    marginBottom: "20px",
  };

  const labelStyle = {
    display: "block",
    fontSize: "13px",
    fontWeight: 700,
    color: "#111",
    marginBottom: "4px",
  };

  const descStyle = {
    fontSize: "12px",
    color: "#6b7280",
    marginBottom: "14px",
    lineHeight: 1.5,
  };

  const fileRowStyle = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  };

  const fileNameStyle = {
    flex: 1,
    fontSize: "13px",
    color: "#374151",
    background: "#fff",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    padding: "7px 11px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  };

  const uploadBtn = {
    flexShrink: 0,
    padding: "7px 14px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
  };

  const clearBtn = {
    flexShrink: 0,
    padding: "7px 10px",
    background: "none",
    color: "#9ca3af",
    border: "1px solid #e5e7eb",
    borderRadius: "6px",
    fontSize: "12px",
    cursor: "pointer",
  };

  return (
    <div>
      <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "18px" }}>
        Documents
      </div>

      {/* Letterhead */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Gift Messages</span>
        <p style={descStyle}>
          Upload your shop letterhead. When an order includes a gift message, the gift
          message will be printed on this letterhead.
        </p>
        <div style={fileRowStyle}>
          <span style={{
            ...fileNameStyle,
            color: config.letterheadName ? "#374151" : "#9ca3af",
            fontStyle: config.letterheadName ? "normal" : "italic",
          }}>
            {config.letterheadName || "No file selected"}
          </span>
          <button
            style={uploadBtn}
            onClick={() => pickFile("letterheadPath", "letterheadName", "Select Gift Message Letterhead", uploadFilters)}
          >
            Browse…
          </button>
          {config.letterheadName && (
            <button style={clearBtn} title="Remove" onClick={() => clearFile("letterheadPath", "letterheadName")}>✕</button>
          )}
        </div>
        {config.letterheadPath && (
          <div style={{ marginTop: "8px", fontSize: "11px", color: "#9ca3af", wordBreak: "break-all" }}>
            {config.letterheadPath}
          </div>
        )}

        {/* Show print icon toggle */}
        <div style={{ marginTop: "16px", display: "flex", alignItems: "center", gap: "10px" }}>
          <label style={{ position: "relative", display: "inline-block", width: 36, height: 20, flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={config.showPrintIcon !== false}
              onChange={(e) => setConfig((prev) => ({ ...prev, showPrintIcon: e.target.checked }))}
              style={{ opacity: 0, width: 0, height: 0, position: "absolute" }}
            />
            <span style={{
              position: "absolute", inset: 0, borderRadius: 999, cursor: "pointer",
              background: config.showPrintIcon !== false ? "#2563eb" : "#d1d5db",
              transition: "background 0.2s",
            }}>
              <span style={{
                position: "absolute", top: 3, left: config.showPrintIcon !== false ? 19 : 3,
                width: 14, height: 14, borderRadius: "50%", background: "#fff",
                transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }} />
            </span>
          </label>
          <span style={{ fontSize: "13px", color: "#374151" }}>
            Show 🖨 print icon on gift message cells
          </span>
        </div>
      </div>

      {/* Thank-you letter */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Thank You Letter</span>
        <p style={descStyle}>
          Upload your standard thank you letter template. This will be used when printing
          packing inserts for orders.
        </p>
        <div style={fileRowStyle}>
          <span style={{
            ...fileNameStyle,
            color: config.thankYouName ? "#374151" : "#9ca3af",
            fontStyle: config.thankYouName ? "normal" : "italic",
          }}>
            {config.thankYouName || "No file selected"}
          </span>
          <button
            style={uploadBtn}
            onClick={() => pickFile("thankYouPath", "thankYouName", "Select Thank You Letter", uploadFilters)}
          >
            Browse…
          </button>
          {config.thankYouName && (
            <button style={clearBtn} title="Remove" onClick={() => clearFile("thankYouPath", "thankYouName")}>✕</button>
          )}
        </div>
        {config.thankYouPath && (
          <div style={{ marginTop: "8px", fontSize: "11px", color: "#9ca3af", wordBreak: "break-all" }}>
            {config.thankYouPath}
          </div>
        )}
      </div>

      {/* Gift message text position */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Gift Message Text Position</span>
        <p style={descStyle}>
          Controls where the gift message is drawn on the letterhead PDF.
          Coordinates are in points (1 inch = 72 pt) measured from the bottom-left corner of the page.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 20px" }}>
          {[
            { key: "giftTextX",        label: "X (left offset, pt)",    min: 0,   max: 800 },
            { key: "giftTextY",        label: "Y (from bottom, pt)",    min: 0,   max: 1200 },
            { key: "giftTextMaxWidth", label: "Max width (pt)",         min: 50,  max: 800 },
            { key: "giftTextFontSize", label: "Font size (pt)",         min: 6,   max: 72 },
          ].map(({ key, label, min, max }) => (
            <label key={key} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span style={{ fontSize: "11px", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                {label}
              </span>
              <input
                type="number"
                min={min}
                max={max}
                value={config[key] ?? ""}
                onChange={(e) => setConfig((p) => ({ ...p, [key]: Number(e.target.value) }))}
                style={{
                  padding: "7px 10px",
                  border: "1px solid #d1d5db",
                  borderRadius: "6px",
                  fontSize: "13px",
                  width: "100%",
                  boxSizing: "border-box",
                }}
                onFocus={(e) => (e.target.style.borderColor = "#2563eb")}
                onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
              />
            </label>
          ))}

          <label style={{ display: "flex", flexDirection: "column", gap: "4px", gridColumn: "1 / -1" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Text color
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <input
                type="color"
                value={config.giftTextColor ?? "#000000"}
                onChange={(e) => setConfig((p) => ({ ...p, giftTextColor: e.target.value }))}
                style={{ width: 38, height: 34, padding: "2px", border: "1px solid #d1d5db", borderRadius: "6px", cursor: "pointer" }}
              />
              <span style={{ fontSize: "12px", color: "#6b7280", fontFamily: "monospace" }}>
                {config.giftTextColor ?? "#000000"}
              </span>
            </div>
          </label>
        </div>
      </div>

      <div style={{ fontSize: "12px", color: "#9ca3af", lineHeight: 1.6 }}>
        Only PDF files are supported. Files are referenced by path — moving or renaming them will require re-selecting.
      </div>
    </div>
  );
}

/* ── main component ─────────────────────────────────────────────────────── */
export default function SettingsModal({ open, onClose, columnOrder: externalColumnOrder, onColumnOrderChange }) {
  const [activeTab, setActiveTab] = React.useState("general");
  const [fields, setFields] = React.useState([]);
  const [localOrder, setLocalOrder] = React.useState([]);
  const [localParserOrder, setLocalParserOrder] = React.useState([]);
  const [localPriceList, setLocalPriceList] = React.useState([]);
  const [localStatusConfig, setLocalStatusConfig] = React.useState(() => structuredClone(DEFAULT_STATUS_CONFIG));
  const [localViewConfig, setLocalViewConfig] = React.useState(() => loadViewConfig());
  const [localDateConfig, setLocalDateConfig] = React.useState(() => loadDateConfig());
  const [localArchiveConfig, setLocalArchiveConfig] = React.useState(() => loadArchiveConfig());
  const [localEmailTemplates, setLocalEmailTemplates] = React.useState(() => loadEmailTemplates());
  const [localShopConfig, setLocalShopConfig] = React.useState(() => loadShopConfig());
  const [localDocumentsConfig, setLocalDocumentsConfig] = React.useState(() => loadDocumentsConfig());

  React.useEffect(() => {
    if (open) {
      setFields(loadFieldConfig());
      setLocalOrder(externalColumnOrder ? [...externalColumnOrder] : defaultColumnOrder());
      setLocalParserOrder(loadParserFieldOrder());
      setLocalPriceList(loadPriceList());
      setLocalStatusConfig(loadStatusConfig());
      setLocalViewConfig(loadViewConfig());
      setLocalDateConfig(loadDateConfig());
      setLocalArchiveConfig(loadArchiveConfig());
      setLocalEmailTemplates(loadEmailTemplates());
      setLocalShopConfig(loadShopConfig());
      setLocalDocumentsConfig(loadDocumentsConfig());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!open) return;
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function handleSave() {
    saveShopConfig(localShopConfig);
    saveDocumentsConfig(localDocumentsConfig);
    saveFieldConfig(fields);
    saveColumnOrder(localOrder);
    if (onColumnOrderChange) onColumnOrderChange(localOrder);
    saveParserFieldOrder(localParserOrder);
    savePriceList(localPriceList);
    saveStatusConfig(localStatusConfig);
    saveViewConfig(localViewConfig);
    saveDateConfig(localDateConfig);
    saveArchiveConfig(localArchiveConfig);
    saveEmailTemplates(localEmailTemplates);
    onClose();
  }

  /** Update the shared label for a field key. Both tabs write here. */
  function setLabel(key, value) {
    setFields((prev) => prev.map((f) => f.key === key ? { ...f, label: value } : f));
  }

  /** Toggle visibleInOrders or visibleInParser for a field key. */
  function toggleVisible(key, visibilityKey) {
    setFields((prev) => prev.map((f) =>
      f.key === key ? { ...f, [visibilityKey]: !f[visibilityKey] } : f
    ));
  }

  /** Toggle paletteEnabled for a field key (controls row-color cell tinting). */
  function togglePalette(key) {
    setFields((prev) => prev.map((f) =>
      f.key === key ? { ...f, paletteEnabled: !f.paletteEnabled } : f
    ));
  }

  function toggleHighlight(key) {
    setFields((prev) => prev.map((f) =>
      f.key === key
        ? { ...f, highlight: { ...f.highlight, enabled: !f.highlight?.enabled } }
        : f
    ));
  }

  function setHighlightColor(key, color) {
    setFields((prev) => prev.map((f) =>
      f.key === key
        ? { ...f, highlight: { ...f.highlight, enabled: true, color } }
        : f
    ));
  }

  /** Move a field up/down by one position in localOrder. */
  function moveField(idx, direction) {
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= localOrder.length) return;
    setLocalOrder((prev) => swapItems(prev, idx, targetIdx));
  }

  function resetOrder() {
    setLocalOrder(defaultColumnOrder());
  }

  if (!open) return null;

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 2000,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{
        background: "#fff",
        borderRadius: "10px",
        boxShadow: "0 24px 64px rgba(0,0,0,0.26)",
        width: "min(92vw, 860px)",
        height: "94vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>

        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center",
          padding: "16px 24px",
          borderBottom: "1px solid #e5e7eb",
          flexShrink: 0,
        }}>
          <div style={{ flex: 1 }}>
            <span style={{ fontWeight: 700, fontSize: "17px", color: "#111" }}>
              Settings
            </span>
            {localShopConfig.shopName?.trim() && (
              <span style={{ marginLeft: 10, fontSize: "13px", color: "#6b7280", fontWeight: 400 }}>
                — {localShopConfig.shopName.trim()}
              </span>
            )}
          </div>
          <button onClick={onClose} style={{
            background: "none", border: "none", fontSize: "20px",
            cursor: "pointer", color: "#666", lineHeight: 1, padding: "2px 6px",
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

          {/* Sidebar */}
          <div style={{
            width: "170px",
            borderRight: "1px solid #e5e7eb",
            background: "#f9fafb",
            padding: "10px 0",
            flexShrink: 0,
          }}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  padding: "10px 18px", border: "none",
                  background: activeTab === tab.id ? "#eff6ff" : "none",
                  color: activeTab === tab.id ? "#2563eb" : "#374151",
                  fontWeight: activeTab === tab.id ? 600 : 400,
                  fontSize: "13px", cursor: "pointer",
                  borderLeft: activeTab === tab.id ? "3px solid #2563eb" : "3px solid transparent",
                }}
                onMouseEnter={(e) => { if (activeTab !== tab.id) e.currentTarget.style.background = "#f3f4f6"; }}
                onMouseLeave={(e) => { if (activeTab !== tab.id) e.currentTarget.style.background = "none"; }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "22px 26px 80px" }}>

            {activeTab === "general" && (
              <div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "18px" }}>
                  Shop Identity
                </div>

                <div style={{ marginBottom: "24px" }}>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                    Shop name
                  </label>
                  <input
                    type="text"
                    value={localShopConfig.shopName ?? ""}
                    onChange={(e) => setLocalShopConfig((p) => ({ ...p, shopName: e.target.value }))}
                    placeholder="Your shop name here"
                    style={{
                      width: "100%", maxWidth: "360px",
                      padding: "9px 12px",
                      border: "1px solid #d1d5db",
                      borderRadius: "6px",
                      fontSize: "14px",
                      color: "#111",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                    onFocus={(e) => (e.target.style.borderColor = "#2563eb")}
                    onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
                  />
                  <div style={{ marginTop: "6px", fontSize: "12px", color: "#9ca3af" }}>
                    Displayed in the app header and window title.
                  </div>
                </div>

                {/* Save location */}
                <div style={{ marginTop: "28px" }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "18px" }}>
                    Save Location
                  </div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                    Save folder
                  </label>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", maxWidth: "480px" }}>
                    <div style={{
                      flex: 1, padding: "8px 11px",
                      border: "1px solid #d1d5db", borderRadius: "6px",
                      fontSize: "13px", color: localShopConfig.saveFolder ? "#111" : "#9ca3af",
                      fontStyle: localShopConfig.saveFolder ? "normal" : "italic",
                      background: "#f9fafb", overflow: "hidden",
                      textOverflow: "ellipsis", whiteSpace: "nowrap",
                      minWidth: 0,
                    }}>
                      {localShopConfig.saveFolder || "No folder selected"}
                    </div>
                    <button
                      onClick={async () => {
                        const result = await window.parserApp?.pickFolder?.();
                        if (result && !result.canceled) {
                          setLocalShopConfig((p) => ({ ...p, saveFolder: result.path }));
                        }
                      }}
                      style={{
                        flexShrink: 0, padding: "8px 14px",
                        background: "#2563eb", color: "#fff",
                        border: "none", borderRadius: "6px",
                        fontSize: "12px", fontWeight: 600, cursor: "pointer",
                      }}
                    >Browse…</button>
                    {localShopConfig.saveFolder && (
                      <button
                        onClick={() => setLocalShopConfig((p) => ({ ...p, saveFolder: "" }))}
                        style={{
                          flexShrink: 0, padding: "8px 10px",
                          background: "none", color: "#9ca3af",
                          border: "1px solid #e5e7eb", borderRadius: "6px",
                          fontSize: "12px", cursor: "pointer",
                        }}
                        title="Clear"
                      >✕</button>
                    )}
                  </div>
                  <div style={{ marginTop: "6px", fontSize: "12px", color: "#9ca3af" }}>
                    Files saved via the save button will be written to this folder.
                  </div>
                </div>

                {/* Restore from backup */}
                <div style={{ marginTop: "28px" }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "6px" }}>
                    Restore from Backup
                  </div>
                  <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "14px", lineHeight: 1.6 }}>
                    Select a <code style={{ background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>.spailabackup</code> file
                    to fully restore all orders and settings. The app will reload automatically.
                    <span style={{ color: "#ef4444", fontWeight: 600 }}> This will overwrite your current data.</span>
                  </div>
                  <button
                    onClick={async () => {
                      const picked = await window.parserApp?.pickFile?.({
                        title: "Select Backup File",
                        filters: [{ name: "Spaila Backup", extensions: ["spailabackup"] }],
                      });
                      if (!picked || picked.canceled) return;

                      const result = await window.parserApp?.backupRestore?.({ filePath: picked.path });
                      if (!result?.ok) {
                        alert(`Restore failed: ${result?.error ?? "unknown error"}`);
                        return;
                      }

                      // Restore localStorage settings
                      try {
                        for (const [key, value] of Object.entries(result.settings || {})) {
                          localStorage.setItem(key, value);
                        }
                      } catch (_) {}

                      alert(`Restore complete! Backup from ${result.createdAt ? new Date(result.createdAt).toLocaleString() : "unknown date"}.\n\nThe app will now reload.`);
                      window.location.reload();
                    }}
                    style={{
                      padding: "9px 18px",
                      background: "#dc2626",
                      color: "#fff",
                      border: "none",
                      borderRadius: "7px",
                      fontSize: "13px",
                      fontWeight: 600,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "7px",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#b91c1c")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "#dc2626")}
                  >
                    ↩ Restore from Backup…
                  </button>
                </div>
              </div>
            )}

            {activeTab === "orders" && (
              <>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "4px" }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: "#111" }}>
                    Orders Sheet Fields
                  </div>
                  <button
                    onClick={resetOrder}
                    style={{
                      fontSize: "11px", color: "#6b7280", background: "none",
                      border: "1px solid #d1d5db", borderRadius: "5px",
                      padding: "3px 10px", cursor: "pointer",
                    }}
                    title="Restore default column order"
                  >
                    Reset to Default Layout
                  </button>
                </div>
                <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "18px", lineHeight: 1.6 }}>
                  Control which fields appear as columns and in what order. Drag columns directly in the
                  table header, or use ↑ ↓ here. Renaming also updates the parser and everywhere else.
                </div>
                <OrderFieldTable
                  fields={fields}
                  localOrder={localOrder}
                  setLabel={setLabel}
                  toggleVisible={toggleVisible}
                  togglePalette={togglePalette}
                  toggleHighlight={toggleHighlight}
                  setHighlightColor={setHighlightColor}
                  moveField={moveField}
                  localStatusConfig={localStatusConfig}
                  setLocalStatusConfig={setLocalStatusConfig}
                />
              </>
            )}

            {activeTab === "pricing" && (
              <PricingTab
                priceList={localPriceList}
                setPriceList={setLocalPriceList}
                typeLabel={fields.find((f) => f.key === PRICE_TYPE_FIELD_KEY)?.label ?? "Type"}
              />
            )}

            {activeTab === "status" && (
              <StatusTab
                config={localStatusConfig}
                setConfig={setLocalStatusConfig}
              />
            )}

            {activeTab === "view" && (
              <ViewTab
                config={localViewConfig}
                setConfig={setLocalViewConfig}
                fields={fields}
              />
            )}

            {activeTab === "dates" && (
              <DatesTab
                config={localDateConfig}
                setConfig={setLocalDateConfig}
              />
            )}

            {activeTab === "archive" && (
              <ArchiveTab
                config={localArchiveConfig}
                setConfig={setLocalArchiveConfig}
              />
            )}

            {activeTab === "emails" && (
              <EmailsTab
                templates={localEmailTemplates}
                setTemplates={setLocalEmailTemplates}
                labelMap={Object.fromEntries(fields.map((f) => [f.key, f.label]))}
                shopConfig={localShopConfig}
                setShopConfig={setLocalShopConfig}
              />
            )}

            {activeTab === "documents" && (
              <DocumentsTab
                config={localDocumentsConfig}
                setConfig={setLocalDocumentsConfig}
              />
            )}

            {activeTab === "parser" && (
              <>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "4px" }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: "#111" }}>
                    Parser Fields
                  </div>
                  <button
                    onClick={() => setLocalParserOrder(defaultParserFieldOrder())}
                    style={{
                      fontSize: "11px", color: "#6b7280", background: "none",
                      border: "1px solid #d1d5db", borderRadius: "5px",
                      padding: "3px 10px", cursor: "pointer",
                    }}
                    title="Restore default parser field order"
                  >
                    Reset to Default Layout
                  </button>
                </div>
                <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "18px", lineHeight: 1.6 }}>
                  Control which fields are shown and in what order while parsing.
                  Use ↑ ↓ to reorder within each section. Renaming also updates the orders sheet everywhere.
                </div>
                <ParserFieldTable
                  fields={fields}
                  localParserOrder={localParserOrder}
                  setLabel={setLabel}
                  toggleVisible={toggleVisible}
                  setLocalParserOrder={setLocalParserOrder}
                />
              </>
            )}

          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: "flex", justifyContent: "flex-end", gap: "8px",
          padding: "13px 24px",
          borderTop: "1px solid #e5e7eb",
          background: "#fafafa",
          flexShrink: 0,
        }}>
          <button onClick={onClose} style={{
            padding: "8px 18px", border: "1px solid #d1d5db",
            borderRadius: "6px", background: "#fff", cursor: "pointer", fontSize: "13px",
          }}>Cancel</button>
          <button onClick={handleSave} style={{
            padding: "8px 22px", border: "none", borderRadius: "6px",
            background: "#2563eb", color: "#fff", cursor: "pointer",
            fontSize: "13px", fontWeight: 600,
          }}>Save</button>
        </div>

      </div>
    </div>
  );
}
