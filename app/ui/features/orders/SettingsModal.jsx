import React from "react";

export default function SettingsModal({ open, onClose }) {
  const [ordersFolder, setOrdersFolder] = React.useState("");

  // Close on ESC
  React.useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
        borderRadius: "8px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
        width: "460px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>

        {/* Header */}
        <div style={{
          display: "flex",
          alignItems: "center",
          padding: "16px 20px",
          borderBottom: "1px solid #e5e7eb",
        }}>
          <span style={{ fontWeight: 700, fontSize: "16px", flex: 1, color: "#111" }}>
            Settings
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: "18px",
              cursor: "pointer",
              color: "#666",
              lineHeight: 1,
              padding: "2px 6px",
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px" }}>

          <div style={{ marginBottom: "20px" }}>
            <label style={{
              display: "block",
              fontSize: "13px",
              fontWeight: 600,
              color: "#333",
              marginBottom: "6px",
            }}>
              Orders Folder Location
            </label>
            <input
              type="text"
              value={ordersFolder}
              onChange={(e) => setOrdersFolder(e.target.value)}
              placeholder="e.g. C:\Users\you\Spaila\orders"
              style={{
                width: "100%",
                padding: "7px 10px",
                border: "1px solid #d1d5db",
                borderRadius: "4px",
                fontSize: "13px",
                color: "#111",
                background: "#fff",
                boxSizing: "border-box",
              }}
            />
            <div style={{ fontSize: "11px", color: "#888", marginTop: "4px" }}>
              Folder where order subfolders are created by the helper.
            </div>
          </div>

        </div>

        {/* Footer */}
        <div style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "8px",
          padding: "12px 20px",
          borderTop: "1px solid #e5e7eb",
          background: "#fafafa",
        }}>
          <button
            onClick={onClose}
            style={{
              padding: "7px 16px",
              border: "1px solid #d1d5db",
              borderRadius: "5px",
              background: "#fff",
              cursor: "pointer",
              fontSize: "13px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onClose}
            style={{
              padding: "7px 18px",
              border: "none",
              borderRadius: "5px",
              background: "#111",
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
