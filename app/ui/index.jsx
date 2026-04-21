import React from "react";
import { createRoot } from "react-dom/client";
import ParserApp from "./features/parser/index.jsx";
import OrdersPage from "./features/orders/index.jsx";
import "./features/parser/styles.css";

function ParserModal({ onClose, onCreated }) {
  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(28, 26, 23, 0.55)",
      zIndex: 1000,
      display: "flex",
      alignItems: "stretch",
      justifyContent: "center",
      padding: "16px",
      overflow: "hidden",
    }}>
      <div style={{
        width: "100%",
        maxWidth: "1280px",
        height: "100%",
        background: "#f5f2eb",
        borderRadius: "18px",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 24px 64px rgba(0,0,0,0.28)",
      }}>
        <div style={{
          flexShrink: 0,
          display: "flex",
          justifyContent: "flex-end",
          padding: "8px 14px",
          borderBottom: "1px solid rgba(47,38,28,0.08)",
        }}>
          <button
            onClick={onClose}
            style={{
              border: "1px solid rgba(47,38,28,0.2)",
              borderRadius: "999px",
              background: "rgba(255,251,245,0.9)",
              color: "#4a3f35",
              padding: "5px 14px",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ✕ Close
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <ParserApp onCreated={onCreated} />
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const [showParser, setShowParser] = React.useState(false);
  const [refreshKey, setRefreshKey] = React.useState(0);

  function handleCreated() {
    setShowParser(false);
    setRefreshKey((k) => k + 1);
  }

  return (
    <>
      <OrdersPage
        onImport={() => setShowParser(true)}
        refreshKey={refreshKey}
      />
      {showParser && (
        <ParserModal
          onClose={() => setShowParser(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")).render(<Shell />);
