import React from "react";
import OrderStatusBadge from "./OrderStatusBadge.jsx";
import { DATE_FIELD_KEYS, formatDate } from "../../shared/dateConfig.js";

const WEB_WIDTH_PROFILE_KEY = "spaila_web_column_width_profile";
const PRICE_TYPE_FIELD_KEY = "custom_6";

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

function matchPriceRule(priceStr, pricingRules) {
  if (!priceStr || !pricingRules?.length) return null;
  const num = parseFloat(String(priceStr).replace(/[^0-9.]/g, ""));
  if (Number.isNaN(num)) return null;
  return pricingRules.find((rule) => {
    const ruleNum = parseFloat(String(rule.price).replace(/[^0-9.]/g, ""));
    return !Number.isNaN(ruleNum) && Math.abs(ruleNum - num) < 0.001;
  }) || null;
}

function normalizePlatform(raw) {
  if (!raw) return "etsy";
  const value = String(raw).toLowerCase();
  if (value.includes("etsy")) return "etsy";
  if (value.includes("woo") || value.includes("web") || value.includes("website")) return "website";
  if (value.includes("shopify")) return "shopify";
  return "unknown";
}

const PLATFORM_LABELS = { website: "Website", shopify: "Shopify", unknown: null };

function getOrderInfoBadges(row) {
  const badges = [];
  const platform = normalizePlatform(row.platform || row.source || row.marketplace);
  if (platform !== "etsy") {
    const label = PLATFORM_LABELS[platform];
    if (label) badges.push({ key: "platform", label, bg: "#f3f4f6", color: "#6b7280" });
  }

  const itemCount = Number(row._item_count || 1);
  if (itemCount > 1) {
    badges.push({ key: "qty", label: `${itemCount} items`, bg: "#e0f2fe", color: "#0369a1" });
  }

  if (row.gift || row.is_gift) {
    badges.push({ key: "gift", label: "Gift", bg: "#fef3c7", color: "#92400e" });
  }
  if (row.gift_message) {
    badges.push({ key: "msg", label: "Message", bg: "#f0fdf4", color: "#166534" });
  }
  if (row.gift_wrapped || row.gift_wrap) {
    badges.push({ key: "wrap", label: "Wrapped", bg: "#faf5ff", color: "#6b21a8" });
  }
  return badges;
}

function OrderInfoCell({ row }) {
  const badges = getOrderInfoBadges(row);
  if (!badges.length) return <span className="orders-cell-muted">—</span>;
  return (
    <div className="orders-info-badges">
      {badges.map((badge) => (
        <span
          key={badge.key}
          style={{ background: badge.bg, color: badge.color }}
        >
          {badge.label}
        </span>
      ))}
    </div>
  );
}

function fieldValue(row, key, dateConfig, priceRule = null) {
  if (key === "status") return <OrderStatusBadge status={row.status} itemStatus={row.item_status} />;
  if (key === "order_info") return <OrderInfoCell row={row} />;
  if (DATE_FIELD_KEYS.has(key)) return formatDate(row[key], dateConfig);
  let value = row[key];
  if (key === PRICE_TYPE_FIELD_KEY && !value && priceRule?.typeValue) {
    value = priceRule.typeValue;
  }
  return value === null || value === undefined || value === "" ? "—" : value;
}

function cellStyle(row, column, priceRule) {
  if (column.key === "status" || column.key === "order_info") return undefined;
  const highlight = column.highlight || {};
  const rawValue = row[column.key];
  const highlightBg = highlight.enabled && highlight.color && rawValue ? highlight.color : null;
  const paletteBg = priceRule && column.paletteEnabled ? priceRule.color : null;
  const background = highlightBg || paletteBg || null;
  const displayValue = column.key === PRICE_TYPE_FIELD_KEY && !rawValue && priceRule?.typeValue
    ? priceRule.typeValue
    : rawValue;
  return {
    background: background || undefined,
    color: background ? contrastColor(background) : (displayValue ? "#334155" : "#94a3b8"),
    fontStyle: !rawValue && column.key === PRICE_TYPE_FIELD_KEY && priceRule?.typeValue ? "italic" : undefined,
  };
}

function readLocalWidthProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(WEB_WIDTH_PROFILE_KEY) || "null");
    return saved?.columns && typeof saved.columns === "object" ? saved : null;
  } catch {
    return null;
  }
}

function profileToPercents(profile) {
  const columns = profile?.columns && typeof profile.columns === "object" ? profile.columns : null;
  if (!columns) return {};
  return Object.fromEntries(
    Object.entries(columns)
      .map(([key, value]) => [key, Number(value?.percent)])
      .filter(([key, percent]) => key && Number.isFinite(percent) && percent > 0)
  );
}

function profileToPixels(profile) {
  const columns = profile?.columns && typeof profile.columns === "object" ? profile.columns : null;
  if (!columns) return {};
  return Object.fromEntries(
    Object.entries(columns)
      .map(([key, value]) => [key, Number(value?.rawWebPx)])
      .filter(([key, width]) => key && Number.isFinite(width) && width > 0)
  );
}

function saveLocalWidthProfile(columns) {
  const total = columns.reduce((sum, column) => sum + Number(column.widthPx || 0), 0);
  if (!total) return;
  const profile = {
    source: "web",
    unit: "percent",
    tolerance: 0.02,
    promoted: false,
    updatedAt: new Date().toISOString(),
    columns: Object.fromEntries(
      columns.map((column) => [
        column.key,
        {
          percent: Number((column.widthPx / total).toFixed(4)),
          rawWebPx: Math.round(column.widthPx),
        },
      ])
    ),
  };
  try {
    localStorage.setItem(WEB_WIDTH_PROFILE_KEY, JSON.stringify(profile));
  } catch (_) {}
  return profile;
}

function getPreferredWidth(column, sheetScale) {
  if (column.key === "order_info") return Math.round(160 * sheetScale);
  if (column.key === "status") return Math.round(100 * sheetScale);
  return Math.round(120 * sheetScale);
}

function buildAdaptiveColumns(fields, localProfile, sheetScale = 1) {
  const columns = fields.map((field) => ({ ...field }));
  const localPercents = profileToPercents(localProfile);
  const localPixels = profileToPixels(localProfile);
  const explicitTotal = columns.reduce((sum, column) => {
    const percent = Number(localPercents[column.key] || column.widthPercent);
    return sum + (Number.isFinite(percent) && percent > 0 ? percent : 0);
  }, 0);
  const missing = columns.filter((column) => {
    const percent = Number(localPercents[column.key] || column.widthPercent);
    return !Number.isFinite(percent) || percent <= 0;
  });
  const fallbackPercent = missing.length ? Math.max(0.04, (Math.max(0, 1 - explicitTotal) || 1) / missing.length) : 0;
  const normalizedTotal = explicitTotal + (fallbackPercent * missing.length);
  return columns.map((column) => {
    const rawPercent = Number(localPercents[column.key] || column.widthPercent);
    const percent = Number.isFinite(rawPercent) && rawPercent > 0 ? rawPercent : fallbackPercent;
    const localPx = Number(localPixels[column.key]);
    const widthPx = Number.isFinite(localPx) && localPx > 0
      ? Math.max(40, Math.round(localPx))
      : Math.max(getPreferredWidth(column, sheetScale), Math.round((normalizedTotal > 0 ? percent / normalizedTotal : 1 / Math.max(1, columns.length)) * 1500 * sheetScale));
    return {
      ...column,
      adaptivePercent: normalizedTotal > 0 ? percent / normalizedTotal : 1 / Math.max(1, columns.length),
      widthPx,
    };
  });
}

export default function OrdersTable({ orders = [], loading = false, onSelectOrder, layout, sheetSize = 12, dateConfig, pricingRules = [] }) {
  const [localProfile, setLocalProfile] = React.useState(readLocalWidthProfile);
  const tableRef = React.useRef(null);
  const normalizedSheetSize = Math.min(20, Math.max(9, Number(sheetSize) || 12));
  const sheetScale = normalizedSheetSize / 12;
  const visibleFields = (layout?.fields || [])
    .filter((field) => field.visibleInOrders !== false);
  const columns = buildAdaptiveColumns(visibleFields.length ? visibleFields : [
    { key: "order_number", label: "Order #" },
    { key: "buyer_name", label: "Buyer" },
    { key: "ship_by", label: "Ship By" },
    { key: "status", label: "Status" },
  ], localProfile, sheetScale);
  const tableMinWidth = columns.reduce((sum, column) => sum + column.widthPx, 0);
  const tableStyleVars = {
    "--orders-sheet-font-size": `${normalizedSheetSize}px`,
    "--orders-sheet-header-font-size": `${Math.max(9, normalizedSheetSize - 2)}px`,
    "--orders-sheet-meta-font-size": `${Math.max(9, normalizedSheetSize - 1)}px`,
    "--orders-sheet-badge-font-size": `${Math.max(9, normalizedSheetSize - 2)}px`,
    "--orders-sheet-cell-padding-y": `${Math.round(normalizedSheetSize * 0.82)}px`,
    "--orders-sheet-cell-padding-x": `${Math.round(normalizedSheetSize * 0.84)}px`,
    "--orders-sheet-header-padding-y": `${Math.round(normalizedSheetSize * 0.9)}px`,
    "--orders-sheet-line-height": normalizedSheetSize <= 10 ? 1.25 : 1.35,
  };

  function startResize(event, column) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = column.widthPx;
    let latestColumns = columns;

    function onMove(moveEvent) {
      const nextWidth = Math.max(40, startWidth + (moveEvent.clientX - startX));
      const nextColumns = columns.map((item) => (
        item.key === column.key ? { ...item, widthPx: nextWidth } : item
      ));
      const total = nextColumns.reduce((sum, item) => sum + item.widthPx, 0);
      latestColumns = nextColumns.map((item) => ({ ...item, adaptivePercent: item.widthPx / total }));
      setLocalProfile({
        source: "web",
        unit: "percent",
        tolerance: 0.02,
        promoted: false,
        updatedAt: new Date().toISOString(),
        columns: Object.fromEntries(
          latestColumns.map((item) => [
            item.key,
            { percent: Number((item.widthPx / total).toFixed(4)), rawWebPx: Math.round(item.widthPx) },
          ])
        ),
      });
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const saved = saveLocalWidthProfile(latestColumns);
      if (saved) setLocalProfile(saved);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  if (loading) {
    return (
      <div className="table-state">
        <div className="spinner" />
        <span>Loading orders...</span>
      </div>
    );
  }

  if (!orders.length) {
    return (
      <div className="table-state table-state-empty">
        <strong>No orders found</strong>
        <span>Try changing the search or filter controls.</span>
      </div>
    );
  }

  return (
    <div className="orders-table-wrap" style={tableStyleVars}>
      <table ref={tableRef} className="orders-table" style={{ width: tableMinWidth, minWidth: tableMinWidth }}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.key} style={{ width: column.widthPx, minWidth: column.widthPx, maxWidth: column.widthPx }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>
                <span className="orders-th-label">{column.label}</span>
                <button
                  type="button"
                  className="orders-col-resize"
                  aria-label={`Resize ${column.label} column`}
                  onMouseDown={(event) => startResize(event, column)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map((row) => {
            const priceRule = matchPriceRule(row.price, pricingRules);
            return (
              <tr key={`${row.order_id}-${row.id}`} onClick={() => onSelectOrder?.(row.order_id)}>
                {columns.map((column) => (
                  <td key={column.key} style={cellStyle(row, column, priceRule)}>
                    {fieldValue(row, column.key, dateConfig, priceRule)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
