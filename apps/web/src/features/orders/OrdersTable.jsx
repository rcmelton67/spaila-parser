import React from "react";
import { DATE_FIELD_KEYS, formatDate } from "../../shared/dateConfig.js";

const WEB_WIDTH_PROFILE_KEY = "spaila_web_column_width_profile";
const PRICE_TYPE_FIELD_KEY = "custom_6";
const CHECKBOX_COLUMN_WIDTH = 38;

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

function StatusPicker({ row, statusConfig, onStatusChange, saving = false }) {
  const states = Array.isArray(statusConfig?.states) ? statusConfig.states : [];
  const rawKey = String(row.item_status || "").trim();
  const currentState = states.find((state) => String(state.key) === rawKey)
    || states.find((state) => String(state.key).toLowerCase() === rawKey.toLowerCase());
  const currentKey = currentState ? String(currentState.key) : "";
  const pillBg = currentState?.color || null;
  const pillTc = pillBg ? contrastColor(pillBg) : "#6b7280";
  const pillBorder = pillBg
    ? (pillTc === "#ffffff" ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.12)")
    : "#d1d5db";

  return (
    <select
      value={currentKey}
      disabled={saving}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onChange={(event) => {
        event.stopPropagation();
        onStatusChange?.(row, event.target.value || null);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "3px 10px",
        border: `1px solid ${pillBorder}`,
        borderRadius: "999px",
        fontSize: "max(10px, calc(var(--orders-sheet-font-size, 12px) - 1px))",
        fontWeight: 600,
        background: pillBg || "transparent",
        color: pillBg ? pillTc : "#9ca3af",
        cursor: saving ? "default" : "pointer",
        outline: "none",
        appearance: "none",
        whiteSpace: "nowrap",
        transition: "all 0.15s ease",
        maxWidth: "100%",
        opacity: saving ? 0.65 : 1,
      }}
    >
      <option value="" hidden></option>
      {states.map((state) => (
        <option key={state.key} value={state.key}>{state.label}</option>
      ))}
    </select>
  );
}

function fieldValue(row, column, dateConfig, priceRule = null, statusConfig = null, onStatusChange = null, savingStatusIds = null) {
  const key = column.key;
  if (key === "status") {
    return (
      <StatusPicker
        row={row}
        statusConfig={statusConfig}
        onStatusChange={onStatusChange}
        saving={savingStatusIds?.has?.(String(row.id))}
      />
    );
  }
  if (key === "order_info") return <OrderInfoCell row={row} />;
  if (DATE_FIELD_KEYS.has(key)) return formatDate(row[key], dateConfig);
  let value = row[key];
  if (key === PRICE_TYPE_FIELD_KEY && !value && priceRule?.typeValue) {
    value = priceRule.typeValue;
  }
  return value === null || value === undefined || value === "" ? "—" : value;
}

function GiftPrintButton({ row, cellBackground, onGenerateGiftLetter }) {
  const onDark = cellBackground && contrastColor(cellBackground) === "#ffffff";
  const iconColor = onDark ? "#ffffff" : "#2563eb";
  return (
    <button
      type="button"
      className="orders-gift-print-button"
      title="Print gift message"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onGenerateGiftLetter?.(row);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{ color: iconColor }}
    >
      🖨
    </button>
  );
}

function cellStyle(row, column, priceRule) {
  if (column.key === "status") {
    return {
      padding: "4px 6px",
      border: "1px solid #e8e8e8",
      background: "transparent",
      overflow: "hidden",
      boxSizing: "border-box",
      verticalAlign: "middle",
      textAlign: "left",
    };
  }
  if (column.key === "order_info") return undefined;
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

export default function OrdersTable({
  orders = [],
  loading = false,
  onSelectOrder,
  onStatusChange,
  savingStatusIds = null,
  layout,
  statusConfig = null,
  sheetSize = 12,
  dateConfig,
  pricingRules = [],
  documentsConfig = null,
  onGenerateGiftLetter = null,
  activeTab = "active",
  onMoveRowsToStatus,
  onDeleteRows,
  searchActive = false,
  searchableColumnKeys = [],
  excludedSearchColumns = new Set(),
  onExcludeSearchColumn,
}) {
  const [localProfile, setLocalProfile] = React.useState(readLocalWidthProfile);
  const [selectedIds, setSelectedIds] = React.useState(() => new Set());
  const [contextMenu, setContextMenu] = React.useState({ visible: false, x: 0, y: 0, row: null });
  const [confirmDelete, setConfirmDelete] = React.useState({ open: false, rows: [] });
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
  const tableMinWidth = columns.reduce((sum, column) => sum + column.widthPx, CHECKBOX_COLUMN_WIDTH);
  const allSelected = orders.length > 0 && selectedIds.size === orders.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
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

  React.useEffect(() => {
    const ids = new Set(orders.map((row) => String(row.id || row.order_id || "")));
    setSelectedIds((current) => new Set([...current].filter((id) => ids.has(id))));
  }, [orders]);

  function getRowId(row) {
    return String(row.id || row.order_id || "");
  }

  function toggleAllRows(event) {
    event.stopPropagation();
    setSelectedIds(allSelected ? new Set() : new Set(orders.map(getRowId).filter(Boolean)));
  }

  function toggleRow(row, event) {
    event.stopPropagation();
    const rowId = getRowId(row);
    if (!rowId) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  function getTargetRows(row) {
    const rowId = getRowId(row);
    if (rowId && selectedIds.has(rowId) && selectedIds.size > 1) {
      return orders.filter((item) => selectedIds.has(getRowId(item)));
    }
    return row ? [row] : [];
  }

  function closeContextMenu() {
    setContextMenu({ visible: false, x: 0, y: 0, row: null });
  }

  function handleContextMenu(event, row) {
    event.preventDefault();
    setContextMenu({ visible: true, x: event.clientX, y: event.clientY, row });
  }

  function handleMoveToCompleted() {
    const targetRows = getTargetRows(contextMenu.row);
    closeContextMenu();
    onMoveRowsToStatus?.(targetRows, "completed");
  }

  function handleMoveToActive() {
    const targetRows = getTargetRows(contextMenu.row);
    closeContextMenu();
    onMoveRowsToStatus?.(targetRows, "active");
  }

  function handleDelete() {
    const targetRows = getTargetRows(contextMenu.row);
    closeContextMenu();
    if (!targetRows.length) return;
    setConfirmDelete({ open: true, rows: targetRows });
  }

  async function confirmDeleteRows() {
    const rowsToDelete = confirmDelete.rows;
    setConfirmDelete({ open: false, rows: [] });
    if (!rowsToDelete.length) return;
    await onDeleteRows?.(rowsToDelete);
    setSelectedIds((current) => {
      const deletedIds = new Set(rowsToDelete.map(getRowId));
      return new Set([...current].filter((id) => !deletedIds.has(id)));
    });
  }

  React.useEffect(() => {
    if (!contextMenu.visible) return undefined;
    function closeMenu() {
      closeContextMenu();
    }
    function onKey(event) {
      if (event.key === "Escape") closeContextMenu();
    }
    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu.visible]);

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
    <div className={`orders-table-wrap${searchActive ? " search-active" : ""}`} style={tableStyleVars}>
      <table ref={tableRef} className="orders-table" style={{ width: tableMinWidth, minWidth: tableMinWidth }}>
        <colgroup>
          <col style={{ width: CHECKBOX_COLUMN_WIDTH, minWidth: CHECKBOX_COLUMN_WIDTH, maxWidth: CHECKBOX_COLUMN_WIDTH }} />
          {columns.map((column) => (
            <col key={column.key} style={{ width: column.widthPx, minWidth: column.widthPx, maxWidth: column.widthPx }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="orders-checkbox-column">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = someSelected;
                }}
                onChange={toggleAllRows}
                onClick={(event) => event.stopPropagation()}
                aria-label="Select all orders"
              />
            </th>
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
          {searchActive ? (
            <tr className="orders-search-column-row">
              <th className="orders-checkbox-column" />
              {columns.map((column) => {
                const searchable = searchableColumnKeys.includes(column.key);
                const excluded = excludedSearchColumns.has(column.key);
                return (
                  <th key={`search-filter-${column.key}`}>
                    {searchable && !excluded ? (
                      <button
                        type="button"
                        title={`Remove ${column.label} from search results`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onExcludeSearchColumn?.(column.key);
                        }}
                      >
                        ×
                      </button>
                    ) : null}
                  </th>
                );
              })}
            </tr>
          ) : null}
        </thead>
        <tbody>
          {orders.map((row) => {
            const priceRule = matchPriceRule(row.price, pricingRules);
            const rowId = getRowId(row);
            const isSelected = rowId ? selectedIds.has(rowId) : false;
            return (
              <tr
                key={`${row.order_id}-${row.id}`}
                className={isSelected ? "selected" : ""}
                onClick={() => onSelectOrder?.(row)}
                onContextMenu={(event) => handleContextMenu(event, row)}
              >
                <td
                  className="orders-checkbox-column"
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(event) => toggleRow(row, event)}
                    aria-label={`Select order ${row.order_number || rowId}`}
                  />
                </td>
                {columns.map((column) => {
                  const baseStyle = cellStyle(row, column, priceRule) || {};
                  const hasGiftPrintIcon = column.key === "gift_message"
                    && !!String(row.gift_message || "").trim()
                    && documentsConfig?.show_gift_print_icon !== false;
                  return (
                    <td
                      key={column.key}
                      style={{
                        ...baseStyle,
                        position: hasGiftPrintIcon ? "relative" : baseStyle.position,
                        paddingRight: hasGiftPrintIcon ? "34px" : baseStyle.paddingRight,
                      }}
                      onClick={column.key === "status" ? (event) => event.stopPropagation() : undefined}
                      onDoubleClick={column.key === "status" ? (event) => event.stopPropagation() : undefined}
                      onPointerDown={column.key === "status" ? (event) => event.stopPropagation() : undefined}
                      onMouseDown={column.key === "status" ? (event) => event.stopPropagation() : undefined}
                    >
                      {hasGiftPrintIcon ? (
                        <GiftPrintButton row={row} cellBackground={baseStyle.background} onGenerateGiftLetter={onGenerateGiftLetter} />
                      ) : null}
                      {fieldValue(row, column, dateConfig, priceRule, statusConfig, onStatusChange, savingStatusIds)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {contextMenu.visible ? (
        <div
          className="orders-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {(() => {
            const targetCount = getTargetRows(contextMenu.row).length || 1;
            const menuItems = activeTab === "completed"
              ? [
                  { label: targetCount > 1 ? `Move ${targetCount} to Active` : "Move to Active", action: handleMoveToActive },
                  { label: targetCount > 1 ? `Delete ${targetCount} Orders` : "Delete Order", action: handleDelete, danger: true },
                ]
              : [
                  { label: targetCount > 1 ? `Move ${targetCount} to Completed` : "Move to Completed", action: handleMoveToCompleted },
                  { label: targetCount > 1 ? `Delete ${targetCount} Orders` : "Delete Order", action: handleDelete, danger: true },
                ];
            return menuItems.map((item) => (
              <button
                key={item.label}
                type="button"
                className={item.danger ? "danger" : ""}
                onClick={item.action}
              >
                {item.label}
              </button>
            ));
          })()}
        </div>
      ) : null}
      {confirmDelete.open ? (
        <div
          className="orders-confirm-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmDelete({ open: false, rows: [] });
          }}
        >
          <div className="orders-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="orders-delete-title">
            <h3 id="orders-delete-title">
              {confirmDelete.rows.length > 1 ? `Delete ${confirmDelete.rows.length} Orders?` : "Delete Order?"}
            </h3>
            <div className="orders-confirm-copy">
              {confirmDelete.rows.length > 1 ? (
                <>
                  Are you sure you want to delete <strong>{confirmDelete.rows.length} orders</strong>?
                  <div className="orders-confirm-list">
                    {confirmDelete.rows.map((row) => (
                      <div key={getRowId(row)}>
                        #{row.order_number || row.order_id} - {row.buyer_name || "Unknown"}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  Are you sure you want to delete order{" "}
                  <strong>#{confirmDelete.rows[0]?.order_number || confirmDelete.rows[0]?.order_id}</strong>
                  {" "}for <strong>{confirmDelete.rows[0]?.buyer_name || "this buyer"}</strong>?
                </>
              )}
              <br />
              <span>This cannot be undone.</span>
            </div>
            <div className="orders-confirm-actions">
              <button type="button" onClick={() => setConfirmDelete({ open: false, rows: [] })}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={confirmDeleteRows}>
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
