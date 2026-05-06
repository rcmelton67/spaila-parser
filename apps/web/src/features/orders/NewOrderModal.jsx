import React from "react";
import { api } from "../../api.js";

const CUSTOM_KEYS = ["custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6"];

function emptyDraft(activeTab) {
  return {
    order_number: "",
    order_date: "",
    ship_by: "",
    quantity: "",
    price: "",
    order_notes: "",
    gift_message: "",
    is_gift: false,
    gift_wrap: false,
    buyer_name: "",
    buyer_email: "",
    shipping_name: "",
    shipping_address: "",
    phone_number: "",
    pet_name: "",
    status: activeTab === "completed" ? "completed" : "active",
    custom_1: "",
    custom_2: "",
    custom_3: "",
    custom_4: "",
    custom_5: "",
    custom_6: "",
  };
}

function fieldLabel(key, layout) {
  const field = (layout?.fields || []).find((f) => f.key === key);
  return field?.label || null;
}

function humanizeError(body) {
  const raw = body?.detail || body?.error;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return raw.message || raw.detail || raw.error || null;
  return null;
}

const inputStyle = {
  width: "100%",
  padding: "7px 10px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontSize: 13,
  boxSizing: "border-box",
  outline: "none",
  background: "#fff",
  color: "#111827",
};

const textareaStyle = {
  ...inputStyle,
  resize: "vertical",
  fontFamily: "inherit",
  lineHeight: 1.5,
};

export default function NewOrderModal({ activeTab = "active", layout = null, onClose, onSaved }) {
  const [form, setForm] = React.useState(() => emptyDraft(activeTab));
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const set = (key, val) => setForm((prev) => ({ ...prev, [key]: val }));

  function L(key, fallback) {
    return fieldLabel(key, layout) || fallback;
  }

  React.useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleCreate() {
    if (!form.order_number.trim()) {
      setError("Order number is required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await api.post("/orders/create-manual", form);
      if (res && (res.status === "created" || res.id)) {
        onSaved?.();
      } else {
        setError("Unexpected response from server.");
      }
    } catch (err) {
      let msg = err?.message || "Could not create order.";
      if (err?.status === 402 || (msg && msg.toLowerCase().includes("trial"))) {
        msg = "Trial expired - upgrade required to create orders.";
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) onClose?.();
  }

  return (
    <div className="new-order-backdrop" onClick={handleBackdropClick}>
      <div className="new-order-dialog" role="dialog" aria-modal="true" aria-labelledby="new-order-title">
        <div className="new-order-header">
          <h3 id="new-order-title">New Order</h3>
          <button type="button" className="new-order-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="new-order-body">
          <div className="new-order-field">
            <input
              autoFocus
              style={inputStyle}
              placeholder={`${L("order_number", "Order Number")} *`}
              value={form.order_number}
              onChange={(e) => set("order_number", e.target.value)}
            />
          </div>
          <div className="new-order-row2">
            <div className="new-order-field">
              <input
                style={inputStyle}
                placeholder={L("buyer_name", "Buyer Name")}
                value={form.buyer_name}
                onChange={(e) => set("buyer_name", e.target.value)}
              />
            </div>
            <div className="new-order-field">
              <input
                style={inputStyle}
                placeholder={L("shipping_name", "Shipping Name")}
                value={form.shipping_name}
                onChange={(e) => set("shipping_name", e.target.value)}
              />
            </div>
          </div>
          <div className="new-order-field">
            <input
              style={inputStyle}
              placeholder={L("buyer_email", "Buyer Email")}
              value={form.buyer_email}
              onChange={(e) => set("buyer_email", e.target.value)}
            />
          </div>
          <div className="new-order-row2">
            <div className="new-order-field">
              <input
                style={inputStyle}
                placeholder={L("order_date", "Order Date")}
                value={form.order_date}
                onChange={(e) => set("order_date", e.target.value)}
              />
            </div>
            <div className="new-order-field">
              <input
                style={inputStyle}
                placeholder={L("ship_by", "Ship By")}
                value={form.ship_by}
                onChange={(e) => set("ship_by", e.target.value)}
              />
            </div>
          </div>
          <div className="new-order-row2">
            <div className="new-order-field">
              <input
                style={inputStyle}
                placeholder={L("price", "Price")}
                value={form.price}
                onChange={(e) => set("price", e.target.value)}
              />
            </div>
            <div className="new-order-field">
              <input
                style={inputStyle}
                placeholder={L("quantity", "Quantity")}
                value={form.quantity}
                onChange={(e) => set("quantity", e.target.value)}
              />
            </div>
          </div>
          {CUSTOM_KEYS.map((key) => (
            <div key={key} className="new-order-field">
              <input
                style={inputStyle}
                placeholder={L(key, key)}
                value={form[key]}
                onChange={(e) => set(key, e.target.value)}
              />
            </div>
          ))}
          <div className="new-order-field">
            <textarea
              style={{ ...textareaStyle, minHeight: 60 }}
              placeholder={L("shipping_address", "Shipping Address")}
              value={form.shipping_address}
              onChange={(e) => set("shipping_address", e.target.value)}
            />
          </div>
          <div className="new-order-field">
            <input
              style={inputStyle}
              placeholder={L("phone_number", "Phone Number")}
              value={form.phone_number}
              onChange={(e) => set("phone_number", e.target.value)}
            />
          </div>
          <div className="new-order-field">
            <textarea
              style={{ ...textareaStyle, minHeight: 56 }}
              placeholder={L("order_notes", "Order Notes")}
              value={form.order_notes}
              onChange={(e) => set("order_notes", e.target.value)}
            />
          </div>
          <div className="new-order-field">
            <textarea
              style={{ ...textareaStyle, minHeight: 56 }}
              placeholder={L("gift_message", "Gift Message")}
              value={form.gift_message}
              onChange={(e) => set("gift_message", e.target.value)}
            />
          </div>
          <div className="new-order-checkboxes">
            <label className="new-order-checkbox-label">
              <input
                type="checkbox"
                checked={form.is_gift}
                onChange={(e) => set("is_gift", e.target.checked)}
              />
              <span>Mark as gift</span>
            </label>
            <label className="new-order-checkbox-label">
              <input
                type="checkbox"
                checked={form.gift_wrap}
                onChange={(e) => set("gift_wrap", e.target.checked)}
              />
              <span>Gift wrap</span>
            </label>
          </div>
        </div>

        <div className="new-order-footer">
          {error ? <div className="new-order-error">{error}</div> : null}
          <div className="new-order-actions">
            <button type="button" className="new-order-btn-cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="new-order-btn-create"
              disabled={saving}
              onClick={handleCreate}
            >
              {saving ? "Creating..." : "Create Order"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
