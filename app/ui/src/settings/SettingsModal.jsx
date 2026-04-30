import React from "react";
import {
  loadFieldConfig, saveFieldConfig,
  saveColumnOrder, defaultColumnOrder,
  loadParserFieldOrder, saveParserFieldOrder, defaultParserFieldOrder,
  PARSER_ORDER_SECTION_KEYS, PARSER_ITEM_SECTION_KEYS,
  loadPriceList, savePriceList,
  PRICE_TYPE_FIELD_KEY,
  contrastColor,
  loadStatusConfig, saveStatusConfig,
  loadViewConfig, saveViewConfig, SEARCH_FIELD_GROUPS,
  FIELD_DEFS,
  loadDateConfig, saveDateConfig, formatDate,
  loadEmailTemplates, saveEmailTemplates, DEFAULT_EMAIL_TEMPLATES, EMAIL_VARIABLE_KEYS,
  evalEmailCondition,
  loadShopConfig, saveShopConfig, DEFAULT_SAVE_FOLDER,
  loadDocumentsConfig, saveDocumentsConfig,
  loadPrintConfig, savePrintConfig,
} from "../shared/utils/fieldConfig.js";
import AppHeader from "../shared/components/AppHeader.jsx";

function swapItems(arr, i, j) {
  const next = [...arr];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

const TABS = [
  { id: "general",   label: "General"     },
  { kind: "divider", label: "Account & Helper" },
  { id: "account",   label: "Account"     },
  { id: "helper",    label: "Helper"      },
  { kind: "divider", label: "Orders"      },
  { id: "orders",    label: "Orders"      },
  { id: "parser",    label: "Order Processing" },
  { id: "learning",  label: "Learning"    },
  { kind: "divider", label: "Display & Rules" },
  { id: "view",      label: "Search / Sort" },
  { id: "dates",     label: "Dates"       },
  { id: "status",    label: "Status"      },
  { id: "pricing",   label: "Pricing"     },
  { kind: "divider", label: "Output & Email" },
  { id: "printing",  label: "Printing"    },
  { id: "documents", label: "Docs"        },
  { id: "emails",    label: "Emails"      },
  { kind: "divider", label: "Data"        },
  { id: "data",      label: "Data"        },
];

function isAbsoluteLocalPath(value) {
  const raw = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\");
}

function localFileSrc(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw || !isAbsoluteLocalPath(raw)) return "";
  return `file:///${raw.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

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
    <div style={{ overflowX: "auto", paddingBottom: "4px" }}>
      <div style={{ minWidth: "700px" }}>
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
                  outline: "none", maxWidth: "100%", minWidth: 0, boxSizing: "border-box",
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
      </div>
    </div>
  );
}

/* ── shared field table used by both tabs ───────────────────────────────── */
/**
 * visibilityKey: "visibleInOrders" | "visibleInParser"
 * visibilityLabel: human label shown in the column header (e.g. "Visible in Orders")
 */
function FieldTable({ fields, visibilityKey, setLabel, toggleVisible }) {
  return (
    <div style={{ overflowX: "auto", paddingBottom: "4px" }}>
      <div style={{ minWidth: "520px" }}>
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
                  maxWidth: "100%",
                  minWidth: 0,
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
      </div>
    </div>
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
      <div style={{ overflowX: "auto", paddingBottom: "4px" }}>
        <div style={{ minWidth: "420px" }}>
        <div style={{ fontSize: "12px", fontWeight: 700, color: "#374151", margin: "0 0 6px 2px" }}>
          {title}
        </div>
        {/* Section header */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 100px 44px 52px",
          gap: "0 8px",
          padding: "5px 10px",
          background: "#f3f4f6",
          borderRadius: "6px 6px 0 0",
          borderBottom: "1px solid #e5e7eb",
          fontSize: "11px", fontWeight: 600, color: "#6b7280",
          letterSpacing: "0.05em", textTransform: "uppercase", alignItems: "center",
        }}>
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
                  gridTemplateColumns: "1fr 100px 44px 52px",
                  gap: "0 8px",
                  padding: "8px 10px",
                  alignItems: "center",
                  background: i % 2 === 0 ? "#fff" : "#fafafa",
                  borderBottom: i < sectionKeys.length - 1 ? "1px solid #f3f4f6" : "none",
                }}
              >
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
                    outline: "none", maxWidth: "100%", minWidth: 0, boxSizing: "border-box",
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
        </div>
      </div>
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

  function duplicateRow(id) {
    setPriceList((prev) => {
      const index = prev.findIndex((r) => r.id === id);
      if (index < 0) return prev;
      const copy = {
        ...prev[index],
        id: Math.random().toString(36).slice(2),
      };
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
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
        <div style={{ overflowX: "auto", paddingBottom: "4px" }}>
          <div style={{ minWidth: "560px" }}>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "100px 1fr 54px 126px",
            gap: "0 10px", padding: "5px 10px",
            background: "#f3f4f6", borderRadius: "6px 6px 0 0",
            borderBottom: "1px solid #e5e7eb",
            fontSize: "11px", fontWeight: 600, color: "#6b7280",
            letterSpacing: "0.05em", textTransform: "uppercase", alignItems: "center",
          }}>
            <span>Price</span>
            <span>{typeLabel}</span>
            <span style={{ textAlign: "center" }}>Color</span>
            <span style={{ textAlign: "center" }}>Actions</span>
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
                outline: "none", maxWidth: "100%", minWidth: 0, boxSizing: "border-box",
              };

              return (
                <div
                  key={row.id}
                  style={{
                    display: "grid", gridTemplateColumns: "100px 1fr 54px 126px",
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
                  <div style={{ display: "flex", justifyContent: "center", gap: "5px" }}>
                    <button
                      onClick={() => duplicateRow(row.id)}
                      style={{
                        padding: "3px 8px", fontSize: "11px", borderRadius: "5px",
                        border: isDark ? "1px solid rgba(255,255,255,0.35)" : "1px solid rgba(0,0,0,0.18)",
                        background: isDark ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.7)",
                        cursor: "pointer", color: textColor,
                      }}
                    >Duplicate</button>
                    <button
                      onClick={() => del(row.id)}
                      style={{
                        padding: "3px 8px", fontSize: "11px", borderRadius: "5px",
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
          </div>
        </div>
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
        <div style={{ overflowX: "auto", paddingBottom: "4px" }}>
          <div style={{ minWidth: "520px" }}>
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
          </div>
        </div>
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

function EmailsTab({ templates, setTemplates, labelMap, shopConfig, setShopConfig, activeEmailSubtab = "sending", setActiveEmailSubtab = () => {} }) {
  const [editingId, setEditingId] = React.useState(null);
  const [smtpState, setSmtpState] = React.useState({ testing: false, message: "", error: "" });
  const [imapState, setImapState] = React.useState({ testing: false, message: "", error: "" });
  const [smtpProvider, setSmtpProvider] = React.useState("other");

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
    maxWidth: "560px", padding: "5px 8px", border: "1px solid #d1d5db",
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

  async function handleTestSmtp() {
    setSmtpState({ testing: true, message: "", error: "" });
    try {
      const result = await window.parserApp?.testSmtpConnection?.({
        config: {
          emailAddress: shopConfig?.smtpEmailAddress || shopConfig?.smtpUsername || "",
          host: shopConfig?.smtpHost || "",
          port: shopConfig?.smtpPort || "",
          username: shopConfig?.smtpUsername || "",
          password: shopConfig?.smtpPassword || "",
        },
      });
      if (result?.ok) {
        setSmtpState({ testing: false, message: result.message || "SMTP connection successful.", error: "" });
      } else {
        setSmtpState({ testing: false, message: "", error: result?.error || "Unable to connect — check settings or network" });
      }
    } catch (error) {
      setSmtpState({ testing: false, message: "", error: error?.message || "Unable to connect — check settings or network" });
    }
  }

  async function handleTestImap() {
    setImapState({ testing: true, message: "", error: "" });
    try {
      const result = await window.parserApp?.testImapConnection?.({
        config: {
          host: shopConfig?.imapHost || "",
          port: shopConfig?.imapPort || "993",
          username: shopConfig?.imapUsername || "",
          password: shopConfig?.imapPassword || "",
          useSsl: shopConfig?.imapUseSsl !== false,
        },
      });
      if (result?.ok) {
        setImapState({ testing: false, message: result.message || "IMAP receiving connection successful.", error: "" });
      } else {
        setImapState({ testing: false, message: "", error: result?.error || "Unable to connect — check IMAP settings or network" });
      }
    } catch (error) {
      setImapState({ testing: false, message: "", error: error?.message || "Unable to connect — check IMAP settings or network" });
    }
  }

  const providerHelp = {
    gmail: {
      title: "Gmail Setup",
      steps: [
        "Enable 2-Step Verification on your Google account",
        "Generate an App Password: Google Account -> Security -> App Passwords",
        "Use this App Password below (NOT your Gmail password)",
      ],
      settings: [
        "SMTP Host: smtp.gmail.com",
        "Port: 587 (or 465)",
        "Username: your full Gmail address",
      ],
      host: "smtp.gmail.com",
      port: "587",
      usernameHint: "your@gmail.com",
      usernameMode: "email",
      passwordHint: "App Password (Google)",
    },
    outlook: {
      title: "Outlook Setup",
      steps: [
        "Use your Outlook email and password",
        "If needed, create an App Password in your Microsoft account",
      ],
      settings: [
        "SMTP Host: smtp.office365.com",
        "Port: 587",
        "Username: your full email address",
      ],
      host: "smtp.office365.com",
      port: "587",
      usernameHint: "your@outlook.com",
      usernameMode: "email",
      passwordHint: "App Password (if required)",
    },
    other: {
      title: "Other Provider Setup",
      steps: [
        "Using a custom or domain email?",
        "Check your provider's SMTP settings (Namecheap, GoDaddy, etc.)",
        "If connection fails, try port 465.",
      ],
      settings: [
        "Host: mail.yourdomain.com",
        "Port: 465 (SSL) or 587 (TLS)",
      ],
      host: "mail.yourdomain.com",
      port: "465",
      usernameHint: "your@email.com",
      usernameMode: "custom",
      passwordHint: "Your email password or app password",
    },
  };
  const selectedProviderHelp = providerHelp[smtpProvider] || providerHelp.other;
  const smtpEmailAddress = String(shopConfig?.smtpEmailAddress || "").trim();
  const smtpHost = String(shopConfig?.smtpHost || "").trim().toLowerCase();
  const smtpPort = String(shopConfig?.smtpPort || "").trim();
  const smtpUsername = String(shopConfig?.smtpUsername || "").trim();
  const matchesGmailDefaults = smtpHost === providerHelp.gmail.host
    && smtpPort === providerHelp.gmail.port
    && (!smtpUsername || !smtpEmailAddress || smtpUsername.toLowerCase() === smtpEmailAddress.toLowerCase());
  const matchesOutlookDefaults = smtpHost === providerHelp.outlook.host
    && smtpPort === providerHelp.outlook.port
    && (!smtpUsername || !smtpEmailAddress || smtpUsername.toLowerCase() === smtpEmailAddress.toLowerCase());
  const providerIndicator = matchesGmailDefaults
    ? "Using: Gmail defaults"
    : matchesOutlookDefaults
      ? "Using: Outlook defaults"
      : "Using: Custom settings";
  const selectedProviderMismatch = (
    (smtpProvider === "gmail" && smtpHost && !matchesGmailDefaults)
    || (smtpProvider === "outlook" && smtpHost && !matchesOutlookDefaults)
  );

  function handleSelectSmtpProvider(providerId) {
    setSmtpProvider(providerHelp[providerId] ? providerId : "other");
  }

  function handleApplySmtpDefaults() {
    if (smtpProvider === "other") {
      return;
    }
    setShopConfig?.((prev) => ({
      ...prev,
      smtpHost: selectedProviderHelp.host,
      smtpPort: selectedProviderHelp.port,
      smtpUsername: (
        !String(prev?.smtpUsername || "").trim()
        || (String(prev?.smtpEmailAddress || "").trim()
          && String(prev?.smtpUsername || "").trim().toLowerCase() === String(prev?.smtpEmailAddress || "").trim().toLowerCase())
        || String(prev?.smtpUsername || "").trim() === providerHelp.gmail.usernameHint
        || String(prev?.smtpUsername || "").trim() === providerHelp.outlook.usernameHint
      )
        ? String(prev?.smtpEmailAddress || "").trim()
        : (prev?.smtpUsername || ""),
    }));
  }

  return (
    <div style={{ padding: "4px 0" }}>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { id: "sending", label: "Send / Receive" },
          { id: "templates", label: "Templates" },
          { id: "storage", label: "Storage" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveEmailSubtab(tab.id)}
            style={{
              padding: "7px 14px",
              border: `1px solid ${activeEmailSubtab === tab.id ? "#93c5fd" : "#d1d5db"}`,
              borderRadius: 999,
              background: activeEmailSubtab === tab.id ? "#eff6ff" : "#fff",
              color: "#111827",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeEmailSubtab === "sending" ? (
      <div style={{
        background: "#f9fafb", border: "1px solid #e5e7eb",
        borderRadius: "10px", padding: "14px 18px", marginBottom: "16px",
      }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: 8 }}>
          Email Send / Receive Setup
        </div>
        <div style={{ fontSize: 12, color: "#4b5563", lineHeight: 1.6, marginBottom: 12 }}>
          To receive customer replies, enter your inbox IMAP settings. To send emails from Spaila, enter your SMTP settings.
          <br />
          Most providers require an App Password instead of your normal email password.
        </div>
        <div style={{ marginTop: 14, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 12px 10px", marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 6 }}>
            Receiving Mail (IMAP)
          </div>
          <div style={{ fontSize: 12, color: "#4b5563", lineHeight: 1.6, marginBottom: 10 }}>
            IMAP lets Spaila read incoming customer replies from your mailbox. Use your provider's IMAP host, usually port 993 with SSL enabled.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <label>
              <span style={labelStyle}>IMAP Host</span>
              <input
                value={shopConfig?.imapHost ?? ""}
                onChange={(e) => setShopConfig?.((prev) => ({ ...prev, imapHost: e.target.value }))}
                placeholder="imap.yourprovider.com"
                style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
              />
            </label>
            <label>
              <span style={labelStyle}>IMAP Port</span>
              <input
                type="number"
                value={shopConfig?.imapPort ?? "993"}
                onChange={(e) => setShopConfig?.((prev) => ({ ...prev, imapPort: e.target.value }))}
                placeholder="993"
                style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
              />
            </label>
            <label>
              <span style={labelStyle}>IMAP Username</span>
              <input
                value={shopConfig?.imapUsername ?? ""}
                onChange={(e) => setShopConfig?.((prev) => ({ ...prev, imapUsername: e.target.value }))}
                placeholder="you@example.com"
                style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
              />
            </label>
            <label>
              <span style={labelStyle}>IMAP Password</span>
              <input
                type="password"
                value={shopConfig?.imapPassword ?? ""}
                onChange={(e) => setShopConfig?.((prev) => ({ ...prev, imapPassword: e.target.value }))}
                placeholder="Mailbox password or app password"
                style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
              <input
                type="checkbox"
                checked={shopConfig?.imapUseSsl !== false}
                onChange={(e) => setShopConfig?.((prev) => ({ ...prev, imapUseSsl: e.target.checked }))}
              />
              <span style={{ fontSize: 12, color: "#374151" }}>Use SSL</span>
            </label>
            <label>
              <span style={labelStyle}>Fetch Limit</span>
              <input
                type="number"
                value={shopConfig?.imapFetchLimit ?? "20"}
                onChange={(e) => setShopConfig?.((prev) => ({ ...prev, imapFetchLimit: e.target.value }))}
                placeholder="20"
                style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
              />
            </label>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleTestImap}
              disabled={imapState.testing}
              style={{ padding: "6px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              {imapState.testing ? "Testing..." : "Test Receiving Connection"}
            </button>
            {imapState.message ? <div style={{ fontSize: 12, color: "#047857" }}>✔ Receiving connection successful</div> : null}
            {imapState.error ? <div style={{ fontSize: 12, color: "#b91c1c" }}>{imapState.error}</div> : null}
          </div>
          <div style={{ marginTop: 14, borderTop: "1px solid #eef2f7", paddingTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 10 }}>
              Background Sync
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
              <label>
                <span style={labelStyle}>Polling Interval (seconds)</span>
                <input
                  type="number"
                  min="60"
                  max="3600"
                  value={shopConfig?.mailPollingIntervalSeconds ?? 300}
                  onChange={(e) => setShopConfig?.((prev) => ({ ...prev, mailPollingIntervalSeconds: e.target.value }))}
                  placeholder="300"
                  style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 20 }}>
                <input
                  type="checkbox"
                  checked={shopConfig?.mailBackgroundSyncEnabled !== false}
                  onChange={(e) => setShopConfig?.((prev) => ({ ...prev, mailBackgroundSyncEnabled: e.target.checked }))}
                />
                <span style={{ fontSize: 12, color: "#374151" }}>Enable background sync</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={shopConfig?.mailStartupAutoConnect !== false}
                  onChange={(e) => setShopConfig?.((prev) => ({ ...prev, mailStartupAutoConnect: e.target.checked }))}
                />
                <span style={{ fontSize: 12, color: "#374151" }}>Auto-connect on app startup</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={shopConfig?.mailReconnectEnabled !== false}
                  onChange={(e) => setShopConfig?.((prev) => ({ ...prev, mailReconnectEnabled: e.target.checked }))}
                />
                <span style={{ fontSize: 12, color: "#374151" }}>Reconnect after disconnect</span>
              </label>
            </div>
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 8 }}>
          Sending Mail (SMTP)
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {[
            { id: "gmail", label: "Gmail" },
            { id: "outlook", label: "Outlook" },
            { id: "other", label: "Other" },
          ].map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => handleSelectSmtpProvider(provider.id)}
              style={{
                padding: "6px 12px",
                border: `1px solid ${smtpProvider === provider.id ? "#93c5fd" : "#d1d5db"}`,
                borderRadius: 999,
                background: smtpProvider === provider.id ? "#eff6ff" : "#fff",
                color: "#111827",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {provider.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
          {providerIndicator}
        </div>
        {selectedProviderMismatch ? (
          <div style={{ fontSize: 11, color: "#92400e", marginBottom: 12 }}>
            Fields do not match {smtpProvider === "gmail" ? "Gmail" : "Outlook"} defaults
          </div>
        ) : null}
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 12px", marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#111827", marginBottom: 6 }}>
            {selectedProviderHelp.title}
          </div>
          <div style={{ fontSize: 12, color: "#4b5563", lineHeight: 1.6 }}>
            {selectedProviderHelp.steps.map((step, index) => (
              <div key={step}>{index + 1}. {step}</div>
            ))}
            {selectedProviderHelp.settings.map((setting) => (
              <div key={setting} style={{ marginTop: 4 }}>{setting}</div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <button
            type="button"
            onClick={handleApplySmtpDefaults}
            disabled={smtpProvider === "other"}
            style={{ padding: "6px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
          >
            Apply Defaults
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          <label>
            <span style={labelStyle}>Sender Name</span>
            <input
              value={shopConfig?.sender_name ?? ""}
              onChange={(e) => setShopConfig?.((prev) => ({ ...prev, sender_name: e.target.value }))}
              placeholder="Your Shop Name"
              style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
            />
          </label>
          <label>
            <span style={labelStyle}>Email Address</span>
            <input
              value={shopConfig?.smtpEmailAddress ?? ""}
              onChange={(e) => setShopConfig?.((prev) => ({ ...prev, smtpEmailAddress: e.target.value }))}
              placeholder="you@example.com"
              style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
            />
          </label>
          <label>
            <span style={labelStyle}>SMTP Host</span>
            <input
              value={shopConfig?.smtpHost ?? ""}
              onChange={(e) => setShopConfig?.((prev) => ({ ...prev, smtpHost: e.target.value }))}
              placeholder={selectedProviderHelp.host}
              style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
            />
          </label>
          <label>
            <span style={labelStyle}>Port</span>
            <input
              value={shopConfig?.smtpPort ?? ""}
              onChange={(e) => setShopConfig?.((prev) => ({ ...prev, smtpPort: e.target.value }))}
              placeholder={selectedProviderHelp.port}
              style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
            />
          </label>
          <label>
            <span style={labelStyle}>Username</span>
            <input
              value={shopConfig?.smtpUsername ?? ""}
              onChange={(e) => setShopConfig?.((prev) => ({ ...prev, smtpUsername: e.target.value }))}
              placeholder={selectedProviderHelp.usernameHint}
              style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
            />
          </label>
          <label style={{ gridColumn: "1 / -1" }}>
            <span style={labelStyle}>Password (App Password)</span>
            <input
              type="password"
              value={shopConfig?.smtpPassword ?? ""}
              onChange={(e) => setShopConfig?.((prev) => ({ ...prev, smtpPassword: e.target.value }))}
              placeholder={selectedProviderHelp.passwordHint}
              style={{ ...inputStyle, width: "100%", maxWidth: "100%" }}
            />
          </label>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleTestSmtp}
            disabled={smtpState.testing}
            style={{ padding: "6px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
          >
            {smtpState.testing ? "Testing..." : "Test Sending Connection"}
          </button>
          {smtpState.message ? <div style={{ fontSize: 12, color: "#047857" }}>✔ Connection successful</div> : null}
          {smtpState.error ? <div style={{ fontSize: 12, color: "#b91c1c" }}>{smtpState.error}</div> : null}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: "#6b7280" }}>
          Some networks (work or public WiFi) may block email sending.
        </div>
      </div>
      ) : null}

      {activeEmailSubtab === "templates" ? (
      <>
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
                    rows={18}
                    style={{
                      ...inputStyle,
                      width: "100%",
                      maxWidth: "none",
                      minHeight: "420px",
                      height: "min(58vh, 680px)",
                      resize: "vertical",
                      fontFamily: "inherit",
                      lineHeight: 1.5,
                    }}
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
        marginTop: 4, maxWidth: "320px", padding: "8px 14px",
        border: "1px dashed #9ca3af", borderRadius: "6px",
        background: "none", color: "#6b7280", fontSize: "13px", cursor: "pointer",
      }}>+ Add Template</button>
      </>
      ) : null}

      {activeEmailSubtab === "storage" ? (
        <div style={{ background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "16px 18px" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 4 }}>Sent Mail Records</div>
          <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6, marginBottom: 16 }}>
            Spaila keeps sent email records so they appear in the Sent view and workspace conversation previews. After the period below, those sent records and Spaila's sent-copy folders are permanently deleted.
            <br />
            <span style={{ color: "#4b5563" }}>Order/customer folders and saved order conversation records are not changed.</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label style={{ fontSize: 13, color: "#374151", fontWeight: 500 }}>
              Keep sent mail records for
            </label>
            <input
              type="number"
              min="1"
              max="365"
              value={shopConfig?.sentMailRetentionDays ?? 30}
              onChange={(e) => {
                const val = Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 30));
                setShopConfig?.((prev) => ({ ...prev, sentMailRetentionDays: val }));
              }}
              style={{
                width: 64,
                padding: "5px 8px",
                border: "1px solid #d1d5db",
                borderRadius: 5,
                fontSize: 13,
                textAlign: "center",
              }}
            />
            <span style={{ fontSize: 13, color: "#374151" }}>days</span>
            <span
              title="Only Spaila's Sent view records and sent-copy folders are removed. Order/customer folders and saved order conversation records are not changed."
              style={{ fontSize: 13, color: "#9ca3af", cursor: "help", userSelect: "none" }}
            >
              ⓘ
            </span>
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: "#9ca3af" }}>
            Default: 30 days. Minimum: 1 day. Maximum: 365 days.
          </div>

          <div style={{ marginTop: 20, borderTop: "1px solid #e5e7eb", paddingTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 4 }}>Email Trash</div>
            <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6, marginBottom: 12 }}>
              Deleted emails are held in Trash so you can recover them before they're permanently removed from your email account.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <label style={{ fontSize: 13, color: "#374151", fontWeight: 500 }}>
                Keep deleted emails for
              </label>
              <input
                type="number"
                min="1"
                max="365"
                value={shopConfig?.trashRetentionDays ?? 30}
                onChange={(e) => {
                  const val = Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 30));
                  setShopConfig?.((prev) => ({ ...prev, trashRetentionDays: val }));
                }}
                style={{
                  width: 64,
                  padding: "5px 8px",
                  border: "1px solid #d1d5db",
                  borderRadius: 5,
                  fontSize: 13,
                  textAlign: "center",
                }}
              />
              <span style={{ fontSize: 13, color: "#374151" }}>days before permanent deletion</span>
              <span
                title="After this period, emails are permanently deleted from your email account via IMAP. Emails in each order folder are not affected."
                style={{ fontSize: 13, color: "#9ca3af", cursor: "help", userSelect: "none" }}
              >
                ⓘ
              </span>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: "#9ca3af" }}>
              Default: 30 days. Minimum: 1 day. Maximum: 365 days.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── DataTab ────────────────────────────────────────────────────────────── */
function DataTab({ shopConfig, setShopConfig }) {
  const setShop = (patch) => setShopConfig((p) => ({ ...p, ...patch }));
  const [workspaceState, setWorkspaceState] = React.useState(null);
  const [loadingCounts, setLoadingCounts] = React.useState(false);
  const [countError, setCountError] = React.useState("");

  async function pickOrderArchiveRoot() {
    const result = await window.parserApp?.pickFolder?.();
    if (result && !result.canceled && result.path) {
      setShop({ orderArchiveRoot: result.path });
    }
  }

  const loadWorkspaceInfo = React.useCallback(async () => {
    setLoadingCounts(true);
    try {
      const nextState = await window.parserApp?.getWorkspaceState?.({ bucket: "Inbox", relativePath: "" });
      setWorkspaceState(nextState || null);
      setCountError("");
    } catch (nextError) {
      setCountError(nextError.message || "Could not load data folder counts.");
    } finally {
      setLoadingCounts(false);
    }
  }, []);

  React.useEffect(() => {
    loadWorkspaceInfo();
  }, [loadWorkspaceInfo]);

  const getBucketCount = (key) => workspaceState?.buckets?.find((item) => item.key === key)?.count ?? 0;

  const sectionStyle = { marginBottom: "28px" };
  const headStyle    = { fontSize: "13px", fontWeight: 700, color: "#111", display: "block", marginBottom: "6px" };
  const mutedStyle   = { fontSize: "12px", color: "#6b7280", marginTop: "2px", marginBottom: "10px", lineHeight: 1.5 };
  const rowStyle     = { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" };
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
  const countCardStyle = {
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: "12px 14px",
    background: "#fff",
    maxWidth: 220,
  };

  return (
    <div style={{ padding: "4px 0" }}>

      <div style={{ ...sectionStyle, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <span style={headStyle}>Data folder counts</span>
          <p style={mutedStyle}>Archive and backup totals are informational and do not change order data.</p>
          {countError ? (
            <div style={{ fontSize: "12px", color: "#b91c1c", marginTop: "6px" }}>{countError}</div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={loadWorkspaceInfo}
          disabled={loadingCounts}
          style={{
            border: "1px solid #d1d5db",
            background: "#fff",
            color: "#374151",
            borderRadius: 8,
            padding: "6px 10px",
            cursor: loadingCounts ? "default" : "pointer",
            opacity: loadingCounts ? 0.7 : 1,
            fontSize: 12,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {loadingCounts ? "Refreshing..." : "Refresh Counts"}
        </button>
      </div>

      {/* Activity archive */}
      <div style={sectionStyle}>
        <span style={headStyle}>Auto-archive orders</span>
        <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
          Days of inactivity (last activity)
        </label>
        <input
          type="number"
          min={1}
          step={1}
          placeholder="Disabled"
          value={shopConfig.autoArchiveDays ?? ""}
          onChange={(e) => {
            const v = e.target.value.trim();
            setShop({ autoArchiveDays: v === "" ? null : Math.max(1, Number.parseInt(v, 10) || 1) });
          }}
          style={{ ...numInput, width: "160px", textAlign: "left", padding: "8px 11px", borderRadius: "6px" }}
          onFocus={(e) => (e.target.style.borderColor = "#2563eb")}
          onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
        />
        <p style={mutedStyle}>
          Leave empty to disable. When set, orders whose last activity is older than this many days are marked archived on load and about every hour. Message history is never removed.
        </p>
      </div>

      {/* Order folder archive root */}
      <div style={sectionStyle}>
        <span style={headStyle}>Archive folder</span>
        <p style={mutedStyle}>Choose where archived order folders are stored on your computer.</p>
        <div style={rowStyle}>
          <div style={pathBox} title={shopConfig.orderArchiveRoot || "Default: C:/Spaila/archive"}>
            {shopConfig.orderArchiveRoot || <span style={{ color: "#9ca3af", fontFamily: "inherit" }}>Default: C:/Spaila/archive</span>}
          </div>
          <button type="button" onClick={pickOrderArchiveRoot} style={browseBtn}>Browse…</button>
          {shopConfig.orderArchiveRoot ? (
            <button
              type="button"
              onClick={() => setShop({ orderArchiveRoot: "" })}
              style={{ ...browseBtn, color: "#64748b", textDecoration: "underline" }}
            >Use default</button>
          ) : null}
        </div>
        <p style={mutedStyle}>
          Archived order folders keep the year/month/name structure, for example <code style={{ background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>.../archive/2026/april/...</code>. Save settings to sync this path for the backend.
        </p>
        <div style={countCardStyle}>
          <div style={{ fontSize: 12, color: "#6b7280" }}>Archive folders</div>
          <div style={{ marginTop: 6, fontSize: 24, fontWeight: 800, color: "#111827" }}>{getBucketCount("Archive")}</div>
        </div>
      </div>

      <div style={sectionStyle}>
        <span style={headStyle}>Backup save location</span>
        <p style={mutedStyle}>Files saved with the backup/save button are written to this folder.</p>
        <div style={{ maxWidth: "480px" }}>
          <div style={{
            padding: "8px 11px",
            border: "1px solid #d1d5db", borderRadius: "6px",
            fontSize: "13px", color: "#111",
            background: "#f9fafb", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap",
            minWidth: 0,
          }}>
            {DEFAULT_SAVE_FOLDER}
          </div>
        </div>
        <div style={{ ...countCardStyle, marginTop: "12px" }}>
          <div style={{ fontSize: 12, color: "#6b7280" }}>Backup files</div>
          <div style={{ marginTop: 6, fontSize: 24, fontWeight: 800, color: "#111827" }}>{getBucketCount("Backup")}</div>
        </div>
      </div>

      <div style={sectionStyle}>
        <span style={headStyle}>Restore from backup</span>
        <p style={mutedStyle}>
          Select a <code style={{ background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>.spailabackup</code> file
          to fully restore all orders and settings. The app will reload automatically.
          <span style={{ color: "#ef4444", fontWeight: 600 }}> This will overwrite your current data.</span>
        </p>
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
          Restore from Backup...
        </button>
      </div>

    </div>
  );
}

/* ── Printing tab ────────────────────────────────────────────────────────── */
function PrintingTab({ columns, config, setConfig }) {
  const rowStyle = { display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" };
  const checkStyle = { width: "15px", height: "15px", cursor: "pointer", accentColor: "#2563eb" };
  const labelStyle = { fontSize: "13px", color: "#374151", cursor: "pointer" };
  const isCardMode = (config.mode || "sheet") === "card";
  const orderedColumns = React.useMemo(() => {
    if (!isCardMode) {
      return columns;
    }
    const byKey = new Map(columns.map((column) => [column.key, column]));
    const seen = new Set();
    const orderedKeys = Array.isArray(config?.cardOrder)
      ? config.cardOrder.filter((key) => {
          if (!byKey.has(key) || seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
      : [];
    return [
      ...orderedKeys.map((key) => byKey.get(key)),
      ...columns.filter((column) => !seen.has(column.key)),
    ];
  }, [columns, config?.cardOrder, isCardMode]);

  function setVisible(key, value) {
    setConfig((prev) => ({
      ...prev,
      columns: { ...(prev?.columns || {}), [key]: value },
    }));
  }

  function setWrap(key, value) {
    setConfig((prev) => ({
      ...prev,
      wrap: { ...(prev?.wrap || {}), [key]: value },
    }));
  }

  function setMode(value) {
    setConfig((prev) => ({
      ...prev,
      mode: value === "card" ? "card" : "sheet",
    }));
  }

  function moveCardField(key, direction) {
    setConfig((prev) => {
      const availableKeys = columns.map((column) => column.key);
      const available = new Set(availableKeys);
      const seen = new Set();
      const order = [
        ...(Array.isArray(prev?.cardOrder) ? prev.cardOrder : []),
        ...availableKeys,
      ].filter((candidate) => {
        if (!available.has(candidate) || seen.has(candidate)) {
          return false;
        }
        seen.add(candidate);
        return true;
      });
      const index = order.indexOf(key);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= order.length) {
        return prev;
      }
      const nextOrder = [...order];
      [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
      return {
        ...prev,
        cardOrder: nextOrder,
      };
    });
  }

  return (
    <div>
      <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "4px" }}>
        Printing Fields
      </div>
      <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "18px", lineHeight: 1.6 }}>
        Choose which columns from the Orders sheet should be included in PDFs and printouts.
        Only fields currently visible on the Orders sheet appear here.
      </div>

      <div style={{ marginBottom: "22px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#111", marginBottom: "10px" }}>
          Print format
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          {[
            { value: "sheet", label: "Orders sheet", desc: "Print the current filtered Orders sheet as rows." },
            { value: "card", label: "Order cards", desc: "Print filtered orders as cards. Large field sets automatically print one card per page." },
          ].map((option) => (
            <label
              key={option.value}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                padding: "10px 12px",
                border: "1px solid",
                borderColor: (config.mode || "sheet") === option.value ? "#2563eb" : "#e5e7eb",
                borderRadius: "7px",
                cursor: "pointer",
                background: (config.mode || "sheet") === option.value ? "#eff6ff" : "#fff",
              }}
            >
              <input
                type="radio"
                name="printMode"
                value={option.value}
                checked={(config.mode || "sheet") === option.value}
                onChange={() => setMode(option.value)}
                style={{ marginTop: "2px", accentColor: "#2563eb" }}
              />
              <div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#111" }}>{option.label}</div>
                <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "2px" }}>{option.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "22px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#111", marginBottom: "10px" }}>
          Page orientation
        </div>
        <div style={{ display: "flex", gap: "10px" }}>
          {[
            { value: "portrait", label: "Portrait", desc: "Best for shorter field sets." },
            { value: "landscape", label: "Landscape", desc: "Wider layout for more columns." },
          ].map((option) => (
            <label
              key={option.value}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "flex-start",
                gap: "8px",
                padding: "10px 12px",
                border: "1px solid",
                borderColor: config.orientation === option.value ? "#2563eb" : "#e5e7eb",
                borderRadius: "7px",
                cursor: "pointer",
                background: config.orientation === option.value ? "#eff6ff" : "#fff",
              }}
            >
              <input
                type="radio"
                name="printOrientation"
                value={option.value}
                checked={config.orientation === option.value}
                onChange={() => setConfig((prev) => ({ ...prev, orientation: option.value }))}
                style={{ marginTop: "2px", accentColor: "#2563eb" }}
              />
              <div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#111" }}>{option.label}</div>
                <div style={{ fontSize: "11px", color: "#6b7280", marginTop: "2px" }}>{option.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div style={{
        border: "1px solid #e5e7eb",
        borderRadius: "8px",
        overflow: "hidden",
        background: "#fff",
      }}>
        <div style={{
          display: "grid",
          gridTemplateColumns: isCardMode ? "1fr 90px 130px 120px" : "1fr 90px 130px",
          gap: "0 12px",
          padding: "8px 12px",
          background: "#f3f4f6",
          borderBottom: "1px solid #e5e7eb",
          fontSize: "11px",
          fontWeight: 700,
          color: "#6b7280",
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          alignItems: "center",
        }}>
          <span>Display name</span>
          <span style={{ textAlign: "center" }}>Print</span>
          <span style={{ textAlign: "center" }}>Wrap if needed</span>
          {isCardMode && <span style={{ textAlign: "center" }}>Card order</span>}
        </div>

        {columns.length === 0 ? (
          <div style={{ padding: "16px 12px", fontSize: "13px", color: "#6b7280" }}>
            No Orders sheet fields are currently visible.
          </div>
        ) : orderedColumns.map((column, index) => {
          const id = `print_${column.key}`;
          const wrapId = `print_wrap_${column.key}`;
          const isVisible = config?.columns?.[column.key] !== false;
          const shouldWrap = !!config?.wrap?.[column.key];
          return (
            <div
              key={column.key}
              style={{
                display: "grid",
                gridTemplateColumns: isCardMode ? "1fr 90px 130px 120px" : "1fr 90px 130px",
                gap: "0 12px",
                padding: "10px 12px",
                alignItems: "center",
                background: index % 2 === 0 ? "#fff" : "#fafafa",
                borderBottom: index < orderedColumns.length - 1 ? "1px solid #f3f4f6" : "none",
              }}
            >
              <label htmlFor={id} style={labelStyle}>{column.label}</label>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <div style={rowStyle}>
                  <input
                    id={id}
                    type="checkbox"
                    style={checkStyle}
                    checked={isVisible}
                    onChange={(e) => setVisible(column.key, e.target.checked)}
                  />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <div style={rowStyle}>
                  <input
                    id={wrapId}
                    type="checkbox"
                    style={checkStyle}
                    checked={shouldWrap}
                    onChange={(e) => setWrap(column.key, e.target.checked)}
                  />
                </div>
              </div>
              {isCardMode && (
                <div style={{ display: "flex", justifyContent: "center", gap: "4px" }}>
                  <button
                    type="button"
                    onClick={() => moveCardField(column.key, -1)}
                    disabled={index === 0}
                    style={{
                      border: "1px solid #d1d5db",
                      borderRadius: "5px",
                      background: index === 0 ? "#f3f4f6" : "#fff",
                      color: index === 0 ? "#9ca3af" : "#374151",
                      cursor: index === 0 ? "default" : "pointer",
                      padding: "3px 8px",
                      fontSize: "12px",
                      fontWeight: 700,
                    }}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    onClick={() => moveCardField(column.key, 1)}
                    disabled={index === orderedColumns.length - 1}
                    style={{
                      border: "1px solid #d1d5db",
                      borderRadius: "5px",
                      background: index === orderedColumns.length - 1 ? "#f3f4f6" : "#fff",
                      color: index === orderedColumns.length - 1 ? "#9ca3af" : "#374151",
                      cursor: index === orderedColumns.length - 1 ? "default" : "pointer",
                      padding: "3px 8px",
                      fontSize: "12px",
                      fontWeight: 700,
                    }}
                  >
                    Down
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Documents tab ──────────────────────────────────────────────────────── */
function DocumentsTab({ config, setConfig }) {
  async function pickFile(field, nameField, title, filters) {
    const result = await window.parserApp?.pickFile?.({ title, filters });
    if (!result || result.canceled) return;
    const copied = await window.parserApp?.copyDocumentToDocs?.({ filePath: result.path });
    if (!copied?.ok) {
      alert(`Could not save document to C:\\Spaila\\Docs: ${copied?.error || "unknown error"}`);
      return;
    }
    setConfig((prev) => ({ ...prev, [field]: copied.path, [nameField]: copied.name }));
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
        Docs
      </div>
      <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "18px", lineHeight: 1.6 }}>
        Selected PDFs are copied into <code style={{ background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>C:\Spaila\Docs</code>. Spaila always uses the saved copy from that folder.
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

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 240px))", gap: "12px 20px" }}>
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
                  maxWidth: "240px",
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
        Only PDF files are supported. After selection, Spaila stores and uses the copied file in C:\Spaila\Docs.
      </div>
    </div>
  );
}

const LEARNING_FIELDS = [
  { key: "shipping_address", label: "Shipping Address" },
  { key: "buyer_name", label: "Buyer Name" },
  { key: "buyer_email", label: "Buyer Email" },
  { key: "price", label: "Price" },
  { key: "quantity", label: "Quantity" },
  { key: "order_date", label: "Order Date" },
  { key: "ship_by", label: "Ship By" },
];

function LearningTab() {
  const [summary, setSummary] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [resettingField, setResettingField] = React.useState("");
  const [error, setError] = React.useState("");
  const [lastReset, setLastReset] = React.useState(null);

  const loadLearningSummary = React.useCallback(async () => {
    setLoading(true);
    try {
      const nextSummary = await window.parserApp?.getLearningSummary?.();
      setSummary(nextSummary || null);
      setError("");
    } catch (nextError) {
      setError(nextError.message || "Could not load learning details.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadLearningSummary();
  }, [loadLearningSummary]);

  const handleResetField = async (field) => {
    const fieldInfo = LEARNING_FIELDS.find((item) => item.key === field);
    const label = fieldInfo?.label || field;
    const confirmed = window.confirm(
      `Reset learning for ${label}?\nThis will clear learned corrections for this field only.`
    );
    if (!confirmed) {
      return;
    }
    setResettingField(field);
    setError("");
    try {
      const result = await window.parserApp?.resetFieldLearning?.({ field });
      setLastReset(result || { field });
      await loadLearningSummary();
    } catch (nextError) {
      setError(nextError.message || `Could not reset ${label} learning.`);
    } finally {
      setResettingField("");
    }
  };

  const summaryByField = Object.fromEntries((summary?.fields || []).map((item) => [item.field, item]));

  return (
    <div>
      <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: 4 }}>
        Learning
      </div>
      <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: 16, lineHeight: 1.6 }}>
        Review learned corrections by field. Resetting is scoped to one field and does not affect other learning.
      </div>
      <div style={{ border: "1px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>Field Learning</div>
            <div style={{ marginTop: 3, fontSize: 12, color: "#6b7280" }}>
              Manual assignments take priority over matching rejections.
            </div>
          </div>
          <button
            type="button"
            onClick={loadLearningSummary}
            disabled={loading}
            style={{
              border: "1px solid #d1d5db",
              background: "#fff",
              color: "#374151",
              borderRadius: 8,
              padding: "6px 10px",
              cursor: loading ? "default" : "pointer",
              opacity: loading ? 0.7 : 1,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        {error ? (
          <div style={{ marginBottom: 12, fontSize: 12, color: "#b91c1c" }}>{error}</div>
        ) : null}
        {lastReset ? (
          <div style={{ marginBottom: 12, fontSize: 12, color: "#166534" }}>
            Reset complete for {LEARNING_FIELDS.find((item) => item.key === lastReset.field)?.label || lastReset.field}.
          </div>
        ) : null}
        <div style={{ display: "grid", gap: 10 }}>
          {LEARNING_FIELDS.map((fieldInfo) => {
            const item = summaryByField[fieldInfo.key] || {};
            const confidence = item.confidence || {};
            const confidenceText = confidence.entries
              ? `${confidence.promoted ? "Promoted" : "Tracking"} (${confidence.max_streak || 0}/4)`
              : "None";
            const isResetting = resettingField === fieldInfo.key;
            return (
              <div
                key={fieldInfo.key}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(150px, 1.2fr) repeat(3, minmax(110px, 0.8fr)) auto",
                  alignItems: "center",
                  gap: 10,
                  border: "1px solid #e5e7eb",
                  borderRadius: 10,
                  padding: 12,
                  background: "#fff",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111827" }}>{fieldInfo.label}</div>
                <div style={{ fontSize: 12, color: "#4b5563" }}>
                  Assignments: <strong>{item.assignments || 0}</strong>
                </div>
                <div style={{ fontSize: 12, color: "#4b5563" }}>
                  Active rejections: <strong>{item.active_rejections || 0}</strong>
                </div>
                <div style={{ fontSize: 12, color: "#4b5563" }}>
                  Confidence: <strong>{confidenceText}</strong>
                </div>
                <button
                  type="button"
                  onClick={() => handleResetField(fieldInfo.key)}
                  disabled={Boolean(resettingField)}
                  style={{
                    border: "1px solid #fecaca",
                    background: "#fff7f7",
                    color: "#991b1b",
                    borderRadius: 8,
                    padding: "6px 10px",
                    cursor: resettingField ? "default" : "pointer",
                    opacity: resettingField && !isResetting ? 0.55 : 1,
                    fontSize: 12,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {isResetting ? "Resetting..." : "Reset Field Learning"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── main component ─────────────────────────────────────────────────────── */
export default function SettingsPage({ onOrders, onWorkspace, onSettings, initialTab = "orders", ordersTab, onOrdersTabChange, columnOrder: externalColumnOrder, onColumnOrderChange }) {
  const [activeTab, setActiveTab] = React.useState(initialTab === "archive" ? "data" : initialTab || "orders");
  const [fields, setFields] = React.useState(() => loadFieldConfig());
  const [localOrder, setLocalOrder] = React.useState(() => externalColumnOrder ? [...externalColumnOrder] : defaultColumnOrder());
  const [localParserOrder, setLocalParserOrder] = React.useState(() => loadParserFieldOrder());
  const [localPriceList, setLocalPriceList] = React.useState(() => loadPriceList());
  const [localStatusConfig, setLocalStatusConfig] = React.useState(() => loadStatusConfig());
  const [localViewConfig, setLocalViewConfig] = React.useState(() => loadViewConfig());
  const [localDateConfig, setLocalDateConfig] = React.useState(() => loadDateConfig());
  const [localEmailTemplates, setLocalEmailTemplates] = React.useState(() => loadEmailTemplates());
  const [localShopConfig, setLocalShopConfig] = React.useState(() => loadShopConfig());
  const [localDocumentsConfig, setLocalDocumentsConfig] = React.useState(() => loadDocumentsConfig());
  const [localPrintConfig, setLocalPrintConfig] = React.useState(() => loadPrintConfig());
  const [activeEmailSubtab, setActiveEmailSubtab] = React.useState("sending");
  const [saveFeedback, setSaveFeedback] = React.useState(false);
  const saveFeedbackTimerRef = React.useRef(null);

  React.useEffect(() => {
    setActiveTab(initialTab === "archive" ? "data" : initialTab || "orders");
  }, [initialTab]);

  React.useEffect(() => {
    return () => {
      if (saveFeedbackTimerRef.current) {
        window.clearTimeout(saveFeedbackTimerRef.current);
      }
    };
  }, []);

  function handleSave() {
    if (saveFeedbackTimerRef.current) {
      window.clearTimeout(saveFeedbackTimerRef.current);
    }
    saveShopConfig(localShopConfig);
    saveDocumentsConfig(localDocumentsConfig);
    savePrintConfig(localPrintConfig);
    saveFieldConfig(fields);
    saveColumnOrder(localOrder);
    if (onColumnOrderChange) onColumnOrderChange(localOrder);
    saveParserFieldOrder(localParserOrder);
    savePriceList(localPriceList);
    saveStatusConfig(localStatusConfig);
    saveViewConfig(localViewConfig);
    saveDateConfig(localDateConfig);
    saveEmailTemplates(localEmailTemplates);
    setSaveFeedback(true);
    saveFeedbackTimerRef.current = window.setTimeout(() => {
      setSaveFeedback(false);
      onOrders?.();
    }, 650);
  }

  async function pickShopLogo() {
    const result = await window.parserApp?.pickFile?.({
      title: "Select Shop Logo",
      filters: [
        { name: "Image Files", extensions: ["png", "jpg", "jpeg", "webp"] },
      ],
    });
    if (!result || result.canceled) return;
    const copied = await window.parserApp?.copyDocumentToDocs?.({
      filePath: result.path,
      allowedExtensions: ["png", "jpg", "jpeg", "webp"],
    });
    if (!copied?.ok) {
      alert(`Could not save logo to C:\\Spaila\\Docs: ${copied?.error || "unknown error"}`);
      return;
    }
    setLocalShopConfig((prev) => ({
      ...prev,
      shopLogoPath: copied.path,
      shopLogoName: copied.name,
    }));
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

  const printingColumns = React.useMemo(() => {
    const fieldMap = Object.fromEntries(fields.map((field) => [field.key, field]));
    return localOrder.flatMap((key) => {
      if (key === "status") {
        return localStatusConfig.enabled
          ? [{ key, label: localStatusConfig.columnLabel || "Status" }]
          : [];
      }
      if (key === "order_info") {
        return [{ key, label: "Order Info" }];
      }
      const field = fieldMap[key];
      if (!field?.visibleInOrders) {
        return [];
      }
      return [{ key, label: field.label || key }];
    });
  }, [fields, localOrder, localStatusConfig]);

  const useWideSettingsContent = false;
  const useExpandedMainContent = activeTab === "emails";
  const contentShellStyle = {
    display: "flex",
    alignItems: "flex-start",
    gap: "32px",
    minWidth: 0,
  };
  const mainColumnStyle = {
    flex: useExpandedMainContent ? "1 1 auto" : "0 1 860px",
    maxWidth: useExpandedMainContent ? "none" : "860px",
    width: useExpandedMainContent ? "100%" : undefined,
    minWidth: 0,
  };
  const helperPanelStyle = {
    flex: "0 0 340px",
    width: "340px",
    minWidth: "340px",
    position: "sticky",
    top: 0,
    alignSelf: "flex-start",
  };
  const helperCardStyle = {
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    background: "#f9fafb",
    padding: "18px 18px 16px",
  };
  const sidebarLogoSrc = localFileSrc(localShopConfig.shopLogoPath);

  return (
    <div style={{
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "#f3f4f6",
      overflow: "hidden",
    }}>
      <AppHeader
        canSave={false}
        saveTitle="Nothing to save yet"
        onSettings={onSettings}
        onWorkspace={onWorkspace}
        documentsConfig={localDocumentsConfig}
        activeTab={ordersTab}
        selectedNav="settings"
        showCompletedTab={localViewConfig.showCompleted !== false}
        onSelectTab={(nextTab) => {
          onOrdersTabChange?.(nextTab);
          onOrders?.(nextTab);
        }}
        showCounts={false}
      />

      <div style={{ flex: 1, minHeight: 0, padding: "20px 24px 24px" }}>
        <div style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: "14px",
          overflow: "hidden",
          boxShadow: "0 8px 24px rgba(15, 23, 42, 0.04)",
        }}>
          {/* Body */}
          <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>

            {/* Sidebar */}
            <div style={{
              width: "210px",
              borderRight: "1px solid #e5e7eb",
              background: "#f9fafb",
              padding: "18px 0",
              flexShrink: 0,
            }}>
              <div style={{
                padding: "0 18px 12px",
                fontSize: "11px",
                fontWeight: 700,
                color: "#9ca3af",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}>
                Settings
              </div>
              {TABS.map((tab, index) => (
                tab.kind === "divider" ? (
                  <div
                    key={`divider-${tab.label}-${index}`}
                    style={{
                      margin: "14px 18px 6px",
                      paddingTop: "12px",
                      borderTop: "1px solid #e5e7eb",
                      fontSize: "10px",
                      fontWeight: 700,
                      color: "#94a3b8",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    }}
                  >
                    {tab.label}
                  </div>
                ) : (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    style={{
                      display: "flex", width: "100%", textAlign: "left",
                      alignItems: "center", gap: "9px",
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
                    {tab.id === "account" ? (
                      <span
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          border: "1px solid #e2e8f0",
                          background: sidebarLogoSrc ? "#fff" : "#e5e7eb",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                          flexShrink: 0,
                        }}
                        title={localShopConfig.shopLogoName || localShopConfig.shopLogoPath || "Shop logo"}
                      >
                        {sidebarLogoSrc ? (
                          <img
                            src={sidebarLogoSrc}
                            alt=""
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <span style={{ fontSize: "11px", fontWeight: 700, color: "#94a3b8" }}>
                            {String(localShopConfig.shopName || "S").trim().slice(0, 1).toUpperCase() || "S"}
                          </span>
                        )}
                      </span>
                    ) : null}
                    <span>{tab.label}</span>
                  </button>
                )
              ))}
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflow: "auto", padding: "22px 26px 80px" }}>
              <div style={contentShellStyle}>
                <div style={mainColumnStyle}>

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
                      maxWidth: "500px",
                      minWidth: "320px",
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

                <div style={{ marginBottom: "24px" }}>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "6px" }}>
                    Shop logo
                  </label>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", maxWidth: "620px" }}>
                    <div
                      title={localShopConfig.shopLogoPath || "No logo selected"}
                      style={{
                        flex: "1 1 260px",
                        minWidth: 0,
                        padding: "8px 11px",
                        border: "1px solid #d1d5db",
                        borderRadius: "6px",
                        fontSize: "13px",
                        color: localShopConfig.shopLogoName ? "#111" : "#9ca3af",
                        background: "#f9fafb",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontStyle: localShopConfig.shopLogoName ? "normal" : "italic",
                      }}
                    >
                      {localShopConfig.shopLogoName || "No logo selected"}
                    </div>
                    <button
                      type="button"
                      onClick={pickShopLogo}
                      style={{
                        padding: "8px 14px",
                        border: "1px solid #cbd5e1",
                        borderRadius: "6px",
                        background: "#fff",
                        cursor: "pointer",
                        fontSize: "13px",
                        fontWeight: 600,
                        color: "#1e293b",
                      }}
                    >Browse...</button>
                    {localShopConfig.shopLogoPath ? (
                      <button
                        type="button"
                        onClick={() => setLocalShopConfig((prev) => ({ ...prev, shopLogoPath: "", shopLogoName: "" }))}
                        style={{
                          padding: "8px 12px",
                          border: "none",
                          borderRadius: "6px",
                          background: "transparent",
                          cursor: "pointer",
                          fontSize: "13px",
                          color: "#64748b",
                          textDecoration: "underline",
                        }}
                      >Remove</button>
                    ) : null}
                  </div>
                  {localShopConfig.shopLogoPath ? (
                    <div style={{ marginTop: "6px", fontSize: "11px", color: "#9ca3af", wordBreak: "break-all" }}>
                      {localShopConfig.shopLogoPath}
                    </div>
                  ) : null}
                  <div style={{ marginTop: "6px", fontSize: "12px", color: "#9ca3af", maxWidth: "620px", lineHeight: 1.55 }}>
                    Selected logos are copied into <code style={{ background: "#f1f5f9", padding: "1px 5px", borderRadius: 4, fontSize: 11 }}>C:\Spaila\Docs</code>. Spaila stores and uses the copied file. A transparent .png logo usually looks best.
                  </div>
                </div>

                <div style={{ marginTop: "28px" }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "10px" }}>
                    App visibility
                  </div>
                  <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "12px", lineHeight: 1.55, maxWidth: "560px" }}>
                    Control which order views appear during normal daily use.
                  </div>
                  {[
                    {
                      key: "showCompleted",
                      label: "Show completed orders",
                      desc: "Show the Completed tab in the main navigation.",
                    },
                    {
                      key: "showInventoryTab",
                      label: 'Show "Inventory Needed" tab',
                      desc: "Show a separate tab for orders missing personalization or production details.",
                    },
                  ].map((option) => {
                    const id = `general_${option.key}`;
                    return (
                      <div key={option.key} style={{ marginBottom: "12px" }}>
                        <label htmlFor={id} style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                          <input
                            id={id}
                            type="checkbox"
                            checked={!!localViewConfig[option.key]}
                            onChange={(e) => setLocalViewConfig((prev) => ({ ...prev, [option.key]: e.target.checked }))}
                            style={{ width: "15px", height: "15px", cursor: "pointer", accentColor: "#2563eb" }}
                          />
                          <span style={{ fontSize: "13px", color: "#374151" }}>{option.label}</span>
                        </label>
                        <div style={{ marginLeft: "23px", marginTop: "3px", fontSize: "11px", color: "#9ca3af", lineHeight: 1.4 }}>
                          {option.desc}
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ marginBottom: "12px" }}>
                    <label htmlFor="general_showThankYouHeaderBtn" style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                      <input
                        id="general_showThankYouHeaderBtn"
                        type="checkbox"
                        checked={localDocumentsConfig.showThankYouHeaderBtn !== false}
                        onChange={(e) => setLocalDocumentsConfig((prev) => ({ ...prev, showThankYouHeaderBtn: e.target.checked }))}
                        style={{ width: "15px", height: "15px", cursor: "pointer", accentColor: "#2563eb" }}
                      />
                      <span style={{ fontSize: "13px", color: "#374151" }}>Show thank-you letter shortcut</span>
                    </label>
                    <div style={{ marginLeft: "23px", marginTop: "3px", fontSize: "11px", color: "#9ca3af", lineHeight: 1.4 }}>
                      Show the header button that opens the saved thank-you letter for printing.
                    </div>
                  </div>
                </div>

              </div>
            )}

            {activeTab === "account" && (
              <div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "8px" }}>
                  Account
                </div>
                <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "18px", lineHeight: 1.6, maxWidth: "620px" }}>
                  This placeholder is reserved for user profile, account, subscription, unsubscribe, and account-management settings.
                </div>
                <div style={{ border: "1px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "18px 20px", maxWidth: "640px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Coming soon</div>
                  <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
                    Future account tools can live here, including profile details, subscription status, billing links, unsubscribe controls, account email, and license/account health.
                  </div>
                </div>
              </div>
            )}

            {activeTab === "helper" && (
              <div>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "8px" }}>
                  Helper
                </div>
                <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "18px", lineHeight: 1.6, maxWidth: "620px" }}>
                  This placeholder is reserved for helper-specific settings and preferences.
                </div>
                <div style={{ border: "1px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "18px 20px", maxWidth: "640px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 6 }}>Coming soon</div>
                  <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>
                    Future helper options can live here, such as assistant behavior, guided workflows, help visibility, automation preferences, and support-related settings.
                  </div>
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

            {activeTab === "data" && (
              <DataTab
                shopConfig={localShopConfig}
                setShopConfig={setLocalShopConfig}
              />
            )}

            {activeTab === "emails" && (
              <EmailsTab
                templates={localEmailTemplates}
                setTemplates={setLocalEmailTemplates}
                labelMap={Object.fromEntries(fields.map((f) => [f.key, f.label]))}
                shopConfig={localShopConfig}
                setShopConfig={setLocalShopConfig}
                activeEmailSubtab={activeEmailSubtab}
                setActiveEmailSubtab={setActiveEmailSubtab}
              />
            )}

            {activeTab === "documents" && (
              <DocumentsTab
                config={localDocumentsConfig}
                setConfig={setLocalDocumentsConfig}
              />
            )}

            {activeTab === "printing" && (
              <PrintingTab
                columns={printingColumns}
                config={localPrintConfig}
                setConfig={setLocalPrintConfig}
              />
            )}

            {activeTab === "learning" && (
              <LearningTab />
            )}

            {activeTab === "parser" && (
              <>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "4px" }}>
                  <div style={{ fontSize: "15px", fontWeight: 700, color: "#111" }}>
                    Order Processing Fields
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
                  Choose which details Spaila shows while converting emails into orders, and set the order they appear in.
                  Renaming also updates matching labels elsewhere in the app.
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

                {!useWideSettingsContent ? (
                <aside style={helperPanelStyle}>
                  <div style={helperCardStyle}>
                    <div style={{ fontSize: "12px", fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "10px" }}>
                      {activeTab === "printing" ? "Printing Help" : activeTab === "orders" ? "Orders Help" : activeTab === "emails" ? "Email Help" : activeTab === "status" ? "Status Help" : activeTab === "pricing" ? "Pricing Help" : activeTab === "view" ? "Search / Sort Help" : activeTab === "dates" ? "Dates Help" : activeTab === "data" ? "Data Help" : activeTab === "documents" ? "Docs Help" : activeTab === "learning" ? "Learning Help" : activeTab === "account" ? "Account Help" : activeTab === "helper" ? "Helper Help" : activeTab === "general" ? "General Help" : activeTab === "parser" ? "Order Processing Help" : "Reserved Panel"}
                    </div>
                    {activeTab === "printing" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Printing orders
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          Choose <strong>Orders sheet</strong> to print the current searched/filtered order rows as a table. This keeps the sheet column order, wrapping, and cell colors.
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "10px" }}>
                          Choose <strong>Order cards</strong> to print the same searched/filtered orders as packing-style cards. Cards do not use cell colors; the order number/name pill uses the pricing color from Settings → Pricing.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Field selection
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Use <strong>Print</strong> to include or remove fields from both print modes. Use <strong>Wrap if needed</strong> for sheet columns that should break onto multiple lines.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Card mode
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            When Order cards is selected, use <strong>Up</strong> and <strong>Down</strong> to set the card field order. Portrait prints two stacked cards per page; landscape prints left and right cards.
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "8px" }}>
                            If too many fields are selected to fit cleanly, Spaila automatically switches cards to one order per page.
                          </div>
                        </div>
                      </>
                    ) : activeTab === "orders" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Orders sheet layout
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          This tab controls the columns shown on the main Orders sheet. Use the eye button to show or hide a field, and rename fields here when you want the label updated across the app.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Column order
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Use the up/down controls here, or drag columns directly in the Orders sheet header. <strong>Reset to Default Layout</strong> restores the standard order.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Colors and highlights
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Palette coloring uses your Settings → Pricing rules to tint enabled fields. Highlight color is field-specific and can be used for important columns that should stand out.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Status and Order Info
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            The Status column can be enabled and renamed here. Order Info is a computed column for badges like platform, gift, messages, and multi-item orders.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so the Orders sheet, Printing tab, and related views use the updated layout.
                        </div>
                      </>
                    ) : activeTab === "status" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Order statuses
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          Statuses help you track where each order is in your workflow, such as new, in progress, ready to ship, or completed.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Show the status column
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Turn the status column on when you want a status badge on the Orders sheet. The column label is the header users will see.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Create useful states
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Add only the states you actually use day to day. Short labels work best because they display as compact badges.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Colors and order
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Choose colors that are easy to scan. Use the arrows to put your most common statuses first in the order picker.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so the Orders sheet uses your updated statuses.
                        </div>
                      </>
                    ) : activeTab === "pricing" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Price-based order types
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          Pricing rules let Spaila identify an order type from the order price. When a price matches, Spaila fills the <strong>Type</strong> field and uses the selected color in the Orders sheet.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Price rules
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Enter the price point you want to match, then enter the Type value that should appear for orders with that price.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Multiple order types
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Add as many rows as needed for different prices or product types. Use <strong>Duplicate</strong> when a new rule should start from an existing price, type, or color.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Colors
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Choose colors that make order types easy to scan. These colors can also be used by print cards for the order header pill.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so new and refreshed orders use the updated pricing rules.
                        </div>
                      </>
                    ) : activeTab === "view" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Search and sort behavior
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          These settings control how the Orders sheet searches, sorts, and shows extra workflow views.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Searchable fields
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Turn on the fields users actually search by, such as order number, buyer, dates, or shipping details. Fewer fields can make search results cleaner.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Smart vs exact
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            <strong>Smart</strong> is best for everyday searching because partial text can match. <strong>Exact</strong> is stricter and works best when users search complete values.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Default sort
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Pick the field and direction the Orders sheet should use when it opens or refreshes. Date descending usually keeps newer orders near the top.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so the Orders sheet uses the updated search and sort behavior.
                        </div>
                      </>
                    ) : activeTab === "dates" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Date display
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          Date settings control how order dates and ship-by dates appear in the Orders sheet and related views.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Choose a format
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            <strong>Short</strong> is easiest to read, <strong>Numeric</strong> is compact, and <strong>ISO</strong> is best when you want sortable year-month-day style dates.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Showing the year
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Turn on <strong>Always show year</strong> when you work across multiple years or want printed sheets to be unambiguous.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Searching dates
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            <strong>Match multiple date formats in search</strong> lets users type dates naturally, like "apr 13", even if the table displays dates in another format.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Preview before saving
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Use the preview examples to confirm the format looks right before saving.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so order dates use the updated display settings.
                        </div>
                      </>
                    ) : activeTab === "data" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Data settings
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          Data settings control archive behavior, backup save location, restore tools, and archive/backup folder counts.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Auto-archive orders
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            <strong>Days of inactivity</strong> archives orders whose messages or edits have been quiet for that many days. Leave it blank to disable this rule.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Archive folder
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Pick where archived order folders should live. Archived folders keep the year, month, and order-name structure so they remain easy to browse later.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Backup and restore
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            The backup save location shows where backup files are written. The Backup count card shows how many backup files are currently stored. Use restore only when you intend to replace current orders and settings with a backup file.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Folder counts
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Archive and Backup counts are informational. Use <strong>Refresh Counts</strong> when you want to recheck what is currently stored on disk.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so archive settings and data paths are stored.
                        </div>
                      </>
                    ) : activeTab === "documents" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Document templates
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          Docs settings connect Spaila to the PDF files you use for printed customer documents. Selected PDFs are copied into <strong>C:\Spaila\Docs</strong> so Spaila uses its own saved copy.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Gift messages
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Upload a PDF letterhead for gift-message orders. When an order has a gift message, Spaila can print that message on this letterhead.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Print placement
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Use the X, Y, width, font size, and color controls to position gift-message text on the PDF. Coordinates are measured in points from the bottom-left of the page.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Thank you letter
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Upload the standard thank-you PDF used for packing inserts. The header shortcut can be shown or hidden from Settings → General.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Saved document copies
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Spaila stores the copied file paths under <strong>C:\Spaila\Docs</strong>. Moving or deleting the original file you selected later will not break Spaila's document settings.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so document paths and display options are stored.
                        </div>
                      </>
                    ) : activeTab === "account" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Account placeholder
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          This section is reserved for user profile and account-management features.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Future profile details
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            User name, business contact details, account email, and profile preferences can be added here later.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Future subscription tools
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Subscription status, plan details, unsubscribe controls, billing links, and license health can live in this tab when available.
                          </div>
                        </div>
                      </>
                    ) : activeTab === "helper" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Helper placeholder
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          This section is reserved for settings that control Spaila helper behavior.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Future helper preferences
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Guided workflow settings, help visibility, assistant prompts, automation preferences, and support tools can be added here.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          This placeholder does not change current Spaila behavior yet.
                        </div>
                      </>
                    ) : activeTab === "general" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          General app settings
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          General settings control shop identity, shop logo, and app visibility.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Shop identity
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Shop name is used in the app header and window title so users know which workspace they are working in.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Shop logo
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Upload a PNG, JPG, or WebP logo. A transparent .png usually looks best because it blends cleanly into Spaila screens and printed layouts. Spaila copies the selected file into <strong>C:\Spaila\Docs</strong> and stores that copied path for future use.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            App visibility
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Use these toggles to decide whether completed orders, the Inventory Needed workflow tab, and the thank-you letter shortcut appear during normal daily use.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so general app behavior uses the updated settings.
                        </div>
                      </>
                    ) : activeTab === "emails" ? (
                      <>
                        {activeEmailSubtab === "sending" ? (
                          <>
                            <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                              Send and receive setup
                            </div>
                            <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                              Use this tab to connect Spaila to the mailbox you use for customer conversations.
                            </div>
                            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                              <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                                Receiving mail
                              </div>
                              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                                IMAP is for incoming email. Enter your provider's IMAP host, username, password, and usually port <strong>993</strong> with SSL enabled. Use <strong>Test Receiving Connection</strong> to verify it can open the inbox.
                              </div>
                            </div>
                            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                              <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                                Sending mail
                              </div>
                              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                                SMTP is for outgoing email. Pick Gmail, Outlook, or Other, apply defaults when available, then enter your sender name, email address, username, and app password. <strong>Sender Name</strong> is the display name customers see when they receive your email.
                              </div>
                            </div>
                            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                              <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                                Sync behavior
                              </div>
                              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                                Background sync checks for new mail on the polling interval. Auto-connect starts the mailbox connection when Spaila opens, and reconnect helps recover from dropped connections.
                              </div>
                            </div>
                            <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                              Use <strong>Test Receiving Connection</strong> to check IMAP and <strong>Test Sending Connection</strong> to check SMTP, then click <strong>Save</strong> to store changes.
                            </div>
                          </>
                        ) : activeEmailSubtab === "templates" ? (
                          <>
                            <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                              Email templates
                            </div>
                            <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                              Templates control the message Spaila prepares when you email a customer from an order.
                            </div>
                            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                              <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                                Template priority
                              </div>
                              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                                Templates are checked from top to bottom. The first matching template is used, so keep specific templates above the default fallback.
                              </div>
                            </div>
                            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                              <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                                Conditions
                              </div>
                              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                                Add a condition when a template should only be used for certain orders. Leave the fallback template with no condition and keep it last.
                              </div>
                            </div>
                            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                              <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                                Variables and attachments
                              </div>
                              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                                Click variable pills to insert order details into the subject or body. Attachment rules let you include images or specific file types when needed.
                              </div>
                            </div>
                            <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                              Click <strong>Save</strong> after editing templates so new emails use the latest wording.
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                              Email storage
                            </div>
                            <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                              Storage settings control how long Spaila keeps sent-mail records in its own Sent view.
                            </div>
                            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                              <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                                What is removed
                              </div>
                              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                                After the retention period, Spaila removes old sent-mail records and sent-copy folders from its own sent-mail storage.
                              </div>
                            </div>
                            <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                              <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                                What is kept
                              </div>
                              <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                                Order folders, customer folders, saved orders, and saved order conversation history are not changed by this cleanup setting.
                              </div>
                            </div>
                            <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                              Choose a retention period that matches how long you want quick access to sent messages, then click <strong>Save</strong>.
                            </div>
                          </>
                        )}
                      </>
                    ) : activeTab === "learning" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Parser learning
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          Learning helps Spaila remember field corrections you make during order processing, so similar future emails can be parsed more accurately.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Field-by-field learning
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Each row is tracked separately. Resetting Buyer Name learning, for example, does not reset price, quantity, address, or date learning.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Assignments and rejections
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            <strong>Assignments</strong> are examples where a user taught Spaila the correct value. <strong>Active rejections</strong> are examples Spaila should avoid using for that field.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Confidence
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Confidence starts as tracking and becomes promoted after repeated matching evidence. Promoted learning is trusted more strongly by the parser.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Reset carefully
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Use <strong>Reset Field Learning</strong> only when a field keeps learning the wrong pattern. The reset is scoped to that field, but it cannot be undone from this screen.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Use <strong>Refresh</strong> to update the counts after processing or correcting orders.
                        </div>
                      </>
                    ) : activeTab === "parser" ? (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#111827", marginBottom: "8px" }}>
                          Email to order conversion
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                          This area controls which order details are shown during the email conversion workflow. It does not change saved orders by itself.
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Display names
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Edit the display name when you want friendlier labels while reviewing converted orders. These labels are shared with related order views.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Visibility and order
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Use the eye button to show or hide a detail during conversion. Use the arrows to put the most important details near the top of each section.
                          </div>
                        </div>
                        <div style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid #e5e7eb" }}>
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#111827", marginBottom: "6px" }}>
                            Good workflow
                          </div>
                          <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65 }}>
                            Keep order number, ship-by date, customer details, quantity, and price easy to review.
                          </div>
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.65, marginTop: "14px" }}>
                          Click <strong>Save</strong> when finished so the conversion screen uses the updated setup.
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ fontSize: "14px", fontWeight: 600, color: "#111827", marginBottom: "6px" }}>
                          Tips and guidance will appear here
                        </div>
                        <div style={{ fontSize: "12px", color: "#6b7280", lineHeight: 1.6 }}>
                          This space is intentionally kept open for future help text, examples, and section-specific guidance.
                        </div>
                      </>
                    )}
                  </div>
                </aside>
                ) : null}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div style={{
            display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "10px",
            padding: "13px 24px",
            borderTop: "1px solid #e5e7eb",
            background: "#fafafa",
            flexShrink: 0,
          }}>
            {saveFeedback && (
              <span style={{
                fontSize: "12px",
                fontWeight: 700,
                color: "#15803d",
                transition: "opacity 0.15s",
              }}>
                Saved
              </span>
            )}
            <button onClick={handleSave} style={{
              padding: "8px 22px", border: "none", borderRadius: "6px",
              background: saveFeedback ? "#16a34a" : "#2563eb", color: "#fff", cursor: "pointer",
              fontSize: "13px", fontWeight: 600,
              boxShadow: saveFeedback
                ? "inset 0 2px 5px rgba(0,0,0,0.2)"
                : "0 1px 3px rgba(37,99,235,0.35)",
              transform: saveFeedback ? "translateY(1px)" : "translateY(0)",
              transition: "background 0.12s, box-shadow 0.12s, transform 0.12s",
            }}>{saveFeedback ? "Saved" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
