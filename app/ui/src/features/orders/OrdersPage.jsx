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
import AppHeader from "../../shared/components/AppHeader.jsx";
import {
  loadFieldConfig,
  loadPriceList,
  matchPriceRule,
  PRICE_TYPE_FIELD_KEY,
  contrastColor,
  loadStatusConfig,
  loadOrderStatuses,
  setOrderStatus,
  loadDateConfig,
  DATE_FIELD_KEYS,
  formatDate,
  loadEmailTemplates,
  selectEmailTemplate,
  renderEmailTemplate,
  loadShopConfig,
  loadDocumentsConfig,
  loadPrintConfig,
  loadViewConfig,
} from "../../shared/utils/fieldConfig.js";

const API = "http://127.0.0.1:8055";

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

function getOrderInfoBadges(row) {
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

  return badges;
}

function OrderInfoCell({ row }) {
  const badges = getOrderInfoBadges(row);

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

function MailDockModal({ dock, onClose, onOpenEmail, onOpenFolder, onSendEmail, canSendEmail }) {
  if (!dock) return null;
  const [currentSubject, setCurrentSubject] = React.useState(dock.currentSubject ?? dock.originalSubject ?? dock.subject ?? "");
  const [currentBody, setCurrentBody] = React.useState(dock.currentBody ?? dock.originalBody ?? dock.body ?? "");
  const [subjectFocused, setSubjectFocused] = React.useState(false);
  const [sendState, setSendState] = React.useState({ sending: false, error: "", success: "" });
  const noteWarnings = (dock.warnings || []).filter((warning) => !/^Multiple attachments found/i.test(String(warning || "")));
  const originalSubject = dock.originalSubject ?? dock.subject ?? "";
  const originalBody = dock.originalBody ?? dock.body ?? "";
  const isCustomMessage = currentSubject === "" && currentBody === "";
  const isEdited = !isCustomMessage && (currentSubject !== originalSubject || currentBody !== originalBody);
  const editStateLabel = isCustomMessage ? "Custom message" : (isEdited ? "Edited" : "");

  React.useEffect(() => {
    setCurrentSubject(dock.currentSubject ?? dock.originalSubject ?? dock.subject ?? "");
    setCurrentBody(dock.currentBody ?? dock.originalBody ?? dock.body ?? "");
    setSubjectFocused(false);
    setSendState({ sending: false, error: "", success: "" });
  }, [dock]);

  async function handleSend() {
    if (!canSendEmail) {
      setSendState({ sending: false, error: "SMTP account info is missing in Settings.", success: "" });
      return;
    }
    if (!String(dock.to || "").trim()) {
      setSendState({ sending: false, error: "Recipient is required.", success: "" });
      return;
    }
    if (!String(currentSubject || "").trim()) {
      setSendState({ sending: false, error: "Subject is required.", success: "" });
      return;
    }
    if (!String(currentBody || "").trim()) {
      setSendState({ sending: false, error: "Body is required.", success: "" });
      return;
    }
    setSendState({ sending: true, error: "", success: "" });
    try {
      const result = await onSendEmail?.({ subject: currentSubject, body: currentBody });
      if (result?.ok) {
        setSendState({ sending: false, error: "", success: "Email sent" });
      } else {
        setSendState({ sending: false, error: result?.error || "Could not send email.", success: "" });
      }
    } catch (error) {
      setSendState({ sending: false, error: error?.message || "Could not send email.", success: "" });
    }
  }

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      background: "rgba(15, 23, 42, 0.45)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 100000,
      padding: 24,
    }}>
      <div style={{
        width: "min(980px, 100%)",
        maxHeight: "92vh",
        overflow: "auto",
        background: "#ffffff",
        borderRadius: 16,
        boxShadow: "0 24px 60px rgba(15, 23, 42, 0.28)",
        border: "1px solid #dbe2ea",
      }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", lineHeight: 1.2 }}>Mail Dock</div>
            <div style={{ marginTop: 2, fontSize: 11, color: "#64748b", lineHeight: 1.3 }}>
              Review the composed email before opening your mail app.
            </div>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>

        <div style={{ padding: 16, display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>To</div>
              <div style={{ marginTop: 3, fontSize: 14, color: "#0f172a", lineHeight: 1.3 }}>{dock.to || "No recipient"}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>Subject</div>
              <input
                value={currentSubject}
                onChange={(event) => setCurrentSubject(event.target.value)}
                onFocus={() => setSubjectFocused(true)}
                onBlur={() => setSubjectFocused(false)}
                placeholder="No subject"
                style={{
                  marginTop: 4,
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 11px",
                  border: `1px solid ${subjectFocused ? "#2563eb" : "#d1d5db"}`,
                  borderRadius: 10,
                  fontSize: 13,
                  color: "#0f172a",
                  background: "#fff",
                  outline: "none",
                  boxShadow: subjectFocused ? "0 0 0 3px rgba(37, 99, 235, 0.12)" : "none",
                }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  onClick={() => setCurrentSubject("")}
                  style={{ border: "1px solid #cbd5e1", background: "#fff", color: "#0f172a", borderRadius: 10, padding: "7px 11px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}
                >
                  Clear Subject
                </button>
                <button
                  onClick={() => setCurrentBody("")}
                  style={{ border: "1px solid #cbd5e1", background: "#fff", color: "#0f172a", borderRadius: 10, padding: "7px 11px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}
                >
                  Clear Body
                </button>
                <button
                  onClick={() => {
                    setCurrentSubject(originalSubject);
                    setCurrentBody(originalBody);
                  }}
                  style={{ border: "1px solid #cbd5e1", background: "#f8fafc", color: "#0f172a", borderRadius: 10, padding: "7px 11px", cursor: "pointer", fontWeight: 600, fontSize: 13 }}
                >
                  Reload Template
                </button>
              </div>
              {editStateLabel ? (
                <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>
                  {editStateLabel}
                </div>
              ) : null}
            </div>
            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>Body</div>
                {editStateLabel ? (
                  <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>
                    {editStateLabel}
                  </div>
                ) : null}
              </div>
              <textarea
                value={currentBody}
                onChange={(event) => setCurrentBody(event.target.value)}
                placeholder="Compose your email"
                style={{
                  marginTop: 4,
                  width: "100%",
                  minHeight: 320,
                  boxSizing: "border-box",
                  padding: 12,
                  background: "#f8fafc",
                  border: "1px solid #e5e7eb",
                  borderRadius: 12,
                  whiteSpace: "pre-wrap",
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: "#0f172a",
                  resize: "vertical",
                  fontFamily: "inherit",
                }}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(260px, 1fr) auto", gap: 12, alignItems: "stretch" }}>
            <div style={{ padding: 12, borderRadius: 12, background: "#f8fafc", border: "1px solid #e5e7eb", display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Attachments ({dock.attachmentPaths?.length || 0})
              </div>
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "center" }}>
                {dock.attachmentPaths?.length ? dock.attachmentPaths.map((filePath) => (
                  <div key={filePath} style={{ fontSize: 13, color: "#0f172a" }}>
                    {String(filePath).split(/[/\\]/).pop()}
                  </div>
                )) : (
                  <div style={{ fontSize: 13, color: "#0f172a" }}>No attachments ready.</div>
                )}
              </div>
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "4px 12px", fontSize: 11, color: "#64748b" }}>
                <div>{dock.attachmentSourceLabel || "Source: Order Folder"}</div>
                {dock.environment?.attachmentCapability === "Manual" ? (
                  <div>Attach manually</div>
                ) : null}
              </div>
            </div>

            <div style={{ padding: 12, borderRadius: 12, background: "#f8fafc", border: "1px solid #e5e7eb", display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Environment
              </div>
              <div style={{ marginTop: 8, fontSize: 13, color: "#0f172a" }}>
                {dock.environment?.os || "Unknown"} • {dock.environment?.emailClient || "Unknown"}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
                Attachments: {dock.environment?.attachmentCapability || "Manual"}
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, paddingLeft: 4 }}>
              <button
                onClick={handleSend}
                disabled={sendState.sending || !canSendEmail}
                style={{ border: "none", background: (sendState.sending || !canSendEmail) ? "#94a3b8" : "#16a34a", color: "#fff", borderRadius: 10, padding: "8px 14px", cursor: (sendState.sending || !canSendEmail) ? "default" : "pointer", fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", opacity: canSendEmail ? 1 : 0.55 }}
              >
                {sendState.sending ? "Sending..." : "Send"}
              </button>
              <button onClick={onOpenFolder} style={{ border: "1px solid #cbd5e1", background: "#fff", borderRadius: 10, padding: "8px 13px", cursor: "pointer", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
                Open Attachment Folder
              </button>
              <button onClick={onClose} style={{ border: "1px solid #e2e8f0", background: "#f8fafc", color: "#475569", borderRadius: 10, padding: "8px 12px", cursor: "pointer", fontWeight: 500, fontSize: 13, whiteSpace: "nowrap" }}>
                Close
              </button>
              <button
                onClick={() => onOpenEmail?.({ subject: currentSubject, body: currentBody })}
                style={{ border: "none", background: "#2563eb", color: "#fff", borderRadius: 10, padding: "8px 14px", cursor: "pointer", fontWeight: 700, fontSize: 13, boxShadow: "0 10px 24px rgba(37, 99, 235, 0.22)", whiteSpace: "nowrap" }}
              >
                Open Email App
              </button>
            </div>
          </div>

          {sendState.error ? (
            <div style={{ fontSize: 12, color: "#b91c1c" }}>{sendState.error}</div>
          ) : null}
          {sendState.success ? (
            <div style={{ fontSize: 12, color: "#047857" }}>✔ {sendState.success}</div>
          ) : null}

          {noteWarnings.length ? (
            <div style={{ padding: 12, borderRadius: 12, background: "#1e293b", color: "#fff" }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>Notes</div>
              <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                {noteWarnings.map((warning, index) => (
                  <div key={`${warning}-${index}`} style={{ fontSize: 12, color: "#fbbf24" }}>• {warning}</div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function isCompletedOrder(row) {
  return row.item_status
    ? row.item_status === "completed"
    : row.status === "completed" || row.status === "done";
}

function parseNumericValue(value) {
  const normalized = String(value ?? "").replace(/[^0-9.-]/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateValue(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSortConfig(sort) {
  return {
    field: sort?.field || "order_date",
    direction: sort?.direction === "asc" ? "asc" : "desc",
  };
}

function compareSortValues(aValue, bValue, direction) {
  if (aValue == null && bValue == null) return 0;
  if (aValue == null) return 1;
  if (bValue == null) return -1;
  if (aValue < bValue) return direction === "asc" ? -1 : 1;
  if (aValue > bValue) return direction === "asc" ? 1 : -1;
  return 0;
}

function getRowSortValue(row, field, { statusConfig, orderStatuses }) {
  if (!field) {
    return null;
  }

  switch (field) {
    case "status": {
      const statusKey = orderStatuses[String(row.id)] ?? "";
      const statusLabel = statusConfig.states.find((state) => state.key === statusKey)?.label || "";
      return statusLabel ? statusLabel.toLowerCase() : null;
    }
    case "order_info": {
      const badges = getOrderInfoBadges(row).map((badge) => badge.label).join(" ");
      return badges ? badges.toLowerCase() : null;
    }
    case "price":
    case "quantity":
      return parseNumericValue(row[field]);
    case "order_date":
    case "ship_by":
      return parseDateValue(row[field]);
    default: {
      const value = row[field];
      if (value == null || value === "") {
        return null;
      }
      return String(value).toLowerCase();
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

/* ── Draggable column header ────────────────────────────────────────────── */
function SortableHeader({ col, width, fontSize, onStartResize, activeSort, onOpenMenu }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: col.key });
  const isSorted = activeSort.field === col.key;
  const sortIndicator = isSorted ? (activeSort.direction === "asc" ? "↑" : "↓") : "";

  return (
    <th
      ref={setNodeRef}
      onContextMenu={(e) => onOpenMenu(e, col)}
      style={{
        width,
        minWidth: width,
        maxWidth: width,
        top: -17,
        padding: "5px 7px",
        textAlign: "left",
        fontWeight: 600,
        fontSize: `${fontSize}px`,
        color: isDragging ? "#2563eb" : "#555",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        border: "1px solid #ccc",
        background: isDragging ? "#dbeafe" : "#e5e5e5",
        position: "sticky",
        userSelect: "none",
        whiteSpace: "normal",
        wordBreak: "break-word",
        overflow: "hidden",
        opacity: isDragging ? 0.85 : 1,
        transform: CSS.Transform.toString(transform),
        transition: transition ?? "transform 200ms ease",
        zIndex: isDragging ? 12 : 4,
        boxSizing: "border-box",
        boxShadow: "inset 0 -1px 0 #d1d5db",
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
          paddingRight: "8px",
        }}
        title={`Drag to reorder — ${col.label}`}
      >
        <span>{col.label}</span>
        {sortIndicator ? <span style={{ marginLeft: "6px", color: "#2563eb" }}>{sortIndicator}</span> : null}
      </span>

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
export default function OrdersPage({ onImport, onWorkspace, onSettings, refreshKey, columnOrder, onColumnOrderChange, activeTab, onActiveTabChange, isActive, onCountsChange }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [viewConfig, setViewConfig] = React.useState(() => loadViewConfig());
  const [activeSort, setActiveSort] = React.useState(() => normalizeSortConfig(loadViewConfig().defaultSort));
  const [editingOrder, setEditingOrder] = React.useState(null);

  // Dirty flag — false on startup, true only after something changes this session
  const [sessionDirty, setSessionDirty] = React.useState(false);
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    // refreshKey increments when a new order is imported
    setSessionDirty(true);
  }, [refreshKey]);
  const [emailToast, setEmailToast] = React.useState(null); // { warnings: string[] }
  const [mailDock, setMailDock] = React.useState(null);
  const [mailDockLoadingId, setMailDockLoadingId] = React.useState("");
  const [emailEnvironment, setEmailEnvironment] = React.useState({ os: "Unknown", emailClient: "Default Email App", attachmentCapability: "Manual" });
  const [emailTemplates, setEmailTemplates] = React.useState(() => loadEmailTemplates());
  React.useEffect(() => {
    function onTpl() { setEmailTemplates(loadEmailTemplates()); }
    window.addEventListener("spaila:emailtemplates", onTpl);
    return () => window.removeEventListener("spaila:emailtemplates", onTpl);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    window.parserApp?.getEmailEnvironment?.()
      .then((info) => {
        if (!cancelled && info) {
          const nextEnvironment = {
            os: info.os || "Unknown",
            emailClient: info.emailClient || "Default Email App",
            attachmentCapability: info.attachmentCapability || "Manual",
          };
          setEmailEnvironment(nextEnvironment);
          setMailDock((current) => current ? { ...current, environment: nextEnvironment } : current);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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

  const smtpConfigured = !!(
    String(shopConfig?.smtpEmailAddress || "").trim()
    && String(shopConfig?.smtpHost || "").trim()
    && String(shopConfig?.smtpPort || "").trim()
    && String(shopConfig?.smtpUsername || "").trim()
    && String(shopConfig?.smtpPassword || "").trim()
  );

  // Documents config (letterhead path + text position)
  const [documentsConfig, setDocumentsConfig] = React.useState(() => loadDocumentsConfig());
  React.useEffect(() => {
    function onDocs() { setDocumentsConfig(loadDocumentsConfig()); }
    window.addEventListener("spaila:documentsconfig", onDocs);
    return () => window.removeEventListener("spaila:documentsconfig", onDocs);
  }, []);

  const [printConfig, setPrintConfig] = React.useState(() => loadPrintConfig());
  React.useEffect(() => {
    function onPrintConfig() { setPrintConfig(loadPrintConfig()); }
    window.addEventListener("spaila:printconfig", onPrintConfig);
    return () => window.removeEventListener("spaila:printconfig", onPrintConfig);
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
      setSessionDirty(false); // dim again until next change
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

  // Date config — display format, showYear, flexibleSearch
  const [dateConfig, setDateConfig] = React.useState(() => loadDateConfig());
  React.useEffect(() => {
    function onDateChange() { setDateConfig(loadDateConfig()); }
    window.addEventListener("spaila:dateconfig", onDateChange);
    return () => window.removeEventListener("spaila:dateconfig", onDateChange);
  }, []);
  React.useEffect(() => {
    function onViewConfigChange() { setViewConfig(loadViewConfig()); }
    window.addEventListener("spaila:viewconfig", onViewConfigChange);
    return () => window.removeEventListener("spaila:viewconfig", onViewConfigChange);
  }, []);
  React.useEffect(() => {
    setActiveSort(normalizeSortConfig(viewConfig.defaultSort));
  }, [viewConfig.defaultSort?.field, viewConfig.defaultSort?.direction]);

  function handleSetStatus(orderId, statusKey) {
    setOrderStatus(orderId, statusKey);
    setOrderStatuses(loadOrderStatuses());
    setSessionDirty(true);
  }

  function updateColumnOrder(next) {
    onColumnOrderChange(next);
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
  const sortFieldOptions = React.useMemo(() => {
    const preferredKeys = new Set(["order_date", "ship_by", "buyer_name", "order_number", "price"]);
    const options = fieldConfig
      .filter((field) => field.visibleInOrders || preferredKeys.has(field.key))
      .map((field) => ({ key: field.key, label: field.label }));
    if (activeSort.field && !options.some((option) => option.key === activeSort.field)) {
      options.unshift({
        key: activeSort.field,
        label:
          activeSort.field === "status"
            ? (statusConfig.columnLabel || "Status")
            : activeSort.field === "order_info"
              ? "Order Info"
              : (fieldMap[activeSort.field]?.label ?? activeSort.field),
      });
    }
    return options;
  }, [activeSort.field, fieldConfig, fieldMap, statusConfig.columnLabel]);

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
  const [headerMenu, setHeaderMenu] = React.useState({ visible: false, x: 0, y: 0, column: null });
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
  const colWidthsRef = React.useRef(colWidths);
  React.useEffect(() => {
    colWidthsRef.current = colWidths;
  }, [colWidths]);
  const safeOrders = rows || [];
  console.log("orders:", safeOrders);

  const getDisplayedCellValue = React.useCallback((row, columnKey) => {
    if (columnKey === "status") {
      const currentKey = orderStatuses[String(row.id)] ?? "";
      return statusConfig.states.find((s) => s.key === currentKey)?.label || "";
    }

    if (columnKey === "order_info") {
      const badges = getOrderInfoBadges(row);
      return badges.length ? badges.map((badge) => badge.label).join(", ") : "—";
    }

    let displayValue = DATE_FIELD_KEYS.has(columnKey)
      ? formatDate(row[columnKey], dateConfig)
      : row[columnKey];

    if (columnKey === PRICE_TYPE_FIELD_KEY && !displayValue) {
      const priceRule = matchPriceRule(row.price, priceList);
      if (priceRule?.typeValue) {
        displayValue = priceRule.typeValue;
      }
    }

    return displayValue ?? "";
  }, [dateConfig, orderStatuses, priceList, statusConfig.states]);

  const getPrintCellPresentation = React.useCallback((row, columnKey) => {
    const text = getDisplayedCellValue(row, columnKey) || "—";

    if (columnKey === "status") {
      const currentKey = orderStatuses[String(row.id)] ?? "";
      const currentState = statusConfig.states.find((s) => s.key === currentKey);
      const bg = currentState?.color || null;
      return {
        text,
        bg,
        color: bg ? contrastColor(bg) : (text === "—" ? "#9ca3af" : "#111827"),
        fontStyle: undefined,
      };
    }

    if (columnKey === "order_info") {
      return {
        text,
        bg: null,
        color: text === "—" ? "#9ca3af" : "#111827",
        fontStyle: undefined,
      };
    }

    const fMeta = fieldMap[columnKey];
    const priceRule = matchPriceRule(row.price, priceList);
    const paletteBg = priceRule && fMeta?.paletteEnabled ? priceRule.color : null;
    const hl = fMeta?.highlight;
    const rawValue = row[columnKey];
    const highlightBg = !paletteBg && hl?.enabled && hl?.color && rawValue ? hl.color : null;
    const bg = paletteBg || highlightBg || null;
    const displayValue = getDisplayedCellValue(row, columnKey);

    return {
      text,
      bg,
      color: bg ? contrastColor(bg) : (displayValue ? "#111827" : "#9ca3af"),
      fontStyle: !rawValue && columnKey === PRICE_TYPE_FIELD_KEY && priceRule?.typeValue ? "italic" : undefined,
    };
  }, [fieldMap, getDisplayedCellValue, orderStatuses, priceList, statusConfig.states]);

  const getRowSearchValues = React.useCallback((row) => {
    const dateStrings = [row.order_date, row.ship_by]
      .flatMap((value) => [value, formatDate(value, dateConfig)])
      .filter(Boolean);

    return [
      row.buyer_name,
      row.order_number,
      row.pet_name,
      row.notes,
      row.order_notes,
      row.custom_1,
      row.custom_2,
      row.custom_3,
      row.custom_4,
      row.custom_5,
      row.custom_6,
      ...dateStrings,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
  }, [dateConfig]);

  function toggleRow(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === displayOrders.length && displayOrders.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(displayOrders.map((r) => r.id)));
    }
  }

  function closeContextMenu() {
    setContextMenu((m) => ({ ...m, visible: false, row: null }));
  }

  function closeHeaderMenu() {
    setHeaderMenu((m) => ({ ...m, visible: false, column: null }));
  }

  function handleContextMenu(e, row) {
    e.preventDefault();
    closeHeaderMenu();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, row });
  }

  function handleHeaderContextMenu(e, column) {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
    setHeaderMenu({ visible: true, x: e.clientX, y: e.clientY, column });
  }

  function applySort(field, direction) {
    setActiveSort(normalizeSortConfig({ field, direction }));
  }

  function resetSortToDefault() {
    applySort(viewConfig.defaultSort?.field, viewConfig.defaultSort?.direction);
  }

  function getTargetRows() {
    const { row } = contextMenu;
    if (!row) return [];
    if (selectedIds.has(row.id) && selectedIds.size > 1) {
      return displayOrders.filter((r) => selectedIds.has(r.id));
    }
    return [row];
  }

  async function handleComposeEmail(row) {
    setMailDockLoadingId(row.id);
    const warnings = [];
    try {
      const labelMap = Object.fromEntries(fieldConfig.map((f) => [f.key, f.label]));
      const template = selectEmailTemplate(emailTemplates, row);
      const { text: subject, warnings: subjectWarnings } = renderEmailTemplate(template.subject_template, row, labelMap);
      const { text: body, warnings: bodyWarnings } = renderEmailTemplate(template.body_template, row, labelMap);
      warnings.push(...subjectWarnings, ...bodyWarnings);

      const attachmentResult = await window.parserApp?.resolveAttachments?.({
        orderFolderPath: row.order_folder_path || "",
        sourceEmlPath: row.source_eml_path || "",
        mode: template.attachment_mode,
        extensions: template.attachment_extensions || [],
      });
      const attachmentPaths = attachmentResult?.files || [];
      warnings.push(...(attachmentResult?.warnings || []));

      const attachmentSourceLabel = attachmentResult?.source === "order_folder_path"
        ? "Source: order folder"
        : attachmentResult?.source === "source_eml_path"
          ? "Source: source_eml_path"
          : "";
      const attachmentFolderPath = attachmentResult?.sourcePath || attachmentPaths[0] || "";

      setMailDock({
        row,
        to: row.buyer_email || "",
        subject,
        body,
        originalSubject: subject,
        originalBody: body,
        currentSubject: subject,
        currentBody: body,
        warnings,
        attachmentPaths,
        attachmentSource: attachmentResult?.source || "none",
        attachmentSourceLabel,
        attachmentSourcePath: attachmentResult?.sourcePath || "",
        attachmentFolderPath,
        environment: emailEnvironment,
      });
    } catch (error) {
      setEmailToast({ warnings: [error.message || "Could not prepare mail dock."] });
    } finally {
      setMailDockLoadingId("");
    }
  }

  async function handleLaunchMailDock(draft = {}) {
    if (!mailDock) return;
    try {
      const result = await window.parserApp?.composeEmail?.({
        to: mailDock.to,
        subject: draft.subject ?? mailDock.currentSubject ?? mailDock.subject,
        body: draft.body ?? mailDock.currentBody ?? mailDock.body,
        attachmentFolderPath: mailDock.attachmentFolderPath || mailDock.attachmentSourcePath || "",
      });
      if (result?.warning) {
        setEmailToast({ warnings: [result.warning] });
      }
    } catch (error) {
      setEmailToast({ warnings: [error.message || "Could not open email app."] });
    }
  }

  async function handleOpenAttachmentFolder() {
    if (!mailDock) return;
    const folderPath = mailDock.attachmentFolderPath || mailDock.attachmentSourcePath || "";
    if (!folderPath) {
      setEmailToast({ warnings: ["No attachment folder available."] });
      return;
    }
    try {
      const result = await window.parserApp?.openFolder?.(folderPath);
      if (!result?.ok) {
        setEmailToast({ warnings: [result?.error || "Could not open attachment folder."] });
      }
    } catch (error) {
      setEmailToast({ warnings: [error.message || "Could not open attachment folder."] });
    }
  }

  async function handleSendDockEmail(draft = {}) {
    if (!mailDock) return { ok: false, error: "Mail Dock is not ready." };
    const result = await window.parserApp?.sendDockEmail?.({
      smtp: {
        emailAddress: shopConfig?.smtpEmailAddress || "",
        host: shopConfig?.smtpHost || "",
        port: shopConfig?.smtpPort || "",
        username: shopConfig?.smtpUsername || "",
        password: shopConfig?.smtpPassword || "",
      },
      to: mailDock.to,
      subject: draft.subject ?? mailDock.currentSubject ?? mailDock.subject,
      body: draft.body ?? mailDock.currentBody ?? mailDock.body,
      attachmentPaths: mailDock.attachmentPaths || [],
      orderFolderPath: mailDock.attachmentFolderPath || mailDock.attachmentSourcePath || "",
    });
    return result || { ok: false, error: "Could not send email." };
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
    setSessionDirty(true);
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
    setSessionDirty(true);
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
    setSessionDirty(true);
  }

  React.useEffect(() => {
    if (!contextMenu.visible && !headerMenu.visible) return;
    function onDown() {
      closeContextMenu();
      closeHeaderMenu();
    }
    function onKey(e) {
      if (e.key === "Escape") {
        closeContextMenu();
        closeHeaderMenu();
      }
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu.visible, headerMenu.visible]);

  function startResize(e, key) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[key] ?? 120;
    let latestWidth = startWidth;
    function onMove(ev) {
      const newWidth = Math.max(40, startWidth + (ev.clientX - startX));
      latestWidth = newWidth;
      setColWidths((prev) => ({ ...prev, [key]: newWidth }));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const nextWidths = { ...colWidthsRef.current, [key]: latestWidth };
      colWidthsRef.current = nextWidths;
      setColWidths(nextWidths);
      try { localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(nextWidths)); } catch (_) {}
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  async function loadOrders({ retries = 5, delayMs = 600 } = {}) {
    setLoading(true);
    setError("");

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res  = await fetch(`${API}/orders/list`);
        const data = await res.json();

        // Compute item count per order so OrderInfoCell can show "N items".
        const countByOrder = {};
        for (const r of data) {
          countByOrder[r.order_id] = (countByOrder[r.order_id] || 0) + 1;
        }
        // Attach _item_count to every row so order_info can access it.
        const enriched = data.map((r) => ({
          ...r,
          _item_count: countByOrder[r.order_id] || 1,
        }));

        setRows(enriched);
        setSelectedIds(new Set());
        setLoading(false);
        return; // success — stop retrying
      } catch (err) {
        if (attempt < retries) {
          // Backend not ready yet — wait and retry silently.
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          // All attempts exhausted — surface the error with a Retry button.
          setError(`Could not reach backend after ${retries} attempts. (${err.message})`);
          setLoading(false);
        }
      }
    }
  }

  React.useEffect(() => { loadOrders(); }, [refreshKey]);

  const filteredOrders = React.useMemo(() => {
    let base = safeOrders.filter((row) => activeTab === "completed" ? isCompletedOrder(row) : !isCompletedOrder(row));

    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return base;
    }

    return base.filter((row) => getRowSearchValues(row).some((value) => value.includes(normalizedQuery)));
  }, [activeTab, getRowSearchValues, safeOrders, searchQuery]);

  const displayOrders = React.useMemo(() => {
    const indexedRows = filteredOrders.map((row, index) => ({ row, index }));
    const sortConfig = normalizeSortConfig(activeSort);

    const compare = (a, b) => {
      const aValue = getRowSortValue(a.row, sortConfig.field, { statusConfig, orderStatuses });
      const bValue = getRowSortValue(b.row, sortConfig.field, { statusConfig, orderStatuses });
      const result = compareSortValues(aValue, bValue, sortConfig.direction);
      return result || (a.index - b.index);
    };

    return [...indexedRows].sort(compare).map(({ row }) => row);
  }, [activeSort, filteredOrders, orderStatuses, statusConfig]);

  const totalCounts = React.useMemo(() => ({
    active: safeOrders.filter((row) => !isCompletedOrder(row)).length,
    completed: safeOrders.filter((row) => isCompletedOrder(row)).length,
  }), [safeOrders]);

  React.useEffect(() => {
    onCountsChange?.(totalCounts);
  }, [onCountsChange, totalCounts]);

  const tabCounts = React.useMemo(() => {
    if (!searchQuery.trim()) return null;
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const matches = (row) => getRowSearchValues(row).some((value) => value.includes(normalizedQuery));
    return {
      active: safeOrders.filter((row) => !isCompletedOrder(row) && matches(row)).length,
      completed: safeOrders.filter((row) => isCompletedOrder(row) && matches(row)).length,
    };
  }, [getRowSearchValues, safeOrders, searchQuery]);

  const safeDisplayOrders = displayOrders || [];

  const handlePrint = React.useCallback(async () => {
    const visiblePrintColumns = visibleColumns.filter(
      (column) => (printConfig?.columns?.[column.key] ?? true) !== false
    );
    const totalPrintWidth = visiblePrintColumns.reduce(
      (sum, column) => sum + (colWidths[column.key] ?? column.defaultWidth ?? 120),
      0
    ) || 1;
    const headerHtml = visiblePrintColumns.length
      ? visiblePrintColumns.map((column) => `<th class="col-${column.key.replace(/_/g, "-")}">${escapeHtml(column.label)}</th>`).join("")
      : "<th>Print Output</th>";
    const columnStyleHtml = visiblePrintColumns.map((column) => {
      const className = `.col-${column.key.replace(/_/g, "-")}`;
      const shouldWrap = !!printConfig?.wrap?.[column.key];
      return shouldWrap
        ? `${className} { white-space: normal; overflow-wrap: anywhere; word-break: break-word; }`
        : `${className} { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`;
    }).join("\n      ");
    const colgroupHtml = visiblePrintColumns.length
      ? `<colgroup>${visiblePrintColumns.map((column) => {
          const width = colWidths[column.key] ?? column.defaultWidth ?? 120;
          const percent = (width / totalPrintWidth) * 100;
          return `<col style="width:${percent.toFixed(4)}%">`;
        }).join("")}</colgroup>`
      : "";

    const rowsHtml = safeDisplayOrders.length
      ? safeDisplayOrders.map((row) => {
          const cells = visiblePrintColumns.map((column) => {
            const presentation = getPrintCellPresentation(row, column.key);
            const styles = [
              presentation.bg ? `background:${presentation.bg}` : "",
              presentation.color ? `color:${presentation.color}` : "",
              presentation.fontStyle ? `font-style:${presentation.fontStyle}` : "",
              "print-color-adjust:exact",
              "-webkit-print-color-adjust:exact",
            ].filter(Boolean).join(";");
            return `<td class="col-${column.key.replace(/_/g, "-")}" style="${styles}">${escapeHtml(presentation.text)}</td>`;
          }).join("");
          return `<tr>${cells}</tr>`;
        }).join("")
      : `<tr><td colspan="${Math.max(1, visiblePrintColumns.length)}" style="text-align:center;color:#666;">${
        visiblePrintColumns.length ? "No orders to print" : "No print fields are enabled"
      }</td></tr>`;

    const summarySearch = searchQuery.trim();
    const shopName = shopConfig.shopName?.trim() || "Parser Viewer";
    const weekdayFromSearch = (() => {
      if (!summarySearch) {
        return "";
      }
      const normalized = summarySearch.trim();
      const match = normalized.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
      if (!match) {
        return "";
      }
      const month = Number.parseInt(match[1], 10);
      const day = Number.parseInt(match[2], 10);
      const yearPart = match[3];
      const year = yearPart
        ? (yearPart.length === 2 ? 2000 + Number.parseInt(yearPart, 10) : Number.parseInt(yearPart, 10))
        : new Date().getFullYear();
      const parsed = new Date(year, month - 1, day);
      if (
        Number.isNaN(parsed.getTime())
        || parsed.getFullYear() !== year
        || parsed.getMonth() !== month - 1
        || parsed.getDate() !== day
      ) {
        return "";
      }
      return parsed.toLocaleDateString(undefined, { weekday: "long" });
    })();
    const headerParts = [
      shopName,
      summarySearch || "",
      weekdayFromSearch,
    ].filter(Boolean);
    const printHtml = `<!doctype html>
<html>
  <head>
    <title>${escapeHtml(shopName)} - Orders Print</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", sans-serif; color: #111827; background: #ffffff; }
      .page {
        padding: 24px;
        background: #fff;
      }
      .meta { margin: 0 0 18px; font-size: 22px; color: #111827; line-height: 1.35; font-weight: 700; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
      th, td { border: 1px solid #d1d5db; padding: 8px 10px; text-align: left; vertical-align: top; }
      th { background: #f3f4f6; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      tbody tr:nth-child(even) td:not([style*="background:"]) { background: #fafafa; }
      .col-order-info { font-size: 11px; line-height: 1.35; }
      ${columnStyleHtml}
      @media print {
        * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        @page { size: ${printConfig?.orientation === "landscape" ? "landscape" : "portrait"}; margin: 0.5in; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="meta">${escapeHtml(headerParts.join(" — "))}</div>
      <table>
        ${colgroupHtml}
        <thead><tr>${headerHtml}</tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  </body>
</html>`;

    const result = await window.parserApp?.exportPrintPdf?.({
      title: "Orders Print",
      html: printHtml,
      orientation: printConfig?.orientation === "landscape" ? "landscape" : "portrait",
    });
    if (result && !result.ok) {
      alert(`Could not open printable PDF: ${result.error || "unknown error"}`);
    }
  }, [colWidths, getPrintCellPresentation, printConfig, safeDisplayOrders, searchQuery, shopConfig.shopName, visibleColumns]);

  React.useEffect(() => {
    if (!isActive) {
      return undefined;
    }

    function onKeyDown(event) {
      const target = event.target;
      const tag = target?.tagName?.toLowerCase?.() || "";
      const isTyping = tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
      if (isTyping || event.repeat) {
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        handlePrint();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlePrint, isActive]);

  const allSelected = safeDisplayOrders.length > 0 && selectedIds.size === safeDisplayOrders.length;
  const someSelected = selectedIds.size > 0 && !allSelected;
  const activeSearchTerm = searchQuery.trim();
  const hasActiveSearch = !!activeSearchTerm;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "'Segoe UI', sans-serif", background: "#f5f5f5" }}>
      <MailDockModal
        dock={mailDock}
        onClose={() => setMailDock(null)}
        onOpenEmail={handleLaunchMailDock}
        onOpenFolder={handleOpenAttachmentFolder}
        onSendEmail={handleSendDockEmail}
        canSendEmail={smtpConfigured}
      />

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

      <AppHeader
        canSave={sessionDirty && safeOrders.length > 0}
        onSave={handleSaveToFolder}
        saveTitle={
          !(sessionDirty && safeOrders.length > 0) ? "Nothing to save yet"
          : shopConfig.saveFolder ? `Save to ${shopConfig.saveFolder}`
          : "Save (set folder in Settings -> General)"
        }
        onSettings={onSettings}
        onWorkspace={onWorkspace}
        documentsConfig={documentsConfig}
        onImport={onImport}
        activeTab={activeTab}
        selectedNav={activeTab}
        onSelectTab={onActiveTabChange}
        activeCount={totalCounts.active}
        completedCount={totalCounts.completed}
        tabCounts={tabCounts}
        rightContent={
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  onClick={() => changeTableFontSize(-1)}
                  title="Decrease sheet font size"
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #ccc",
                    background: "#fff",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "#374151",
                    minWidth: 34,
                  }}
                >
                  A-
                </button>
                <button
                  onClick={() => changeTableFontSize(1)}
                  title="Increase sheet font size"
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #ccc",
                    background: "#fff",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px",
                    fontWeight: 700,
                    color: "#374151",
                    minWidth: 34,
                  }}
                >
                  A+
                </button>
              </div>
              <div style={{ width: 1, height: 26, background: "#d1d5db" }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ position: "relative" }}>
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search orders…"
                  style={{ padding: "6px 34px 6px 10px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px", width: "280px", minWidth: "180px" }}
                />
                {hasActiveSearch && (
                  <button
                    onClick={() => setSearchQuery("")}
                    title="Clear search"
                    style={{
                      position: "absolute",
                      right: 6,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 22,
                      height: 22,
                      border: "none",
                      borderRadius: 999,
                      background: "#e5e7eb",
                      color: "#374151",
                      cursor: "pointer",
                      fontSize: "13px",
                      lineHeight: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
              {hasActiveSearch && (
                <div style={{
                  padding: "5px 10px",
                  borderRadius: 999,
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  border: "1px solid #bfdbfe",
                  fontSize: "12px",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}>
                  Search active
                </div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <select
                value={activeSort.field}
                onChange={(e) => applySort(e.target.value, activeSort.direction)}
                style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px", width: "185px", background: "#fff" }}
              >
                {sortFieldOptions.map((option) => (
                  <option key={option.key} value={option.key}>{option.label}</option>
                ))}
              </select>
              <select
                value={activeSort.direction}
                onChange={(e) => applySort(activeSort.field, e.target.value)}
                style={{ padding: "6px 10px", border: "1px solid #ccc", borderRadius: "4px", fontSize: "13px", width: "135px", background: "#fff" }}
              >
                <option value="asc">Ascending ↑</option>
                <option value="desc">Descending ↓</option>
              </select>
            </div>
            <button
              onClick={handlePrint}
              style={{
                padding: "6px 14px",
                border: "1px solid #ccc",
                background: "#fff",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: 600,
                color: "#374151",
              }}
            >
              Print
            </button>
          </>
        }
      />

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px", overflowX: "auto" }}>
        {hasActiveSearch && (
          <div style={{
            marginBottom: "12px",
            padding: "10px 12px",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "8px",
            color: "#1e3a8a",
            fontSize: "13px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}>
            <span>
              Showing filtered results for <strong>{activeSearchTerm}</strong>.
            </span>
            <button
              onClick={() => setSearchQuery("")}
              style={{
                flexShrink: 0,
                border: "1px solid #93c5fd",
                borderRadius: "6px",
                background: "#fff",
                color: "#1d4ed8",
                padding: "5px 10px",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Clear search
            </button>
          </div>
        )}
        {error ? (
          <div style={{ padding: "16px 18px", background: "#fee2e2", borderRadius: "8px", color: "#991b1b", fontSize: "13px", display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ flex: 1 }}>{error}</span>
            <button
              onClick={() => loadOrders()}
              style={{ flexShrink: 0, border: "1px solid #f87171", borderRadius: "6px", background: "#fff", color: "#991b1b", padding: "5px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              ↺ Retry
            </button>
          </div>
        ) : (!rows || loading) ? (
          <div style={{ color: "#888", padding: "12px", fontSize: "13px" }}>Loading orders…</div>
        ) : safeDisplayOrders.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ color: "#888", fontSize: "14px", marginBottom: "14px" }}>
              {searchQuery.trim()
                ? "No orders match your search."
                : activeTab === "completed"
                  ? "No completed orders yet."
                  : "No active orders yet."}
            </div>
            {!searchQuery.trim() && activeTab === "active" && <button onClick={onImport} style={primaryButton}>+ Import your first order</button>}
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
                      top: -17,
                      padding: "5px 0 5px 8px",
                      border: "1px solid #ccc", userSelect: "none",
                      background: "#e5e5e5",
                      position: "sticky",
                      zIndex: 5,
                      boxSizing: "border-box",
                      boxShadow: "inset 0 -1px 0 #d1d5db",
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
                        activeSort={activeSort}
                        onOpenMenu={handleHeaderContextMenu}
                      />
                    ))}
                  </tr>
                </thead>
              </SortableContext>

              <tbody>
                {(safeDisplayOrders || []).map((r, i) => {
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
                        verticalAlign: "middle",
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
                              verticalAlign: "middle",
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

                        const isBuyerName  = c.key === "buyer_name" && shopConfig.showEmailIcon !== false;
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
                            overflow: "hidden",
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
                                : (documentsConfig.letterheadPath ? "#6d28d9" : "#64748b");
                              return (
                                <button
                                  title={documentsConfig.letterheadPath
                                    ? "Generate gift letter PDF"
                                    : "Generate gift message PDF (no letterhead — plain page)"}
                                  onClick={(e) => { e.stopPropagation(); handleGenerateGiftLetter(r); }}
                                  style={{
                                    position: "absolute", bottom: 2, right: 3,
                                    width: 20, height: 20,
                                    background: "none", border: "none", cursor: "pointer",
                                    padding: 0, lineHeight: 1,
                                    fontSize: 17,
                                    color: iconColor,
                                    opacity: 0.9,
                                    transition: "opacity 0.15s, transform 0.1s",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1.2)"; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.9"; e.currentTarget.style.transform = "scale(1)"; }}
                                >🖨</button>
                              );
                            })()}
                            {isBuyerName && (() => {
                              const onDark = cellBg && contrastColor(cellBg) === "#ffffff";
                              const iconColor = onDark ? "#ffffff" : "#1e40af";
                              return (
                                <button
                                  title="Compose email"
                                  onClick={(e) => { e.stopPropagation(); handleComposeEmail(r); }}
                                  className="email-btn"
                                  disabled={mailDockLoadingId === r.id}
                                  style={{
                                    position: "absolute", bottom: 2, right: 3,
                                    width: 20, height: 20,
                                    background: "none", border: "none", cursor: mailDockLoadingId === r.id ? "wait" : "pointer",
                                    padding: 0, lineHeight: 1,
                                    fontSize: 17,
                                    color: iconColor,
                                    opacity: mailDockLoadingId === r.id ? 0.5 : 0.9,
                                    transition: "opacity 0.15s, transform 0.1s",
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1.2)"; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.9"; e.currentTarget.style.transform = "scale(1)"; }}
                                >{mailDockLoadingId === r.id ? "…" : "✉"}</button>
                              );
                            })()}
                            <div style={{
                              display: "-webkit-box",
                              WebkitBoxOrient: "vertical",
                              WebkitLineClamp: 3,
                              overflow: "hidden",
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                              wordBreak: "break-word",
                              lineHeight: 1.35,
                              maxHeight: `${rowH - 10}px`,
                              paddingRight: needsIcon ? 20 : 0,
                            }}>
                              {displayValue ?? ""}
                            </div>
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
          onSaved={() => { setEditingOrder(null); loadOrders(); setSessionDirty(true); }}
        />
      )}

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
            const menuItems = activeTab === "completed"
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
      {headerMenu.visible && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed", top: headerMenu.y, left: headerMenu.x,
            background: "#fff", border: "1px solid #d1d5db", borderRadius: "6px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)", zIndex: 10000,
            padding: "4px 0", minWidth: "190px", fontSize: "13px",
          }}
        >
          {(() => {
            const column = headerMenu.column;
            if (!column) return [];
            const defaultSort = normalizeSortConfig(viewConfig.defaultSort);
            return [
              {
                label: `Sort ${column.label} Ascending`,
                action: () => {
                  applySort(column.key, "asc");
                  closeHeaderMenu();
                },
              },
              {
                label: `Sort ${column.label} Descending`,
                action: () => {
                  applySort(column.key, "desc");
                  closeHeaderMenu();
                },
              },
              {
                label: `Reset to Default (${defaultSort.field === column.key ? column.label : (fieldMap[defaultSort.field]?.label ?? defaultSort.field)} ${defaultSort.direction === "asc" ? "↑" : "↓"})`,
                action: () => {
                  resetSortToDefault();
                  closeHeaderMenu();
                },
                color: "#2563eb",
              },
            ];
          })().map(({ label, action, color = "#111" }) => (
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
