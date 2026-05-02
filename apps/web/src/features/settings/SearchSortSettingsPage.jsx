import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { api } from "../../api.js";

const SEARCH_FIELD_GROUPS = [
  { label: "Core", keys: ["order_number", "buyer_name", "price", "quantity"] },
  { label: "Details", keys: ["custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6", "order_date", "ship_by"] },
  { label: "System", keys: ["buyer_email", "shipping_address", "gift_message", "order_notes"] },
];

const DEFAULT_SEARCHABLE = Object.fromEntries(
  SEARCH_FIELD_GROUPS.flatMap((group) => group.keys).map((key) => [
    key,
    ["order_number", "buyer_name", "custom_1", "custom_2", "custom_3"].includes(key),
  ])
);

const DEFAULT_CONFIG = {
  searchableFields: DEFAULT_SEARCHABLE,
  includeOrderInfo: true,
  searchMode: "smart",
  defaultSort: { field: "order_date", direction: "desc" },
};

const DEFAULT_LABELS = {
  order_number: "Order #",
  buyer_name: "Buyer",
  price: "Price",
  quantity: "Qty",
  custom_1: "Pet Name",
  custom_2: "Pet Type",
  custom_3: "Epitaph",
  custom_4: "Dates Of Life",
  custom_5: "Stone Color",
  custom_6: "Stone Type",
  order_date: "Order Date",
  ship_by: "Ship By",
  buyer_email: "Buyer Email",
  shipping_address: "Shipping Address",
  gift_message: "Gift Message",
  order_notes: "Notes",
};

function normalizeConfig(layout = {}) {
  const searchDefaults = layout.search_defaults && typeof layout.search_defaults === "object" ? layout.search_defaults : {};
  const sortDefaults = layout.sort_defaults && typeof layout.sort_defaults === "object" ? layout.sort_defaults : {};
  return {
    searchableFields: {
      ...DEFAULT_CONFIG.searchableFields,
      ...(searchDefaults.searchableFields || {}),
    },
    includeOrderInfo: searchDefaults.includeOrderInfo !== false,
    searchMode: searchDefaults.searchMode === "exact" ? "exact" : "smart",
    defaultSort: {
      field: sortDefaults.field || DEFAULT_CONFIG.defaultSort.field,
      direction: sortDefaults.direction === "asc" ? "asc" : "desc",
    },
  };
}

function getLabelMap(layout = {}) {
  const labels = { ...DEFAULT_LABELS };
  for (const field of layout.fields || []) {
    if (field?.key && field?.label) labels[field.key] = field.label;
  }
  if (layout.status?.columnLabel) labels.status = layout.status.columnLabel;
  return labels;
}

function HelpPanel() {
  return (
    <aside className="orders-help-card">
      <div className="gen-help-label">Search / Sort Help</div>
      <div className="gen-help-entry">
        <strong>Search and sort behavior</strong>
        <p>These settings control how the Orders sheet searches, sorts, and shows extra workflow views.</p>
      </div>
      <div className="gen-help-entry">
        <strong>Searchable fields</strong>
        <p>Turn on the fields users actually search by, such as order number, buyer, dates, or shipping details. Fewer fields can make search results cleaner.</p>
      </div>
      <div className="gen-help-entry">
        <strong>Smart vs exact</strong>
        <p>Smart is best for everyday searching because partial text can match. Exact is stricter and works best when users search complete values.</p>
      </div>
      <div className="gen-help-entry">
        <strong>Default sort</strong>
        <p>Pick the field and direction the Orders sheet should use when it opens or refreshes. Date descending usually keeps newer orders near the top.</p>
      </div>
    </aside>
  );
}

export default function SearchSortSettingsPage({ onSettingsSaved }) {
  const [layout, setLayout] = React.useState(null);
  const [form, setForm] = React.useState(DEFAULT_CONFIG);
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", message: "" });

  React.useEffect(() => {
    let cancelled = false;
    api.get(API_ENDPOINTS.orderFieldLayout).then((sharedLayout) => {
      if (cancelled) return;
      setLayout(sharedLayout);
      setForm(normalizeConfig(sharedLayout));
      setState({ loading: false, saving: false, error: "", message: "" });
    }).catch(() => {
      if (cancelled) return;
      setLayout({});
      setForm(DEFAULT_CONFIG);
      setState({ loading: false, saving: false, error: "", message: "" });
    });
    return () => { cancelled = true; };
  }, []);

  const labelMap = getLabelMap(layout || {});
  const sortableKeys = ["order_date", "ship_by", "buyer_name", "order_number", "price", "quantity", "custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6", "status"];

  function setSearch(key, checked) {
    setForm((current) => ({
      ...current,
      searchableFields: { ...(current.searchableFields || {}), [key]: checked },
    }));
    setState((current) => ({ ...current, error: "", message: "" }));
  }

  function setDefaultSort(patch) {
    setForm((current) => ({ ...current, defaultSort: { ...(current.defaultSort || {}), ...patch } }));
    setState((current) => ({ ...current, error: "", message: "" }));
  }

  async function save() {
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const saved = await api.patch(API_ENDPOINTS.orderFieldLayout, {
        search_defaults: {
          scope: "current",
          searchableFields: form.searchableFields || {},
          includeOrderInfo: form.includeOrderInfo !== false,
          searchMode: form.searchMode === "exact" ? "exact" : "smart",
        },
        sort_defaults: {
          field: form.defaultSort?.field || "order_date",
          direction: form.defaultSort?.direction === "asc" ? "asc" : "desc",
        },
        layout_version: 1,
      });
      setLayout(saved);
      setForm(normalizeConfig(saved));
      setState({ loading: false, saving: false, error: "", message: "Search and sort settings saved and shared with desktop." });
      onSettingsSaved?.();
    } catch (error) {
      setState((current) => ({ ...current, saving: false, error: error?.message || "Could not save search and sort settings.", message: "" }));
    }
  }

  if (state.loading) {
    return (
      <div className="search-sort-layout">
        <main className="search-sort-main">
          <div className="table-state"><div className="spinner" /><span>Loading search and sort settings...</span></div>
        </main>
        <HelpPanel />
      </div>
    );
  }

  return (
    <div className="search-sort-layout">
      <main className="search-sort-main">
        <section className="search-sort-section">
          <h3>Searchable Fields</h3>
          <p>Choose which fields are scanned when you type in the search box.</p>
          {SEARCH_FIELD_GROUPS.map((group) => (
            <div className="search-field-group" key={group.label}>
              <div>{group.label}</div>
              {group.keys.map((key) => (
                <label key={key} className="search-sort-check">
                  <input type="checkbox" checked={!!form.searchableFields?.[key]} onChange={(event) => setSearch(key, event.target.checked)} />
                  <span>{labelMap[key] || key}</span>
                </label>
              ))}
            </div>
          ))}
          <label className="search-sort-info-check">
            <input type="checkbox" checked={form.includeOrderInfo !== false} onChange={(event) => setForm((current) => ({ ...current, includeOrderInfo: event.target.checked }))} />
            <span>
              <strong>Include Order Info</strong>
              <small>Also searches platform badges, gift flags, and notes text.</small>
            </span>
          </label>
        </section>

        <section className="search-sort-section">
          <h3>Search Mode</h3>
          <div className="search-mode-grid">
            {[
              { id: "smart", label: "Smart", desc: "Partial match across selected fields" },
              { id: "exact", label: "Exact", desc: "Strict full-value match" },
            ].map((option) => (
              <label key={option.id} className={form.searchMode === option.id ? "active" : ""}>
                <input type="radio" name="searchMode" checked={form.searchMode === option.id} onChange={() => setForm((current) => ({ ...current, searchMode: option.id }))} />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.desc}</small>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="search-sort-section">
          <h3>Default Sort</h3>
          <p>Applied when orders load or refresh.</p>
          <div className="search-sort-select-row">
            <label>
              <span>Field</span>
              <select value={form.defaultSort?.field || "order_date"} onChange={(event) => setDefaultSort({ field: event.target.value })}>
                {sortableKeys.map((key) => (
                  <option key={key} value={key}>{labelMap[key] || key}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Direction</span>
              <select value={form.defaultSort?.direction || "desc"} onChange={(event) => setDefaultSort({ direction: event.target.value })}>
                <option value="asc">Ascending ↑</option>
                <option value="desc">Descending ↓</option>
              </select>
            </label>
          </div>
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
