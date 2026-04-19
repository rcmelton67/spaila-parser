import React from "react";

const API = "http://127.0.0.1:8055";

// ── Configurable product-info field labels ──────────────────────────────────
const PRODUCT_FIELDS = [
  { key: "custom_1", label: "Custom 1", hint: "" },
  { key: "custom_2", label: "Custom 2", hint: "" },
  { key: "custom_3", label: "Custom 3", hint: "" },
  { key: "custom_4", label: "Custom 4", hint: "" },
  { key: "custom_5", label: "Custom 5", hint: "" },
  { key: "custom_6", label: "Custom 6", hint: "" },
];

// ── Shared primitives ───────────────────────────────────────────────────────
const input = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #d1d5db",
  borderRadius: "4px",
  fontSize: "13px",
  color: "#111",
  background: "#fff",
  boxSizing: "border-box",
};

const textarea = {
  ...input,
  resize: "vertical",
  minHeight: "90px",
  fontFamily: "inherit",
};

const hint = {
  fontSize: "11px",
  color: "#2563eb",
  marginTop: "3px",
};

const readLabel = {
  fontSize: "12px",
  fontWeight: 700,
  color: "#333",
  marginBottom: "3px",
  display: "block",
};

const readValue = {
  fontSize: "13px",
  color: "#1a1a1a",
};

// ── Panel wrapper ───────────────────────────────────────────────────────────
function Panel({ title, children }) {
  const [visible, setVisible] = React.useState(true);
  return (
    <div style={{
      background: "#f5f5f5",
      borderRadius: "6px",
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: "0",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <span style={{ fontWeight: 700, fontSize: "14px", color: "#111" }}>{title}</span>
        <button
          onClick={() => setVisible((v) => !v)}
          title={visible ? "Hide" : "Show"}
          style={{
            border: "1px solid #ccc",
            borderRadius: "999px",
            background: "#fff",
            width: "28px",
            height: "28px",
            cursor: "pointer",
            fontSize: "12px",
            color: "#666",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {visible ? "👁" : "○"}
        </button>
      </div>
      {visible && children}
    </div>
  );
}

// ── Labelled field row (label left, input right) ─────────────────────────────
function FieldRow({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", marginBottom: "10px", gap: "8px" }}>
      <span style={{ width: "84px", paddingTop: "7px", fontSize: "13px", color: "#555", flexShrink: 0, textAlign: "right" }}>
        {label}
      </span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────
export default function EditOrderModal({ order, onClose, onSaved }) {
  const [form, setForm] = React.useState({ ...order });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const set = (key, val) => setForm((p) => ({ ...p, [key]: val }));

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`${API}/orders/update-full`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  function handleReset() {
    setForm({ ...order });
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "12px 16px",
        overflowY: "auto",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{
        width: "100%",
        maxWidth: "760px",
        background: "#fff",
        borderRadius: "8px",
        boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>

        {/* ── Title bar ── */}
        <div style={{
          display: "flex",
          alignItems: "center",
          padding: "14px 20px 10px",
          borderBottom: "1px solid #e5e7eb",
          gap: "12px",
        }}>
          <span style={{ fontWeight: 700, fontSize: "17px", flex: 1, color: "#111" }}>
            Editing Order {order.order_number}
          </span>
          <button
            onClick={() => {
              const folder = order.order_folder_path;
              if (!folder) {
                alert("No order folder assigned yet. The helper creates this folder once the order is matched.");
                return;
              }
              window.parserApp?.openFolder(folder);
            }}
            title={order.order_folder_path || "No folder assigned yet"}
            style={{
              padding: "5px 12px",
              border: "1px solid #ccc",
              borderRadius: "4px",
              background: order.order_folder_path ? "#fff" : "#f3f4f6",
              fontSize: "12px",
              cursor: order.order_folder_path ? "pointer" : "default",
              color: order.order_folder_path ? "#333" : "#999",
            }}
          >
            Show Folder
          </button>
          <select
            value={form.status || "active"}
            onChange={(e) => set("status", e.target.value)}
            style={{
              padding: "5px 10px",
              border: "1px solid #ccc",
              borderRadius: "4px",
              fontSize: "12px",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: "flex", gap: "6px", padding: "10px 20px 0", borderBottom: "1px solid #e5e7eb" }}>
          <button
            style={{
              padding: "6px 14px",
              border: "1px solid #ccc",
              borderBottom: "none",
              borderRadius: "4px 4px 0 0",
              background: "#fff",
              fontWeight: 700,
              fontSize: "13px",
              cursor: "default",
              color: "#333",
              position: "relative",
              bottom: "-1px",
            }}
          >
            Details
          </button>
        </div>

        {/* ── Body ── */}
        <div style={{ padding: "16px 20px", overflowY: "auto", maxHeight: "calc(100vh - 120px)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>

              {/* ── Order Summary ── */}
              <Panel title="Order Summary">
                <FieldRow label="Order Date:">
                  <input style={input} value={form.order_date || ""} onChange={(e) => set("order_date", e.target.value)} />
                  <div style={hint}>Manual override (YYYY-MM-DD)</div>
                </FieldRow>
                <FieldRow label="Ship By:">
                  <input style={input} value={form.ship_by || ""} onChange={(e) => set("ship_by", e.target.value)} />
                  <div style={hint}>Manual override (YYYY-MM-DD)</div>
                </FieldRow>
                <FieldRow label="Quantity:">
                  <input style={input} value={form.quantity || ""} onChange={(e) => set("quantity", e.target.value)} />
                </FieldRow>
                <FieldRow label="Price:">
                  <input style={input} value={form.price || ""} onChange={(e) => set("price", e.target.value)} />
                </FieldRow>
                <div style={{ fontSize: "13px", color: "#555", marginTop: "4px" }}>
                  Website order: <strong>No</strong>
                </div>
              </Panel>

              {/* ── Notes & Messages ── */}
              <Panel title="Notes & Messages">
                <label style={{ ...readLabel, fontWeight: 400, color: "#666", marginBottom: "4px" }}>Order notes</label>
                <textarea
                  style={{ ...textarea, marginBottom: "12px" }}
                  value={form.notes || ""}
                  onChange={(e) => set("notes", e.target.value)}
                />
                <label style={{ ...readLabel, fontWeight: 400, color: "#666", marginBottom: "4px" }}>Message</label>
                <textarea
                  style={textarea}
                  value={form.message || ""}
                  onChange={(e) => set("message", e.target.value)}
                />
              </Panel>

              {/* ── Customer Info ── */}
              <Panel title="Customer info">
                <label style={readLabel}>Name</label>
                <div style={{ ...readValue, marginBottom: "12px" }}>{order.buyer_name || "—"}</div>

                <label style={readLabel}>Buyer Email</label>
                <div style={{ ...readValue, color: "#2563eb", marginBottom: "12px" }}>{order.buyer_email || "—"}</div>

                <label style={readLabel}>Address</label>
                <textarea
                  readOnly
                  style={{ ...textarea, background: "#f0f0f0", color: "#333", resize: "none", minHeight: "72px" }}
                  value={order.shipping_address || ""}
                />
              </Panel>

              {/* ── Product Info ── */}
              <Panel title="Product info">
                {PRODUCT_FIELDS.map((f) => (
                  <FieldRow key={f.key} label={f.label + ":"}>
                    <input
                      style={input}
                      value={form[f.key] || ""}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                    {f.hint && <div style={hint}>{f.hint}</div>}
                  </FieldRow>
                ))}
              </Panel>

          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{
          display: "flex",
          alignItems: "center",
          padding: "12px 20px",
          borderTop: "1px solid #e5e7eb",
          background: "#fafafa",
        }}>
          <button
            onClick={handleReset}
            style={{ fontSize: "13px", color: "#2563eb", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            Reset view
          </button>
          {error && <span style={{ fontSize: "12px", color: "#991b1b", marginLeft: "12px" }}>{error}</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
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
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: "7px 18px",
                border: "none",
                borderRadius: "5px",
                background: saving ? "#6b7280" : "#111",
                color: "#fff",
                cursor: saving ? "not-allowed" : "pointer",
                fontSize: "13px",
                fontWeight: 600,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
