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
import SettingsModal from "../../settings/SettingsModal.jsx";
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
  loadEmailTemplates,
  selectEmailTemplate,
  renderEmailTemplate,
  loadShopConfig,
  loadDocumentsConfig,
} from "../../shared/utils/fieldConfig.js";

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

  if (!badges.length) {
    return <span style={{ color: "#bbb" }}>—</span>;
  }

  return (
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
  );
}

/* ── Draggable column header ────────────────────────────────────────────── */
function SortableHeader({ col, width, fontSize, onStartResize, isSearchable, isExcluded, onToggleExclusion, searchActive }) {
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
        minWidth: width,
        maxWidth: width,
        padding: "5px 7px",
        textAlign: "left",
        fontWeight: 600,
        fontSize: `${fontSize}px`,
        color: isDragging ? "#2563eb" : "#555",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        border: "1px solid #ccc",
        position: "relative",
        userSelect: "none",
        whiteSpace: "normal",
        wordBreak: "break-word",
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
          whiteSpace: "normal",
          wordBreak: "break-word",
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
  const [emailToast, setEmailToast] = React.useState(null); // { warnings: string[] }
  const [emailTemplates, setEmailTemplates] = React.useState(() => loadEmailTemplates());
  React.useEffect(() => {
    function onTpl() { setEmailTemplates(loadEmailTemplates()); }
    window.addEventListener("spaila:emailtemplates", onTpl);
    return () => window.removeEventListener("spaila:emailtemplates", onTpl);
  }, []);

  const [shopConfig, setShopConfig] = React.useState(() => loadShopConfig());
  React.useEffect(() => {
    function onShop() {
      const cfg = loadShopConfig();
      setShopConfig(cfg);
      const name = cfg.shopName?.trim() || "Parser Viewer";
      document.title = name;
      window.parserApp?.setTitle?.(name);
    }
    window.addEventListener("spaila:shopconfig", onShop);
    return () => window.removeEventListener("spaila:shopconfig", onShop);
  }, []);

  // Sync title on mount
  React.useEffect(() => {
    const name = shopConfig.shopName?.trim() || "Parser Viewer";
    document.title = name;
    window.parserApp?.setTitle?.(name);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Documents config (letterhead path + text position)
  const [documentsConfig, setDocumentsConfig] = React.useState(() => loadDocumentsConfig());
  React.useEffect(() => {
    function onDocs() { setDocumentsConfig(loadDocumentsConfig()); }
    window.addEventListener("spaila:documentsconfig", onDocs);
    return () => window.removeEventListener("spaila:documentsconfig", onDocs);
  }, []);

  const [giftLetterToast, setGiftLetterToast] = React.useState(null); // { error?: string }
  const [saveToast, setSaveToast] = React.useState(null); // { ok, message }

  async function handleSaveToFolder() {
    const folder = shopConfig.saveFolder;
    if (!folder) {
      setSaveToast({ ok: false, message: "No save folder set. Go to Settings → General to choose one." });
      setTimeout(() => setSaveToast(null), 5000);
      return;
    }
    // Collect ALL localStorage entries so they're included in the backup
    const localStorageData = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        localStorageData[key] = localStorage.getItem(key);
      }
    } catch (_) {}

    const result = await window.parserApp?.backupSave?.({
      folderPath: folder,
      localStorageData,
    });
    if (result?.ok) {
      setSaveToast({ ok: true, message: `Saved to ${folder}` });
    } else {
      setSaveToast({ ok: false, message: `Backup failed: ${result?.error ?? "unknown error"}` });
    }
    setTimeout(() => setSaveToast(null), 5000);
  }

  async function handleGenerateGiftLetter(row) {
    const result = await window.parserApp?.generateGiftLetter?.({
      letterheadPath: documentsConfig.letterheadPath,
      giftMessage:    row.gift_message,
      textX:          documentsConfig.giftTextX,
      textY:          documentsConfig.giftTextY,
      textMaxWidth:   documentsConfig.giftTextMaxWidth,
      textFontSize:   documentsConfig.giftTextFontSize,
      textColor:      documentsConfig.giftTextColor,
    });
    if (result && !result.ok) {
      setGiftLetterToast({ error: `PDF error: ${result.error}` });
      setTimeout(() => setGiftLetterToast(null), 6000);
    }
  }

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
            defaultWidth: 100,
          };
          if (key === "order_info") return {
            key: "order_info",
            label: "Order Info",
            defaultWidth: 160,
          };
          return {
            key,
            label: fieldMap[key]?.label ?? key,
            defaultWidth: fieldMap[key]?.defaultWidth ?? 120,
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

  const FONT_SIZE_KEY = "spaila_table_font_size";
  const [tableFontSize, setTableFontSize] = React.useState(() => {
    try { return parseInt(localStorage.getItem(FONT_SIZE_KEY), 10) || 12; } catch { return 12; }
  });
  function changeTableFontSize(delta) {
    setTableFontSize((prev) => {
      const next = Math.min(20, Math.max(9, prev + delta));
      try { localStorage.setItem(FONT_SIZE_KEY, String(next)); } catch (_) {}
      return next;
    });
  }

  const COL_WIDTHS_KEY = "spaila_col_widths";
  const [colWidths, setColWidths] = React.useState(() => {
    const defaults = Object.fromEntries(loadFieldConfig().map((f) => [f.key, f.defaultWidth ?? 120]));
    try {
      const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || "{}");
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  });

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

  async function handleComposeEmail(row) {
    const warnings = [];
    // Build label map from current fieldConfig so warnings show user-defined names
    const labelMap = Object.fromEntries(fieldConfig.map((f) => [f.key, f.label]));
    // Select template
    const template = selectEmailTemplate(emailTemplates, row);
    // Render subject + body
    const { text: subject, warnings: subjectWarnings } = renderEmailTemplate(template.subject_template, row, labelMap);
    const { text: body,    warnings: bodyWarnings    } = renderEmailTemplate(template.body_template,    row, labelMap);
    warnings.push(...subjectWarnings, ...bodyWarnings);
    // Gather attachments
    let attachmentPaths = [];
    if (template.attachment_mode !== "none" && row.order_folder_path) {
      const result = await window.parserApp?.listAttachments?.({
        folderPath: row.order_folder_path,
        mode: template.attachment_mode,
        extensions: template.attachment_extensions || [],
      });
      if (result) {
        attachmentPaths = result.files || [];
        warnings.push(...(result.warnings || []));
      }
    }
    // Show warnings toast (non-blocking)
    if (warnings.length) setEmailToast({ warnings });
    // Open compose
    const result = await window.parserApp?.composeEmail?.({
      to: row.buyer_email || "",
      subject,
      body,
      attachmentPaths,
    });
    // If mailto fallback was used but attachments existed, add note
    if (result?.method === "mailto" && result?.attachmentsFallback) {
      setEmailToast((prev) => ({
        warnings: [
          ...(prev?.warnings || []),
          "Outlook not found — attachments were not included. Install Outlook or add files manually.",
        ],
      }));
    }
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
    const startWidth = colWidths[key] ?? 120;
    function onMove(ev) {
      const newWidth = Math.max(40, startWidth + (ev.clientX - startX));
      setColWidths((prev) => ({ ...prev, [key]: newWidth }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Persist after drag ends
      setColWidths((prev) => {
        try { localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(prev)); } catch (_) {}
        return prev;
      });
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

      {/* Email warnings toast */}
      {emailToast && (
        <div style={{
          position: "fixed", top: 16, right: 16, zIndex: 99999,
          background: "#1e293b", color: "#fff", borderRadius: 8,
          padding: "12px 16px", maxWidth: 340, boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
          fontSize: 12, lineHeight: 1.6,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>⚠ Email warnings</div>
              {emailToast.warnings.map((w, i) => <div key={i} style={{ color: "#fbbf24" }}>• {w}</div>)}
            </div>
            <button onClick={() => setEmailToast(null)}
              style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 14, padding: 0, flexShrink: 0 }}>✕</button>
          </div>
        </div>
      )}

      {/* Gift letter toast */}
      {giftLetterToast && (
        <div style={{
          position: "fixed", top: 16, right: 16, zIndex: 99999,
          background: giftLetterToast.error ? "#7f1d1d" : "#14532d",
          color: "#fff", borderRadius: 8,
          padding: "12px 16px", maxWidth: 360,
          boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
          fontSize: 12, lineHeight: 1.6,
          display: "flex", alignItems: "flex-start", gap: 10,
        }}>
          <span style={{ flex: 1 }}>
            {giftLetterToast.error
              ? `⚠ ${giftLetterToast.error}`
              : "✓ Gift letter generated"}
          </span>
          <button onClick={() => setGiftLetterToast(null)}
            style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 14, padding: 0, flexShrink: 0 }}>✕</button>
        </div>
      )}

      {/* Save toast */}
      {saveToast && (
        <div style={{
          position: "fixed", top: 56, right: 16, zIndex: 99999,
          background: saveToast.ok ? "#14532d" : "#7f1d1d",
          color: "#fff", borderRadius: 8,
          padding: "12px 16px", maxWidth: 360,
          boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
          fontSize: 12, lineHeight: 1.6,
          display: "flex", alignItems: "flex-start", gap: 10,
        }}>
          <span style={{ flex: 1 }}>{saveToast.ok ? "✓" : "⚠"} {saveToast.message}</span>
          <button onClick={() => setSaveToast(null)}
            style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 14, padding: 0 }}>✕</button>
        </div>
      )}

      {/* Command bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px", borderBottom: "1px solid #ddd",
        background: "#f7f7f7", flexShrink: 0,
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* Save button — bright when rows exist, dim when nothing to save */}
          {(() => {
            const canSave = rows.length > 0;
            return (
              <button
                onClick={canSave ? handleSaveToFolder : undefined}
                title={
                  !canSave ? "Nothing to save yet"
                  : shopConfig.saveFolder ? `Save to ${shopConfig.saveFolder}`
                  : "Save (set folder in Settings → General)"
                }
                style={{
                  width: 36, height: 36,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: canSave ? "#2563eb" : "#e2e8f0",
                  border: `1px solid ${canSave ? "#1d4ed8" : "#cbd5e1"}`,
                  borderRadius: "10px",
                  cursor: canSave ? "pointer" : "default",
                  fontSize: "18px",
                  color: canSave ? "#fff" : "#94a3b8",
                  boxShadow: canSave ? "0 1px 3px rgba(37,99,235,0.4)" : "none",
                  transition: "all 0.2s",
                  flexShrink: 0,
                  opacity: canSave ? 1 : 0.55,
                }}
                onMouseEnter={(e) => {
                  if (!canSave) return;
                  e.currentTarget.style.background = "#1d4ed8";
                  e.currentTarget.style.boxShadow = "0 2px 8px rgba(37,99,235,0.5)";
                }}
                onMouseLeave={(e) => {
                  if (!canSave) return;
                  e.currentTarget.style.background = "#2563eb";
                  e.currentTarget.style.boxShadow = "0 1px 3px rgba(37,99,235,0.4)";
                }}
              >💾</button>
            );
          })()}

          {/* Settings button */}
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{
              width: 36, height: 36,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              cursor: "pointer",
              fontSize: "18px", color: "#64748b",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
              transition: "box-shadow 0.15s, border-color 0.15s, color 0.15s",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.14)";
              e.currentTarget.style.borderColor = "#cbd5e1";
              e.currentTarget.style.color = "#1e293b";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.08)";
              e.currentTarget.style.borderColor = "#e2e8f0";
              e.currentTarget.style.color = "#64748b";
            }}
          >⚙</button>

          {/* Divider */}
          <div style={{ width: 1, height: 28, background: "#d1d5db", margin: "0 4px", flexShrink: 0 }} />

          <button onClick={onImport} style={tabStyle}>+ Import Order</button>
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
          {/* Font size control */}
          <div style={{
            display: "flex", alignItems: "center", gap: "2px",
            border: "1px solid #ccc", borderRadius: "4px",
            overflow: "hidden",
          }}>
            <button
              onClick={() => changeTableFontSize(-1)}
              title="Decrease font size"
              disabled={tableFontSize <= 9}
              style={{
                padding: "4px 7px", border: "none", background: "none",
                cursor: tableFontSize <= 9 ? "default" : "pointer",
                fontSize: "11px", color: tableFontSize <= 9 ? "#bbb" : "#555",
                lineHeight: 1,
              }}
            >A−</button>
            <span style={{
              fontSize: "11px", color: "#666", minWidth: "24px",
              textAlign: "center", userSelect: "none",
            }}>{tableFontSize}</span>
            <button
              onClick={() => changeTableFontSize(1)}
              title="Increase font size"
              disabled={tableFontSize >= 20}
              style={{
                padding: "4px 7px", border: "none", background: "none",
                cursor: tableFontSize >= 20 ? "default" : "pointer",
                fontSize: "13px", color: tableFontSize >= 20 ? "#bbb" : "#555",
                lineHeight: 1,
              }}
            >A+</button>
          </div>
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
      <div style={{ flex: 1, overflow: "auto", padding: "16px", overflowX: "auto" }}>
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
            <table style={{
              borderCollapse: "collapse",
              fontSize: `${tableFontSize}px`,
              tableLayout: "fixed",
              border: "1px solid #ddd",
              width: 30 + visibleColumns.reduce((sum, c) => sum + (colWidths[c.key] ?? c.defaultWidth), 0),
              minWidth: 30 + visibleColumns.reduce((sum, c) => sum + (colWidths[c.key] ?? c.defaultWidth), 0),
            }}>
              <colgroup>
                <col style={{ width: 30, minWidth: 30, maxWidth: 30 }} />
                {visibleColumns.map((c) => {
                  const w = colWidths[c.key] ?? c.defaultWidth;
                  return <col key={c.key} style={{ width: w, minWidth: w, maxWidth: w }} />;
                })}
              </colgroup>

              <SortableContext items={columnOrder} strategy={horizontalListSortingStrategy}>
                <thead style={{ background: "#e5e5e5" }}>
                  <tr>
                    <th style={{
                      width: 30, minWidth: 30, maxWidth: 30,
                      padding: "5px 0 5px 8px",
                      border: "1px solid #ccc", userSelect: "none",
                      boxSizing: "border-box",
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
                        fontSize={tableFontSize}
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
                  const rowH = Math.round(tableFontSize * 1.6 * 3); // 3 lines tall
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
                      <td style={{
                        width: 30, minWidth: 30, maxWidth: 30,
                        height: rowH,
                        padding: "5px 0 5px 8px",
                        border: "1px solid #e8e8e8",
                        boxSizing: "border-box",
                        verticalAlign: "top",
                      }}>
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
                          const pillBg  = currentState?.color || null;
                          const pillTc  = pillBg ? contrastColor(pillBg) : "#6b7280";
                          const pillBorder = pillBg
                            ? (pillTc === "#ffffff" ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.12)")
                            : "#d1d5db";
                          return (
                            <td key="status" style={{
                              width: w, minWidth: w, maxWidth: w,
                              height: rowH,
                              padding: "4px 6px",
                              border: "1px solid #e8e8e8",
                              background: "transparent",
                              overflow: "hidden",
                              boxSizing: "border-box",
                              verticalAlign: "top",
                              textAlign: "left",
                            }}>
                              <select
                                value={currentKey}
                                onChange={(e) => handleSetStatus(r.id, e.target.value || null)}
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: "3px 10px",
                                  border: `1px solid ${pillBorder}`,
                                  borderRadius: "999px",
                                  fontSize: `${Math.max(10, tableFontSize - 1)}px`,
                                  fontWeight: 600,
                                  background: pillBg || "transparent",
                                  color: pillBg ? pillTc : "#9ca3af",
                                  cursor: "pointer",
                                  outline: "none",
                                  appearance: "none",
                                  whiteSpace: "nowrap",
                                  transition: "all 0.15s ease",
                                  maxWidth: "100%",
                                }}
                              >
                                <option value="">Status</option>
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
                              width: w, minWidth: w, maxWidth: w,
                              height: rowH,
                              padding: "3px 6px",
                              border: "1px solid #e8e8e8",
                              verticalAlign: "top",
                              overflow: "hidden",
                              boxSizing: "border-box",
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

                        const isBuyerName  = c.key === "buyer_name";
                        const isGiftMsg    = c.key === "gift_message";
                        const hasGiftMsg   = isGiftMsg && !!r.gift_message && documentsConfig.showPrintIcon !== false;
                        const needsIcon    = isBuyerName || hasGiftMsg;
                        return (
                          <td key={c.key} style={{
                            width: w,
                            minWidth: w,
                            maxWidth: w,
                            height: rowH,
                            padding: "5px 7px",
                            border: "1px solid #e8e8e8",
                            background: cellBg, color: cellTextColor,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            verticalAlign: "top",
                            fontStyle: !r[c.key] && c.key === PRICE_TYPE_FIELD_KEY && priceRule?.typeValue
                              ? "italic" : undefined,
                            position: needsIcon ? "relative" : undefined,
                            boxSizing: "border-box",
                          }}>
                            {/* Gift letter icon — only when gift_message has text */}
                            {hasGiftMsg && (() => {
                              const onDark = cellBg && contrastColor(cellBg) === "#ffffff";
                              const iconColor = onDark
                                ? "#ffffff"
                                : (documentsConfig.letterheadPath ? "#7c3aed" : "#94a3b8");
                              return (
                                <button
                                  title={documentsConfig.letterheadPath
                                    ? "Generate gift letter PDF"
                                    : "Generate gift message PDF (no letterhead — plain page)"}
                                  onClick={(e) => { e.stopPropagation(); handleGenerateGiftLetter(r); }}
                                  style={{
                                  position: "absolute", bottom: 3, right: 3,
                                  width: 16, height: 16,
                                  background: "none", border: "none", cursor: "pointer",
                                  padding: 0, lineHeight: 1,
                                  fontSize: 14,
                                  color: iconColor,
                                  opacity: 0.85,
                                  transition: "opacity 0.15s, transform 0.1s",
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1.15)"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.85"; e.currentTarget.style.transform = "scale(1)"; }}
                              >🖨</button>
                              );
                            })()}
                            {isBuyerName && (() => {
                              const onDark = cellBg && contrastColor(cellBg) === "#ffffff";
                              const iconColor = onDark ? "#ffffff" : "#64748b";
                              return (
                                <button
                                  title="Compose email"
                                  onClick={(e) => { e.stopPropagation(); handleComposeEmail(r); }}
                                  className="email-btn"
                                  style={{
                                  position: "absolute", bottom: 3, right: 3,
                                  width: 16, height: 16,
                                  background: "none", border: "none", cursor: "pointer",
                                  padding: 0, lineHeight: 1,
                                  fontSize: 14,
                                  color: iconColor,
                                  opacity: 0.85,
                                  transition: "opacity 0.15s, transform 0.1s",
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1.15)"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.85"; e.currentTarget.style.transform = "scale(1)"; }}
                              >✉</button>
                              );
                            })()}
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
