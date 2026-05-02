import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { api } from "../../api.js";

const STORAGE_KEY = "spaila_web_order_field_layout";
const WEB_WIDTH_PROFILE_KEY = "spaila_web_column_width_profile";

const DEFAULT_HIGHLIGHT_COLOR = "#fca5a5";

const DEFAULT_FIELDS = [
  { key: "status", label: "Status", visible: true, color: false, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "order_info", label: "Order Info", visible: true, color: false, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR, fixed: true },
  { key: "order_number", label: "Order #", visible: false, color: false, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "buyer_name", label: "Buyer", visible: true, color: true, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "price", label: "Price", visible: true, color: true, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "quantity", label: "Qty", visible: true, color: false, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "custom_1", label: "Pet Name", visible: true, color: true, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "custom_2", label: "Pet Type", visible: true, color: true, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "custom_3", label: "Epitaph", visible: true, color: true, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "custom_4", label: "Dates Of Life", visible: true, color: true, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "custom_5", label: "Stone Color", visible: true, color: true, highlight: true, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "custom_6", label: "Type", visible: false, color: true, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "shipping_address", label: "Shipping Address", visible: false, color: false, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "order_date", label: "Order Date", visible: true, color: false, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "ship_by", label: "Ship By", visible: true, color: false, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "buyer_email", label: "Buyer Email", visible: false, color: false, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "gift_message", label: "Gift Message", visible: false, color: false, highlight: true, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
  { key: "order_notes", label: "Notes", visible: true, color: true, highlight: false, highlightColor: DEFAULT_HIGHLIGHT_COLOR },
];

function normalizeWidthProfile(fields) {
  try {
    const saved = JSON.parse(localStorage.getItem(WEB_WIDTH_PROFILE_KEY) || "null");
    if (saved?.columns && typeof saved.columns === "object") {
      return {
        ...saved,
        source: "web",
        unit: "percent",
        tolerance: Number(saved.tolerance || 0.02),
        promoted: true,
        updatedAt: new Date().toISOString(),
      };
    }
  } catch (_) {}
  const visibleFields = fields.filter((field) => field.visible !== false);
  if (!visibleFields.length) return null;
  const percent = Number((1 / visibleFields.length).toFixed(4));
  return {
    source: "web",
    unit: "percent",
    tolerance: 0.02,
    promoted: true,
    updatedAt: new Date().toISOString(),
    columns: Object.fromEntries(
      visibleFields.map((field) => [field.key, { percent }])
    ),
  };
}

function loadFields() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!Array.isArray(saved) || !saved.length) return DEFAULT_FIELDS.map((field) => ({ ...field }));
    const byKey = new Map(saved.map((field) => [field.key, field]));
    return [
      ...saved.filter((field) => DEFAULT_FIELDS.some((base) => base.key === field.key)),
      ...DEFAULT_FIELDS.filter((base) => !byKey.has(base.key)),
    ].map((field) => ({ ...field }));
  } catch {
    return DEFAULT_FIELDS.map((field) => ({ ...field }));
  }
}

function layoutToFields(layout) {
  if (!layout || typeof layout !== "object") return loadFields();
  const fieldMap = new Map((layout.fields || []).map((field) => [field.key, field]));
  const orderedKeys = Array.isArray(layout.order) && layout.order.length
    ? layout.order
    : DEFAULT_FIELDS.map((field) => field.key);
  const defaultMap = new Map(DEFAULT_FIELDS.map((field) => [field.key, field]));
  const keys = [...orderedKeys, ...DEFAULT_FIELDS.map((field) => field.key).filter((key) => !orderedKeys.includes(key))];
  return keys
    .map((key) => {
      const base = defaultMap.get(key);
      if (!base) return null;
      if (key === "status") {
        return {
          ...base,
          label: layout.status?.columnLabel || base.label,
          visible: layout.status?.enabled !== false,
        };
      }
      const incoming = fieldMap.get(key);
      if (!incoming) return { ...base };
      return {
        ...base,
        label: incoming.label || base.label,
        visible: incoming.visibleInOrders !== false,
        color: incoming.paletteEnabled !== false,
        highlight: incoming.highlight?.enabled === true,
        highlightColor: incoming.highlight?.color || base.highlightColor || DEFAULT_HIGHLIGHT_COLOR,
      };
    })
    .filter(Boolean);
}

function fieldsToLayout(fields) {
  return {
    fields: fields
      .filter((field) => field.key !== "status" && field.key !== "order_info")
      .map((field) => ({
        key: field.key,
        label: field.label,
        visibleInOrders: field.visible !== false,
        paletteEnabled: field.color !== false,
        highlight: {
          enabled: field.highlight === true,
          color: field.highlightColor || DEFAULT_HIGHLIGHT_COLOR,
        },
      })),
    order: fields.map((field) => field.key),
    status: {
      enabled: fields.find((field) => field.key === "status")?.visible !== false,
      columnLabel: fields.find((field) => field.key === "status")?.label || "Status",
    },
  };
}

function Toggle({ checked, onChange, disabled = false }) {
  return (
    <button
      type="button"
      className={`orders-field-toggle${checked ? " on" : ""}`}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      aria-pressed={checked}
    >
      <span />
    </button>
  );
}

function IconButton({ children, active = true, onClick, title }) {
  return (
    <button
      type="button"
      className={`orders-field-icon${active ? "" : " muted"}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function HighlightControl({ field, onToggle, onColor }) {
  const color = field.highlightColor || DEFAULT_HIGHLIGHT_COLOR;
  return (
    <div className="orders-highlight-control">
      <Toggle
        checked={field.highlight}
        onChange={(checked) => onToggle(checked)}
      />
      {field.highlight ? (
        <label className="orders-highlight-swatch" title="Change highlight color">
          <span style={{ background: color }} />
          <input
            type="color"
            value={color}
            onChange={(event) => onColor(event.target.value)}
          />
        </label>
      ) : null}
    </div>
  );
}

export default function OrdersSettingsPage({ onSettingsSaved }) {
  const [fields, setFields] = React.useState(loadFields);
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", message: "" });

  React.useEffect(() => {
    let cancelled = false;
    api.get(API_ENDPOINTS.orderFieldLayout).then((layout) => {
      if (cancelled) return;
      const next = layoutToFields(layout);
      setFields(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setState({ loading: false, saving: false, error: "", message: "" });
    }).catch(() => {
      if (!cancelled) setState({ loading: false, saving: false, error: "", message: "" });
    });
    return () => { cancelled = true; };
  }, []);

  function updateField(key, patch) {
    setFields((current) => current.map((field) => (
      field.key === key ? { ...field, ...patch } : field
    )));
    setState((current) => ({ ...current, message: "", error: "" }));
  }

  function moveField(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= fields.length) return;
    setFields((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
    setState((current) => ({ ...current, message: "", error: "" }));
  }

  function resetLayout() {
    setFields(DEFAULT_FIELDS.map((field) => ({ ...field })));
    setState((current) => ({ ...current, message: "Default layout restored. Click Save to keep it.", error: "" }));
  }

  async function saveLayout() {
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const layout = fieldsToLayout(fields);
      const saved = await api.patch(API_ENDPOINTS.orderFieldLayout, layout);
      const next = layoutToFields(saved);
      setFields(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setState({ loading: false, saving: false, error: "", message: "Orders layout saved and shared with desktop." });
      onSettingsSaved?.();
    } catch (error) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fields));
      setState({
        loading: false,
        saving: false,
        error: error?.message || "Could not save shared order field layout.",
        message: "",
      });
    }
  }

  async function syncWebLayoutToDesktop() {
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const profile = normalizeWidthProfile(fields);
      const saved = await api.patch(API_ENDPOINTS.orderFieldLayout, {
        column_width_profiles: profile ? { web: profile } : {},
        platform_overrides: {
          web: {
            promotedAt: new Date().toISOString(),
            source: "settings/orders",
          },
        },
        layout_version: 1,
      });
      const next = layoutToFields(saved);
      setFields(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setState({ loading: false, saving: false, error: "", message: "Current web width profile saved for all devices." });
      onSettingsSaved?.();
    } catch (error) {
      setState({
        loading: false,
        saving: false,
        error: error?.message || "Could not sync web layout changes.",
        message: "",
      });
    }
  }

  return (
    <div className="orders-settings-layout">
      <div className="orders-settings-main">
        <div className="orders-settings-heading">
          <div>
            <h3>Orders Sheet Fields</h3>
            <p>Control which fields appear as columns and in what order. Drag columns directly in the table header, or use ↑ ↓ here.</p>
          </div>
          <button className="orders-reset-btn" type="button" onClick={resetLayout}>
            Reset to Default Layout
          </button>
        </div>

        <div className="orders-field-table">
          {state.loading ? (
            <div className="table-state"><div className="spinner" /><span>Loading shared order fields...</span></div>
          ) : null}
          <div className="orders-field-head">
            <span>System Key</span>
            <span>Display Name</span>
            <span className="center">👁</span>
            <span className="center">🎨</span>
            <span className="center">Highlight</span>
            <span className="center">Order</span>
          </div>

          {fields.map((field, index) => (
            <div className="orders-field-row" key={field.key}>
              <code>{field.key}</code>
              <input
                value={field.label}
                disabled={field.fixed}
                onChange={(event) => updateField(field.key, { label: event.target.value })}
              />
              <IconButton
                active={field.visible}
                onClick={() => updateField(field.key, { visible: !field.visible })}
                title={field.visible ? "Visible in orders" : "Hidden from orders"}
              >
                {field.visible ? "⊙" : "⊘"}
              </IconButton>
              <IconButton
                active={field.color}
                onClick={() => updateField(field.key, { color: !field.color })}
                title={field.color ? "Color enabled" : "Color disabled"}
              >
                ◉
              </IconButton>
              <HighlightControl
                field={field}
                onToggle={(checked) => updateField(field.key, {
                  highlight: checked,
                  highlightColor: field.highlightColor || DEFAULT_HIGHLIGHT_COLOR,
                })}
                onColor={(color) => updateField(field.key, {
                  highlight: true,
                  highlightColor: color,
                })}
              />
              <div className="orders-field-order">
                <button type="button" disabled={index === 0} onClick={() => moveField(index, -1)}>↑</button>
                <button type="button" disabled={index === fields.length - 1} onClick={() => moveField(index, 1)}>↓</button>
              </div>
            </div>
          ))}
        </div>

        {state.error ? <div className="error-banner">{state.error}</div> : null}
        {state.message ? <div className="success-banner">{state.message}</div> : null}
        <div className="orders-settings-actions">
          <button className="orders-secondary-btn" type="button" onClick={syncWebLayoutToDesktop} disabled={state.saving}>
            Apply current web layout to all devices
          </button>
          <button className="gen-save-btn" type="button" onClick={saveLayout} disabled={state.saving}>
            {state.saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <aside className="orders-help-card">
        <div className="gen-help-label">Orders Help</div>
        <div className="gen-help-entry">
          <strong>Orders sheet layout</strong>
          <p>This tab controls the columns shown on the main Orders sheet. Use the eye button to show or hide a field, and rename fields here when you want the label updated across the app.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Column order</strong>
          <p>Use the up/down controls here, or drag columns directly in the Orders sheet header. Reset to Default Layout restores the standard order.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Width sync</strong>
          <p>Desktop keeps precise column widths. Web uses the shared percentage profile and adapts it to the browser. Use “Apply current web layout to all devices” only when you intentionally want the web profile shared.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Colors and highlights</strong>
          <p>Palette coloring uses your Pricing rules to tint enabled fields. Highlight color is field-specific and can be used for important columns that should stand out.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Status and Order Info</strong>
          <p>The Status column can be enabled and renamed here. Order Info is a compact column for badges like platform, gift, messages, and multi-item orders.</p>
        </div>
      </aside>
    </div>
  );
}
