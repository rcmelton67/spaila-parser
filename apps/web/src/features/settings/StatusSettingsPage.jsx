import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { normalizeStatusConfig } from "../../../../../shared/models/statusConfig.mjs";
import { api } from "../../api.js";

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

function StatusEditor({ config, setConfig }) {
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
      states: prev.states.map((s) => (s.key === key ? { ...s, [field]: value } : s)),
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "18px" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "2px" }}>
            Order Status
          </div>
          <div style={{ fontSize: "12px", color: "#6b7280" }}>
            Define the status states available for orders. Each order can be set to one state.
          </div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", flexShrink: 0 }}>
          <span style={{ fontSize: "12px", color: "#374151", fontWeight: 500 }}>
            {config.enabled ? "Enabled" : "Disabled"}
          </span>
          <div
            role="switch"
            tabIndex={0}
            aria-checked={config.enabled}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setConfig((p) => ({ ...p, enabled: !p.enabled }));
              }
            }}
            onClick={() => setConfig((p) => ({ ...p, enabled: !p.enabled }))}
            style={{
              width: 36,
              height: 20,
              borderRadius: 10,
              cursor: "pointer",
              background: config.enabled ? "#2563eb" : "#d1d5db",
              position: "relative",
              transition: "background 0.2s",
              flexShrink: 0,
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 2,
                left: config.enabled ? 18 : 2,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 0.2s",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }}
            />
          </div>
        </label>
      </div>

      <div style={{ marginBottom: "22px" }}>
        <label style={{ fontSize: "12px", fontWeight: 600, color: "#374151", display: "block", marginBottom: "5px" }}>
          Column Label
        </label>
        <input
          type="text"
          value={config.columnLabel}
          onChange={(e) => setConfig((p) => ({ ...p, columnLabel: e.target.value }))}
          style={{
            padding: "6px 10px",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            fontSize: "13px",
            width: "220px",
            outline: "none",
            color: "#111",
          }}
          onFocus={(e) => (e.target.style.borderColor = "#2563eb")}
          onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
        />
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: "#374151" }}>States</div>
        <button
          type="button"
          onClick={addState}
          style={{
            padding: "4px 12px",
            fontSize: "12px",
            fontWeight: 600,
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: "5px",
            cursor: "pointer",
            color: "#374151",
          }}
        >
          + Add state
        </button>
      </div>

      {config.states.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "30px 20px",
            color: "#9ca3af",
            fontSize: "13px",
            border: "1px dashed #e5e7eb",
            borderRadius: "8px",
          }}
        >
          No states defined. Click <strong>+ Add state</strong> to create one.
        </div>
      ) : (
        <div style={{ overflowX: "auto", paddingBottom: "4px" }}>
          <div style={{ minWidth: "520px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 60px 44px 52px",
                gap: "0 8px",
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
              }}
            >
              <span>State label</span>
              <span style={{ textAlign: "center" }}>Color</span>
              <span />
              <span style={{ textAlign: "center" }}>Order</span>
            </div>

            <div
              style={{
                border: "1px solid #e5e7eb",
                borderTop: "none",
                borderRadius: "0 0 6px 6px",
                overflow: "hidden",
              }}
            >
              {config.states.map((s, i) => {
                const tc = contrastColor(s.color);
                const isDark = tc === "#ffffff";
                return (
                  <div
                    key={s.key}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 60px 44px 52px",
                      gap: "0 8px",
                      padding: "8px 10px",
                      alignItems: "center",
                      background: i % 2 === 0 ? "#fff" : "#fafafa",
                      borderBottom: i < config.states.length - 1 ? "1px solid #f3f4f6" : "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span
                        style={{
                          padding: "2px 10px",
                          borderRadius: "999px",
                          fontSize: "12px",
                          fontWeight: 600,
                          background: s.color,
                          color: tc,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {s.label || "—"}
                      </span>
                      <input
                        type="text"
                        value={s.label}
                        onChange={(e) => updateState(s.key, "label", e.target.value)}
                        style={{
                          padding: "4px 8px",
                          border: "1px solid #d1d5db",
                          borderRadius: "5px",
                          fontSize: "13px",
                          outline: "none",
                          flex: 1,
                          color: "#111",
                          background: "#fff",
                        }}
                        onFocus={(e) => (e.target.style.borderColor = "#2563eb")}
                        onBlur={(e) => (e.target.style.borderColor = "#d1d5db")}
                      />
                    </div>

                    <div style={{ textAlign: "center" }}>
                      <label style={{ position: "relative", display: "inline-block", cursor: "pointer" }}>
                        <div
                          style={{
                            width: 32,
                            height: 22,
                            borderRadius: "5px",
                            background: s.color,
                            border: isDark ? "2px solid rgba(255,255,255,0.4)" : "2px solid rgba(0,0,0,0.22)",
                            display: "inline-block",
                          }}
                        />
                        <input
                          type="color"
                          value={s.color}
                          onChange={(e) => updateState(s.key, "color", e.target.value)}
                          style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
                        />
                      </label>
                    </div>

                    <div style={{ textAlign: "center" }}>
                      <button
                        type="button"
                        onClick={() => removeState(s.key)}
                        title="Remove state"
                        style={{
                          background: "none",
                          border: "1px solid #e5e7eb",
                          borderRadius: "4px",
                          padding: "2px 7px",
                          cursor: "pointer",
                          fontSize: "12px",
                          color: "#dc2626",
                        }}
                      >
                        ✕
                      </button>
                    </div>

                    <div style={{ display: "flex", gap: "2px", justifyContent: "center" }}>
                      <button
                        type="button"
                        onClick={() => moveState(i, -1)}
                        disabled={i === 0}
                        style={{
                          background: "none",
                          border: "1px solid #e5e7eb",
                          borderRadius: "3px",
                          padding: "2px 5px",
                          cursor: i === 0 ? "default" : "pointer",
                          color: i === 0 ? "#d1d5db" : "#374151",
                          fontSize: "11px",
                          lineHeight: 1,
                        }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveState(i, 1)}
                        disabled={i === config.states.length - 1}
                        style={{
                          background: "none",
                          border: "1px solid #e5e7eb",
                          borderRadius: "3px",
                          padding: "2px 5px",
                          cursor: i === config.states.length - 1 ? "default" : "pointer",
                          color: i === config.states.length - 1 ? "#d1d5db" : "#374151",
                          fontSize: "11px",
                          lineHeight: 1,
                        }}
                      >
                        ↓
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: "16px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {config.states.map((s) => (
                <span
                  key={s.key}
                  style={{
                    padding: "3px 12px",
                    borderRadius: "999px",
                    fontSize: "12px",
                    fontWeight: 600,
                    background: s.color,
                    color: contrastColor(s.color),
                  }}
                >
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

function HelpPanel() {
  return (
    <aside className="orders-help-card">
      <div className="gen-help-label">Status Help</div>
      <div className="gen-help-entry">
        <strong>Order statuses</strong>
        <p>Statuses help you track where each order is in your workflow, such as new, in progress, ready to ship, or completed.</p>
      </div>
      <div className="gen-help-entry">
        <strong>Show the status column</strong>
        <p>Turn the status column on when you want a status badge on the Orders sheet. The column label is the header users will see.</p>
      </div>
      <div className="gen-help-entry">
        <strong>Create useful states</strong>
        <p>Add only the states you actually use day to day. Short labels work best because they display as compact badges.</p>
      </div>
      <div className="gen-help-entry">
        <strong>Colors and order</strong>
        <p>Choose colors that are easy to scan. Use the arrows to put your most common statuses first in the order picker.</p>
      </div>
      <div className="gen-help-entry">
        <p>Click <strong>Save</strong> when finished so the Orders sheet uses your updated statuses.</p>
      </div>
    </aside>
  );
}

export default function StatusSettingsPage({ onSettingsSaved }) {
  const [config, setConfig] = React.useState(() => normalizeStatusConfig(null));
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", message: "" });

  React.useEffect(() => {
    let cancelled = false;
    api.get(API_ENDPOINTS.orderFieldLayout).then((layout) => {
      if (cancelled) return;
      setConfig(normalizeStatusConfig(layout?.status));
      setState({ loading: false, saving: false, error: "", message: "" });
    }).catch(() => {
      if (!cancelled) setState({ loading: false, saving: false, error: "", message: "" });
    });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setState((s) => ({ ...s, saving: true, error: "", message: "" }));
    try {
      const states = (config.states || []).map((s) => ({
        key: String(s.key || "").trim() || Math.random().toString(36).slice(2),
        label: String(s.label ?? "").trim() || "State",
        color: typeof s.color === "string" && s.color.startsWith("#") ? s.color : "#f3f4f6",
      }));
      const saved = await api.patch(API_ENDPOINTS.orderFieldLayout, {
        status: {
          enabled: config.enabled !== false,
          columnLabel: String(config.columnLabel || "").trim() || "Status",
          states,
        },
        layout_version: 1,
      });
      setConfig(normalizeStatusConfig(saved?.status));
      setState({ loading: false, saving: false, error: "", message: "Status settings saved and shared with desktop." });
      onSettingsSaved?.();
    } catch (error) {
      setState((s) => ({
        ...s,
        saving: false,
        error: error?.message || "Could not save status settings.",
        message: "",
      }));
    }
  }

  if (state.loading) {
    return (
      <div className="search-sort-layout">
        <main className="search-sort-main">
          <div className="table-state">
            <div className="spinner" />
            <span>Loading shared status settings...</span>
          </div>
        </main>
        <HelpPanel />
      </div>
    );
  }

  return (
    <div className="search-sort-layout">
      <main className="search-sort-main">
        <section className="search-sort-section" style={{ maxWidth: 720 }}>
          <StatusEditor config={config} setConfig={setConfig} />
        </section>
        {state.error ? <div className="error-banner">{state.error}</div> : null}
        {state.message ? <div className="success-banner">{state.message}</div> : null}
        <button className="gen-save-btn" type="button" disabled={state.saving} onClick={save}>
          {state.saving ? "Saving..." : "Save"}
        </button>
      </main>
      <HelpPanel />
    </div>
  );
}
