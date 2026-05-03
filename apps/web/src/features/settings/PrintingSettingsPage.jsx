import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { api } from "../../api.js";

const DEFAULT_ORDER = [
  "status",
  "order_info",
  "order_number",
  "buyer_name",
  "price",
  "quantity",
  "custom_1",
  "custom_2",
  "custom_3",
  "custom_4",
  "custom_5",
  "custom_6",
  "shipping_address",
  "order_date",
  "ship_by",
  "buyer_email",
  "gift_message",
  "order_notes",
];

const DEFAULT_LABELS = {
  status: "Status",
  order_info: "Order Info",
  order_number: "Order #",
  buyer_name: "Buyer",
  price: "Price",
  quantity: "Qty",
  custom_1: "Pet Name",
  custom_2: "Pet Type",
  custom_3: "Epitaph",
  custom_4: "Dates Of Life",
  custom_5: "Stone Color",
  custom_6: "Type",
  shipping_address: "Shipping Address",
  order_date: "Order Date",
  ship_by: "Ship By",
  buyer_email: "Buyer Email",
  gift_message: "Gift Message",
  order_notes: "Notes",
};

function normalizePrintConfig(config = {}) {
  return {
    mode: config.mode === "card" ? "card" : "sheet",
    orientation: config.orientation === "landscape" ? "landscape" : "portrait",
    columns: config.columns && typeof config.columns === "object" ? config.columns : {},
    wrap: config.wrap && typeof config.wrap === "object" ? config.wrap : { order_info: true },
    cardOrder: Array.isArray(config.cardOrder) ? config.cardOrder : DEFAULT_ORDER,
  };
}

function layoutToColumns(layout) {
  const fields = Array.isArray(layout?.fields) ? layout.fields : [];
  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  const order = Array.isArray(layout?.order) && layout.order.length ? layout.order : DEFAULT_ORDER;
  const status = {
    key: "status",
    label: layout?.status?.columnLabel || "Status",
    visibleInOrders: layout?.status?.enabled !== false,
  };
  return order
    .map((key) => {
      if (key === "status") return status;
      if (key === "order_info") return { key, label: "Order Info", visibleInOrders: true };
      const field = fieldMap.get(key);
      return {
        key,
        label: field?.label || DEFAULT_LABELS[key] || key,
        visibleInOrders: field?.visibleInOrders !== false,
      };
    })
    .filter((field) => field.visibleInOrders !== false);
}

function orderedForCards(columns, config) {
  if (config.mode !== "card") return columns;
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const seen = new Set();
  const orderedKeys = [...(config.cardOrder || []), ...columns.map((column) => column.key)]
    .filter((key) => byKey.has(key) && !seen.has(key) && seen.add(key));
  return orderedKeys.map((key) => byKey.get(key));
}

export default function PrintingSettingsPage({ onSettingsSaved }) {
  const [columns, setColumns] = React.useState([]);
  const [config, setConfig] = React.useState(() => normalizePrintConfig());
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", message: "" });

  React.useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.get(API_ENDPOINTS.orderFieldLayout),
      api.get(API_ENDPOINTS.printConfig),
    ]).then(([layoutResult, printResult]) => {
      if (cancelled) return;
      if (layoutResult.status === "fulfilled") setColumns(layoutToColumns(layoutResult.value));
      if (printResult.status === "fulfilled") setConfig(normalizePrintConfig(printResult.value));
      setState({ loading: false, saving: false, error: "", message: "" });
    }).catch(() => {
      if (!cancelled) setState({ loading: false, saving: false, error: "Could not load printing settings.", message: "" });
    });
    return () => { cancelled = true; };
  }, []);

  const isCardMode = config.mode === "card";
  const displayColumns = orderedForCards(columns, config);

  function updateColumn(key, value) {
    setConfig((current) => ({ ...current, columns: { ...current.columns, [key]: value } }));
  }

  function updateWrap(key, value) {
    setConfig((current) => ({ ...current, wrap: { ...current.wrap, [key]: value } }));
  }

  function moveCardField(key, direction) {
    setConfig((current) => {
      const available = new Set(columns.map((column) => column.key));
      const seen = new Set();
      const order = [...(current.cardOrder || []), ...columns.map((column) => column.key)]
        .filter((candidate) => available.has(candidate) && !seen.has(candidate) && seen.add(candidate));
      const index = order.indexOf(key);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return current;
      const nextOrder = [...order];
      [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
      return { ...current, cardOrder: nextOrder };
    });
  }

  async function savePrinting() {
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const saved = await api.patch(API_ENDPOINTS.printConfig, { ...config, layout_version: 1 });
      setConfig(normalizePrintConfig(saved));
      setState({ loading: false, saving: false, error: "", message: "Printing settings saved and shared with desktop." });
      onSettingsSaved?.();
    } catch (error) {
      setState({ loading: false, saving: false, error: error?.message || "Could not save printing settings.", message: "" });
    }
  }

  return (
    <div className="printing-settings-layout">
      <div className="printing-settings-main">
        <div className="orders-settings-heading">
          <div>
            <h3>Printing Fields</h3>
            <p>Choose which columns from the Orders sheet should be included in PDFs and printouts. Only visible Orders sheet fields appear here.</p>
          </div>
        </div>

        {state.loading ? <div className="table-state"><div className="spinner" /><span>Loading printing settings...</span></div> : null}

        <section className="printing-option-section">
          <h4>Print format</h4>
          <div className="printing-choice-grid">
            {[
              { value: "sheet", label: "Orders sheet", desc: "Print the current filtered Orders sheet as rows." },
              { value: "card", label: "Order cards", desc: "Print filtered orders as cards." },
            ].map((option) => (
              <label key={option.value} className={config.mode === option.value ? "selected" : ""}>
                <input type="radio" name="printMode" checked={config.mode === option.value} onChange={() => setConfig((current) => ({ ...current, mode: option.value }))} />
                <span><strong>{option.label}</strong><small>{option.desc}</small></span>
              </label>
            ))}
          </div>
        </section>

        <section className="printing-option-section">
          <h4>Page orientation</h4>
          <div className="printing-choice-grid">
            {[
              { value: "portrait", label: "Portrait", desc: "Best for shorter field sets." },
              { value: "landscape", label: "Landscape", desc: "Wider layout for more columns." },
            ].map((option) => (
              <label key={option.value} className={config.orientation === option.value ? "selected" : ""}>
                <input type="radio" name="printOrientation" checked={config.orientation === option.value} onChange={() => setConfig((current) => ({ ...current, orientation: option.value }))} />
                <span><strong>{option.label}</strong><small>{option.desc}</small></span>
              </label>
            ))}
          </div>
        </section>

        <div className="printing-field-table">
          <div className={`printing-field-head${isCardMode ? " card" : ""}`}>
            <span>Display Name</span>
            <span>Print</span>
            <span>Wrap If Needed</span>
            {isCardMode ? <span>Card Order</span> : null}
          </div>
          {displayColumns.length ? displayColumns.map((column, index) => (
            <div className={`printing-field-row${isCardMode ? " card" : ""}`} key={column.key}>
              <span>{column.label}</span>
              <input type="checkbox" checked={config.columns?.[column.key] !== false} onChange={(event) => updateColumn(column.key, event.target.checked)} />
              <input type="checkbox" checked={!!config.wrap?.[column.key]} onChange={(event) => updateWrap(column.key, event.target.checked)} />
              {isCardMode ? (
                <div className="printing-card-order">
                  <button type="button" disabled={index === 0} onClick={() => moveCardField(column.key, -1)}>Up</button>
                  <button type="button" disabled={index === displayColumns.length - 1} onClick={() => moveCardField(column.key, 1)}>Down</button>
                </div>
              ) : null}
            </div>
          )) : (
            <div className="printing-empty">No Orders sheet fields are currently visible.</div>
          )}
        </div>

        {state.error ? <div className="error-banner">{state.error}</div> : null}
        {state.message ? <div className="success-banner">{state.message}</div> : null}
        <div className="orders-settings-actions">
          <button className="gen-save-btn" type="button" onClick={savePrinting} disabled={state.saving}>
            {state.saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <aside className="orders-help-card">
        <div className="gen-help-label">Printing Help</div>
        <div className="gen-help-entry">
          <strong>Printing orders</strong>
          <p>Orders sheet prints the current searched, filtered order rows as a table. Order cards print filtered orders as packing-style cards.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Field selection</strong>
          <p>Use Print to include fields and Wrap if needed for cells that should break onto multiple lines.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Shared with desktop</strong>
          <p>Saving here updates the shared Spaila profile so desktop and web use the same print behavior.</p>
        </div>
      </aside>
    </div>
  );
}
