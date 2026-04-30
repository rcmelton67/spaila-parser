import React from "react";
import ReactDOM from "react-dom";
import { loadFieldConfig, buildLabelMap, loadShopConfig, loadStatusConfig, loadOrderStatuses, setOrderStatus, contrastColor } from "../../shared/utils/fieldConfig.js";

const API = "http://127.0.0.1:8055";
const DEV_MODE = true;

// Keys shown in "Product info" panel — order preserved
const CUSTOM_KEYS = ["custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6"];

// ── Shared primitives ───────────────────────────────────────────────────────
const input = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #d1d5db",
  borderRadius: "4px",
  fontSize: "13px",
  color: "#111",
  background: "#fff",
  boxSizing: "border-box",
};

const textarea = {
  ...input,
  resize: "vertical",
  minHeight: "72px",
  fontFamily: "inherit",
};

const readLabel = {
  fontSize: "11px",
  fontWeight: 600,
  color: "#6b7280",
  marginBottom: "3px",
  display: "block",
};

const readValue = {
  fontSize: "13px",
  color: "#1a1a1a",
};

const checkboxLabel = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "13px",
  color: "#374151",
  cursor: "pointer",
  userSelect: "none",
};

function parseMessageTimeMs(message) {
  const raw = String(message?.timestamp || "").trim();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeMessageBodyForMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractCurrentReplyText(value) {
  const text = String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return "";
  const lines = text.split("\n");
  const quoteHeaderPatterns = [
    /^\s*On\s.+\bwrote:\s*$/i,
    /^\s*Begin forwarded message:\s*$/i,
    /^\s*-{2,}\s*(Original Message|Forwarded message).*$/i,
    /^\s*_{3,}\s*$/,
    /^\s*From:\s*.+$/i,
  ];
  const boundaryIndex = lines.findIndex((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith(">")) return true;
    if (quoteHeaderPatterns.some((pattern) => pattern.test(line))) {
      return index > 0 || /^from:/i.test(trimmed) || /^begin forwarded/i.test(trimmed);
    }
    return false;
  });
  const currentLines = boundaryIndex >= 0 ? lines.slice(0, boundaryIndex) : lines.filter((line) => !line.trim().startsWith(">"));
  return currentLines.join("\n").trim();
}

function normalizeRecipientForMatch(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMessageIdForMatch(value) {
  return String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

function fallbackMessageFingerprint(message) {
  const dir = String(message?.direction || message?.type || "").toLowerCase();
  const ts = String(message?.timestamp || "").trim();
  const body = normalizeMessageBodyForMatch(message?.body || message?.preview_text || "");
  return `${dir}|${ts}|${body}`;
}

function areLikelySameOptimisticOutbound(localSending, serverOutbound) {
  if ((serverOutbound?.direction || serverOutbound?.type) !== "outbound") return false;
  if ((localSending?.direction || localSending?.type) !== "outbound") return false;
  const bodyA = normalizeMessageBodyForMatch(localSending?.body || localSending?.preview_text || "");
  const bodyB = normalizeMessageBodyForMatch(serverOutbound?.body || serverOutbound?.preview_text || "");
  if (!bodyA || !bodyB || bodyA !== bodyB) return false;
  const toA = normalizeRecipientForMatch(localSending?.to || localSending?.buyer_email || "");
  const toB = normalizeRecipientForMatch(serverOutbound?.to || serverOutbound?.buyer_email || "");
  if (toA && toB && toA !== toB) return false;
  const timeA = parseMessageTimeMs(localSending);
  const timeB = parseMessageTimeMs(serverOutbound);
  if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && Math.abs(timeA - timeB) > 30000) return false;
  return true;
}

function mergeRowFromServer(prev, server, reconciledOptimistic) {
  const nextId = String(server?.id || server?.message_id || prev?.id || "").trim() || prev?.id;
  const merged = {
    ...prev,
    ...server,
    id: nextId || prev?.id,
    message_id: server?.message_id ?? prev?.message_id,
    attachments: Array.isArray(server?.attachments) ? server.attachments : prev?.attachments,
    status: server?.status || (reconciledOptimistic ? "sent" : prev?.status),
  };
  if (reconciledOptimistic) {
    delete merged.client_temp_id;
  }
  return merged;
}

function findOptimisticSendingIndex(rows, serverMsg) {
  if ((serverMsg?.direction || serverMsg?.type) !== "outbound") return -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (String(row?.status || "").toLowerCase() !== "sending") continue;
    if ((row?.direction || row?.type) !== "outbound") continue;
    if (areLikelySameOptimisticOutbound(row, serverMsg)) return i;
  }
  return -1;
}

function findDuplicateIndex(rows, serverMsg) {
  const sId = String(serverMsg?.id || "").trim();
  const sMid = normalizeMessageIdForMatch(serverMsg?.message_id || serverMsg?.id || "");
  const sEid = String(serverMsg?.email_id || "").trim().toLowerCase();
  const sFp = fallbackMessageFingerprint(serverMsg);

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const rId = String(r?.id || "").trim();
    if (sId && rId && sId === rId) return i;
  }
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const rMid = normalizeMessageIdForMatch(r?.message_id || r?.id || "");
    if (sMid && rMid && sMid === rMid) return i;
  }
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const rEid = String(r?.email_id || "").trim().toLowerCase();
    if (sEid && rEid && sEid === rEid) return i;
  }
  if (sFp) {
    for (let i = 0; i < rows.length; i += 1) {
      if (fallbackMessageFingerprint(rows[i]) === sFp) return i;
    }
  }
  return -1;
}

function mergeOrderThreadFromServer(existing = [], incoming = [], orderIdForLog = "") {
  let added = 0;
  let updated = 0;
  let reconciled = 0;
  const next = [...existing];
  const incomingSorted = [...incoming].sort((a, b) => String(a?.timestamp || "").localeCompare(String(b?.timestamp || "")));

  for (const serverMsg of incomingSorted) {
    const optIdx = findOptimisticSendingIndex(next, serverMsg);
    if (optIdx >= 0) {
      const prevLocal = next[optIdx];
      next[optIdx] = mergeRowFromServer(next[optIdx], serverMsg, true);
      reconciled += 1;
      console.log("[ORDER_THREAD_RECONCILED_OPTIMISTIC]", {
        order_id: orderIdForLog,
        local_id: prevLocal?.client_temp_id || prevLocal?.id,
        server_id: serverMsg?.id || serverMsg?.message_id,
      });
      continue;
    }
    const dupIdx = findDuplicateIndex(next, serverMsg);
    if (dupIdx >= 0) {
      next[dupIdx] = mergeRowFromServer(next[dupIdx], serverMsg, false);
      updated += 1;
      continue;
    }
    next.push({ ...serverMsg });
    added += 1;
  }

  next.sort((a, b) => String(a?.timestamp || "").localeCompare(String(b?.timestamp || "")));
  return { next, added, updated, reconciled };
}

function readOrderMessages(order) {
  return Array.isArray(order?.messages) ? order.messages : [];
}

async function fetchOrderMessagesFromApi(orderId) {
  const oid = String(orderId || "").trim();
  if (!oid) return [];
  try {
    const response = await fetch(`${API}/orders/${encodeURIComponent(oid)}`);
    if (response.ok) {
      const data = await response.json();
      return readOrderMessages(data);
    }
  } catch (_) {
    /* keep fallthrough */
  }
  try {
    const response = await fetch(`${API}/orders/list`);
    const list = await response.json();
    if (!Array.isArray(list)) return [];
    const row = list.find((item) => String(item?.order_id || item?.id || "").trim() === oid);
    return readOrderMessages(row);
  } catch (_) {
    return [];
  }
}

function getEmailDomain(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.includes("@") ? email.split("@").pop() : "";
}

function fileNameFromPath(filePath) {
  return String(filePath || "").split(/[/\\]/).pop() || "Attachment";
}

function attachmentsFromPaths(paths = []) {
  return (Array.isArray(paths) ? paths : [])
    .map((filePath) => String(filePath || "").trim())
    .filter(Boolean)
    .map((filePath) => ({
      name: fileNameFromPath(filePath),
      path: filePath,
      source: "template",
    }));
}

function isAbsoluteLocalPath(value) {
  const raw = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\");
}

function getAttachmentOpenPath(attachment) {
  if (typeof attachment === "string") return attachment;
  const direct = String(attachment?.path || attachment?.filePath || "").trim();
  if (isAbsoluteLocalPath(direct)) return direct;
  const original = String(attachment?.original_path || attachment?.originalPath || "").trim();
  if (isAbsoluteLocalPath(original)) return original;
  const sentCopy = String(attachment?.sent_copy_path || attachment?.sentCopyPath || "").trim();
  if (isAbsoluteLocalPath(sentCopy)) return sentCopy;
  return direct || original || sentCopy;
}

function getEmailAttachments(message) {
  const values = message?.attachments || message?.attachment_paths || message?.attachmentPaths || [];
  return Array.isArray(values) ? values.filter(Boolean).map((attachment) => {
    if (typeof attachment === "string") {
      return {
        name: fileNameFromPath(attachment),
        path: attachment,
        original_path: attachment,
        type: "",
      };
    }
    return {
      ...attachment,
      name: attachment?.name || attachment?.filename || attachment?.file || fileNameFromPath(getAttachmentOpenPath(attachment)),
      path: getAttachmentOpenPath(attachment),
      type: attachment?.type || attachment?.mime_type || attachment?.mimeType || "",
    };
  }) : [];
}

function isImageAttachment(attachment) {
  const name = String(attachment?.name || "").toLowerCase();
  const type = String(attachment?.type || attachment?.mime_type || "").toLowerCase();
  return type.includes("image") || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}

function attachmentPreviewSrc(attachment) {
  const openPath = getAttachmentOpenPath(attachment);
  if (!openPath || !isAbsoluteLocalPath(openPath) || !isImageAttachment(attachment)) return "";
  return `file:///${openPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function normalizeOutboundAttachmentsForHistory(paths, timestamp = new Date().toISOString()) {
  return (Array.isArray(paths) ? paths : [])
    .map((filePath) => String(filePath || "").trim())
    .filter(Boolean)
    .map((filePath) => ({
      file: fileNameFromPath(filePath),
      filename: fileNameFromPath(filePath),
      name: fileNameFromPath(filePath),
      path: filePath,
      original_path: filePath,
      source: "outbound_send",
      direction: "outbound",
      timestamp,
    }));
}

// ── Panel wrapper ───────────────────────────────────────────────────────────
function Panel({ title, children }) {
  const [visible, setVisible] = React.useState(true);
  return (
    <div style={{
      background: "#f5f5f5",
      borderRadius: "6px",
      padding: "14px 16px",
      display: "flex",
      flexDirection: "column",
      gap: "0",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <span style={{ fontWeight: 700, fontSize: "14px", color: "#111" }}>{title}</span>
        <button
          onClick={() => setVisible((v) => !v)}
          title={visible ? "Hide" : "Show"}
          style={{
            border: "1px solid #ccc",
            borderRadius: "999px",
            background: "#fff",
            width: "28px",
            height: "28px",
            cursor: "pointer",
            fontSize: "12px",
            color: "#666",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {visible ? "👁" : "○"}
        </button>
      </div>
      {visible && children}
    </div>
  );
}

// ── Labelled field row (label left, input right) ─────────────────────────────
function FieldRow({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", marginBottom: "10px", gap: "8px" }}>
      <span style={{ width: "84px", paddingTop: "7px", fontSize: "13px", color: "#555", flexShrink: 0, textAlign: "right" }}>
        {label}
      </span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────
export default function EditOrderModal({ order, launchContext = null, onClose, onSaved, onRefresh }) {
  const isNewOrder = !!order.__isNew;
  const orderIdentityKey = React.useMemo(
    () => String(order?.order_id || order?.id || "").trim(),
    [order?.order_id, order?.id],
  );
  const modalOrderId = orderIdentityKey;

  const [form, setForm] = React.useState({ ...order });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [draftReply, setDraftReply] = React.useState("");
  const [previewCompose, setPreviewCompose] = React.useState(null);
  const [previewSendState, setPreviewSendState] = React.useState({ sending: false, error: "", success: "" });
  const [templateLoadedNotice, setTemplateLoadedNotice] = React.useState(false);
  const [replyAttachments, setReplyAttachments] = React.useState([]);
  const [isSendingReply, setIsSendingReply] = React.useState(false);
  const [shopConfig, setShopConfig] = React.useState(() => loadShopConfig());
  const [statusConfig, setStatusConfig] = React.useState(() => loadStatusConfig());
  const [orderStatuses, setOrderStatuses] = React.useState(() => loadOrderStatuses());
  const [conversationMessages, setConversationMessages] = React.useState(() => readOrderMessages(order));
  const threadScrollRef = React.useRef(null);
  const shouldAutoScrollRef = React.useRef(false);
  const replyFileInputRef = React.useRef(null);
  const draftTextareaRef = React.useRef(null);

  React.useEffect(() => {
    function onStatusConfigChange() {
      setStatusConfig(loadStatusConfig());
      setOrderStatuses(loadOrderStatuses());
    }
    window.addEventListener("spaila:statusconfig", onStatusConfigChange);
    return () => window.removeEventListener("spaila:statusconfig", onStatusConfigChange);
  }, []);

  React.useEffect(() => {
    if (!order) return;
    setForm({ ...order });
    setSaving(false);
    setError("");
    if (launchContext?.action === "email") {
      const nextBody = String(launchContext?.draftBody || "").trim();
      const nextSubject = String(launchContext?.draftSubject || "").trim();
      const nextAttachments = attachmentsFromPaths(launchContext?.attachmentPaths || []);
      setDraftReply("");
      setPreviewCompose({
        to: String(order?.buyer_email || "").trim(),
        subject: nextSubject,
        body: nextBody,
        originalSubject: nextSubject,
        originalBody: nextBody,
        attachments: nextAttachments,
        attachmentSourceLabel: launchContext?.attachmentSourceLabel || "",
        attachmentSourcePath: launchContext?.attachmentSourcePath || "",
        attachmentWarnings: launchContext?.attachmentWarnings || [],
        templateName: launchContext?.template?.name || "Template",
      });
      setPreviewSendState({ sending: false, error: "", success: "" });
      setTemplateLoadedNotice(!!nextBody || !!nextSubject);
    } else {
      setDraftReply("");
      setPreviewCompose(null);
      setPreviewSendState({ sending: false, error: "", success: "" });
      setTemplateLoadedNotice(false);
    }
    setReplyAttachments([]);
    setIsSendingReply(false);
    setConversationMessages(readOrderMessages(order));
    // Intentionally omit `order` from deps: parent list refresh must not reset draft, attachments, or thread (sync handles messages).
  }, [orderIdentityKey, launchContext]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (!templateLoadedNotice) return undefined;
    const timer = window.setTimeout(() => setTemplateLoadedNotice(false), 1200);
    return () => window.clearTimeout(timer);
  }, [templateLoadedNotice]);

  // ── Reactive field labels from Settings ──────────────────────────────────
  const [labels, setLabels] = React.useState(() => buildLabelMap(loadFieldConfig()));
  React.useEffect(() => {
    function onCfg() { setLabels(buildLabelMap(loadFieldConfig())); }
    window.addEventListener("spaila:fieldconfig", onCfg);
    return () => window.removeEventListener("spaila:fieldconfig", onCfg);
  }, []);
  React.useEffect(() => {
    function onShopConfigUpdate() {
      setShopConfig(loadShopConfig());
    }
    window.addEventListener("spaila:shopconfig", onShopConfigUpdate);
    return () => window.removeEventListener("spaila:shopconfig", onShopConfigUpdate);
  }, []);
  const L = (key, fallback) => labels[key] || fallback;

  const set = (key, val) => setForm((p) => ({ ...p, [key]: val }));

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const endpoint = isNewOrder ? "/orders/create-manual" : "/orders/update-full";
      const shop = loadShopConfig();
      const payload = isNewOrder
        ? form
        : { ...form, archive_root: String(shop.orderArchiveRoot || "").trim() };
      const res = await fetch(`${API}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let detail = `Server error ${res.status}`;
        try {
          const payload = await res.json();
          detail = payload?.detail || payload?.error || detail;
        } catch (_) {}
        throw new Error(detail);
      }
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  function handleReset() {
    setForm({ ...order });
  }

  async function handleArchiveNow() {
    if (!order?.order_id) return;
    const confirmed = window.confirm("Archive this order now? This will move the folder to archive and remove it from the database.");
    if (!confirmed) return;
    try {
      const res = await fetch(`${API}/orders/${encodeURIComponent(order.order_id)}/archive-now`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.detail || "Archive failed");
      }
      console.log("[UI_FORCE_ARCHIVE_SUCCESS]", order.order_id);
      onClose?.();
      onRefresh?.();
    } catch (err) {
      console.error("[UI_FORCE_ARCHIVE_FAIL]", err);
      alert(`Archive failed: ${err.message}`);
    }
  }

  const handleRestore = async (folderPath) => {
    const confirmed = window.confirm("Restore this archived order?");
    if (!confirmed) return;

    const res = await fetch(`${API}/orders/restore-from-archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_path: folderPath }),
    });

    if (!res.ok) {
      alert("Restore failed");
      return;
    }

    onClose?.();
    onRefresh?.();
  };

  async function handleOpenEtsyMessages() {
    const orderNumber = String(form?.order_number || "").trim();
    const url = orderNumber
      ? `https://www.etsy.com/messages?search_query=${encodeURIComponent(orderNumber)}`
      : "https://www.etsy.com/messages";
    try {
      await window.electronAPI?.openExternal?.(url);
    } catch (_error) {
      setError("Could not open Etsy Messages in your browser.");
    }
  }

  async function handleAttachReplyFiles(files) {
    const nextAttachments = await Promise.all((files || []).map(async (file) => {
      let filePath = "";
      try {
        filePath = window.parserApp?.getFilePath?.(file) || "";
      } catch (_error) {
        filePath = "";
      }
      return {
        name: file.name || "Attachment",
        size: file.size || 0,
        lastModified: file.lastModified || 0,
        path: filePath,
      };
    }));
    setReplyAttachments((current) => {
      const existing = new Set(current.map((item) => String(item.path || "").trim()));
      const deduped = nextAttachments.filter((item) => {
        const key = String(item.path || "").trim();
        if (!key || existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      return [...current, ...deduped];
    });
  }

  function handleRemoveReplyAttachment(indexToRemove) {
    setReplyAttachments((current) => current.filter((_file, index) => index !== indexToRemove));
  }

  async function handleAttachPreviewFiles(files) {
    const nextAttachments = await Promise.all((files || []).map(async (file) => {
      let filePath = "";
      try {
        filePath = window.parserApp?.getFilePath?.(file) || "";
      } catch (_error) {
        filePath = "";
      }
      return {
        name: file.name || "Attachment",
        size: file.size || 0,
        lastModified: file.lastModified || 0,
        path: filePath,
        source: "manual",
      };
    }));
    setPreviewCompose((current) => {
      if (!current) return current;
      const existing = new Set((current.attachments || []).map((item) => String(item.path || "").trim()));
      const deduped = nextAttachments.filter((item) => {
        const key = String(item.path || "").trim();
        if (!key || existing.has(key)) return false;
        existing.add(key);
        return true;
      });
      return { ...current, attachments: [...(current.attachments || []), ...deduped] };
    });
  }

  function handleRemovePreviewAttachment(indexToRemove) {
    setPreviewCompose((current) => {
      if (!current) return current;
      return {
        ...current,
        attachments: (current.attachments || []).filter((_file, index) => index !== indexToRemove),
      };
    });
  }

  async function handleOpenConversationAttachment(attachment) {
    try {
      console.log("[ATTACHMENT_RENDER]", {
        action: "open",
        name: attachment?.name || attachment?.filename || attachment?.file || "Attachment",
        path: getAttachmentOpenPath(attachment),
      });
      const result = await window.parserApp?.openAttachment?.({ attachment });
      if (!result?.ok) {
        setError(result?.error || "Could not open attachment.");
      }
    } catch (nextError) {
      setError(nextError?.message || "Could not open attachment.");
    }
  }

  async function handleSendReply() {
    if (isSendingReply) return;
    const to = String(form.buyer_email || "").trim();
    const body = draftReply;
    const attachmentPaths = replyAttachments.map((attachment) => String(attachment.path || "").trim()).filter(Boolean);
    if (!to) {
      setError("Buyer email is required to send a reply.");
      return;
    }
    if (!body.trim() && !attachmentPaths.length) {
      return;
    }
    if (replyAttachments.length && attachmentPaths.length !== replyAttachments.length) {
      setError("One or more attachments could not be read.");
      return;
    }
    const from = String(shopConfig?.smtpEmailAddress || "").trim();
    const smtpUsername = String(shopConfig?.smtpUsername || "").trim();
    if (!from) {
      setError("SMTP sender email is missing in Settings.");
      return;
    }
    const fromDomain = getEmailDomain(from);
    const usernameDomain = getEmailDomain(smtpUsername);
    if (fromDomain && usernameDomain && fromDomain !== usernameDomain) {
      setError("SMTP username must match the sender email domain.");
      return;
    }
    const subject = String(form.order_number || "").trim()
      ? `Re: Order ${form.order_number}`
      : "Re: Order conversation";
    const optimisticId = `temp_${Date.now()}`;
    const optimisticTimestamp = new Date().toISOString();
    const attachmentMetadata = normalizeOutboundAttachmentsForHistory(attachmentPaths, optimisticTimestamp);
    setConversationMessages((current) => [
      ...current,
      {
        id: optimisticId,
        client_temp_id: optimisticId,
        type: "outbound",
        direction: "outbound",
        status: "sending",
        to,
        buyer_email: to,
        subject,
        body,
        timestamp: optimisticTimestamp,
        attachments: attachmentMetadata,
      },
    ]);
    shouldAutoScrollRef.current = true;
    setIsSendingReply(true);
    setError("");
    try {
      const sendResult = await window.parserApp?.sendDockEmail?.({
        from,
        smtp: {
          senderName: shopConfig?.sender_name || "",
          emailAddress: from,
          host: shopConfig?.smtpHost || "",
          port: shopConfig?.smtpPort || "",
          username: smtpUsername,
          password: shopConfig?.smtpPassword || "",
        },
        imap: {
          host: shopConfig?.imapHost || "",
          port: shopConfig?.imapPort || "993",
          username: shopConfig?.imapUsername || "",
          password: shopConfig?.imapPassword || "",
          useSsl: shopConfig?.imapUseSsl !== false,
        },
        to,
        subject,
        body,
        attachmentPaths,
        orderFolderPath: form.order_folder_path || "",
        orderNumber: form.order_number || "",
        buyerName: form.buyer_name || "",
        buyerEmail: to,
      });
      if (!sendResult?.ok) {
        throw new Error(sendResult?.error || "Could not send reply.");
      }
      const sentMessage = {
        id: String(sendResult?.message_id || sendResult?.messageId || `outbound:${Date.now()}`),
        message_id: String(sendResult?.message_id || sendResult?.messageId || ""),
        type: "outbound",
        direction: "outbound",
        to,
        buyer_email: to,
        subject,
        body,
        timestamp: sendResult?.timestamp || new Date().toISOString(),
        attachments: normalizeOutboundAttachmentsForHistory(attachmentPaths, sendResult?.timestamp || new Date().toISOString()),
        status: "sent",
      };
      setConversationMessages((current) => {
        const { next } = mergeOrderThreadFromServer(current, [sentMessage], modalOrderId);
        return next;
      });
      shouldAutoScrollRef.current = true;
      setDraftReply("");
      setReplyAttachments([]);
      if (modalOrderId) {
        fetch(`${API}/orders/${encodeURIComponent(modalOrderId)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: sentMessage }),
        }).catch(() => {});
      }
    } catch (nextError) {
      setConversationMessages((current) => current.filter((m) => String(m?.client_temp_id || "") !== optimisticId));
      setError(nextError?.message || "Could not send reply.");
    } finally {
      setIsSendingReply(false);
    }
  }

  async function handleSendPreviewCompose() {
    if (previewSendState.sending || !previewCompose) return;
    const to = String(previewCompose.to || "").trim();
    const subject = String(previewCompose.subject || "").trim();
    const body = String(previewCompose.body || "");
    const attachmentPaths = (previewCompose.attachments || [])
      .map((attachment) => String(attachment.path || "").trim())
      .filter(Boolean);
    if (!to) {
      setPreviewSendState({ sending: false, error: "Recipient is required.", success: "" });
      return;
    }
    if (!subject) {
      setPreviewSendState({ sending: false, error: "Subject is required.", success: "" });
      return;
    }
    if (!body.trim() && !attachmentPaths.length) {
      setPreviewSendState({ sending: false, error: "Body or attachment is required.", success: "" });
      return;
    }
    if ((previewCompose.attachments || []).length && attachmentPaths.length !== (previewCompose.attachments || []).length) {
      setPreviewSendState({ sending: false, error: "One or more attachments could not be read.", success: "" });
      return;
    }
    const from = String(shopConfig?.smtpEmailAddress || "").trim();
    const smtpUsername = String(shopConfig?.smtpUsername || "").trim();
    if (!from) {
      setPreviewSendState({ sending: false, error: "SMTP sender email is missing in Settings.", success: "" });
      return;
    }
    const fromDomain = getEmailDomain(from);
    const usernameDomain = getEmailDomain(smtpUsername);
    if (fromDomain && usernameDomain && fromDomain !== usernameDomain) {
      setPreviewSendState({ sending: false, error: "SMTP username must match the sender email domain.", success: "" });
      return;
    }

    setPreviewSendState({ sending: true, error: "", success: "" });
    setError("");
    try {
      const sendResult = await window.parserApp?.sendDockEmail?.({
        from,
        smtp: {
          senderName: shopConfig?.sender_name || "",
          emailAddress: from,
          host: shopConfig?.smtpHost || "",
          port: shopConfig?.smtpPort || "",
          username: smtpUsername,
          password: shopConfig?.smtpPassword || "",
        },
        imap: {
          host: shopConfig?.imapHost || "",
          port: shopConfig?.imapPort || "993",
          username: shopConfig?.imapUsername || "",
          password: shopConfig?.imapPassword || "",
          useSsl: shopConfig?.imapUseSsl !== false,
        },
        to,
        subject,
        body,
        attachmentPaths,
        orderFolderPath: form.order_folder_path || "",
        orderNumber: form.order_number || "",
        buyerName: form.buyer_name || "",
        buyerEmail: to,
      });
      if (!sendResult?.ok) {
        throw new Error(sendResult?.error || "Could not send preview email.");
      }
      const sentMessage = {
        id: String(sendResult?.message_id || sendResult?.messageId || `outbound:${Date.now()}`),
        message_id: String(sendResult?.message_id || sendResult?.messageId || ""),
        type: "outbound",
        direction: "outbound",
        to,
        buyer_email: to,
        subject,
        body,
        timestamp: sendResult?.timestamp || new Date().toISOString(),
        attachments: normalizeOutboundAttachmentsForHistory(attachmentPaths, sendResult?.timestamp || new Date().toISOString()),
        status: "sent",
      };
      setConversationMessages((current) => {
        const { next } = mergeOrderThreadFromServer(current, [sentMessage], modalOrderId);
        return next;
      });
      shouldAutoScrollRef.current = true;
      if (modalOrderId) {
        fetch(`${API}/orders/${encodeURIComponent(modalOrderId)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: sentMessage }),
        }).catch(() => {});
      }
      setPreviewSendState({ sending: false, error: "", success: "Preview email sent." });
      setPreviewCompose(null);
    } catch (nextError) {
      setPreviewSendState({ sending: false, error: nextError?.message || "Could not send preview email.", success: "" });
    }
  }

  const conversationSubject = String(form.order_number || "").trim()
    ? `Order ${form.order_number}`
    : "Order conversation";
  const customerLabel = String(form.buyer_name || form.buyer_email || "Customer").trim();

  React.useEffect(() => {
    if (!modalOrderId || isNewOrder) return undefined;
    let cancelled = false;

    async function syncThread() {
      if (cancelled) return;
      const incoming = await fetchOrderMessagesFromApi(modalOrderId);
      if (cancelled || !Array.isArray(incoming)) return;
      setConversationMessages((current) => {
        const existingCount = current.length;
        const incomingCount = incoming.length;
        const merged = mergeOrderThreadFromServer(current, incoming, modalOrderId);
        console.log("[ORDER_THREAD_SYNC]", {
          order_id: modalOrderId,
          existing_count: existingCount,
          incoming_count: incomingCount,
          added_count: merged.added,
          updated_count: merged.updated,
          reconciled_count: merged.reconciled,
        });
        const hadNew = merged.added > 0 || merged.reconciled > 0;
        if (hadNew || merged.updated > 0) {
          shouldAutoScrollRef.current = true;
        }
        return merged.next;
      });
    }

    syncThread();
    const interval = window.setInterval(syncThread, 5000);
    function onOrderThreadUpdated(event) {
      const detailId = String(event?.detail?.order_id || event?.detail?.orderId || "").trim();
      if (detailId && detailId !== modalOrderId) return;
      syncThread();
    }
    window.addEventListener("order-thread-updated", onOrderThreadUpdated);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("order-thread-updated", onOrderThreadUpdated);
    };
  }, [modalOrderId, isNewOrder]);

  React.useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    shouldAutoScrollRef.current = false;
    const node = threadScrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [conversationMessages]);

  React.useEffect(() => {
    window.requestAnimationFrame(() => {
      const node = threadScrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, [modalOrderId]);

  return ReactDOM.createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(0,0,0,0.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "stretch",
        padding: 0,
        overflow: "auto",
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div style={{
        width: "100vw",
        height: "100vh",
        background: "#fff",
        borderRadius: 0,
        boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
        display: "flex",
        flexDirection: "row",
        overflow: "hidden",
      }}>
        <aside style={{
          width: 360,
          minWidth: 300,
          borderRight: "1px solid #e5e7eb",
          overflow: "hidden",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          background: "#f9fafb",
        }}>
          {/* scrollable fields */}
          <div style={{ flex: 1, overflowY: "auto", padding: 14, boxSizing: "border-box" }}>
            <div style={{ marginBottom: 9 }}>
              <input style={input} placeholder={L("buyer_name", "Name")} value={form.buyer_name || ""} onChange={(e) => set("buyer_name", e.target.value)} />
            </div>
            <div style={{ marginBottom: 9 }}>
              <input style={input} placeholder={L("shipping_name", "Shipping Name")} value={form.shipping_name || ""} onChange={(e) => set("shipping_name", e.target.value)} />
            </div>
            <div style={{ marginBottom: 9 }}>
              <input style={input} placeholder={L("buyer_email", "Buyer Email")} value={form.buyer_email || ""} onChange={(e) => set("buyer_email", e.target.value)} />
            </div>
            <div style={{ marginBottom: 9 }}>
              <textarea style={{ ...textarea, minHeight: 64 }} placeholder={L("shipping_address", "Address")} value={form.shipping_address || ""} onChange={(e) => set("shipping_address", e.target.value)} />
            </div>
            <div style={{ marginBottom: 9 }}>
              <input style={input} placeholder={L("phone_number", "Phone Number")} value={form.phone_number || ""} onChange={(e) => set("phone_number", e.target.value)} />
            </div>
            <div style={{ marginBottom: 9 }}>
              <input autoFocus={isNewOrder} style={input} placeholder={L("order_number", "Order Number")} value={form.order_number || ""} onChange={(e) => set("order_number", e.target.value)} />
            </div>
            <div style={{ marginBottom: 9 }}>
              <input style={input} placeholder={L("order_date", "Order Date")} value={form.order_date || ""} onChange={(e) => set("order_date", e.target.value)} />
            </div>
            <div style={{ marginBottom: 9 }}>
              <input style={input} placeholder={L("ship_by", "Ship By")} value={form.ship_by || ""} onChange={(e) => set("ship_by", e.target.value)} />
            </div>
            <div style={{ marginBottom: 9, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <input style={input} placeholder={L("price", "Price")} value={form.price || ""} onChange={(e) => set("price", e.target.value)} />
              <input style={input} placeholder={L("quantity", "Quantity")} value={form.quantity || ""} onChange={(e) => set("quantity", e.target.value)} />
            </div>

            {CUSTOM_KEYS.map((key) => (
              <div key={key} style={{ marginBottom: 9 }}>
                <input style={input} placeholder={L(key, key)} value={form[key] || ""} onChange={(e) => set(key, e.target.value)} />
              </div>
            ))}

            <div style={{ marginBottom: 9 }}>
              <textarea style={{ ...textarea, minHeight: 68 }} placeholder={L("order_notes", "Order Notes")} value={form.order_notes || form.notes || ""} onChange={(e) => set("order_notes", e.target.value)} />
            </div>
            <div style={{ marginBottom: 0 }}>
              <textarea style={{ ...textarea, minHeight: 68 }} placeholder={L("gift_message", "Gift Message")} value={form.gift_message || form.message || ""} onChange={(e) => set("gift_message", e.target.value)} />
            </div>
          </div>

          {/* fixed footer */}
          <div style={{ flexShrink: 0, borderTop: "1px solid #e5e7eb", padding: "10px 14px", background: "#f9fafb", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 16 }}>
              <label style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={!!form.is_gift}
                  onChange={(e) => set("is_gift", e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: "#2563eb" }}
                />
                <span>Mark as gift</span>
              </label>
              <label style={checkboxLabel}>
                <input
                  type="checkbox"
                  checked={!!form.gift_wrap}
                  onChange={(e) => set("gift_wrap", e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: "#2563eb" }}
                />
                <span>Gift wrap</span>
              </label>
            </div>

            {error ? <div style={{ fontSize: 12, color: "#991b1b" }}>{error}</div> : null}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleReset}
                style={{ padding: "7px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 }}
              >
                Reset
              </button>
              {!isNewOrder ? (
                <button
                  onClick={() => {
                    const folder = order.order_folder_path;
                    if (!folder) {
                      alert("No order folder assigned yet. The helper creates this folder once the order is matched.");
                      return;
                    }
                    window.parserApp?.openFolder(folder);
                  }}
                  style={{ padding: "7px 12px", border: "1px solid #d1d5db", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 }}
                >
                  Show Folder
                </button>
              ) : null}
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  marginLeft: "auto",
                  padding: "7px 14px",
                  border: "none",
                  borderRadius: 6,
                  background: saving ? "#6b7280" : "#111",
                  color: "#fff",
                  cursor: saving ? "not-allowed" : "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {saving ? "Saving..." : isNewOrder ? "Create Order" : "Save"}
              </button>
            </div>
          </div>
        </aside>

        <section style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 18px", borderBottom: "1px solid #e5e7eb", background: "#fff" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Conversation
              </div>
              <div style={{ fontSize: 24, fontWeight: 700, color: "#0f172a", marginTop: 4, overflowWrap: "anywhere" }}>
                {conversationSubject}
              </div>
              <div style={{ fontSize: 14, color: "#64748b", marginTop: 2 }}>
                {customerLabel}
              </div>
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {statusConfig.enabled && !isNewOrder && (() => {
                const statusId = String(order?.id || "");
                const currentKey = orderStatuses[statusId] ?? "";
                const currentState = statusConfig.states.find((s) => s.key === currentKey);
                const pillBg = currentState?.color || "#f1f5f9";
                const pillTc = contrastColor(pillBg);
                return (
                  <select
                    value={currentKey}
                    onChange={(e) => {
                      const next = e.target.value || null;
                      setOrderStatus(statusId, next);
                      setOrderStatuses(loadOrderStatuses());
                    }}
                    style={{
                      background: pillBg,
                      color: pillTc,
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 6,
                      padding: "5px 10px",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                      outline: "none",
                    }}
                  >
                    <option value="">{statusConfig.columnLabel || "Status"}</option>
                    {statusConfig.states.map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                );
              })()}
              <button
                onClick={onClose}
                style={{ border: "1px solid #d1d5db", background: "#fff", color: "#334155", borderRadius: 8, padding: "8px 12px", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
              >
                X Close
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
            <div
              ref={threadScrollRef}
              style={{ flex: 1, overflowY: "auto", padding: "18px 20px", background: "#f8fafc", minWidth: 0 }}
            >
              {conversationMessages.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {conversationMessages.map((message, index) => {
                    const isOutbound = (message.direction || message.type) === "outbound";
                    const senderLabel = isOutbound ? "You" : (message.sender || message.from || customerLabel);
                    const rawBody = String(message.body || message.preview_text || "").trim();
                    const displayBody = extractCurrentReplyText(rawBody) || rawBody;
                    const rowKey = String(
                      message.id || message.message_id || message.email_id || `row-${index}-${fallbackMessageFingerprint(message)}`,
                    );
                    const statusLine = isOutbound && String(message.status || "").toLowerCase() === "sending" ? "Sending…" : null;
                    const messageAttachments = getEmailAttachments(message);
                    return (
                      <div key={rowKey} style={{ alignSelf: isOutbound ? "flex-end" : "flex-start", maxWidth: "86%" }}>
                        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontWeight: 600 }}>{senderLabel}</div>
                        <div style={{
                          background: isOutbound ? "#e7efff" : "#f3f7f5",
                          border: isOutbound ? "1px solid #c6d7ff" : "1px solid #e1ebe6",
                          borderRadius: isOutbound ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                          padding: "10px 12px",
                          color: "#1f2937",
                          fontSize: 14,
                          lineHeight: 1.55,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          overflowWrap: "anywhere",
                        }}>
                          {displayBody || "Attachment sent"}
                          {statusLine ? (
                            <div style={{ marginTop: 6, fontSize: 11, color: "#64748b", fontWeight: 600 }}>{statusLine}</div>
                          ) : null}
                          {messageAttachments.length ? (
                            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {messageAttachments.map((attachment, attachmentIndex) => (
                                <button
                                  key={`${attachment.name || "attachment"}-${attachment.path || attachmentIndex}`}
                                  type="button"
                                  onClick={() => handleOpenConversationAttachment(attachment)}
                                  title={attachment.path || attachment.name}
                                  style={{
                                    border: "1px solid #cbd5e1",
                                    background: "#fff",
                                    color: "#334155",
                                    borderRadius: 999,
                                    padding: "4px 8px",
                                    cursor: "pointer",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 6,
                                    maxWidth: 280,
                                    fontSize: 12,
                                    fontWeight: 700,
                                  }}
                                >
                                  {attachmentPreviewSrc(attachment) ? (
                                    <img
                                      src={attachmentPreviewSrc(attachment)}
                                      alt=""
                                      style={{ width: 24, height: 24, borderRadius: 6, objectFit: "cover", border: "1px solid #e5e7eb" }}
                                    />
                                  ) : (
                                    <span style={{ color: "#64748b", fontSize: 11 }}>FILE</span>
                                  )}
                                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {attachment.name || "Attachment"}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13, background: "#fff" }}>
                  No conversation messages yet.
                </div>
              )}
            </div>
          </div>

          <div style={{ borderTop: "1px solid #e5e7eb", background: "#fff", padding: "12px 16px" }}>
            <input
              ref={replyFileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                if (files.length) {
                  if (previewCompose) {
                    handleAttachPreviewFiles(files);
                  } else {
                    handleAttachReplyFiles(files);
                  }
                }
                event.target.value = "";
              }}
            />

            {previewCompose ? (
              <div style={{ border: "1px solid #c7d2fe", background: "#f8fbff", borderRadius: 14, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 900, color: "#1e40af", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      Composing customer email
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                      Standalone outbound email. This is not a thread reply.
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: "#475569", fontWeight: 700 }}>
                    {previewCompose.templateName || "Template"}
                  </div>
                </div>

                {templateLoadedNotice ? (
                  <div style={{ fontSize: 11, color: "#2563eb", marginBottom: 8, fontWeight: 700 }}>
                    Template loaded
                  </div>
                ) : null}

                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr)", gap: 10, marginBottom: 10 }}>
                  <label>
                    <span style={{ ...readLabel, textTransform: "uppercase", letterSpacing: "0.04em" }}>To</span>
                    <input
                      style={input}
                      value={previewCompose.to || ""}
                      onChange={(e) => setPreviewCompose((current) => ({ ...current, to: e.target.value }))}
                      placeholder="customer@example.com"
                    />
                  </label>
                  <label>
                    <span style={{ ...readLabel, textTransform: "uppercase", letterSpacing: "0.04em" }}>Subject</span>
                    <input
                      style={input}
                      value={previewCompose.subject || ""}
                      onChange={(e) => setPreviewCompose((current) => ({ ...current, subject: e.target.value }))}
                      placeholder="Email subject"
                    />
                  </label>
                </div>

                <label>
                  <span style={{ ...readLabel, textTransform: "uppercase", letterSpacing: "0.04em" }}>Template Body</span>
                  <textarea
                    value={previewCompose.body || ""}
                    onChange={(e) => setPreviewCompose((current) => ({ ...current, body: e.target.value }))}
                    placeholder="Compose your preview email"
                    style={{ ...textarea, minHeight: 180, background: "#fff", marginBottom: 10 }}
                  />
                </label>

                <div style={{ border: "1px solid #dbeafe", background: "#fff", borderRadius: 12, padding: 10, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 900, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Attachments ({previewCompose.attachments?.length || 0})
                    </div>
                    <button
                      type="button"
                      onClick={() => replyFileInputRef.current?.click()}
                      style={{ border: "1px solid #cbd5e1", background: "#fff", color: "#334155", borderRadius: 8, padding: "5px 9px", cursor: "pointer", fontSize: 12, fontWeight: 800 }}
                    >
                      Add attachment
                    </button>
                  </div>
                  {previewCompose.attachments?.length ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {previewCompose.attachments.map((file, index) => (
                        <span
                          key={`${file.name || "attachment"}-${file.path || index}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 7,
                            border: "1px solid #e2e8f0",
                            background: "#f8fafc",
                            color: "#334155",
                            borderRadius: 999,
                            padding: "4px 8px 4px 10px",
                            fontSize: 12,
                            fontWeight: 700,
                            maxWidth: 320,
                          }}
                          title={file.path || file.name || "Attachment"}
                        >
                          <button
                            type="button"
                            onClick={() => handleOpenConversationAttachment(file)}
                            style={{ border: "none", background: "transparent", color: "#334155", cursor: "pointer", padding: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: "inherit", fontWeight: 700 }}
                          >
                            {file.name || fileNameFromPath(file.path)}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemovePreviewAttachment(index)}
                            aria-label={`Remove ${file.name || "attachment"}`}
                            style={{ border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 13, fontWeight: 900, lineHeight: 1, padding: 0 }}
                          >
                            x
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "#64748b" }}>No attachments ready.</div>
                  )}
                  <div style={{ marginTop: 8, fontSize: 11, color: "#64748b" }}>
                    {previewCompose.attachmentSourceLabel || "Source: order folder"}
                  </div>
                  {previewCompose.attachmentWarnings?.length ? (
                    <div style={{ marginTop: 6, display: "grid", gap: 3 }}>
                      {previewCompose.attachmentWarnings.map((warning, index) => (
                        <div key={`${warning}-${index}`} style={{ fontSize: 11, color: "#b45309", fontWeight: 700 }}>
                          {warning}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                {previewSendState.error ? (
                  <div style={{ fontSize: 12, color: "#b91c1c", marginBottom: 8 }}>{previewSendState.error}</div>
                ) : null}
                {previewSendState.success ? (
                  <div style={{ fontSize: 12, color: "#047857", marginBottom: 8 }}>{previewSendState.success}</div>
                ) : null}

                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => setPreviewCompose((current) => current ? ({ ...current, subject: current.originalSubject, body: current.originalBody }) : current)}
                      style={{ border: "1px solid #cbd5e1", background: "#fff", color: "#334155", borderRadius: 9, padding: "7px 11px", cursor: "pointer", fontSize: 12, fontWeight: 800 }}
                    >
                      Reload Template
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewCompose(null)}
                      style={{ border: "1px solid #e2e8f0", background: "#fff", color: "#475569", borderRadius: 9, padding: "7px 11px", cursor: "pointer", fontSize: 12, fontWeight: 800 }}
                    >
                      Cancel
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleSendPreviewCompose}
                    disabled={previewSendState.sending}
                    style={{
                      border: "none",
                      background: previewSendState.sending ? "#94a3b8" : "#16a34a",
                      color: "#fff",
                      borderRadius: 10,
                      padding: "8px 16px",
                      cursor: previewSendState.sending ? "not-allowed" : "pointer",
                      fontSize: 13,
                      fontWeight: 900,
                    }}
                  >
                    {previewSendState.sending ? "Sending..." : "Send Email"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "#334155" }}>Draft Reply</div>
                  <div style={{ fontSize: 11, color: "#6b7280", display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: "#2563eb", fontSize: 10 }}>●</span> Draft (unsent)
                  </div>
                </div>
                {replyAttachments.length ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                    {replyAttachments.map((file, index) => (
                      <span
                        key={`${file.name || "attachment"}-${file.path || index}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 7,
                          border: "1px solid #e2e8f0",
                          background: "#f8fafc",
                          color: "#334155",
                          borderRadius: 999,
                          padding: "4px 8px 4px 10px",
                          fontSize: 12,
                          fontWeight: 700,
                          maxWidth: 300,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => handleOpenConversationAttachment(file)}
                          style={{ border: "none", background: "transparent", color: "#334155", cursor: "pointer", padding: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: "inherit", fontWeight: 700 }}
                        >
                          {file.name || "Attachment"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveReplyAttachment(index)}
                          aria-label={`Remove ${file.name || "attachment"}`}
                          style={{ border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 13, fontWeight: 900, lineHeight: 1, padding: 0 }}
                        >
                          x
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <textarea
                  ref={draftTextareaRef}
                  value={draftReply}
                  onChange={(e) => setDraftReply(e.target.value)}
                  placeholder="Write a reply..."
                  style={{ ...textarea, minHeight: 86, background: "#fff" }}
                />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 10 }}>
                  <button
                    type="button"
                    onClick={() => replyFileInputRef.current?.click()}
                    title={replyAttachments.length ? `${replyAttachments.length} file${replyAttachments.length === 1 ? "" : "s"} attached` : "Attach file"}
                    aria-label="Attach file"
                    style={{ border: "1px solid #cbd5e1", background: "#fff", color: "#475569", borderRadius: 10, padding: "8px 11px", cursor: "pointer", fontSize: 12, fontWeight: 800 }}
                  >
                    Attach file
                  </button>
                  <button
                    type="button"
                    onClick={handleSendReply}
                    disabled={isSendingReply}
                    style={{
                      border: "none",
                      background: "#2563eb",
                      color: "#fff",
                      borderRadius: 10,
                      padding: "8px 14px",
                      cursor: isSendingReply ? "not-allowed" : "pointer",
                      fontSize: 13,
                      fontWeight: 800,
                      opacity: isSendingReply ? 0.72 : 1,
                    }}
                  >
                    {isSendingReply ? "Sending..." : "Send Reply"}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

      </div>
    </div>,
    document.body
  );
}
