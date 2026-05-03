import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { normalizeStatusConfig } from "../../../../../shared/models/statusConfig.mjs";
import { api, ordersApi, settingsApi } from "../../api.js";
import OrdersTable from "./OrdersTable.jsx";
import { DATE_FIELD_KEYS, formatDate } from "../../shared/dateConfig.js";
import { normalizedSearchMatches } from "../../../../../shared/search/dateSearch.mjs";

const DEFAULT_ORDER_SHEET_SIZE = 12;
const ORDER_ROWS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const orderRowsCache = new Map();
const orderRowsInflight = new Map();

const DEFAULT_ORDER_LAYOUT = Object.freeze({
  fields: [
    { key: "status", label: "Status", visibleInOrders: true, paletteEnabled: false },
    { key: "order_info", label: "Order Info", visibleInOrders: true, paletteEnabled: false },
    { key: "order_number", label: "Order #", visibleInOrders: true, paletteEnabled: false },
    { key: "buyer_name", label: "Buyer", visibleInOrders: true, paletteEnabled: true },
    { key: "price", label: "Price", visibleInOrders: true, paletteEnabled: true },
    { key: "quantity", label: "Qty", visibleInOrders: true, paletteEnabled: false },
    { key: "custom_1", label: "Pet Name", visibleInOrders: true, paletteEnabled: true },
    { key: "custom_2", label: "Pet Type", visibleInOrders: true, paletteEnabled: true },
    { key: "custom_3", label: "Epitaph", visibleInOrders: true, paletteEnabled: true },
    { key: "custom_4", label: "Dates Of Life", visibleInOrders: true, paletteEnabled: true },
    { key: "custom_5", label: "Stone Color", visibleInOrders: true, paletteEnabled: true },
    { key: "custom_6", label: "Type", visibleInOrders: false, paletteEnabled: true },
    { key: "shipping_address", label: "Shipping Address", visibleInOrders: false, paletteEnabled: false },
    { key: "order_date", label: "Order Date", visibleInOrders: true, paletteEnabled: false },
    { key: "ship_by", label: "Ship By", visibleInOrders: true, paletteEnabled: false },
    { key: "buyer_email", label: "Buyer Email", visibleInOrders: false, paletteEnabled: false },
    { key: "gift_message", label: "Gift Message", visibleInOrders: false, paletteEnabled: false, highlight: { enabled: true, color: "#fca5a5" } },
    { key: "order_notes", label: "Notes", visibleInOrders: true, paletteEnabled: false },
  ],
  order: [
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
  ],
  status: normalizeStatusConfig({ enabled: true, columnLabel: "Status" }),
});

const DEFAULT_SEARCHABLE_FIELDS = {
  order_number: true,
  buyer_name: true,
  price: false,
  quantity: false,
  custom_1: true,
  custom_2: true,
  custom_3: true,
  custom_4: false,
  custom_5: false,
  custom_6: false,
  order_date: false,
  ship_by: false,
  buyer_email: false,
  shipping_address: false,
  gift_message: false,
  order_notes: false,
};

function normalizeSearchSortConfig(layout = {}) {
  const searchDefaults = layout.searchDefaults || {};
  const sortDefaults = layout.sortDefaults || {};
  return {
    searchableFields: {
      ...DEFAULT_SEARCHABLE_FIELDS,
      ...(searchDefaults.searchableFields || {}),
    },
    includeOrderInfo: searchDefaults.includeOrderInfo !== false,
    searchMode: searchDefaults.searchMode === "exact" ? "exact" : "smart",
    defaultSort: {
      field: sortDefaults.field || "order_date",
      direction: sortDefaults.direction === "asc" ? "asc" : "desc",
    },
  };
}

function parseSortDate(value) {
  if (!value) return 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Date(year, month - 1, day).getTime() || 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function normalizeSearchText(value) {
  return String(value ?? "").toLowerCase().trim();
}

function getOrderInfoSearchValues(row) {
  const values = [];
  const platform = String(row.platform || row.source || row.marketplace || "").trim();
  if (platform && !platform.toLowerCase().includes("etsy")) values.push(platform);
  if (Number(row._item_count || 1) > 1) values.push(`${row._item_count} items`);
  if (row.gift || row.is_gift) values.push("gift");
  if (row.gift_message) values.push("message", row.gift_message);
  if (row.gift_wrapped || row.gift_wrap) values.push("wrapped");
  return values;
}

function getOrderInfoDisplayValues(row) {
  const values = [];
  const platform = String(row.platform || row.source || row.marketplace || "").trim().toLowerCase();
  if (platform && !platform.includes("etsy")) {
    if (platform.includes("shopify")) values.push("Shopify");
    else if (platform.includes("woo") || platform.includes("web") || platform.includes("website")) values.push("Website");
  }
  if (Number(row._item_count || 1) > 1) values.push(`${row._item_count} items`);
  if (row.gift || row.is_gift) values.push("Gift");
  if (row.gift_message) values.push("Message");
  if (row.gift_wrapped || row.gift_wrap) values.push("Wrapped");
  return values;
}

function getSearchValues(row, key, dateConfig, pricingRules) {
  if (key === "order_info") return getOrderInfoSearchValues(row);
  const raw = row[key];
  const values = [];
  if (raw !== null && raw !== undefined && raw !== "") values.push(raw);
  if (DATE_FIELD_KEYS.has(key)) values.push(formatDate(raw, dateConfig));
  if (key === "custom_6" && !raw) {
    const price = parseFloat(String(row.price || "").replace(/[^0-9.]/g, ""));
    const match = pricingRules.find((rule) => {
      const rulePrice = parseFloat(String(rule.price || "").replace(/[^0-9.]/g, ""));
      return Number.isFinite(price) && Number.isFinite(rulePrice) && Math.abs(price - rulePrice) < 0.001;
    });
    if (match?.typeValue) values.push(match.typeValue);
  }
  return values;
}

function matchesSearch(row, query, config, dateConfig, pricingRules, excludedColumns = new Set()) {
  if (!normalizeSearchText(query)) return true;
  const keys = Object.entries(config.searchableFields || {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
  if (config.includeOrderInfo !== false) keys.push("order_info");
  const searchableKeys = keys
    .filter((key) => !excludedColumns.has(key))
    .filter((key, index, array) => array.indexOf(key) === index);
  const values = searchableKeys.flatMap((key) => getSearchValues(row, key, dateConfig, pricingRules))
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(normalizeSearchText);
  return normalizedSearchMatches(query, values, config.searchMode);
}

function getSortValue(row, field, dateConfig, pricingRules) {
  if (field === "status") return row.item_status || row.status || "";
  const values = getSearchValues(row, field, dateConfig, pricingRules);
  return values[0] ?? "";
}

function compareRows(a, b, sortConfig, dateConfig, pricingRules) {
  const field = sortConfig?.field || "order_date";
  const direction = sortConfig?.direction === "asc" ? 1 : -1;
  const av = getSortValue(a, field, dateConfig, pricingRules);
  const bv = getSortValue(b, field, dateConfig, pricingRules);
  let result = 0;
  if (DATE_FIELD_KEYS.has(field)) {
    result = parseSortDate(av) - parseSortDate(bv);
  } else if (field === "price" || field === "quantity") {
    result = (parseFloat(String(av).replace(/[^0-9.-]/g, "")) || 0) - (parseFloat(String(bv).replace(/[^0-9.-]/g, "")) || 0);
  } else {
    result = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
  }
  return result * direction;
}

function normalizeWidthProfile(layout) {
  const profiles = layout?.column_width_profiles && typeof layout.column_width_profiles === "object"
    ? Object.values(layout.column_width_profiles).filter((profile) => profile && typeof profile === "object")
    : [];
  const profile = profiles.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""))[0];
  const columns = profile?.columns && typeof profile.columns === "object" ? profile.columns : null;
  if (!columns) return {};
  return Object.fromEntries(
    Object.entries(columns)
      .map(([key, value]) => [key, Number(value?.percent)])
      .filter(([key, percent]) => key && Number.isFinite(percent) && percent > 0)
  );
}

function normalizeOrderLayout(layout) {
  const source = layout && typeof layout === "object" ? layout : DEFAULT_ORDER_LAYOUT;
  const widthProfile = normalizeWidthProfile(source);
  const fieldMap = new Map((source.fields || []).map((field) => [field.key, field]));
  const defaultMap = new Map(DEFAULT_ORDER_LAYOUT.fields.map((field) => [field.key, field]));
  const statusConfig = normalizeStatusConfig(source.status);
  const statusField = {
    key: "status",
    label: statusConfig.columnLabel || "Status",
    visibleInOrders: statusConfig.enabled !== false,
  };
  const order = Array.isArray(source.order) && source.order.length ? source.order : DEFAULT_ORDER_LAYOUT.order;
  const fields = [
    ...order.map((key) => {
      if (key === "status") return statusField;
      const incoming = fieldMap.get(key);
      const fallback = defaultMap.get(key);
      return incoming || fallback || null;
    }).filter(Boolean),
    ...DEFAULT_ORDER_LAYOUT.fields
      .filter((field) => !order.includes(field.key))
      .map((field) => fieldMap.get(field.key) || field),
    ...[...fieldMap.values()].filter((field) => !order.includes(field.key) && !defaultMap.has(field.key)),
  ];
  return {
    fields: fields.map((field) => ({
      key: field.key,
      label: field.label || field.key,
      visibleInOrders: field.visibleInOrders !== false,
      paletteEnabled: field.paletteEnabled ?? defaultMap.get(field.key)?.paletteEnabled ?? false,
      highlight: field.highlight && typeof field.highlight === "object"
        ? field.highlight
        : (defaultMap.get(field.key)?.highlight || {}),
      widthPercent: widthProfile[field.key],
    })),
    sortDefaults: source.sort_defaults || {},
    searchDefaults: source.search_defaults || {},
    status: statusConfig,
  };
}

function filterRows(rows, filter) {
  if (filter === "gift") return rows.filter((row) => row.is_gift || row.gift_wrap || row.gift_message);
  if (filter === "has_notes") return rows.filter((row) => row.order_notes || row.gift_message);
  if (filter === "needs_status") return rows.filter((row) => !row.item_status);
  return rows;
}

function isCompletedRow(row) {
  return row.item_status === "completed" || row.status === "completed" || row.status === "done";
}

function isInventoryNeededRow(row) {
  if (isCompletedRow(row) || row.status === "archived") return false;
  return !row.item_status || row.item_status === "pending";
}

function attachOrderItemCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row.order_id || row.id || "");
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return rows.map((row) => ({
    ...row,
    _item_count: counts.get(String(row.order_id || row.id || "")) || 1,
  }));
}

function getOrdersCacheKey({ tab }) {
  return JSON.stringify({
    tab,
  });
}

async function loadRowsForTab(tab) {
  const cacheKey = getOrdersCacheKey({ tab });
  const cached = orderRowsCache.get(cacheKey);
  if (cached?.rows && Date.now() - cached.updatedAt < ORDER_ROWS_CACHE_MAX_AGE_MS) {
    return cached.rows;
  }
  const apiStatus = tab === "inventory" ? "active" : tab;
  const fetchPromise = orderRowsInflight.get(cacheKey) || ordersApi.list({ status: apiStatus });
  orderRowsInflight.set(cacheKey, fetchPromise);
  try {
    const result = attachOrderItemCounts(await fetchPromise);
    const nextRows = tab === "inventory" ? result.filter(isInventoryNeededRow) : result;
    orderRowsCache.set(cacheKey, { rows: nextRows, updatedAt: Date.now() });
    return nextRows;
  } finally {
    orderRowsInflight.delete(cacheKey);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getCellText(row, key, dateConfig, pricingRules) {
  if (key === "order_info") {
    return getOrderInfoDisplayValues(row).join(", ");
  }
  const values = getSearchValues(row, key, dateConfig, pricingRules);
  return values[0] ?? "";
}

export default function OrdersPage({
  scope,
  activeTab,
  onTabChange,
  onSelectOrder,
  showCompletedTab = true,
  layoutRefreshKey = 0,
  ordersRefreshKey = 0,
  search = "",
  filter = "all",
  sortField = "order_date",
  sortDirection = "asc",
  sheetSize = DEFAULT_ORDER_SHEET_SIZE,
  onRegisterPrint,
  onSearchCountsChange,
  onClearSearch,
}) {
  // Support both controlled (activeTab/onTabChange from parent) and uncontrolled (scope prop alone)
  const [localTab, setLocalTab] = React.useState(scope || "active");
  const currentTab = activeTab || localTab;
  function setTab(next) {
    // If completed tab is being hidden and we're on it, bounce back to active
    if (next === "completed" && !showCompletedTab) next = "active";
    setLocalTab(next);
    onTabChange?.(next);
  }

  // If completed tab is hidden while we're viewing it, jump to active
  React.useEffect(() => {
    if (!showCompletedTab && currentTab === "completed") setTab("active");
  }, [showCompletedTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const [rows, setRows] = React.useState([]);
  const [layout, setLayout] = React.useState(() => normalizeOrderLayout(null));
  const [pricingRules, setPricingRules] = React.useState([]);
  const [dateConfig, setDateConfig] = React.useState(null);
  const [printConfig, setPrintConfig] = React.useState(null);
  const [state, setState] = React.useState({ loading: true, error: "" });
  const [savingStatusIds, setSavingStatusIds] = React.useState(() => new Set());
  const [searchExcludedColumns, setSearchExcludedColumns] = React.useState(() => new Set());
  const loadSeqRef = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    settingsApi.getDateConfig().then((config) => {
      if (!cancelled) setDateConfig(config);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [layoutRefreshKey]);

  const loadOrders = React.useCallback(async () => {
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    const cacheKey = getOrdersCacheKey({ tab: currentTab });
    const cached = orderRowsCache.get(cacheKey);
    const now = Date.now();
    if (cached?.rows) {
      setRows(cached.rows);
      setState({ loading: false, error: "" });
      if (now - cached.updatedAt < ORDER_ROWS_CACHE_MAX_AGE_MS && !orderRowsInflight.has(cacheKey)) {
        return;
      }
    } else {
      setState({ loading: true, error: "" });
    }

    try {
      const nextRows = await loadRowsForTab(currentTab);
      if (loadSeqRef.current !== seq) return;
      setRows(nextRows);
      setState({ loading: false, error: "" });
    } catch (error) {
      orderRowsInflight.delete(cacheKey);
      if (loadSeqRef.current !== seq) return;
      setState({
        loading: false,
        error: cached?.rows ? "" : (error?.message || "Could not load orders."),
      });
    }
  }, [currentTab, ordersRefreshKey]);

  React.useEffect(() => {
    const timer = window.setTimeout(loadOrders, 180);
    return () => window.clearTimeout(timer);
  }, [loadOrders]);

  React.useEffect(() => {
    let cancelled = false;
    api.get(API_ENDPOINTS.orderFieldLayout).then((sharedLayout) => {
      if (!cancelled) setLayout(normalizeOrderLayout(sharedLayout));
    }).catch(() => {
      if (!cancelled) setLayout(normalizeOrderLayout(null));
    });
    return () => { cancelled = true; };
  }, [layoutRefreshKey]);

  React.useEffect(() => {
    let cancelled = false;
    async function refreshSharedLayout() {
      try {
        const sharedLayout = await api.get(API_ENDPOINTS.orderFieldLayout);
        if (!cancelled) setLayout(normalizeOrderLayout(sharedLayout));
      } catch (_) {}
    }
    function refreshFromOtherSurface() {
      orderRowsCache.clear();
      refreshSharedLayout();
      loadOrders();
    }
    function handleVisibilityChange() {
      if (!document.hidden) refreshFromOtherSurface();
    }
    window.addEventListener("focus", refreshFromOtherSurface);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshFromOtherSurface);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadOrders]);

  React.useEffect(() => {
    let cancelled = false;
    api.get(API_ENDPOINTS.pricingRules).then((pricing) => {
      if (!cancelled) setPricingRules(Array.isArray(pricing?.rules) ? pricing.rules : []);
    }).catch(() => {
      if (!cancelled) setPricingRules([]);
    });
    return () => { cancelled = true; };
  }, [layoutRefreshKey]);

  React.useEffect(() => {
    let cancelled = false;
    api.get(API_ENDPOINTS.printConfig).then((config) => {
      if (!cancelled) setPrintConfig(config || null);
    }).catch(() => {
      if (!cancelled) setPrintConfig(null);
    });
    return () => { cancelled = true; };
  }, [layoutRefreshKey]);

  const searchSortConfig = React.useMemo(() => normalizeSearchSortConfig(layout), [layout]);
  React.useEffect(() => {
    if (!search.trim() && searchExcludedColumns.size) {
      setSearchExcludedColumns(new Set());
    }
  }, [search, searchExcludedColumns.size]);

  const searchableColumnKeys = React.useMemo(() => {
    const keys = Object.entries(searchSortConfig.searchableFields || {})
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);
    if (searchSortConfig.includeOrderInfo !== false) keys.push("order_info");
    return keys.filter((key, index, array) => array.indexOf(key) === index);
  }, [searchSortConfig.includeOrderInfo, searchSortConfig.searchableFields]);

  function excludeSearchColumn(columnKey) {
    setSearchExcludedColumns((current) => {
      const next = new Set(current);
      next.add(columnKey);
      return next;
    });
  }

  const activeSort = React.useMemo(() => {
    const field = sortField || searchSortConfig.defaultSort?.field || "order_date";
    const direction = sortDirection === "desc" ? "desc" : "asc";
    return { field, direction };
  }, [searchSortConfig.defaultSort?.field, sortDirection, sortField]);
  const visibleRows = React.useMemo(() => (
    filterRows(rows, filter)
      .filter((row) => matchesSearch(row, search, searchSortConfig, dateConfig, pricingRules, searchExcludedColumns))
      .slice()
      .sort((a, b) => compareRows(a, b, activeSort, dateConfig, pricingRules))
  ), [activeSort, dateConfig, filter, pricingRules, rows, search, searchExcludedColumns, searchSortConfig]);

  React.useEffect(() => {
    const query = search.trim();
    if (!query) {
      onSearchCountsChange?.({});
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const [activeRows, completedRows, inventoryRows] = await Promise.all([
          loadRowsForTab("active"),
          loadRowsForTab("completed"),
          loadRowsForTab("inventory"),
        ]);
        if (cancelled) return;
        const countMatches = (items) => items.filter((row) => matchesSearch(row, query, searchSortConfig, dateConfig, pricingRules, searchExcludedColumns)).length;
        onSearchCountsChange?.({
          active: countMatches(activeRows),
          completed: countMatches(completedRows),
          inventory: countMatches(inventoryRows),
        });
      } catch {
        if (!cancelled) onSearchCountsChange?.({});
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dateConfig, onSearchCountsChange, pricingRules, search, searchExcludedColumns, searchSortConfig]);

  async function updateItemWorkflowStatus(row, nextStatus) {
    const itemId = String(row?.id || "").trim();
    if (!itemId) return;
    const previousStatus = row.item_status || "";
    const normalizedNext = nextStatus || "";
    setSavingStatusIds((current) => new Set(current).add(itemId));
    setState((current) => ({ ...current, error: "" }));
    setRows((current) => current.map((item) => (
      String(item.id) === itemId ? { ...item, item_status: normalizedNext } : item
    )));
    try {
      await ordersApi.updateItemStatus(itemId, normalizedNext || null);
      for (const [cacheKey, cached] of orderRowsCache.entries()) {
        if (!cached?.rows) continue;
        orderRowsCache.set(cacheKey, {
          ...cached,
          rows: cached.rows.map((item) => (
            String(item.id) === itemId ? { ...item, item_status: normalizedNext } : item
          )),
        });
      }
    } catch (error) {
      setRows((current) => current.map((item) => (
        String(item.id) === itemId ? { ...item, item_status: previousStatus } : item
      )));
      setState((current) => ({
        ...current,
        error: error?.message || "Could not update item status.",
      }));
    } finally {
      setSavingStatusIds((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  }

  const printCurrentSheet = React.useCallback(() => {
    const config = printConfig || {};
    const printableColumns = (layout.fields || []).filter((field) => (
      field.visibleInOrders !== false && config.columns?.[field.key] !== false
    ));
    const cardOrder = Array.isArray(config.cardOrder) ? config.cardOrder : [];
    const cardIndex = new Map(cardOrder.map((key, index) => [key, index]));
    const orderedCardColumns = [...printableColumns].sort((a, b) => (
      (cardIndex.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (cardIndex.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    ));
    const mode = config.mode === "card" ? "card" : "sheet";
    const orientation = config.orientation === "landscape" ? "landscape" : "portrait";
    const headerHtml = printableColumns.map((column) => `<th class="col-${column.key}">${escapeHtml(column.label || column.key)}</th>`).join("");
    const columnCss = printableColumns.map((column) => (
      `.col-${column.key} { ${config.wrap?.[column.key] ? "white-space: normal; overflow-wrap: anywhere;" : "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"} }`
    )).join("\n");
    const rowsHtml = visibleRows.length
      ? visibleRows.map((row) => {
          const cells = printableColumns.map((column) => `<td class="col-${column.key}">${escapeHtml(getCellText(row, column.key, dateConfig, pricingRules) || "—")}</td>`).join("");
          return `<tr>${cells}</tr>`;
        }).join("")
      : `<tr><td colspan="${Math.max(1, printableColumns.length)}">No orders to print</td></tr>`;
    const cardsHtml = visibleRows.length && orderedCardColumns.length
      ? visibleRows.map((row) => (
          `<section class="order-card">${orderedCardColumns.map((column) => (
            `<div class="card-field"><strong>${escapeHtml(column.label || column.key)}</strong><span>${escapeHtml(getCellText(row, column.key, dateConfig, pricingRules) || "—")}</span></div>`
          )).join("")}</section>`
        )).join("")
      : `<div class="empty-print">${visibleRows.length ? "No print fields are enabled" : "No orders to print"}</div>`;
    const html = `<!doctype html>
<html>
  <head>
    <title>Spaila Orders Print</title>
    <style>
      @page { size: ${orientation}; margin: 0.35in; }
      body { margin: 24px; font-family: "Segoe UI", sans-serif; color: #111827; }
      h1 { font-size: 18px; margin: 0 0 14px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      th { background: #e5e5e5; color: #475569; font-size: 11px; text-align: left; text-transform: uppercase; }
      th, td { border: 1px solid #d1d5db; padding: 6px 7px; vertical-align: top; overflow-wrap: anywhere; }
      td { font-size: 12px; }
      ${columnCss}
      .cards { display: grid; grid-template-columns: ${orientation === "landscape" ? "1fr 1fr" : "1fr"}; gap: 12px; }
      .order-card { break-inside: avoid; border: 1px solid #d1d5db; border-radius: 8px; padding: 12px; display: grid; gap: 8px; }
      .card-field { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 8px; font-size: 12px; }
      .card-field strong { color: #475569; }
      .empty-print { color: #64748b; font-size: 13px; }
    </style>
  </head>
  <body>
    <h1>${mode === "card" ? "Spaila Order Cards" : "Spaila Orders"}</h1>
    ${mode === "card" ? `<div class="cards">${cardsHtml}</div>` : `<table>
      <thead><tr>${headerHtml}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`}
    <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script>
  </body>
</html>`;
    const printWindow = window.open("", "_blank", "width=1100,height=800");
    if (!printWindow) return;
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  }, [dateConfig, layout.fields, pricingRules, printConfig, visibleRows]);

  React.useEffect(() => {
    if (!onRegisterPrint) return undefined;
    onRegisterPrint(() => printCurrentSheet);
    return () => onRegisterPrint(null);
  }, [onRegisterPrint, printCurrentSheet]);

  return (
    <section className="orders-page">
      {currentTab === "inventory" ? (
        <div className="info-banner">
          Inventory Needed summarizes active orders only. Completed and archived orders are excluded.
        </div>
      ) : null}

      {search.trim() ? (
        <div className="orders-search-banner">
          <span>
            Showing filtered <strong>{currentTab}</strong> results for <strong>{search.trim()}</strong>.
          </span>
          <button type="button" onClick={onClearSearch}>
            Clear search
          </button>
        </div>
      ) : null}

      {state.error ? <div className="error-banner">{state.error}</div> : null}
      <OrdersTable
        orders={visibleRows}
        loading={state.loading && rows.length === 0}
        onSelectOrder={onSelectOrder}
        onStatusChange={updateItemWorkflowStatus}
        savingStatusIds={savingStatusIds}
        layout={layout}
        statusConfig={layout.status}
        sheetSize={sheetSize}
        dateConfig={dateConfig}
        pricingRules={pricingRules}
        searchActive={!!search.trim()}
        searchableColumnKeys={searchableColumnKeys}
        excludedSearchColumns={searchExcludedColumns}
        onExcludeSearchColumn={excludeSearchColumn}
      />
    </section>
  );
}
