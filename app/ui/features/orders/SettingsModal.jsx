import React from "react";
import { loadFieldConfig, saveFieldConfig } from "./fieldConfig.js";

const TABS = [
  { id: "orders", label: "Orders" },
];

/* ── tiny icon helpers ─────────────────────────────────────────────────── */
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

/* ── component ─────────────────────────────────────────────────────────── */
export default function SettingsModal({ open, onClose }) {
  const [activeTab, setActiveTab] = React.useState("orders");
  const [fields, setFields] = React.useState([]);

  // Load persisted config when modal opens
  React.useEffect(() => {
    if (open) setFields(loadFieldConfig());
  }, [open]);

  // Close on ESC
  React.useEffect(() => {
    if (!open) return;
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function handleSave() {
    saveFieldConfig(fields);
    onClose();
  }

  function setLabel(key, value) {
    setFields((prev) => prev.map((f) => f.key === key ? { ...f, label: value } : f));
  }

  function toggleVisible(key) {
    setFields((prev) => prev.map((f) => f.key === key ? { ...f, visible: !f.visible } : f));
  }

  if (!open) return null;

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 2000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{
        background: "#fff",
        borderRadius: "10px",
        boxShadow: "0 24px 64px rgba(0,0,0,0.26)",
        width: "min(92vw, 860px)",
        height: "min(88vh, 640px)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>

        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          padding: "18px 24px",
          borderBottom: "1px solid #e5e7eb",
          flexShrink: 0,
        }}>
          <span style={{ fontWeight: 700, fontSize: "17px", flex: 1, color: "#111" }}>
            Settings
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none", border: "none", fontSize: "20px",
              cursor: "pointer", color: "#666", lineHeight: 1, padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

          {/* Sidebar */}
          <div style={{
            width: "180px",
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
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 18px",
                  border: "none",
                  background: activeTab === tab.id ? "#eff6ff" : "none",
                  color: activeTab === tab.id ? "#2563eb" : "#374151",
                  fontWeight: activeTab === tab.id ? 600 : 400,
                  fontSize: "13px",
                  cursor: "pointer",
                  borderLeft: activeTab === tab.id
                    ? "3px solid #2563eb"
                    : "3px solid transparent",
                }}
                onMouseEnter={(e) => {
                  if (activeTab !== tab.id) e.currentTarget.style.background = "#f3f4f6";
                }}
                onMouseLeave={(e) => {
                  if (activeTab !== tab.id) e.currentTarget.style.background = "none";
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>

            {activeTab === "orders" && (
              <>
                <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "6px" }}>
                  Order Fields
                </div>
                <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "20px" }}>
                  Rename columns and toggle their visibility in the orders table.
                  Locked fields cannot be changed.
                </div>

                {/* Column headers */}
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "160px 1fr 80px 52px",
                  gap: "0 12px",
                  padding: "6px 10px",
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

                {/* Rows */}
                <div style={{
                  border: "1px solid #e5e7eb",
                  borderTop: "none",
                  borderRadius: "0 0 6px 6px",
                  overflow: "hidden",
                }}>
                  {fields.map((f, i) => (
                    <div
                      key={f.key}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "160px 1fr 80px 52px",
                        gap: "0 12px",
                        padding: "10px 10px",
                        alignItems: "center",
                        background: i % 2 === 0 ? "#fff" : "#fafafa",
                        borderBottom: i < fields.length - 1 ? "1px solid #f3f4f6" : "none",
                      }}
                    >
                      {/* System key */}
                      <div style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        fontSize: "12px",
                        color: "#9ca3af",
                        fontFamily: "monospace",
                      }}>
                        {f.fixed && <LockIcon />}
                        {f.key}
                      </div>

                      {/* Display name */}
                      <input
                        type="text"
                        value={f.label}
                        disabled={f.fixed}
                        onChange={(e) => setLabel(f.key, e.target.value)}
                        style={{
                          padding: "6px 9px",
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

                      {/* Visible toggle */}
                      <div style={{ textAlign: "center" }}>
                        <button
                          onClick={() => !f.fixed && toggleVisible(f.key)}
                          disabled={f.fixed}
                          title={f.fixed ? "Always visible" : f.visible ? "Hide column" : "Show column"}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: f.fixed ? "not-allowed" : "pointer",
                            color: f.fixed ? "#d1d5db" : f.visible ? "#2563eb" : "#9ca3af",
                            padding: "4px",
                            borderRadius: "4px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <EyeIcon visible={f.visible} />
                        </button>
                      </div>

                      {/* Status badge */}
                      <div style={{ fontSize: "11px", color: "#9ca3af", textAlign: "right" }}>
                        {f.fixed
                          ? <span style={{ color: "#d1d5db" }}>fixed</span>
                          : f.visible
                            ? <span style={{ color: "#16a34a" }}>on</span>
                            : <span style={{ color: "#dc2626" }}>off</span>
                        }
                      </div>
                    </div>
                  ))}
                </div>

              </>
            )}

          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "8px",
          padding: "14px 24px",
          borderTop: "1px solid #e5e7eb",
          background: "#fafafa",
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 18px",
              border: "1px solid #d1d5db",
              borderRadius: "6px",
              background: "#fff",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              padding: "8px 22px",
              border: "none",
              borderRadius: "6px",
              background: "#2563eb",
              color: "#fff",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 600,
            }}
          >
            Save
          </button>
        </div>

      </div>
    </div>
  );
}
