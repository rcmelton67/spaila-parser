import React from "react";
import ReactDOM from "react-dom";
import { loadFieldConfig, buildLabelMap, loadShopConfig } from "../../shared/utils/fieldConfig.js";

const API = "http://127.0.0.1:8055";

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
export default function EditOrderModal({ order, launchContext = null, onClose, onSaved }) {
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
  const [templateLoadedNotice, setTemplateLoadedNotice] = React.useState(false);
  const [replyAttachments, setReplyAttachments] = React.useState([]);
  const [isSendingReply, setIsSendingReply] = React.useState(false);
  const [shopConfig, setShopConfig] = React.useState(() => loadShopConfig());
  const [conversationMessages, setConversationMessages] = React.useState(() => readOrderMessages(order));
  const [showNewMessageHint, setShowNewMessageHint] = React.useState(false);
  const threadScrollRef = React.useRef(null);
  const shouldAutoScrollRef = React.useRef(false);
  const replyFileInputRef = React.useRef(null);
  const draftTextareaRef = React.useRef(null);

  React.useEffect(() => {
    if (!order) return;
    setForm({ ...order });
    setSaving(false);
    setError("");
    if (launchContext?.action === "email") {
      const nextDraft = String(launchContext?.draftBody || "").trim();
      setDraftReply(nextDraft);
      setTemplateLoadedNotice(!!nextDraft);
      window.requestAnimationFrame(() => {
        const node = draftTextareaRef.current;
        if (!node) return;
        node.focus();
        const end = node.value.length;
        node.setSelectionRange(end, end);
      });
    } else {
      setDraftReply("");
      setTemplateLoadedNotice(false);
    }
    setReplyAttachments([]);
    setIsSendingReply(false);
    setConversationMessages(readOrderMessages(order));
    setShowNewMessageHint(false);
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
        attachments: attachmentPaths,
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
        attachments: attachmentPaths,
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
      const scrollNode = threadScrollRef.current;
      const nearBottom = !!scrollNode
        && (scrollNode.scrollHeight - scrollNode.scrollTop - scrollNode.clientHeight) <= 80;

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
        if (hadNew && !nearBottom) {
          queueMicrotask(() => setShowNewMessageHint(true));
        }
        if ((hadNew || merged.updated > 0) && nearBottom) {
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

  function handleThreadScroll() {
    const node = threadScrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 80;
    if (nearBottom) setShowNewMessageHint(false);
  }

  function scrollThreadToBottom() {
    const node = threadScrollRef.current;
    if (!node) return;
    setShowNewMessageHint(false);
    window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }

  React.useEffect(() => {
    if (!shouldAutoScrollRef.current) return;
    shouldAutoScrollRef.current = false;
    const node = threadScrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [conversationMessages]);

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
          overflowY: "auto",
          padding: 14,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: 0,
          background: "#f9fafb",
        }}>
          <div style={{ marginBottom: 9 }}>
            <label style={readLabel}>{L("buyer_name", "Name")}</label>
            <input style={input} value={form.buyer_name || ""} onChange={(e) => set("buyer_name", e.target.value)} />
          </div>
          <div style={{ marginBottom: 9 }}>
            <label style={readLabel}>{L("buyer_email", "Buyer Email")}</label>
            <input style={input} value={form.buyer_email || ""} onChange={(e) => set("buyer_email", e.target.value)} />
          </div>
          <div style={{ marginBottom: 9 }}>
            <label style={readLabel}>{L("shipping_address", "Address")}</label>
            <textarea style={{ ...textarea, minHeight: 64 }} value={form.shipping_address || ""} onChange={(e) => set("shipping_address", e.target.value)} />
          </div>
          <div style={{ marginBottom: 9 }}>
            <label style={readLabel}>{L("order_number", "Order Number")}</label>
            <input autoFocus={isNewOrder} style={input} value={form.order_number || ""} onChange={(e) => set("order_number", e.target.value)} />
          </div>
          <div style={{ marginBottom: 9 }}>
            <label style={readLabel}>{L("order_date", "Order Date")}</label>
            <input style={input} value={form.order_date || ""} onChange={(e) => set("order_date", e.target.value)} />
          </div>
          <div style={{ marginBottom: 9 }}>
            <label style={readLabel}>{L("ship_by", "Ship By")}</label>
            <input style={input} value={form.ship_by || ""} onChange={(e) => set("ship_by", e.target.value)} />
          </div>

          {CUSTOM_KEYS.map((key) => (
            <div key={key} style={{ marginBottom: 9 }}>
              <label style={readLabel}>{L(key, key)}</label>
              <input style={input} value={form[key] || ""} onChange={(e) => set(key, e.target.value)} />
            </div>
          ))}

          <div style={{ marginBottom: 9 }}>
            <label style={readLabel}>{L("order_notes", "Order Notes")}</label>
            <textarea style={{ ...textarea, minHeight: 68 }} value={form.order_notes || form.notes || ""} onChange={(e) => set("order_notes", e.target.value)} />
          </div>
          <div style={{ marginBottom: 9 }}>
            <label style={readLabel}>{L("gift_message", "Gift Message")}</label>
            <textarea style={{ ...textarea, minHeight: 68 }} value={form.gift_message || form.message || ""} onChange={(e) => set("gift_message", e.target.value)} />
          </div>

          <div style={{ display: "grid", gap: 8, paddingTop: 2 }}>
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

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
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
              <button
                type="button"
                onClick={handleOpenEtsyMessages}
                title="Open Etsy Messages"
                style={{
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  color: "#6b7280",
                  borderRadius: 8,
                  padding: "8px 10px",
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                Etsy
              </button>
              <button
                onClick={onClose}
                style={{ border: "1px solid #d1d5db", background: "#fff", color: "#334155", borderRadius: 8, padding: "8px 12px", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
              >
                X Close
              </button>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
            {showNewMessageHint ? (
              <button
                type="button"
                onClick={scrollThreadToBottom}
                style={{
                  position: "absolute",
                  top: 10,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 3,
                  border: "1px solid #bfdbfe",
                  background: "#eff6ff",
                  color: "#1e40af",
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "6px 14px",
                  borderRadius: 999,
                  cursor: "pointer",
                  boxShadow: "0 4px 12px rgba(15, 23, 42, 0.08)",
                }}
              >
                New message
              </button>
            ) : null}
            <div
              ref={threadScrollRef}
              onScroll={handleThreadScroll}
              style={{ flex: 1, overflowY: "auto", padding: "18px 20px", background: "#f8fafc", minWidth: 0 }}
            >
              {conversationMessages.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {conversationMessages.map((message, index) => {
                    const isOutbound = (message.direction || message.type) === "outbound";
                    const senderLabel = isOutbound ? "You" : (message.sender || message.from || customerLabel);
                    const rowKey = String(
                      message.id || message.message_id || message.email_id || `row-${index}-${fallbackMessageFingerprint(message)}`,
                    );
                    const statusLine = isOutbound && String(message.status || "").toLowerCase() === "sending" ? "Sending…" : null;
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
                          {String(message.body || message.preview_text || "").trim() || "Attachment sent"}
                          {statusLine ? (
                            <div style={{ marginTop: 6, fontSize: 11, color: "#64748b", fontWeight: 600 }}>{statusLine}</div>
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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#334155" }}>Draft Reply</div>
              <div style={{ fontSize: 11, color: "#6b7280", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "#2563eb", fontSize: 10 }}>●</span> Draft (unsent)
              </div>
            </div>
            {templateLoadedNotice ? (
              <div style={{ fontSize: 11, color: "#2563eb", marginBottom: 6, fontWeight: 600 }}>
                Template loaded
              </div>
            ) : null}
            <input
              ref={replyFileInputRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                if (files.length) {
                  handleAttachReplyFiles(files);
                }
                event.target.value = "";
              }}
            />
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
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {file.name || "Attachment"}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleRemoveReplyAttachment(index)}
                      aria-label={`Remove ${file.name || "attachment"}`}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "#64748b",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 900,
                        lineHeight: 1,
                        padding: 0,
                      }}
                    >
                      ×
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
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => replyFileInputRef.current?.click()}
                  title={replyAttachments.length ? `${replyAttachments.length} file${replyAttachments.length === 1 ? "" : "s"} attached` : "Attach file"}
                  aria-label="Attach file"
                  style={{
                    border: "1px solid #cbd5e1",
                    background: "#fff",
                    color: "#475569",
                    borderRadius: 10,
                    width: 36,
                    height: 34,
                    cursor: "pointer",
                    fontSize: 16,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  📎
                </button>
                <button
                  type="button"
                  disabled
                  title="Attach from Order (coming soon)"
                  aria-label="Attach from Order"
                  style={{
                    border: "1px solid #cbd5e1",
                    background: "#f8fafc",
                    color: "#94a3b8",
                    borderRadius: 10,
                    width: 36,
                    height: 34,
                    cursor: "not-allowed",
                    fontSize: 16,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  📁
                </button>
              </div>
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
                {isSendingReply ? "Sending..." : "Send"}
              </button>
            </div>
          </div>
        </section>

      </div>
    </div>,
    document.body
  );
}
