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
import AttachmentPreviewCard from "../../shared/components/AttachmentPreviewCard.jsx";
import { normalizedSearchMatches } from "../../../../../shared/search/dateSearch.mjs";
import {
  loadFieldConfig,
  loadPriceList,
  matchPriceRule,
  PRICE_TYPE_FIELD_KEY,
  contrastColor,
  loadStatusConfig,
  saveStatusConfig,
  loadOrderStatuses,
  setOrderStatus,
  loadDateConfig,
  saveDateConfig,
  DATE_FIELD_KEYS,
  formatDate,
  loadEmailTemplates,
  selectEmailTemplate,
  renderEmailTemplate,
  loadShopConfig,
  DEFAULT_SAVE_FOLDER,
  loadDocumentsConfig,
  loadPrintConfig,
  loadViewConfig,
  saveViewConfig,
} from "../../shared/utils/fieldConfig.js";

const API = "http://127.0.0.1:8055";
const EMPTY_TRAILING_ROW_COUNT = 6;
const MAX_TWO_UP_CARD_FIELDS = 12;
const WIDTH_PROFILE_TOLERANCE = 0.02;
const SHARED_ORDER_REFRESH_INTERVAL_MS = 20 * 1000;

function buildColumnWidthProfile(columns = [], widths = {}) {
  const visibleColumns = columns
    .map((column) => ({
      key: column.key,
      width: Number(widths[column.key] ?? column.defaultWidth ?? 120),
    }))
    .filter((column) => column.key && Number.isFinite(column.width) && column.width > 0);
  const totalWidth = visibleColumns.reduce((sum, column) => sum + column.width, 0);
  if (!totalWidth) return null;
  return {
    source: "desktop",
    unit: "percent",
    tolerance: WIDTH_PROFILE_TOLERANCE,
    updatedAt: new Date().toISOString(),
    columns: Object.fromEntries(
      visibleColumns.map((column) => [
        column.key,
        {
          percent: Number((column.width / totalWidth).toFixed(4)),
          rawDesktopPx: Math.round(column.width),
        },
      ])
    ),
  };
}

function syncSharedDesktopWidthProfile(columns, widths) {
  const profile = buildColumnWidthProfile(columns, widths);
  if (!profile) return;
  window.parserApp?.updateOrderFieldLayout?.({
    column_width_profiles: { desktop: profile },
    layout_version: 1,
  }).catch(() => {});
}

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

const BACKUP_STEPS = [
  { key: "start", label: "Preparing backup" },
  { key: "scanning", label: "Scanning workspace" },
  { key: "database", label: "Backing up database/settings" },
  { key: "copying", label: "Backing up orders/files" },
  { key: "internal", label: "Backing up internal system data" },
  { key: "manifest", label: "Writing manifest" },
  { key: "compressing", label: "Building archive" },
  { key: "validating", label: "Validating backup" },
  { key: "finalizing", label: "Finalizing" },
];

const BACKUP_STAGE_INDEX = {
  start: 0,
  scanning: 1,
  database: 2,
  copying: 3,
  internal: 4,
  manifest: 5,
  compressing: 6,
  validating: 7,
  finalizing: 8,
  complete: BACKUP_STEPS.length,
  failed: -1,
};

function emptyBackupDialog() {
  return {
    open: false,
    status: "idle",
    stage: "start",
    message: "",
    startedAt: 0,
    endedAt: 0,
    path: "",
    filename: "",
    error: "",
    fileCount: null,
    payloadBytes: null,
    archiveBytes: null,
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function BackupProgressModal({ backup, now, onClose, onRetry, onOpenFolder }) {
  if (!backup.open) return null;
  const isRunning = backup.status === "running";
  const isSuccess = backup.status === "success";
  const isFailure = backup.status === "failure";
  const stepIndex = isSuccess ? BACKUP_STEPS.length : Math.max(0, BACKUP_STAGE_INDEX[backup.stage] ?? 0);
  const percent = isFailure ? 100 : Math.min(100, Math.round((stepIndex / BACKUP_STEPS.length) * 100));
  const elapsed = backup.startedAt ? formatDuration((backup.endedAt || now) - backup.startedAt) : "0s";
  const estimate = isRunning && stepIndex > 0
    ? formatDuration((((now - backup.startedAt) / stepIndex) * (BACKUP_STEPS.length - stepIndex)))
    : "Estimating";
  const archiveSizeLabel = formatBytes(backup.archiveBytes) || (isRunning ? "Calculating..." : "Not available");
  const payloadSizeLabel = formatBytes(backup.payloadBytes) || (isRunning ? "Calculating..." : "Not available");
  const isFinalizing = isRunning && backup.stage === "finalizing";
  const finalizingSubstep = isFinalizing
    ? (backup.message || "Securing archive, recording final size, and cleaning up temporary files.")
    : "";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="backup-progress-title"
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200000,
        background: "rgba(15, 23, 42, 0.62)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{
        width: "min(720px, 96vw)",
        maxHeight: "calc(100vh - 32px)",
        background: "#f8fafc",
        borderRadius: 20,
        boxShadow: "0 28px 90px rgba(15,23,42,0.38)",
        border: "1px solid rgba(148,163,184,0.45)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}>
        <div style={{
          padding: "22px 26px",
          background: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 58%, #075985 100%)",
          color: "#fff",
        }}>
          <div style={{ fontSize: 12, letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.78, fontWeight: 800 }}>
            Full Workspace Backup
          </div>
          <h2 id="backup-progress-title" style={{ margin: "6px 0 0", fontSize: 24, fontWeight: 900 }}>
            Creating Full Workspace Backup
          </h2>
          <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.55, color: "#dbeafe" }}>
            Spaila is preserving orders, inbox files, settings, and internal recovery data. Interrupting this process can leave an incomplete archive, so keep the app open until verification finishes.
          </p>
        </div>

        <div style={{ padding: 26, overflowY: "auto", minHeight: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13, color: "#64748b", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Current Step
              </div>
              <div style={{ marginTop: 4, fontSize: 18, color: "#0f172a", fontWeight: 900 }}>
                {isSuccess ? "Backup complete" : isFailure ? "Backup failed" : BACKUP_STEPS[stepIndex]?.label || "Preparing backup"}
              </div>
            </div>
            <div style={{ textAlign: "right", fontSize: 12, color: "#475569", lineHeight: 1.7 }}>
              <div><strong>Elapsed:</strong> {elapsed}</div>
              {isRunning ? <div><strong>Remaining:</strong> {estimate}</div> : null}
            </div>
          </div>

          <div style={{ height: 12, borderRadius: 999, background: "#e2e8f0", overflow: "hidden", border: "1px solid #cbd5e1" }}>
            <div style={{
              height: "100%",
              width: `${percent}%`,
              background: isFailure
                ? "linear-gradient(90deg, #ef4444, #b91c1c)"
                : "linear-gradient(90deg, #2563eb, #06b6d4)",
              transition: "width 0.25s ease",
            }} />
          </div>

          <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
            <div style={{ padding: 12, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b", fontWeight: 800 }}>Files Processed</div>
              <div style={{ marginTop: 5, fontSize: 18, fontWeight: 900, color: "#0f172a" }}>{backup.fileCount ?? "..."}</div>
            </div>
            <div style={{ padding: 12, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b", fontWeight: 800 }}>Payload Size</div>
              <div style={{ marginTop: 5, fontSize: 18, fontWeight: 900, color: "#0f172a" }}>{payloadSizeLabel}</div>
            </div>
            <div style={{ padding: 12, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12 }}>
              <div style={{ fontSize: 11, color: "#64748b", fontWeight: 800 }}>Archive Size</div>
              <div style={{ marginTop: 5, fontSize: 18, fontWeight: 900, color: "#0f172a" }}>{archiveSizeLabel}</div>
            </div>
          </div>

          {isFinalizing ? (
            <div style={{
              marginTop: 14,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 12,
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              color: "#1e3a8a",
              fontSize: 13,
              fontWeight: 700,
            }}>
              <span style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                border: "3px solid #bfdbfe",
                borderTopColor: "#2563eb",
                display: "inline-block",
                animation: "spailaBackupSpin 0.9s linear infinite",
              }} />
              <span>{finalizingSubstep}</span>
            </div>
          ) : null}

          <div style={{ marginTop: 18, display: "grid", gap: 8 }}>
            {BACKUP_STEPS.map((step, index) => {
              const done = isSuccess || (!isFailure && index < stepIndex);
              const active = isRunning && index === stepIndex;
              return (
                <div key={step.key} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 10px",
                  borderRadius: 10,
                  background: active ? "#eff6ff" : done ? "#f0fdf4" : "#fff",
                  border: `1px solid ${active ? "#93c5fd" : done ? "#bbf7d0" : "#e2e8f0"}`,
                  color: "#0f172a",
                  fontSize: 13,
                }}>
                  <span style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 900,
                    background: done ? "#16a34a" : active ? "#2563eb" : "#e2e8f0",
                    color: done || active ? "#fff" : "#64748b",
                  }}>
                    {done ? "OK" : index + 1}
                  </span>
                  <span style={{ fontWeight: active ? 900 : 700 }}>{step.label}</span>
                </div>
              );
            })}
          </div>

          <div style={{
            marginTop: 18,
            padding: 12,
            borderRadius: 12,
            background: isFailure ? "#fef2f2" : isSuccess ? "#f0fdf4" : "#f8fafc",
            border: `1px solid ${isFailure ? "#fecaca" : isSuccess ? "#bbf7d0" : "#e2e8f0"}`,
            color: isFailure ? "#991b1b" : "#334155",
            fontSize: 13,
            lineHeight: 1.55,
          }}>
            {isFailure ? backup.error : isSuccess ? (
              <div>
                <div style={{ fontWeight: 900, color: "#166534", marginBottom: 6 }}>Backup complete and integrity verified.</div>
                <div><strong>Path:</strong> {backup.path}</div>
                <div><strong>Final archive size:</strong> {archiveSizeLabel}</div>
                <div><strong>Elapsed time:</strong> {elapsed}</div>
              </div>
            ) : backup.message || "Backup is running."}
          </div>
        </div>

        <div style={{
          padding: "14px 26px",
          borderTop: "1px solid #e2e8f0",
          background: "rgba(248,250,252,0.98)",
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          flexShrink: 0,
        }}>
            {isSuccess ? (
              <button onClick={onOpenFolder} style={{ ...primaryButton, background: "#0f766e" }}>Open Backup Folder</button>
            ) : null}
            {isFailure ? (
              <>
                <button onClick={onRetry} style={{ ...primaryButton }}>Retry</button>
                <button onClick={onOpenFolder} style={{ ...primaryButton, background: "#475569" }}>View Diagnostics</button>
              </>
            ) : null}
            <button
              onClick={onClose}
              disabled={isRunning}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "1px solid #cbd5e1",
                background: isRunning ? "#e2e8f0" : "#fff",
                color: isRunning ? "#94a3b8" : "#0f172a",
                cursor: isRunning ? "not-allowed" : "pointer",
                fontWeight: 800,
              }}
            >
              {isRunning ? "Backup in Progress..." : "Close"}
            </button>
        </div>
      </div>
    </div>
  );
}

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

function MailDockModal({ dock, onClose, onOpenEmail, onOpenFolder, onOpenAttachment, onSendEmail, canSendEmail }) {
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
        onClose?.();
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

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "stretch" }}>
            <div style={{ padding: 12, borderRadius: 12, background: "#f8fafc", border: "1px solid #e5e7eb", display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                Attachments ({dock.attachmentPaths?.length || 0})
              </div>
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                {dock.attachmentPaths?.length ? dock.attachmentPaths.map((filePath) => (
                  <AttachmentPreviewCard
                    key={filePath}
                    attachment={{ name: String(filePath).split(/[/\\]/).pop() || "Attachment", path: filePath }}
                    compact
                    maxWidth={300}
                    onOpen={onOpenAttachment}
                  />
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

function isArchivedOrder(row) {
  return String(row?.status || "").toLowerCase() === "archived";
}

function getInventoryQuantity(row) {
  const parsed = Number.parseFloat(String(row?.quantity ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
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
      const statusKey = getWorkflowStatusKey(row, orderStatuses);
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

function getWorkflowStatusKey(row, orderStatuses = {}) {
  return String(row?.item_status || orderStatuses[String(row?.id)] || "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function createManualOrderDraft(activeTab = "active") {
  return {
    __isNew: true,
    order_number: "",
    order_date: "",
    ship_by: "",
    quantity: "",
    price: "",
    order_notes: "",
    gift_message: "",
    is_gift: false,
    gift_wrap: false,
    buyer_name: "",
    buyer_email: "",
    shipping_address: "",
    status: activeTab === "completed" ? "completed" : "active",
    custom_1: "",
    custom_2: "",
    custom_3: "",
    custom_4: "",
    custom_5: "",
    custom_6: "",
    order_folder_path: "",
  };
}

/* ── Draggable column header ────────────────────────────────────────────── */
function SortableHeader({
  col,
  width,
  fontSize,
  onStartResize,
  activeSort,
  onOpenMenu,
}) {
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
export default function OrdersPage({ onWorkspace, onSettings, refreshKey, columnOrder, onColumnOrderChange, activeTab, onActiveTabChange, focusOrderRequest, isActive, onCountsChange, onDirectOrderModalClose }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchExcludedColumns, setSearchExcludedColumns] = React.useState(() => new Set());
  const [searchScope, setSearchScope] = React.useState("current");
  const [viewConfig, setViewConfig] = React.useState(() => loadViewConfig());
  const [activeSort, setActiveSort] = React.useState(() => normalizeSortConfig(loadViewConfig().defaultSort));
  const [editingOrder, setEditingOrder] = React.useState(null);
  const [editOrderLaunchContext, setEditOrderLaunchContext] = React.useState(null);

  // Dirty flag — false on startup, true only after something changes this session
  const [sessionDirty, setSessionDirty] = React.useState(false);
  const mountedRef = React.useRef(false);
  const directOpenActiveRef = React.useRef(false);
  const ordersRefreshInFlightRef = React.useRef(null);
  React.useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    // refreshKey increments when a new order is imported
    setSessionDirty(true);
  }, [refreshKey]);

  React.useEffect(() => {
    if (activeTab === "archived") {
      onActiveTabChange?.("active");
    }
    if (activeTab === "inventory" && viewConfig.showInventoryTab !== true) {
      onActiveTabChange?.("active");
    }
  }, [activeTab, onActiveTabChange, viewConfig.showInventoryTab]);

  const [archiveResults, setArchiveResults] = React.useState([]);
  const [archiveSearching, setArchiveSearching] = React.useState(false);

  React.useEffect(() => {
    const q = searchQuery.trim();
    if (!q || (searchScope !== "archived" && searchScope !== "all")) {
      setArchiveResults([]);
      setArchiveSearching(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setArchiveSearching(true);
      try {
        const res = await fetch(`${API}/orders/archive/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setArchiveResults(Array.isArray(data) ? data : []);
      } catch (_) {}
      if (!cancelled) setArchiveSearching(false);
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [searchQuery, searchScope]);

  async function handleRestoreFromSearch(folderPath) {
    const confirmed = window.confirm("Restore this archived order?");
    if (!confirmed) return;
    try {
      const res = await fetch(`${API}/orders/restore-from-archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: folderPath }),
      });
      if (!res.ok) { alert("Restore failed"); return; }
      setArchiveResults([]);
      setSearchQuery("");
      await loadOrders();
    } catch (err) {
      alert(`Restore failed: ${err.message}`);
    }
  }

  async function handleReindexArchive() {
    try {
      setArchiveSearching(true);
      const res = await fetch(`${API}/orders/archive/reindex`, { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload?.detail || "Archive reindex failed.");
      }
      alert(`Archive index updated. Indexed ${payload.indexed || 0} archived order${payload.indexed === 1 ? "" : "s"}.`);
      if (searchQuery.trim()) {
        const searchRes = await fetch(`${API}/orders/archive/search?q=${encodeURIComponent(searchQuery.trim())}`);
        if (searchRes.ok) {
          const data = await searchRes.json();
          setArchiveResults(Array.isArray(data) ? data : []);
        }
      }
    } catch (err) {
      alert(`Archive reindex failed: ${err.message}`);
    } finally {
      setArchiveSearching(false);
    }
  }

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

  const smtpSenderAddress = String(
    shopConfig?.smtpEmailAddress || shopConfig?.smtpUsername || ""
  ).trim();
  const smtpConfigured = !!(
    smtpSenderAddress
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
  const [backupSaving, setBackupSaving] = React.useState(false);
  const [backupDialog, setBackupDialog] = React.useState(() => emptyBackupDialog());
  const [backupNow, setBackupNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!emailToast || emailToast.kind !== "success") return undefined;
    const timer = window.setTimeout(() => setEmailToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [emailToast]);

  React.useEffect(() => {
    const unsubscribe = window.parserApp?.onBackupProgress?.((progress) => {
      if (!progress?.message) return;
      setBackupDialog((prev) => {
        if (!prev.open) return prev;
        return {
          ...prev,
          status: progress.stage === "failed" ? "failure" : prev.status,
          stage: progress.stage || prev.stage,
          message: progress.message || prev.message,
          error: progress.stage === "failed" ? progress.message || prev.error : prev.error,
          fileCount: progress.fileCount ?? prev.fileCount,
          payloadBytes: progress.payloadBytes ?? prev.payloadBytes,
          archiveBytes: progress.archiveBytes ?? prev.archiveBytes,
        };
      });
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    if (!backupDialog.open || backupDialog.status !== "running") return undefined;
    const timer = window.setInterval(() => setBackupNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [backupDialog.open, backupDialog.status]);

  React.useEffect(() => {
    if (!backupSaving) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "Backup in progress. Closing now may corrupt your backup. Are you sure?";
      return event.returnValue;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [backupSaving]);

  async function handleSaveToFolder() {
    if (backupSaving) return;
    const folder = DEFAULT_SAVE_FOLDER;
    if (!folder) {
      setBackupDialog({
        ...emptyBackupDialog(),
        open: true,
        status: "failure",
        error: "No save folder available.",
        message: "No save folder available.",
        startedAt: Date.now(),
        endedAt: Date.now(),
      });
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

    setBackupSaving(true);
    const startedAt = Date.now();
    setBackupNow(startedAt);
    setBackupDialog({
      ...emptyBackupDialog(),
      open: true,
      status: "running",
      stage: "start",
      message: "Preparing full workspace backup.",
      startedAt,
    });
    try {
      const result = await window.parserApp?.backupSave?.({
        folderPath: folder,
        localStorageData,
      });
      if (result?.ok) {
        setBackupDialog((prev) => ({
          ...prev,
          open: true,
          status: "success",
          stage: "complete",
          message: "Backup complete.",
          endedAt: Date.now(),
          path: result.path || "",
          filename: result.filename || "",
          fileCount: result.metadata?.fileCount ?? prev.fileCount,
          payloadBytes: result.metadata?.payloadBytes ?? prev.payloadBytes,
          archiveBytes: result.metadata?.archiveBytes ?? prev.archiveBytes,
        }));
        setSessionDirty(false); // dim again until next change
      } else {
        setBackupDialog((prev) => ({
          ...prev,
          open: true,
          status: "failure",
          stage: "failed",
          message: "Backup failed.",
          error: result?.error ?? "unknown error",
          endedAt: Date.now(),
        }));
      }
    } catch (error) {
      setBackupDialog((prev) => ({
        ...prev,
        open: true,
        status: "failure",
        stage: "failed",
        message: "Backup failed.",
        error: error?.message || "unknown error",
        endedAt: Date.now(),
      }));
    } finally {
      setBackupSaving(false);
    }
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
    function onOrderStatusesChange() { setOrderStatuses(loadOrderStatuses()); }
    window.addEventListener("spaila:statusconfig", onStatusChange);
    window.addEventListener("spaila:orderstatuses", onOrderStatusesChange);
    return () => {
      window.removeEventListener("spaila:statusconfig", onStatusChange);
      window.removeEventListener("spaila:orderstatuses", onOrderStatusesChange);
    };
  }, []);

  // Date config — display format, showYear, flexibleSearch
  const [dateConfig, setDateConfig] = React.useState(() => loadDateConfig());
  React.useEffect(() => {
    function onDateChange() { setDateConfig(loadDateConfig()); }
    window.addEventListener("spaila:dateconfig", onDateChange);
    return () => window.removeEventListener("spaila:dateconfig", onDateChange);
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    async function syncSharedDateConfig() {
      try {
        const response = await fetch(`${API}/account/date-config`);
        if (!response.ok) return;
        const config = await response.json();
        if (cancelled || !config || typeof config !== "object") return;
        if (!config.updated_at) return;
        saveDateConfig({ ...loadDateConfig(), ...config });
      } catch (_) {}
    }
    syncSharedDateConfig();
    window.addEventListener("focus", syncSharedDateConfig);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", syncSharedDateConfig);
    };
  }, []);
  React.useEffect(() => {
    function onViewConfigChange() { setViewConfig(loadViewConfig()); }
    window.addEventListener("spaila:viewconfig", onViewConfigChange);
    return () => window.removeEventListener("spaila:viewconfig", onViewConfigChange);
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    async function syncSharedViewConfig() {
      try {
        const response = await fetch(`${API}/account/order-field-layout`);
        if (!response.ok) return;
        const layout = await response.json();
        if (cancelled || !layout || typeof layout !== "object") return;
        const patch = {};
        if (layout.search_defaults && typeof layout.search_defaults === "object") {
          patch.searchableFields = layout.search_defaults.searchableFields || {};
          patch.includeOrderInfo = layout.search_defaults.includeOrderInfo !== false;
          patch.searchMode = layout.search_defaults.searchMode === "exact" ? "exact" : "smart";
        }
        if (layout.sort_defaults && typeof layout.sort_defaults === "object") {
          patch.defaultSort = {
            field: layout.sort_defaults.field || "order_date",
            direction: layout.sort_defaults.direction === "asc" ? "asc" : "desc",
          };
        }
        if (Object.keys(patch).length) {
          const current = loadViewConfig();
          saveViewConfig({
            ...current,
            ...patch,
            searchableFields: {
              ...(current.searchableFields || {}),
              ...(patch.searchableFields || {}),
            },
            defaultSort: {
              ...(current.defaultSort || {}),
              ...(patch.defaultSort || {}),
            },
          });
        }
        if (layout.status && typeof layout.status === "object") {
          const currentSc = loadStatusConfig();
          const incomingStates = Array.isArray(layout.status.states) ? layout.status.states : null;
          const nextStatus = {
            ...currentSc,
            enabled: layout.status.enabled !== false,
            columnLabel: layout.status.columnLabel || currentSc.columnLabel || "Status",
            states:
              incomingStates && incomingStates.length
                ? incomingStates.map((s, i) => ({
                    key: String(s?.key || "").trim() || `state-${i + 1}`,
                    label: String(s?.label ?? "").trim() || "State",
                    color: typeof s?.color === "string" && s.color.startsWith("#") ? s.color : "#f3f4f6",
                  }))
                : currentSc.states,
          };
          saveStatusConfig(nextStatus);
        }
      } catch (_) {}
    }
    syncSharedViewConfig();
    window.addEventListener("focus", syncSharedViewConfig);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", syncSharedViewConfig);
    };
  }, []);
  React.useEffect(() => {
    if (viewConfig.showCompleted === false && activeTab === "completed") {
      onActiveTabChange?.("active");
    }
  }, [activeTab, onActiveTabChange, viewConfig.showCompleted]);
  React.useEffect(() => {
    setActiveSort(normalizeSortConfig(viewConfig.defaultSort));
  }, [viewConfig.defaultSort?.field, viewConfig.defaultSort?.direction]);

  async function handleSetStatus(itemId, statusKey) {
    const nextStatus = statusKey || null;
    setRows((current) => current.map((row) => (
      String(row.id) === String(itemId) ? { ...row, item_status: nextStatus || "" } : row
    )));
    setOrderStatus(itemId, nextStatus);
    setOrderStatuses(loadOrderStatuses());
    setSessionDirty(true);
    try {
      await fetch(`${API}/items/${itemId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_status: nextStatus }),
      });
    } catch (_) {
      // Keep the local optimistic value; the next refresh will reconcile from the shared backend.
    }
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
      const currentKey = getWorkflowStatusKey(row, orderStatuses);
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

  const searchActive = searchQuery.trim().length > 0;
  React.useEffect(() => {
    if (!searchActive && searchExcludedColumns.size) {
      setSearchExcludedColumns(new Set());
    }
  }, [searchActive, searchExcludedColumns.size]);

  const toggleSearchColumnExclusion = React.useCallback((columnKey) => {
    setSearchExcludedColumns((current) => {
      const next = new Set(current);
      if (next.has(columnKey)) {
        next.delete(columnKey);
      } else {
        next.add(columnKey);
      }
      return next;
    });
  }, []);

  const getColumnSearchValues = React.useCallback((row, columnKey) => {
    const rawValue = row[columnKey];
    const displayValue = getDisplayedCellValue(row, columnKey);
    const values = [];

    if (rawValue !== undefined && rawValue !== null && rawValue !== "") {
      values.push(rawValue);
    }
    if (displayValue !== undefined && displayValue !== null && displayValue !== "" && displayValue !== rawValue) {
      values.push(displayValue);
    }
    if (DATE_FIELD_KEYS.has(columnKey)) {
      const formatted = formatDate(rawValue, dateConfig);
      if (formatted) {
        values.push(formatted);
      }
    }

    return values
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
  }, [dateConfig, getDisplayedCellValue]);

  const getPrintCellPresentation = React.useCallback((row, columnKey) => {
    const text = getDisplayedCellValue(row, columnKey) || "—";

    if (columnKey === "status") {
      const currentKey = getWorkflowStatusKey(row, orderStatuses);
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
    const hl = fMeta?.highlight;
    const rawValue = row[columnKey];
    const highlightBg = hl?.enabled && hl?.color && rawValue ? hl.color : null;
    const paletteBg = priceRule && fMeta?.paletteEnabled ? priceRule.color : null;
    const bg = highlightBg || paletteBg || null;
    const displayValue = getDisplayedCellValue(row, columnKey);

    return {
      text,
      bg,
      color: bg ? contrastColor(bg) : (displayValue ? "#111827" : "#9ca3af"),
      fontStyle: !rawValue && columnKey === PRICE_TYPE_FIELD_KEY && priceRule?.typeValue ? "italic" : undefined,
    };
  }, [fieldMap, getDisplayedCellValue, orderStatuses, priceList, statusConfig.states]);

  const searchableColumnKeys = React.useMemo(() => {
    const configuredKeys = Object.entries(viewConfig.searchableFields || {})
      .filter(([, enabled]) => !!enabled)
      .map(([key]) => key);

    if (viewConfig.includeOrderInfo) {
      configuredKeys.push("order_info");
    }

    return configuredKeys.filter((key, index, array) => (
      !searchExcludedColumns.has(key) && array.indexOf(key) === index
    ));
  }, [searchExcludedColumns, viewConfig.includeOrderInfo, viewConfig.searchableFields]);

  const getRowSearchValues = React.useCallback((row) => (
    searchableColumnKeys.flatMap((columnKey) => getColumnSearchValues(row, columnKey))
  ), [getColumnSearchValues, searchableColumnKeys]);

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

  async function handleOpenEmailInOrderModal(row) {
    setMailDockLoadingId(row.id);
    const labelMap = Object.fromEntries(fieldConfig.map((f) => [f.key, f.label]));
    const template = selectEmailTemplate(emailTemplates, row);
    const { text: subject } = renderEmailTemplate(template.subject_template, row, labelMap);
    const { text: body } = renderEmailTemplate(template.body_template, row, labelMap);
    try {
      const attachmentResult = await window.parserApp?.resolveAttachments?.({
        orderFolderPath: row.order_folder_path || "",
        sourceEmlPath: row.source_eml_path || "",
        mode: template.attachment_mode,
        extensions: template.attachment_extensions || [],
      });
      const attachmentPaths = attachmentResult?.files || [];
      const attachmentSourceLabel = attachmentResult?.source === "order_folder_path"
        ? "Source: order folder"
        : attachmentResult?.source === "source_eml_path"
          ? "Source: source_eml_path"
          : attachmentResult?.source === "none"
            ? "Source: none"
            : "Source: not ready";
      setEditOrderLaunchContext({
        orderId: String(row?.order_id || row?.id || ""),
        action: "email",
        template: {
          id: template?.id || "default",
          name: template?.name || "Default",
          attachmentMode: template?.attachment_mode || "none",
        },
        draftSubject: subject,
        draftBody: body,
        attachmentPaths,
        attachmentSource: attachmentResult?.source || "none",
        attachmentSourceLabel,
        attachmentSourcePath: attachmentResult?.sourcePath || "",
        attachmentWarnings: attachmentResult?.warnings || [],
      });
      setEditingOrder(row);
    } catch (error) {
      setEmailToast({ warnings: [error.message || "Could not prepare email preview."] });
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

  async function handleOpenMailDockAttachment(attachment) {
    try {
      const result = await window.parserApp?.openAttachment?.({ attachment });
      if (!result?.ok) {
        setEmailToast({ warnings: [result?.error || "Could not open attachment."] });
      }
    } catch (error) {
      setEmailToast({ warnings: [error?.message || "Could not open attachment."] });
    }
  }

  async function handleSendDockEmail(draft = {}) {
    if (!mailDock) return { ok: false, error: "Mail Dock is not ready." };
    const result = await window.parserApp?.sendDockEmail?.({
      smtp: {
        senderName: shopConfig?.sender_name || "",
        emailAddress: smtpSenderAddress,
        host: shopConfig?.smtpHost || "",
        port: shopConfig?.smtpPort || "",
        username: shopConfig?.smtpUsername || "",
        password: shopConfig?.smtpPassword || "",
      },
      imap: {
        host: shopConfig?.imapHost || "",
        port: shopConfig?.imapPort || "993",
        username: shopConfig?.imapUsername || "",
        password: shopConfig?.imapPassword || "",
        useSsl: shopConfig?.imapUseSsl !== false,
      },
      to: mailDock.to,
      subject: draft.subject ?? mailDock.currentSubject ?? mailDock.subject,
      body: draft.body ?? mailDock.currentBody ?? mailDock.body,
      attachmentPaths: mailDock.attachmentPaths || [],
      orderFolderPath: mailDock.attachmentFolderPath || mailDock.attachmentSourcePath || "",
      orderNumber: mailDock.row?.order_number || "",
      buyerName: mailDock.row?.buyer_name || "",
      buyerEmail: mailDock.row?.buyer_email || "",
    });
    if (result?.ok) {
      const append = result.appendToSent || {};
      setEmailToast({
        title: append.ok ? "Email sent" : "Email sent with warning",
        warnings: [
          "Sent",
          append.ok ? "Saved to Sent folder" : "Could not save to Sent folder",
        ],
        kind: append.ok ? "success" : "warning",
      });
    }
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

  async function handleOffloadToFilesystem() {
    const targets = getTargetRows();
    closeContextMenu();
    if (!targets.length) return;
    const orderIds = [...new Set(targets.map((r) => r.order_id).filter(Boolean))];
    const archiveRoot = String(loadShopConfig().orderArchiveRoot || "").trim();
    const failures = [];
    await Promise.all(
      orderIds.map(async (oid) => {
        try {
          const res = await fetch(`${API}/orders/${encodeURIComponent(oid)}/offload-to-filesystem`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archive_root: archiveRoot }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            const detail = body?.detail || `HTTP ${res.status}`;
            console.error("[OFFLOAD_FS] archive failed", { oid, detail });
            failures.push({ oid, detail });
          }
        } catch (err) {
          console.error("[OFFLOAD_FS] request error", { oid, err });
          failures.push({ oid, detail: err.message });
        }
      })
    );
    if (failures.length) {
      alert(
        `Archive failed for ${failures.length} order(s):\n` +
        failures.map((f) => `• ${f.oid}: ${f.detail}`).join("\n")
      );
    }
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
      syncSharedDesktopWidthProfile(visibleColumns, nextWidths);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  async function loadOrders({ retries = 5, delayMs = 600, background = false, preserveSelection = false } = {}) {
    if (ordersRefreshInFlightRef.current) {
      return ordersRefreshInFlightRef.current;
    }

    const refreshPromise = (async () => {
      if (!background) {
        setLoading(true);
        setError("");
      }

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res  = await fetch(`${API}/orders/list`);
          const data = await res.json();

          // Compute item count per order so OrderInfoCell can show "N items".
          const countByOrder = {};
          for (const r of data) {
            countByOrder[r.order_id] = (countByOrder[r.order_id] || 0) + 1;
          }
          const legacyStatuses = loadOrderStatuses();
          const legacyMigrations = [];
          // Attach _item_count to every row so order_info can access it.
          const enriched = data.map((r) => ({
            ...r,
            item_status: r.item_status || legacyStatuses[String(r.id)] || "",
            _item_count: countByOrder[r.order_id] || 1,
          })).map((r) => {
            const legacyStatus = legacyStatuses[String(r.id)];
            if (!data.find((source) => source.id === r.id)?.item_status && legacyStatus) {
              legacyMigrations.push({ id: r.id, status: legacyStatus });
            }
            return r;
          });
          if (legacyMigrations.length) {
            Promise.allSettled(legacyMigrations.map((item) => (
              fetch(`${API}/items/${item.id}/status`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ item_status: item.status }),
              })
            ))).catch(() => {});
          }

          setRows(enriched);
          if (preserveSelection) {
            const refreshedIds = new Set(enriched.map((row) => row.id));
            setSelectedIds((current) => new Set([...current].filter((id) => refreshedIds.has(id))));
          } else {
            setSelectedIds(new Set());
          }
          setLoading(false);
          if (!background) setError("");
          return; // success — stop retrying
        } catch (err) {
          if (attempt < retries) {
            // Backend not ready yet — wait and retry silently.
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          } else if (!background) {
            // All attempts exhausted — surface the error with a Retry button.
            setError(`Could not reach backend after ${retries} attempts. (${err.message})`);
            setLoading(false);
          }
        }
      }
    })();

    ordersRefreshInFlightRef.current = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (ordersRefreshInFlightRef.current === refreshPromise) {
        ordersRefreshInFlightRef.current = null;
      }
    }
  }

  function refreshOrdersFromSharedState() {
    return loadOrders({
      retries: 1,
      delayMs: 300,
      background: true,
      preserveSelection: true,
    });
  }

  const tryAutoArchive = React.useCallback(async () => {
    const raw = loadShopConfig().autoArchiveDays;
    const days = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
    if (days == null) return 0;
    try {
      const res = await fetch(`${API}/orders/auto-archive/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          days,
          archive_root: String(loadShopConfig().orderArchiveRoot || "").trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return 0;
      return Number(data?.archived_count) || 0;
    } catch {
      return 0;
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      await loadOrders();
      if (cancelled) return;
      const n = await tryAutoArchive();
      if (cancelled) return;
      if (n > 0) await loadOrders({ retries: 1, delayMs: 300 });
    })();
    return () => { cancelled = true; };
  }, [refreshKey, tryAutoArchive]);

  React.useEffect(() => {
    if (isActive === false) return undefined;
    let lastRefreshAt = 0;
    function refreshIfReady() {
      const now = Date.now();
      if (now - lastRefreshAt < 1000) return;
      lastRefreshAt = now;
      refreshOrdersFromSharedState();
    }
    function onVisibilityChange() {
      if (!document.hidden) refreshIfReady();
    }
    window.addEventListener("focus", refreshIfReady);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", refreshIfReady);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isActive]);

  React.useEffect(() => {
    if (isActive === false) return undefined;
    const id = window.setInterval(() => {
      refreshOrdersFromSharedState();
    }, SHARED_ORDER_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [isActive]);

  React.useEffect(() => {
    const id = window.setInterval(async () => {
      const n = await tryAutoArchive();
      if (n > 0) await loadOrders({ retries: 1, delayMs: 300 });
    }, 60 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [tryAutoArchive]);

  React.useEffect(() => {
    const orderNumber = String(focusOrderRequest?.orderNumber || "").trim();
    const orderId = String(focusOrderRequest?.orderId || "").trim();
    if (!orderNumber && !orderId) return;

    if (focusOrderRequest?.directOpen) {
      // Find the row in the already-loaded table; fall back to the passed object.
      const row =
        safeOrders.find(
          (o) =>
            (orderId && (o.order_id === orderId || o.id === orderId)) ||
            (orderNumber && o.order_number === orderNumber)
        ) ||
        focusOrderRequest?.orderData ||
        null;
      if (row) {
        directOpenActiveRef.current = true;
        setEditOrderLaunchContext(null);
        setEditingOrder(row);
      }
    } else {
      setSearchQuery(orderNumber);
    }
  }, [focusOrderRequest?.key, focusOrderRequest?.orderNumber, focusOrderRequest?.orderId]);

  const filteredOrders = React.useMemo(() => {
    let base;
    if (searchScope === "active") {
      base = safeOrders.filter((row) => !isArchivedOrder(row) && !isCompletedOrder(row));
    } else if (searchScope === "completed") {
      base = safeOrders.filter((row) => !isArchivedOrder(row) && isCompletedOrder(row));
    } else if (searchScope === "archived") {
      base = [];
    } else if (activeTab === "completed") {
      base = safeOrders.filter((row) => !isArchivedOrder(row) && isCompletedOrder(row));
    } else {
      base = safeOrders.filter((row) => !isArchivedOrder(row) && !isCompletedOrder(row));
    }

    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return base;
    }

    return base.filter((row) => normalizedSearchMatches(normalizedQuery, getRowSearchValues(row), viewConfig.searchMode));
  }, [activeTab, getRowSearchValues, safeOrders, searchQuery, searchScope, viewConfig.searchMode]);

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
    active: safeOrders.filter((row) => !isArchivedOrder(row) && !isCompletedOrder(row)).length,
    completed: safeOrders.filter((row) => !isArchivedOrder(row) && isCompletedOrder(row)).length,
  }), [safeOrders]);

  const inventoryNeeded = React.useMemo(() => {
    const byRuleId = new Map();
    for (const rule of priceList || []) {
      const key = String(rule?.id || rule?.price || rule?.typeValue || "").trim();
      if (!key) continue;
      byRuleId.set(key, {
        key,
        price: String(rule?.price || "").trim(),
        typeValue: String(rule?.typeValue || "").trim() || String(rule?.price || "").trim() || "Untitled type",
        color: rule?.color || "#e5e7eb",
        quantity: 0,
        orderCount: 0,
      });
    }
    for (const row of safeOrders) {
      if (isArchivedOrder(row) || isCompletedOrder(row)) continue;
      const rule = matchPriceRule(row.price, priceList);
      if (!rule) continue;
      const key = String(rule?.id || rule?.price || rule?.typeValue || "").trim();
      if (!key || !byRuleId.has(key)) continue;
      const entry = byRuleId.get(key);
      entry.quantity += getInventoryQuantity(row);
      entry.orderCount += 1;
    }
    return [...byRuleId.values()].filter((entry) => entry.quantity > 0);
  }, [priceList, safeOrders]);

  React.useEffect(() => {
    onCountsChange?.(totalCounts);
  }, [onCountsChange, totalCounts]);

  const tabCounts = React.useMemo(() => {
    if (!searchQuery.trim()) return null;
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const matches = (row) => getRowSearchValues(row).some((value) => value.includes(normalizedQuery));
    return {
      active: safeOrders.filter((row) => !isArchivedOrder(row) && !isCompletedOrder(row) && matches(row)).length,
      completed: safeOrders.filter((row) => !isArchivedOrder(row) && isCompletedOrder(row) && matches(row)).length,
    };
  }, [getRowSearchValues, safeOrders, searchQuery]);

  const safeDisplayOrders = displayOrders || [];
  const rowH = Math.round(tableFontSize * 1.6 * 3); // 3 lines tall
  const activeSearchableVisibleColumns = React.useMemo(() => (
    visibleColumns.filter((column) => searchableColumnKeys.includes(column.key))
  ), [searchableColumnKeys, visibleColumns]);

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
    const printMode = printConfig?.mode === "card" ? "card" : "sheet";
    const cardOrderIndex = new Map(
      (Array.isArray(printConfig?.cardOrder) ? printConfig.cardOrder : []).map((key, index) => [key, index])
    );
    const cardPrintColumns = [...visiblePrintColumns].sort((a, b) => (
      (cardOrderIndex.get(a.key) ?? Number.MAX_SAFE_INTEGER)
      - (cardOrderIndex.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    ));
    const useOneUpCards = cardPrintColumns.length > MAX_TWO_UP_CARD_FIELDS;
    const cardOrientation = printConfig?.orientation === "landscape" ? "landscape" : "portrait";
    const cardColumnsPerPage = useOneUpCards ? 1 : (cardOrientation === "landscape" ? 2 : 1);
    const cardRowsPerPage = useOneUpCards ? 1 : (cardOrientation === "landscape" ? 1 : 2);
    const cardsPerPage = cardColumnsPerPage * cardRowsPerPage;
    const printTitle = printMode === "card" ? "Order Cards" : "Orders Print";
    const cardHtmlRows = safeDisplayOrders.length && cardPrintColumns.length
      ? safeDisplayOrders.map((row) => {
          const orderNumber = getDisplayedCellValue(row, "order_number") || row.order_number || "Order";
          const buyerName = getDisplayedCellValue(row, "buyer_name") || row.buyer_name || "";
          const shipByDate = getDisplayedCellValue(row, "ship_by") || row.ship_by || "";
          const priceRule = matchPriceRule(row.price, priceList);
          const identityBg = priceRule?.color || "#ffffff";
          const identityColor = priceRule?.color ? contrastColor(priceRule.color) : "#0f172a";
          const fields = cardPrintColumns.map((column) => {
            const presentation = getPrintCellPresentation(row, column.key);
            return `<div class="card-field">
              <div class="card-label">${escapeHtml(column.label)}</div>
              <div class="card-value">${escapeHtml(presentation.text)}</div>
            </div>`;
          }).join("");
          return `<article class="order-card">
            <div class="card-topline">
              <div class="card-identity" style="background:${identityBg};color:${identityColor};border-color:${identityBg};">
                <div class="card-title">#${escapeHtml(orderNumber)}</div>
                <div class="card-subtitle">${escapeHtml(buyerName)}</div>
              </div>
              <div class="card-ship-by">
                <div class="card-ship-by-label">Ship by</div>
                <div class="card-ship-by-value">${escapeHtml(shipByDate || "—")}</div>
              </div>
              <div class="card-pill">${escapeHtml(getDisplayedCellValue(row, "status") || "Order")}</div>
            </div>
            <div class="card-fields">${fields}</div>
          </article>`;
        })
      : [];
    const cardRowsHtml = cardHtmlRows.length
      ? Array.from({ length: Math.ceil(cardHtmlRows.length / cardsPerPage) }, (_unused, pageIndex) => (
          `<section class="card-page">${cardHtmlRows.slice(pageIndex * cardsPerPage, pageIndex * cardsPerPage + cardsPerPage).join("")}</section>`
        )).join("")
      : `<div class="empty-card">${safeDisplayOrders.length ? "No print fields are enabled" : "No orders to print"}</div>`;
    const sheetPrintHtml = `<!doctype html>
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
    const cardPrintHtml = `<!doctype html>
<html>
  <head>
    <title>${escapeHtml(shopName)} - Order Cards</title>
    <style>
      :root { color-scheme: light; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", sans-serif; color: #111827; background: #ffffff; }
      .page { padding: 0; background: #fff; }
      .cards { display: block; }
      .card-page {
        display: grid;
        grid-template-columns: repeat(${cardColumnsPerPage}, minmax(0, 1fr));
        grid-template-rows: repeat(${cardRowsPerPage}, minmax(0, 1fr));
        gap: 16px;
        height: ${cardOrientation === "landscape" ? "7.05in" : "9.55in"};
      }
      .card-page:not(:last-child) {
        break-after: page;
        page-break-after: always;
      }
      .order-card {
        width: 100%;
        height: 100%;
        min-height: 0;
        break-inside: avoid;
        page-break-inside: avoid;
        border: 1px solid #cbd5e1;
        border-radius: 14px;
        padding: 16px;
        background: #ffffff;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .card-topline {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        position: relative;
        border-bottom: 1px solid #e5e7eb;
        padding-bottom: 10px;
      }
      .card-identity {
        max-width: 72%;
        border: 2px solid;
        border-radius: 999px;
        padding: 10px 18px 11px;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.42), 0 1px 2px rgba(15,23,42,0.12);
        overflow-wrap: anywhere;
      }
      .card-title { font-size: 20px; font-weight: 800; color: inherit; line-height: 1.1; }
      .card-subtitle { margin-top: 5px; color: inherit; font-size: 13px; font-weight: 700; line-height: 1.2; opacity: 0.92; }
      .card-ship-by {
        position: absolute;
        left: 50%;
        top: 2px;
        transform: translateX(-50%);
        text-align: center;
        color: #0f172a;
        min-width: 112px;
      }
      .card-ship-by-label {
        color: #64748b;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .card-ship-by-value {
        margin-top: 3px;
        color: #111827;
        font-size: 14px;
        font-weight: 800;
        line-height: 1.2;
        white-space: nowrap;
      }
      .card-pill {
        max-width: 42%;
        border: 1px solid #cbd5e1;
        border-radius: 999px;
        color: #334155;
        background: #ffffff;
        padding: 4px 9px;
        font-size: 11px;
        font-weight: 800;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .card-fields {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 9px 12px;
      }
      .card-field {
        min-width: 0;
        border-bottom: 1px solid #f1f5f9;
        padding-bottom: 6px;
      }
      .card-label {
        margin-bottom: 3px;
        color: #64748b;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .card-value {
        min-height: 18px;
        border-radius: 5px;
        color: #111827;
        font-size: 12px;
        line-height: 1.35;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      .empty-card {
        grid-column: 1 / -1;
        padding: 28px;
        border: 1px dashed #cbd5e1;
        border-radius: 14px;
        text-align: center;
        color: #64748b;
      }
      @media print {
        * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
        @page { size: ${printConfig?.orientation === "landscape" ? "landscape" : "portrait"}; margin: 0.5in; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="cards">${cardRowsHtml}</div>
    </div>
  </body>
</html>`;
    const printHtml = printMode === "card" ? cardPrintHtml : sheetPrintHtml;

    const result = await window.parserApp?.exportPrintPdf?.({
      title: printTitle,
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
        onOpenAttachment={handleOpenMailDockAttachment}
        onSendEmail={handleSendDockEmail}
        canSendEmail={smtpConfigured}
      />
      <BackupProgressModal
        backup={backupDialog}
        now={backupNow}
        onRetry={handleSaveToFolder}
        onOpenFolder={() => window.parserApp?.openFolder?.(DEFAULT_SAVE_FOLDER)}
        onClose={() => {
          if (backupDialog.status === "running") return;
          setBackupDialog(emptyBackupDialog());
        }}
      />

      {/* Email warnings toast */}
      {emailToast && (
        <div style={{
          position: "fixed", top: 16, right: 16, zIndex: 99999,
          background: emailToast.kind === "success" ? "#dbeafe" : "#1e293b",
          color: emailToast.kind === "success" ? "#1e3a8a" : "#fff",
          border: emailToast.kind === "success" ? "1px solid #93c5fd" : "none",
          borderRadius: 8,
          padding: "12px 16px", maxWidth: 340, boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
          fontSize: 12, lineHeight: 1.6,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {emailToast.title || "⚠ Email warnings"}
              </div>
              {emailToast.warnings.map((w, i) => (
                <div key={i} style={{ color: emailToast.kind === "success" ? "#1d4ed8" : "#fbbf24" }}>• {w}</div>
              ))}
            </div>
            <button onClick={() => setEmailToast(null)}
              style={{ background: "none", border: "none", color: emailToast.kind === "success" ? "#60a5fa" : "#9ca3af", cursor: "pointer", fontSize: 14, padding: 0, flexShrink: 0 }}>✕</button>
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

      <AppHeader
        canSave={safeOrders.length > 0 && !backupSaving}
        onSave={handleSaveToFolder}
        saveTitle={
          backupSaving ? "Creating backup..."
          : !safeOrders.length ? "No orders to back up"
          : `Save to ${DEFAULT_SAVE_FOLDER}`
        }
        onSettings={onSettings}
        onWorkspace={onWorkspace}
        documentsConfig={documentsConfig}
        activeTab={activeTab}
        selectedNav={activeTab}
        onSelectTab={onActiveTabChange}
        activeCount={totalCounts.active}
        completedCount={totalCounts.completed}
        showCompletedTab={viewConfig.showCompleted !== false}
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
              {hasActiveSearch && (
                <select
                  value={searchScope}
                  onChange={(e) => setSearchScope(e.target.value)}
                  title="Search scope"
                  style={{
                    padding: "6px 10px",
                    border: "1px solid #bfdbfe",
                    borderRadius: 999,
                    background: "#fff",
                    color: "#1e3a8a",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  <option value="current">Current tab</option>
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="archived">Archived</option>
                  <option value="all">All</option>
                </select>
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
              Showing filtered <strong>{searchScope === "current" ? activeTab : searchScope}</strong> results for <strong>{activeSearchTerm}</strong>
              {(searchScope === "archived" || searchScope === "all") ? " across the archive index." : "."}
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
        ) : activeTab === "inventory" ? (
          <div style={{ width: "min(880px, 100%)", margin: "0 auto" }}>
            <div style={{
              marginBottom: 10,
              padding: "8px 12px",
              border: "1px solid #dbeafe",
              background: "#eff6ff",
              color: "#1e3a8a",
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.35,
            }}>
              Inventory Needed summarizes active orders only. Completed orders and archived orders are excluded.
            </div>
            {inventoryNeeded.length ? (
              <div style={{ display: "grid", gap: 5 }}>
                {inventoryNeeded.map((entry) => {
                  const bg = entry.color || "#e5e7eb";
                  const fg = contrastColor(bg);
                  return (
                    <div
                      key={entry.key}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(260px, 1fr) 110px",
                        alignItems: "stretch",
                        gap: 0,
                        padding: 0,
                        border: "1px solid #dbe3ee",
                        borderRadius: 8,
                        background: "#f8fafc",
                        boxShadow: "0 1px 2px rgba(15, 23, 42, 0.035)",
                        overflow: "hidden",
                      }}
                    >
                      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10, padding: "5px 10px", background: bg, color: fg }}>
                        <div style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontWeight: 800 }}>
                          {entry.typeValue}
                        </div>
                        <div style={{ flexShrink: 0, fontSize: 11, color: fg, opacity: 0.78, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          Price {entry.price || "—"} · {entry.orderCount} active order{entry.orderCount === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div style={{ textAlign: "center", padding: "5px 10px", background: "linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)", borderLeft: "1px solid #dbe3ee" }}>
                        <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.045em" }}>Quantity</div>
                        <div style={{ fontSize: 16, lineHeight: 1, color: "#0f172a", fontWeight: 900 }}>{entry.quantity}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{
                padding: "12px 14px",
                border: "1px dashed #cbd5e1",
                borderRadius: 9,
                color: "#64748b",
                background: "#fff",
                fontSize: 12,
              }}>
                No active orders match your pricing types right now.
              </div>
            )}
          </div>
        ) : (
          <>
            {safeDisplayOrders.length === 0 && (
              <div style={{
                marginBottom: "12px",
                padding: "10px 12px",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: "8px",
                color: "#475569",
                fontSize: "13px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
              }}>
                <span>
                  {searchQuery.trim()
                    ? "No orders match your search. Double-click a blank row below to add a manual order."
                    : activeTab === "completed"
                      ? "No completed orders yet. Double-click a blank row below to add a manual order."
                      : "Double-click a blank row below to add a manual order."}
                </span>
                {!searchQuery.trim() && activeTab === "active" && <button onClick={onWorkspace} style={primaryButton}>Go to Workspace</button>}
              </div>
            )}
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
                  {searchActive && activeSearchableVisibleColumns.length > 0 && (
                    <tr>
                      <th style={{
                        width: 30, minWidth: 30, maxWidth: 30,
                        padding: "6px 0 6px 8px",
                        border: "1px solid #e5e7eb",
                        background: "#f8fafc",
                        boxSizing: "border-box",
                      }} />
                      {visibleColumns.map((c) => {
                        const w = colWidths[c.key] ?? c.defaultWidth;
                        const isSearchableColumn = searchableColumnKeys.includes(c.key);
                        return (
                          <th
                            key={`filter-chip-${c.key}`}
                            style={{
                              width: w,
                              minWidth: w,
                              maxWidth: w,
                              padding: "6px 7px",
                              border: "1px solid #e5e7eb",
                              background: "#f8fafc",
                              textAlign: "left",
                              fontWeight: 400,
                              boxSizing: "border-box",
                            }}
                          >
                            {isSearchableColumn ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  toggleSearchColumnExclusion(c.key);
                                }}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  width: 22,
                                  height: 22,
                                  borderRadius: "12px",
                                  background: "#dbeafe",
                                  border: "1px solid #93c5fd",
                                  color: "#1d4ed8",
                                  cursor: "pointer",
                                  padding: 0,
                                  fontSize: "13px",
                                  fontWeight: 800,
                                  lineHeight: 1,
                                }}
                                title={`Remove ${c.label} from search`}
                              >
                                ×
                              </button>
                            ) : null}
                          </th>
                        );
                      })}
                    </tr>
                  )}
                </thead>
              </SortableContext>

              <tbody>
                {(safeDisplayOrders || []).map((r, i) => {
                  const isSelected = selectedIds.has(r.id);
                  // Price-list lookup: find matching rule for this row's price
                  const priceRule = matchPriceRule(r.price, priceList);

                  return (
                    <tr
                      key={r.id}
                      onDoubleClick={() => { setEditOrderLaunchContext(null); setEditingOrder(r); }}
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
                          const currentKey   = getWorkflowStatusKey(r, orderStatuses);
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
                                <option value="" hidden></option>
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

                        // Priority: field highlight > price palette > none
                        const hl = fMeta?.highlight;
                        const highlightBg = hl?.enabled && hl?.color && r[c.key]
                          ? hl.color : null;
                        const paletteBg = !isSelected && priceRule && fMeta?.paletteEnabled
                          ? priceRule.color : null;
                        const cellBg = highlightBg || paletteBg || undefined;

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
                                  onClick={(e) => { e.stopPropagation(); handleOpenEmailInOrderModal(r); }}
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
                {Array.from({ length: EMPTY_TRAILING_ROW_COUNT }).map((_, index) => {
                  const rowIndex = safeDisplayOrders.length + index;
                  return (
                    <tr
                      key={`empty-row-${index}`}
                  onDoubleClick={() => { setEditOrderLaunchContext(null); setEditingOrder(createManualOrderDraft(activeTab)); }}
                      style={{
                        cursor: "cell",
                        background: rowIndex % 2 === 0 ? "#fff" : "#fafafa",
                      }}
                    >
                      <td style={{
                        width: 30, minWidth: 30, maxWidth: 30,
                        height: rowH,
                        padding: 0,
                        border: "1px solid #f1f5f9",
                        boxSizing: "border-box",
                        verticalAlign: "middle",
                      }} />
                      {visibleColumns.map((c, columnIndex) => {
                        const w = colWidths[c.key] ?? c.defaultWidth;
                        const showHint = index === 0 && columnIndex === 0;
                        return (
                          <td key={`${c.key}-empty-${index}`} style={{
                            width: w,
                            minWidth: w,
                            maxWidth: w,
                            height: rowH,
                            padding: "5px 7px",
                            border: "1px solid #f1f5f9",
                            color: "#cbd5e1",
                            boxSizing: "border-box",
                            verticalAlign: "middle",
                            background: "transparent",
                          }}>
                            {showHint ? "Double-click to add manual order" : ""}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </DndContext>
          </>
        )}
      </div>

      {/* Archive search results */}
      {hasActiveSearch && (archiveSearching || archiveResults.length > 0) && (
        <div style={{ marginTop: 16 }}>
          <div style={{
            padding: "8px 14px",
            background: "#1e1b4b",
            color: "#c7d2fe",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            borderRadius: "6px 6px 0 0",
          }}>
            {archiveSearching ? "Searching archive…" : `Archived Orders (${archiveResults.length})`}
            <button
              type="button"
              onClick={handleReindexArchive}
              style={{
                float: "right",
                border: "1px solid #818cf8",
                background: "#312e81",
                color: "#e0e7ff",
                borderRadius: 5,
                padding: "2px 8px",
                cursor: "pointer",
                fontSize: 10,
                fontWeight: 800,
              }}
            >
              Reindex Archive
            </button>
          </div>
          {archiveResults.length > 0 && (
            <div style={{
              border: "1px solid #c7d2fe",
              borderTop: "none",
              borderRadius: "0 0 6px 6px",
              overflow: "hidden",
            }}>
              {archiveResults.map((order) => (
                <div key={order.order_id || order.folder_path} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  borderBottom: "1px solid #e0e7ff",
                  background: "#fafafa",
                  fontSize: 13,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 700, color: "#1e1b4b" }}>
                      {order.buyer_name || "—"}
                    </span>
                    {order.order_number && (
                      <span style={{ marginLeft: 6, color: "#6366f1", fontWeight: 600 }}>
                        #{order.order_number}
                      </span>
                    )}
                    {order.buyer_email && (
                      <span style={{ marginLeft: 8, color: "#64748b", fontSize: 12 }}>
                        {order.buyer_email}
                      </span>
                    )}
                    {order.pet_name && (
                      <span style={{ marginLeft: 8, color: "#1d4ed8", fontSize: 12, fontWeight: 700 }}>
                        Pet: {order.pet_name}
                      </span>
                    )}
                    {Array.isArray(order.match_fields) && order.match_fields.length > 0 && (
                      <div style={{ marginTop: 4, color: "#64748b", fontSize: 11 }}>
                        Matched: {order.match_fields.join(", ")}
                      </div>
                    )}
                    {order.snippet && (
                      <div style={{ marginTop: 4, color: "#475569", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {order.snippet}
                      </div>
                    )}
                  </div>
                  {order.archived_at && (
                    <div style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>
                      Archived {new Date(order.archived_at).toLocaleString()}
                    </div>
                  )}
                  <button
                    onClick={() => handleRestoreFromSearch(order.folder_path)}
                    style={{
                      padding: "5px 12px",
                      background: "#6366f1",
                      color: "#fff",
                      border: "none",
                      borderRadius: 5,
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {editingOrder && (
        <EditOrderModal
          order={editingOrder}
          launchContext={editOrderLaunchContext}
          onClose={() => {
            const wasDirectOpen = directOpenActiveRef.current;
            directOpenActiveRef.current = false;
            setEditOrderLaunchContext(null);
            setEditingOrder(null);
            if (wasDirectOpen) onDirectOrderModalClose?.();
          }}
          onSaved={() => {
            const wasDirectOpen = directOpenActiveRef.current;
            directOpenActiveRef.current = false;
            setEditOrderLaunchContext(null);
            setEditingOrder(null);
            loadOrders();
            setSessionDirty(true);
            if (wasDirectOpen) onDirectOrderModalClose?.();
          }}
          onRefresh={() => {
            const wasDirectOpen = directOpenActiveRef.current;
            directOpenActiveRef.current = false;
            setEditOrderLaunchContext(null);
            setEditingOrder(null);
            loadOrders();
            if (wasDirectOpen) onDirectOrderModalClose?.();
          }}
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
              ...(searchActive ? [{
                label: searchExcludedColumns.has(column.key)
                  ? `Clear ${column.label} Filter`
                  : `Filter ${column.label} by "${activeSearchTerm}"`,
                action: () => {
                  toggleSearchColumnExclusion(column.key);
                  closeHeaderMenu();
                },
                color: searchExcludedColumns.has(column.key) ? "#2563eb" : "#111",
              }] : []),
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
