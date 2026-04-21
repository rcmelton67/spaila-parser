import React from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import EditOrderModal from "./EditOrderModal.jsx";
import SettingsModal from "./SettingsModal.jsx";
import {
  loadFieldConfig,
  loadColumnOrder,
  saveColumnOrder,
  defaultColumnOrder,
  loadPriceList,
  matchPriceRule,
  PRICE_TYPE_FIELD_KEY,
  contrastColor,
  loadStatusConfig,
  loadOrderStatuses,
  setOrderStatus,
  loadViewConfig,
  loadDateConfig,
  DATE_FIELD_KEYS,
  formatDate,
  generateDateVariants,
} from "./fieldConfig.js";

const API = "http://127.0.0.1:8055";

const tabStyle = {
  padding: "6px 14px",
  border: "1px solid #ccc",
  background: "#eee",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "13px",
};

const tabStyleActive = {
  ...tabStyle,
  background: "#fff",
  borderBottom: "2px solid #2563eb",
  fontWeight: "bold",
  color: "#2563eb",
};

const primaryButton = {
  padding: "6px 14px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
};

/* ── Order-info badge cell (computed, no storage) ───────────────────────── */

/** Normalise any raw platform/source string into a canonical token. */
function normalizePlatform(raw) {
  if (!raw) return "etsy";
  const s = String(raw).toLowerCase();
  if (s.includes("etsy"))                  return "etsy";
  if (s.includes("woo") || s.includes("web") || s.includes("website")) return "website";
  if (s.includes("shopify"))               return "shopify";
  return "unknown";
}

const PLATFORM_LABELS = { website: "Website", shopify: "Shopify", unknown: null };

function OrderInfoCell({ row }) {
  // order_context falls back to the row itself for single-item orders
  const ctx = row;
  const badges = [];

  // Platform badge — only for non-Etsy orders
  const rawPlatform = ctx.platform || ctx.source || ctx.marketplace;
  const platform = normalizePlatform(rawPlatform);
  console.log("ORDER_INFO_PLATFORM", { raw: rawPlatform, normalized: platform });
  if (platform !== "etsy") {
    const label = PLATFORM_LABELS[platform];
    if (label) badges.push({ key: "platform", label, bg: "#f3f4f6", color: "#6b7280" });
  }

  // "N items" — use item count for the order, not per-item quantity
  const itemCount = ctx._item_count || 1;
  if (itemCount > 1) {
    badges.push({ key: "qty", label: `${itemCount} items`, bg: "#e0f2fe", color: "#0369a1" });
  }

  // Gift flags
  if (ctx.gift || ctx.is_gift) {
    badges.push({ key: "gift", label: "Gift", bg: "#fef3c7", color: "#92400e" });
  }
  if (ctx.gift_message) {
    badges.push({ key: "msg", label: "Message", bg: "#f0fdf4", color: "#166534" });
  }
  if (ctx.gift_wrapped || ctx.gift_wrap) {
    badges.push({ key: "wrap", label: "Wrapped", bg: "#faf5ff", color: "#6b21a8" });
  }

  const notes = ctx.order_notes || "";

  if (!badges.length && !notes) {
    return <span style={{ color: "#bbb" }}>—</span>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
      {badges.length > 0 && (
        <div style={{ display: "flex", gap: "3px", flexWrap: "wrap" }}>
          {badges.map((b) => (
            <span key={b.key} style={{
              padding: "1px 6px", borderRadius: "999px",
              fontSize: "10px", fontWeight: 600,
              background: b.bg, color: b.color,
              whiteSpace: "nowrap", lineHeight: "16px",
            }}>{b.label}</span>
          ))}
        </div>
      )}
      {notes && (
        <span title={notes} style={{
          fontSize: "10px", color: "#9ca3af", lineHeight: "14px",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{notes}</span>
      )}
    </div>
  );
}

/* ── Draggable column header ────────────────────────────────────────────── */
function SortableHeader({ col, width, onStartResize, isSearchable, isExcluded, onToggleExclusion, searchActive }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: col.key });

  return (
    <th
      ref={setNodeRef}
      style={{
        width,
        padding: "9px 10px",
        textAlign: "left",
        fontWeight: 600,
        fontSize: "12px",
        color: isDragging ? "#2563eb" : "#555",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        border: "1px solid #ccc",
        position: "relative",
        userSelect: "none",
        whiteSpace: "nowrap",
        overflow: "hidden",
        background: isDragging ? "#dbeafe" : undefined,
        opacity: isDragging ? 0.85 : isExcluded ? 0.45 : 1,
        transform: CSS.Transform.toString(transform),
        transition: transition ?? "transform 200ms ease",
        zIndex: isDragging ? 10 : undefined,
        boxSizing: "border-box",
      }}
      {...attributes}
    >
      {/* Drag handle = entire label area */}
      <span
        {...listeners}
        style={{
          cursor: isDragging ? "grabbing" : "grab",
          display: "block",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          paddingRight: (isSearchable && searchActive) ? "20px" : "8px",
        }}
        title={`Drag to reorder — ${col.label}`}
      >
        {col.label}
      </span>

      {/* Search-exclusion toggle — only while search is active */}
      {isSearchable && searchActive && (
        <button
          onMouseDown={(e) => e.stopPropagation()} // don't start drag
          onClick={(e) => { e.stopPropagation(); onToggleExclusion(col.key); }}
          title={isExcluded ? `Re-include "${col.label}" in search` : `Exclude "${col.label}" from search`}
          style={{
            position: "absolute",
            top: "50%",
            right: "6px",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px",
            lineHeight: 1,
            fontSize: "10px",
            color: isExcluded ? "#9ca3af" : "#aab",
            opacity: isExcluded ? 1 : 0.55,
            borderRadius: "3px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {isExcluded ? "↺" : "✕"}
        </button>
      )}

      {/* Column resize handle */}
      <div
        onMouseDown={(e) => onStartResize(e, col.key)}
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          width: 5,
          height: "100%",
          cursor: "col-resize",
          background: "transparent",
        }}
      />
    </th>
  );
}

/* ── Main component ─────────────────────────────────────────────────────── */
export default function OrdersPage({ onImport, refreshKey }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [tab, setTab] = React.useState("active");
  const [search, setSearch] = React.useState("");
  const [activeSearchExclusions, setActiveSearchExclusions] = React.useState([]);

  function toggleExclusion(key) {
    setActiveSearchExclusions((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }
  function clearExclusions() { setActiveSearchExclusions([]); }
  const [editingOrder, setEditingOrder] = React.useState(null);
  const [showSettings, setShowSettings] = React.useState(false);

  // Field labels + visibility + palette config
  const [fieldConfig, setFieldConfig] = React.useState(() => loadFieldConfig());
  React.useEffect(() => {
    function onConfigChange() { setFieldConfig(loadFieldConfig()); }
    window.addEventListener("spaila:fieldconfig", onConfigChange);
    return () => window.removeEventListener("spaila:fieldconfig", onConfigChange);
  }, []);

  // Price list for row color-coding
  const [priceList, setPriceList] = React.useState(() => loadPriceList());
  React.useEffect(() => {
    function onPriceChange() { setPriceList(loadPriceList()); }
    window.addEventListener("spaila:pricelist", onPriceChange);
    return () => window.removeEventListener("spaila:pricelist", onPriceChange);
  }, []);

  // Status column config + per-order statuses
  const [statusConfig, setStatusConfig] = React.useState(() => loadStatusConfig());
  const [orderStatuses, setOrderStatuses] = React.useState(() => loadOrderStatuses());
  React.useEffect(() => {
    function onStatusChange() { setStatusConfig(loadStatusConfig()); }
    window.addEventListener("spaila:statusconfig", onStatusChange);
    return () => window.removeEventListener("spaila:statusconfig", onStatusChange);
  }, []);

  // View config — search fields, sort, visibility
  const [viewConfig, setViewConfig] = React.useState(() => loadViewConfig());
  React.useEffect(() => {
    function onViewChange() { setViewConfig(loadViewConfig()); }
    window.addEventListener("spaila:viewconfig", onViewChange);
    return () => window.removeEventListener("spaila:viewconfig", onViewChange);
  }, []);

  // Date config — display format, showYear, flexibleSearch
  const [dateConfig, setDateConfig] = React.useState(() => loadDateConfig());
  React.useEffect(() => {
    function onDateChange() { setDateConfig(loadDateConfig()); }
    window.addEventListener("spaila:dateconfig", onDateChange);
    return () => window.removeEventListener("spaila:dateconfig", onDateChange);
  }, []);

  function handleSetStatus(orderId, statusKey) {
    setOrderStatus(orderId, statusKey);
    setOrderStatuses(loadOrderStatuses());
  }

  // Column order — single source of truth for both table and Settings
  const [columnOrder, setColumnOrder] = React.useState(() => loadColumnOrder());

  function updateColumnOrder(next) {
    setColumnOrder(next);
    saveColumnOrder(next);
  }

  // Build field lookup map: key → { label, visibleInOrders, defaultWidth }
  const fieldMap = React.useMemo(
    () => Object.fromEntries(fieldConfig.map((f) => [f.key, f])),
    [fieldConfig]
  );

  // Visible columns in user-defined order — "status" is virtual (not in fieldMap)
  const visibleColumns = React.useMemo(
    () =>
      columnOrder
        .filter((key) => {
          if (key === "status")     return statusConfig.enabled;
          if (key === "order_info") return true; // always visible (user hides via columnOrder)
          return fieldMap[key]?.visibleInOrders;
        })
        .map((key) => {
          if (key === "status") return {
            key: "status",
            label: statusConfig.columnLabel || "Status",
            defaultWidth: 130,
          };
          if (key === "order_info") return {
            key: "order_info",
            label: "Order Info",
            defaultWidth: 220,
          };
          return {
            key,
            label: fieldMap[key]?.label ?? key,
            defaultWidth: fieldMap[key]?.defaultWidth ?? 150,
          };
        }),
    [columnOrder, fieldMap, statusConfig]
  );

  // DnD sensors — require 6px movement to start drag (avoids accidental drags on click)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = columnOrder.indexOf(active.id);
    const newIdx = columnOrder.indexOf(over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    updateColumnOrder(arrayMove(columnOrder, oldIdx, newIdx));
  }

  const [contextMenu, setContextMenu] = React.useState({ visible: false, x: 0, y: 0, row: null });
  const [confirmDelete, setConfirmDelete] = React.useState({ open: false, rows: [] });
  const [selectedIds, setSelectedIds] = React.useState(new Set());

  const [colWidths, setColWidths] = React.useState(
    () => Object.fromEntries(loadFieldConfig().map((f) => [f.key, f.defaultWidth ?? 150]))
  );

  function toggleRow(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((r) => r.id)));
    }
  }

  function closeContextMenu() {
    setContextMenu((m) => ({ ...m, visible: false, row: null }));
  }

  function handleContextMenu(e, row) {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, row });
  }

  function getTargetRows() {
    const { row } = contextMenu;
    if (!row) return [];
    if (selectedIds.has(row.id) && selectedIds.size > 1) {
      return filtered.filter((r) => selectedIds.has(r.id));
    }
    return [row];
  }

  async function handleMoveToCompleted() {
    const targets = getTargetRows();
    closeContextMenu();
    if (!targets.length) return;
    await Promise.all(
      targets.map((r) =>
        fetch(`${API}/items/${r.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item_status: "completed" }),
        })
      )
    );
    loadOrders();
  }

  async function handleMoveToActive() {
    const targets = getTargetRows();
    closeContextMenu();
    if (!targets.length) return;
    await Promise.all(
      targets.map((r) =>
        fetch(`${API}/items/${r.id}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item_status: "active" }),
        })
      )
    );
    loadOrders();
  }

  function handleDelete() {
    const targets = getTargetRows();
    closeContextMenu();
    if (!targets.length) return;
    setConfirmDelete({ open: true, rows: targets });
  }

  async function confirmDeleteOrder() {
    const { rows } = confirmDelete;
    setConfirmDelete({ open: false, rows: [] });
    if (!rows.length) return;
    await Promise.all(
      rows.map((r) => fetch(`${API}/orders/${r.order_id}`, { method: "DELETE" }))
    );
    loadOrders();
  }

  React.useEffect(() => {
    if (!contextMenu.visible) return;
    function onDown() { closeContextMenu(); }
    function onKey(e) { if (e.key === "Escape") closeContextMenu(); }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu.visible]);

  function startResize(e, key) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = colWidths[key] ?? 150;
    function onMove(ev) {
      const newWidth = Math.max(60, startWidth + (ev.clientX - startX));
      setColWidths((prev) => ({ ...prev, [key]: newWidth }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function loadOrders() {
    setLoading(true);
    setError("");
    fetch(`${API}/orders/list`)
      .then((res) => res.json())
      .then((data) => {
        // Compute item count per order so OrderInfoCell can show "N items"
        const countByOrder = {};
        for (const r of data) {
          countByOrder[r.order_id] = (countByOrder[r.order_id] || 0) + 1;
        }
        // Attach order_context (order-level fields) to every item row so
        // computed columns like order_info can access them regardless of split.
        const enriched = data.map((r) => ({
          ...r,
          _item_count: countByOrder[r.order_id] || 1,
        }));
        setRows(enriched);
        setSelectedIds(new Set());
        setLoading(false);
      })
      .catch((err) => {
        setError("Failed to load orders: " + err.message);
        setLoading(false);
      });
  }

  React.useEffect(() => { loadOrders(); }, [refreshKey]);

  // ── Apply viewConfig: visibility, search, sort ───────────────────────────
  const filtered = React.useMemo(() => {
    const sf = viewConfig.searchableFields ?? {};
    const mode = viewConfig.searchMode ?? "smart";
    const includeInfo = viewConfig.includeOrderInfo ?? true;
    const showCompleted = viewConfig.showCompleted ?? true;

    // 1. Visibility / tab filter
    // If item_status is set, it is authoritative. Fall back to order-level status only when unset.
    const isCompleted = (r) => r.item_status
      ? r.item_status === "completed"
      : r.status === "completed" || r.status === "done";
    let base = rows.filter((r) => {
      if (tab === "completed") return isCompleted(r);
      // Active tab: hide completed rows unless showCompleted is on
      if (!showCompleted && isCompleted(r)) return false;
      if (isCompleted(r)) return false; // completed always go to completed tab only
      return true;
    });

    // 2. Search filter
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      base = base.filter((r) => {
        // Collect searchable values — skip globally-disabled AND runtime-excluded fields
        const flexDates = viewConfig.flexibleSearch ?? true; // from viewConfig; date override below
        const vals = Object.entries(sf)
          .filter(([key, on]) => on && !activeSearchExclusions.includes(key))
          .flatMap(([key]) => {
            const raw = r[key];
            if (DATE_FIELD_KEYS.has(key) && dateConfig.flexibleSearch) {
              return generateDateVariants(raw);
            }
            return [(raw || "").toLowerCase()];
          });

        // Order Info composite (platform badge label + gift flags + notes text)
        if (includeInfo) {
          const raw = r.platform || r.source || "";
          vals.push(normalizePlatform(raw)); // "website" / "shopify"
          if (r.gift_message) vals.push((r.gift_message || "").toLowerCase());
          if (r.order_notes)  vals.push((r.order_notes  || "").toLowerCase());
          if (r._item_count > 1) vals.push(`${r._item_count} items`);
        }

        if (mode === "exact") {
          return vals.some((v) => v === q);
        }
        // smart: partial match
        return vals.some((v) => v.includes(q));
      });
    }

    // 3. Default sort
    const sortField = viewConfig.defaultSort?.field || "order_date";
    const sortDir   = viewConfig.defaultSort?.direction || "desc";
    base = [...base].sort((a, b) => {
      const av = (a[sortField] ?? "").toString().toLowerCase();
      const bv = (b[sortField] ?? "").toString().toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 :  1;
      if (av > bv) return sortDir === "asc" ?  1 : -1;
      return 0;
    });

    return base;
  }, [rows, search, viewConfig, activeSearchExclusions, dateConfig, tab]);

  // Count matching rows per tab when a search is active — used for tab badges
  const tabCounts = React.useMemo(() => {
    if (!search.trim()) return null;
    const sf = viewConfig.searchableFields ?? {};
    const mode = viewConfig.searchMode ?? "smart";
    const includeInfo = viewConfig.includeOrderInfo ?? true;
    const isCompleted = (r) => r.item_status
      ? r.item_status === "completed"
      : r.status === "completed" || r.status === "done";
    const q = search.trim().toLowerCase();
    const matches = (r) => {
      const vals = Object.entries(sf)
        .filter(([key, on]) => on && !activeSearchExclusions.includes(key))
        .flatMap(([key]) => {
          const raw = r[key];
          if (DATE_FIELD_KEYS.has(key) && dateConfig.flexibleSearch) return generateDateVariants(raw);
          return [(raw || "").toLowerCase()];
        });
      if (includeInfo) {
        vals.push(normalizePlatform(r.platform || r.source || ""));
        if (r.gift_message) vals.push((r.gift_message || "").toLowerCase());
        if (r.order_notes)  vals.push((r.order_notes  || "").toLowerCase());
        if (r._item_count > 1) vals.push(`${r._item_count} items`);
      }
      return mode === "exact" ? vals.some((v) => v === q) : vals.some((v) => v.includes(q));
    };
    return {
      active:    rows.filter((r) => !isCompleted(r) && matches(r)).length,
      completed: rows.filter((r) =>  isCompleted(r) && matches(r)).length,
    };
  }, [rows, search, viewConfig, activeSearchExclusions, dateConfig]);

  const allSelected = filtered.length > 0 && selectedIds.size === filtered.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "'Segoe UI', sans-serif", background: "#f5f5f5" }}>

      {/* Command bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px", borderBottom: "1px solid #ddd",
        background: "#f7f7f7", flexShrink: 0,
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: "18px", color: "#666", padding: "4px 6px",
              lineHeight: 1, opacity: 0.75, transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.75")}
          >⚙</button>
          <button onClick={onImport} style={primaryButton}>+ Import Order</button>
          <button style={tab === "active"    ? tabStyleActive : tabStyle} onClick={() => setTab("active")}>
            Active ({rows.filter((r) => !(r.item_status ? r.item_status === "completed" : r.status === "completed" || r.status === "done")).length})
            {tabCounts && (
              <span style={{
                marginLeft: 6, background: tab === "active" ? "#2563eb" : "#6b7280",
                color: "#fff", borderRadius: 999, padding: "1px 7px",
                fontSize: 11, fontWeight: 700, lineHeight: "16px",
              }}>{tabCounts.active}</span>
            )}
          </button>
          <button style={tab === "completed" ? tabStyleActive : tabStyle} onClick={() => setTab("completed")}>
            Completed
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (!e.target.value) clearExclusions();
            }}
            placeholder="Search orders…"
            style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px", width: "180px" }}
          />
          <button onClick={loadOrders} style={{ ...tabStyle, padding: "6px 12px" }}>Refresh</button>
        </div>
      </div>

      {/* Search-exclusion indicator bar */}
      {activeSearchExclusions.length > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: "8px",
          padding: "5px 16px", background: "#fffbeb",
          borderBottom: "1px solid #fde68a", fontSize: "12px", color: "#92400e",
          flexShrink: 0,
        }}>
          <span>Search excluding:</span>
          {activeSearchExclusions.map((key) => {
            const col = visibleColumns.find((c) => c.key === key);
            return (
              <span key={key} style={{
                padding: "1px 8px", borderRadius: "999px",
                background: "#fde68a", color: "#78350f", fontWeight: 600,
              }}>
                {col?.label ?? key}
                <button
                  onClick={() => toggleExclusion(key)}
                  style={{ marginLeft: "4px", background: "none", border: "none",
                    cursor: "pointer", color: "#92400e", padding: 0, fontSize: "11px" }}
                >✕</button>
              </span>
            );
          })}
          <button
            onClick={clearExclusions}
            style={{ marginLeft: "auto", fontSize: "11px", color: "#2563eb",
              background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >Reset</button>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>
        {error ? (
          <div style={{ padding: "12px 16px", background: "#fee2e2", borderRadius: "6px", color: "#991b1b", fontSize: "13px" }}>
            {error}
          </div>
        ) : loading ? (
          <div style={{ color: "#888", padding: "12px", fontSize: "13px" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ color: "#888", fontSize: "14px", marginBottom: "14px" }}>
              {search
                ? "No orders match your search."
                : tab === "completed"
                  ? "No completed orders yet."
                  : "No active orders yet."}
            </div>
            {!search && tab === "active" && <button onClick={onImport} style={primaryButton}>+ Import your first order</button>}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <table style={{ borderCollapse: "collapse", fontSize: "14px", tableLayout: "fixed", border: "1px solid #ddd" }}>
              <colgroup>
                <col style={{ width: 36 }} />
                {visibleColumns.map((c) => (
                  <col key={c.key} style={{ width: colWidths[c.key] ?? c.defaultWidth }} />
                ))}
              </colgroup>

              <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
                <thead style={{ background: "#e5e5e5" }}>
                  <tr>
                    <th style={{
                      width: 36, padding: "9px 0 9px 10px",
                      border: "1px solid #ccc", userSelect: "none",
                    }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => { if (el) el.indeterminate = someSelected; }}
                        onChange={toggleAll}
                        style={{ cursor: "pointer" }}
                      />
                    </th>
                    {visibleColumns.map((c) => (
                      <SortableHeader
                        key={c.key}
                        col={c}
                        width={colWidths[c.key] ?? c.defaultWidth}
                        onStartResize={startResize}
                        isSearchable={!!(viewConfig.searchableFields?.[c.key])}
                        isExcluded={activeSearchExclusions.includes(c.key)}
                        onToggleExclusion={toggleExclusion}
                        searchActive={search.trim().length > 0}
                      />
                    ))}
                  </tr>
                </thead>
              </SortableContext>

              <tbody>
                {filtered.map((r, i) => {
                  const isSelected = selectedIds.has(r.id);
                  // Price-list lookup: find matching rule for this row's price
                  const priceRule = matchPriceRule(r.price, priceList);

                  return (
                    <tr
                      key={r.id}
                      onDoubleClick={() => setEditingOrder(r)}
                      onContextMenu={(e) => handleContextMenu(e, r)}
                      style={{
                        cursor: "pointer",
                        background: isSelected ? "#eff6ff" : i % 2 === 0 ? "#fff" : "#fafafa",
                      }}
                    >
                      <td
                        style={{ width: 36, padding: "8px 0 8px 10px", border: "1px solid #e8e8e8" }}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => { e.stopPropagation(); toggleRow(r.id); }}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                      {visibleColumns.map((c) => {
                        const w = colWidths[c.key] ?? c.defaultWidth;

                        // ── Status cell ──────────────────────────────────────
                        if (c.key === "status") {
                          const currentKey   = orderStatuses[String(r.id)] ?? "";
                          const currentState = statusConfig.states.find((s) => s.key === currentKey);
                          const bg  = currentState?.color;
                          const tc  = currentState ? contrastColor(bg) : "#9ca3af";
                          const borderClr = bg
                            ? (tc === "#ffffff" ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.15)")
                            : "#e5e7eb";
                          return (
                            <td key="status" style={{
                              width: w, padding: "5px 8px",
                              border: "1px solid #e8e8e8",
                              background: !isSelected && bg ? bg : undefined,
                            }}>
                              <select
                                value={currentKey}
                                onChange={(e) => handleSetStatus(r.id, e.target.value || null)}
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  width: "100%", padding: "3px 6px",
                                  border: `1px solid ${borderClr}`,
                                  borderRadius: "999px",
                                  fontSize: "11px", fontWeight: 600,
                                  background: currentState ? bg : "#f9fafb",
                                  color: tc, cursor: "pointer",
                                  outline: "none", appearance: "none", textAlign: "center",
                                }}
                              >
                                <option value="">— Set status —</option>
                                {statusConfig.states.map((s) => (
                                  <option key={s.key} value={s.key}>{s.label}</option>
                                ))}
                              </select>
                            </td>
                          );
                        }

                        // ── Order-info cell ─────────────────────────────────
                        if (c.key === "order_info") {
                          return (
                            <td key="order_info" style={{
                              width: w, padding: "5px 10px",
                              border: "1px solid #e8e8e8",
                              verticalAlign: "middle",
                              maxWidth: w,
                            }}>
                              <OrderInfoCell row={r} />
                            </td>
                          );
                        }

                        // ── Regular data cell ────────────────────────────────
                        const fMeta = fieldMap[c.key];

                        // Priority: price palette > field highlight > none
                        const paletteBg = !isSelected && priceRule && fMeta?.paletteEnabled
                          ? priceRule.color : null;
                        const hl = fMeta?.highlight;
                        const highlightBg = !paletteBg && hl?.enabled && hl?.color && r[c.key]
                          ? hl.color : null;
                        const cellBg = paletteBg || highlightBg || undefined;

                        let displayValue = DATE_FIELD_KEYS.has(c.key)
                          ? formatDate(r[c.key], dateConfig)
                          : r[c.key];
                        if (c.key === PRICE_TYPE_FIELD_KEY && !displayValue && priceRule?.typeValue) {
                          displayValue = priceRule.typeValue;
                        }

                        const cellTextColor = cellBg
                          ? contrastColor(cellBg)
                          : (displayValue ? "#1a1a1a" : "#bbb");

                        return (
                          <td key={c.key} style={{
                            width: w, padding: "8px 10px",
                            border: "1px solid #e8e8e8",
                            background: cellBg, color: cellTextColor,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            fontStyle: !r[c.key] && c.key === PRICE_TYPE_FIELD_KEY && priceRule?.typeValue
                              ? "italic" : undefined,
                          }}>
                            {displayValue ?? ""}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DndContext>
        )}
      </div>

      {editingOrder && (
        <EditOrderModal
          order={editingOrder}
          onClose={() => setEditingOrder(null)}
          onSaved={() => { setEditingOrder(null); loadOrders(); }}
        />
      )}

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        columnOrder={columnOrder}
        onColumnOrderChange={updateColumnOrder}
      />

      {/* Confirm delete dialog */}
      {confirmDelete.open && (
        <div
          onClick={(e) => e.target === e.currentTarget && setConfirmDelete({ open: false, rows: [] })}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
            zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div style={{
            background: "#fff", borderRadius: "8px",
            boxShadow: "0 20px 60px rgba(0,0,0,0.22)", width: "380px", padding: "24px",
          }}>
            <div style={{ fontWeight: 700, fontSize: "16px", color: "#111", marginBottom: "10px" }}>
              {confirmDelete.rows.length > 1 ? `Delete ${confirmDelete.rows.length} Orders?` : "Delete Order?"}
            </div>
            <div style={{ fontSize: "13px", color: "#444", lineHeight: 1.6, marginBottom: "24px" }}>
              {confirmDelete.rows.length > 1 ? (
                <>
                  Are you sure you want to delete{" "}
                  <strong>{confirmDelete.rows.length} orders</strong>?
                  <div style={{ marginTop: "8px", maxHeight: "120px", overflowY: "auto" }}>
                    {confirmDelete.rows.map((r) => (
                      <div key={r.id} style={{ color: "#555", fontSize: "12px" }}>
                        #{r.order_number} — {r.buyer_name || "Unknown"}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  Are you sure you want to delete order{" "}
                  <strong>#{confirmDelete.rows[0]?.order_number}</strong> for{" "}
                  <strong>{confirmDelete.rows[0]?.buyer_name || "this buyer"}</strong>?
                </>
              )}
              <br />
              <span style={{ color: "#888" }}>This cannot be undone.</span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setConfirmDelete({ open: false, rows: [] })}
                style={{ padding: "7px 16px", border: "1px solid #d1d5db", borderRadius: "5px", background: "#fff", cursor: "pointer", fontSize: "13px" }}
              >Cancel</button>
              <button
                onClick={confirmDeleteOrder}
                style={{ padding: "7px 18px", border: "none", borderRadius: "5px", background: "#dc2626", color: "#fff", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
              >Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu.visible && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed", top: contextMenu.y, left: contextMenu.x,
            background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)", zIndex: 9999,
            padding: "4px 0", minWidth: "170px", fontSize: "13px",
          }}
        >
          {(() => {
            const n = contextMenu.row && selectedIds.has(contextMenu.row.id) && selectedIds.size > 1 ? selectedIds.size : 1;
            const menuItems = tab === "completed"
              ? [
                  { label: n > 1 ? `Move ${n} to Active` : "Move to Active", action: handleMoveToActive, color: "#111" },
                  { label: n > 1 ? `Delete ${n} Orders`  : "Delete Order",   action: handleDelete,        color: "#dc2626" },
                ]
              : [
                  { label: n > 1 ? `Move ${n} to Completed` : "Move to Completed", action: handleMoveToCompleted, color: "#111" },
                  { label: n > 1 ? `Delete ${n} Orders`     : "Delete Order",       action: handleDelete,          color: "#dc2626" },
                ];
            return menuItems;
          })().map(({ label, action, color }) => (
            <div
              key={label}
              onClick={action}
              style={{ padding: "8px 16px", cursor: "pointer", color, userSelect: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >{label}</div>
          ))}
        </div>
      )}
    </div>
  );
}
