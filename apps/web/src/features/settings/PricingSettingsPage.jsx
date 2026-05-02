import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { api } from "../../api.js";

const DEFAULT_COLOR = "#e8d5f5";

function contrastColor(hex) {
  const value = String(hex || "").replace("#", "");
  const expanded = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  if (expanded.length !== 6) return "#1a1a1a";
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.55 ? "#ffffff" : "#1a1a1a";
}

function createRule() {
  return {
    id: Math.random().toString(36).slice(2),
    price: "",
    typeValue: "",
    color: DEFAULT_COLOR,
  };
}

function normalizeRules(payload) {
  const rules = Array.isArray(payload?.rules) ? payload.rules : [];
  return rules.map((rule, index) => ({
    id: String(rule.id || `rule-${index + 1}`),
    price: String(rule.price || ""),
    typeValue: String(rule.typeValue || ""),
    color: String(rule.color || DEFAULT_COLOR),
  }));
}

function getTypeLabel(layout) {
  const field = Array.isArray(layout?.fields)
    ? layout.fields.find((item) => item?.key === "custom_6")
    : null;
  return field?.label || "Type";
}

export default function PricingSettingsPage({ onSettingsSaved }) {
  const [rules, setRules] = React.useState([]);
  const [typeLabel, setTypeLabel] = React.useState("Type");
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", message: "" });

  React.useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.get(API_ENDPOINTS.pricingRules),
      api.get(API_ENDPOINTS.orderFieldLayout),
    ]).then(([pricingResult, layoutResult]) => {
      if (cancelled) return;
      if (pricingResult.status === "fulfilled") {
        setRules(normalizeRules(pricingResult.value));
      }
      if (layoutResult.status === "fulfilled") {
        setTypeLabel(getTypeLabel(layoutResult.value));
      }
      setState({ loading: false, saving: false, error: "", message: "" });
    }).catch(() => {
      if (!cancelled) setState({ loading: false, saving: false, error: "Could not load shared pricing rules.", message: "" });
    });
    return () => { cancelled = true; };
  }, []);

  function addRow() {
    setRules((current) => [...current, createRule()]);
    setState((current) => ({ ...current, error: "", message: "" }));
  }

  function duplicateRow(id) {
    setRules((current) => {
      const index = current.findIndex((rule) => rule.id === id);
      if (index < 0) return current;
      const next = [...current];
      next.splice(index + 1, 0, { ...current[index], id: Math.random().toString(36).slice(2) });
      return next;
    });
    setState((current) => ({ ...current, error: "", message: "" }));
  }

  function deleteRow(id) {
    setRules((current) => current.filter((rule) => rule.id !== id));
    setState((current) => ({ ...current, error: "", message: "" }));
  }

  function updateRow(id, field, value) {
    setRules((current) => current.map((rule) => (
      rule.id === id ? { ...rule, [field]: value } : rule
    )));
    setState((current) => ({ ...current, error: "", message: "" }));
  }

  async function savePricingRules() {
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const saved = await api.patch(API_ENDPOINTS.pricingRules, {
        rules,
        layout_version: 1,
      });
      setRules(normalizeRules(saved));
      setState({ loading: false, saving: false, error: "", message: "Pricing rules saved and shared with desktop." });
      onSettingsSaved?.();
    } catch (error) {
      setState({
        loading: false,
        saving: false,
        error: error?.message || "Could not save shared pricing rules.",
        message: "",
      });
    }
  }

  return (
    <div className="pricing-settings-layout">
      <div className="pricing-settings-main">
        <div className="orders-settings-heading">
          <div>
            <h3>Price List</h3>
            <p>
              Assign a display color to each price point. The <strong>{typeLabel}</strong> value is
              auto-filled on matching orders and the row receives the chosen color in the Orders sheet.
            </p>
          </div>
          <button className="orders-reset-btn" type="button" onClick={addRow}>
            + Add row
          </button>
        </div>

        {state.loading ? (
          <div className="table-state"><div className="spinner" /><span>Loading shared pricing rules...</span></div>
        ) : rules.length === 0 ? (
          <div className="pricing-empty">
            No price rules yet. Click <strong>+ Add row</strong> to create one.
          </div>
        ) : (
          <div className="pricing-table-wrap">
            <div className="pricing-table">
              <div className="pricing-table-head">
                <span>Price</span>
                <span>{typeLabel}</span>
                <span className="center">Color</span>
                <span className="center">Actions</span>
              </div>
              {rules.map((rule, index) => {
                const rowBg = rule.color || (index % 2 === 0 ? "#fff" : "#fafafa");
                const textColor = contrastColor(rowBg);
                const isDark = textColor === "#ffffff";
                return (
                  <div
                    className="pricing-row"
                    key={rule.id}
                    style={{ background: rowBg, color: textColor }}
                  >
                    <input
                      type="text"
                      value={rule.price}
                      placeholder="e.g. 35.00"
                      onChange={(event) => updateRow(rule.id, "price", event.target.value)}
                      style={{ color: textColor }}
                      className={isDark ? "dark" : ""}
                    />
                    <input
                      type="text"
                      value={rule.typeValue}
                      placeholder={`Enter ${typeLabel}...`}
                      onChange={(event) => updateRow(rule.id, "typeValue", event.target.value)}
                      style={{ color: textColor }}
                      className={isDark ? "dark" : ""}
                    />
                    <label className="pricing-color-picker" title="Pick row color">
                      <span style={{ background: rowBg, borderColor: isDark ? "rgba(255,255,255,0.4)" : "rgba(0,0,0,0.22)" }} />
                      <input
                        type="color"
                        value={rule.color || DEFAULT_COLOR}
                        onChange={(event) => updateRow(rule.id, "color", event.target.value)}
                      />
                    </label>
                    <div className="pricing-actions">
                      <button type="button" className={isDark ? "dark" : ""} onClick={() => duplicateRow(rule.id)}>Duplicate</button>
                      <button type="button" className={isDark ? "dark" : ""} onClick={() => deleteRow(rule.id)}>Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {state.error ? <div className="error-banner">{state.error}</div> : null}
        {state.message ? <div className="success-banner">{state.message}</div> : null}
        <div className="orders-settings-actions">
          <button className="gen-save-btn" type="button" onClick={savePricingRules} disabled={state.saving}>
            {state.saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <aside className="orders-help-card">
        <div className="gen-help-label">Pricing Help</div>
        <div className="gen-help-entry">
          <strong>Price-based order types</strong>
          <p>Pricing rules let Spaila identify an order type from the order price, fill the shared Type field, and use the selected color on order-sheet rows so each order type is easy to identify visually.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Shared with desktop</strong>
          <p>Saving here updates the shared Spaila profile. The desktop app imports the same rules when it starts or when Settings opens.</p>
        </div>
      </aside>
    </div>
  );
}
