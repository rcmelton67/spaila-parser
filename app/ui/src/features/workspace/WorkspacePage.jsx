import React from "react";
import AppHeader from "../../shared/components/AppHeader.jsx";

const panelStyle = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
};
const ORDER_NUMBER_PATTERN = /\b\d{6,12}\b/g;

function formatTimestamp(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function getInboxItemId(item) {
  return String(item?.id || item?.email_id || "").trim();
}

function getMessageId(item) {
  return String(item?.id || item?.message_id || item?.email_id || "").trim();
}

function normalizeProcessedEmailRef(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase();
}

function getProcessedEmailRefVariants(value) {
  const ref = normalizeProcessedEmailRef(value);
  if (!ref) return [];
  const parts = ref.split("/").filter(Boolean);
  const filename = parts[parts.length - 1] || "";
  return filename && filename !== ref ? [ref, filename] : [ref];
}

function getInboxItemRefs(item) {
  return [
    item?.id,
    item?.email_id,
    item?.message_id,
    item?.imap_uid,
    item?.path,
    item?.relativePath,
    item?.source_eml_path,
    item?.name,
  ].flatMap(getProcessedEmailRefVariants).filter(Boolean);
}

function loadProcessedInboxMemory() {
  try {
    const parsed = JSON.parse(window.localStorage?.getItem("spaila.processedInboxRefs") || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(normalizeProcessedEmailRef).filter(Boolean) : []);
  } catch (_error) {
    return new Set();
  }
}

function saveProcessedInboxMemory(refs) {
  try {
    window.localStorage?.setItem("spaila.processedInboxRefs", JSON.stringify([...refs].slice(-1000)));
  } catch (_error) {
    // Local memory is a convenience only; orders remain the source of truth.
  }
}

function buildProcessedEmailRefs(orders = []) {
  const refs = loadProcessedInboxMemory();
  for (const order of orders || []) {
    for (const value of [
      order?.email_id,
      order?.message_id,
      order?.imap_uid,
      order?.source_eml_path,
      order?.eml_path,
    ]) {
      for (const ref of getProcessedEmailRefVariants(value)) {
        refs.add(ref);
      }
    }
  }
  return refs;
}

function isProcessedInboxItem(item, processedRefs) {
  return getInboxItemRefs(item).some((ref) => processedRefs.has(ref));
}

function hasStableReceivedAt(item) {
  const receivedAt = String(item?.received_at || "").trim();
  return receivedAt && Number.isFinite(Date.parse(receivedAt));
}

function filterProcessedInboxItems(items = [], processedRefs = new Set()) {
  const nextProcessedRefs = new Set(processedRefs);
  const filtered = [];
  let removed = 0;
  let missingReceivedAt = 0;
  for (const item of items || []) {
    if (!hasStableReceivedAt(item)) {
      missingReceivedAt += 1;
      continue;
    }
    if (isProcessedInboxItem(item, nextProcessedRefs)) {
      removed += 1;
      for (const ref of getInboxItemRefs(item)) {
        nextProcessedRefs.add(ref);
      }
      continue;
    }
    filtered.push(item);
  }
  if (removed || missingReceivedAt) {
    console.log("[INBOX_PROCESSED_FILTER]", { removed, missing_received_at: missingReceivedAt });
  }
  if (nextProcessedRefs.size !== processedRefs.size) {
    saveProcessedInboxMemory(nextProcessedRefs);
  }
  return filtered;
}

async function fetchOrdersForLinking() {
  const response = await fetch("http://127.0.0.1:8055/orders/list");
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? payload : [];
}

function mergeInboxItems(previousItems = [], fetchedItems = [], processedRefs = new Set()) {
  const previousVisibleItems = filterProcessedInboxItems(previousItems, processedRefs);
  const filteredFetchedItems = filterProcessedInboxItems(fetchedItems, processedRefs);
  const existingIds = new Set(previousVisibleItems.map(getInboxItemId).filter(Boolean));
  const fetchedById = new Map();
  for (const item of filteredFetchedItems) {
    const id = getInboxItemId(item);
    if (id && !fetchedById.has(id)) {
      fetchedById.set(id, item);
    }
  }
  const seenNewIds = new Set();
  const newItems = filteredFetchedItems.filter((item) => {
    const id = getInboxItemId(item);
    if (!id || existingIds.has(id) || seenNewIds.has(id)) {
      return false;
    }
    seenNewIds.add(id);
    return true;
  });
  const updatedExisting = previousVisibleItems.map((item) => {
    const id = getInboxItemId(item);
    const fresh = id ? fetchedById.get(id) : null;
    return fresh ? { ...item, ...fresh } : item;
  });
  console.log("[INBOX_MERGE]", {
    new_count: newItems.length,
    existing_count: previousVisibleItems.length,
  });
  console.log("[INBOX_NO_REORDER]", { verified: true });
  return [...newItems, ...updatedExisting];
}

function renderTextWithLinks(text) {
  const parts = [];
  const pattern = /https?:\/\/[^\s]+/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(String(text || ""))) !== null) {
    const url = match[0].replace(/[),.;]+$/, "");
    const suffix = match[0].slice(url.length);
    if (match.index > lastIndex) {
      parts.push(String(text).slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={`${url}-${match.index}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "#2563eb", textDecoration: "underline" }}
      >
        {url}
      </a>
    );
    if (suffix) {
      parts.push(suffix);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < String(text || "").length) {
    parts.push(String(text || "").slice(lastIndex));
  }
  return parts.length ? parts : text;
}

function extractOrderNumberCandidates(...values) {
  const found = new Set();
  for (const value of values) {
    const source = String(value || "");
    for (const match of source.matchAll(ORDER_NUMBER_PATTERN)) {
      found.add(match[0]);
    }
  }
  return [...found];
}

function normalizeOrderNumber(value) {
  return String(value || "").trim();
}

function buildOrderMetadata(orders) {
  const byOrderNumber = new Map();
  const bySourcePath = new Map();
  for (const order of orders || []) {
    const orderNumber = normalizeOrderNumber(order?.order_number);
    if (!orderNumber) continue;
    const current = byOrderNumber.get(orderNumber) || {
      order_number: orderNumber,
      buyer_name: order?.buyer_name || "",
      buyer_email: order?.buyer_email || "",
      order: { ...order, order_number: orderNumber },
    };
    if (!current.buyer_name && order?.buyer_name) current.buyer_name = order.buyer_name;
    if (!current.buyer_email && order?.buyer_email) current.buyer_email = order.buyer_email;
    byOrderNumber.set(orderNumber, current);
    for (const sourcePath of [order?.source_eml_path]) {
      const key = String(sourcePath || "").trim();
      if (key) bySourcePath.set(key, current);
    }
  }
  return { byOrderNumber, bySourcePath };
}

function resolveMessageOrderNumber(item, orderMetadata) {
  const explicit = normalizeOrderNumber(item?.order_number);
  if (explicit) {
    return explicit;
  }
  for (const sourcePath of [item?.source_eml_path, item?.path]) {
    const key = String(sourcePath || "").trim();
    const matched = key ? orderMetadata.bySourcePath.get(key) : null;
    if (matched?.order_number) {
      return matched.order_number;
    }
  }
  return "";
}

function normalizeInboundMessage(item, orderMetadata) {
  const id = getInboxItemId(item);
  const orderNumber = resolveMessageOrderNumber(item, orderMetadata);
  const orderInfo = orderNumber ? orderMetadata.byOrderNumber.get(orderNumber) : null;
  return {
    ...item,
    id,
    message_id: String(item?.message_id || item?.email_id || id),
    direction: "inbound",
    order_number: orderNumber,
    buyer_name: orderInfo?.buyer_name || "",
    buyer_email: orderInfo?.buyer_email || "",
    from: item?.sender || item?.from || "",
    to: item?.to || "",
    body: item?.preview_text || item?.preview || "",
    timestamp: item?.timestamp || item?.received_at || "",
    received_at: item?.received_at || item?.timestamp || "",
    preview_text: item?.preview_text || item?.preview || "",
    preview: item?.preview || "",
    source_item: item,
    source_eml_path: item?.source_eml_path || item?.path || "",
  };
}

function normalizeOutboundMessage(item, orderMetadata) {
  const id = getMessageId(item);
  const orderNumber = resolveMessageOrderNumber(item, orderMetadata);
  const orderInfo = orderNumber ? orderMetadata.byOrderNumber.get(orderNumber) : null;
  return {
    ...item,
    id,
    message_id: String(item?.message_id || id),
    direction: "outbound",
    order_number: orderNumber,
    buyer_name: item?.buyer_name || orderInfo?.buyer_name || "",
    buyer_email: item?.buyer_email || orderInfo?.buyer_email || "",
    sender: item?.from || "Spaila",
    from: item?.from || "Spaila",
    to: item?.to || "",
    body: item?.body || item?.preview_text || "",
    timestamp: item?.timestamp || item?.received_at || "",
    received_at: item?.received_at || item?.timestamp || "",
    preview_text: item?.preview_text || item?.body || item?.preview || "",
    preview: item?.preview || buildThreadPreview(item?.preview_text || item?.body || ""),
    source_item: item,
    source_eml_path: item?.source_eml_path || "",
  };
}

function buildThreadPreview(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "(No preview available)";
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function buildThreadsFromMessages(inboxItems, sentMessages, orders) {
  const orderMetadata = buildOrderMetadata(orders);
  const threadsById = new Map();
  const unlinkedMessages = [];
  const messages = [
    ...(inboxItems || []).map((item) => normalizeInboundMessage(item, orderMetadata)),
    ...(sentMessages || []).map((item) => normalizeOutboundMessage(item, orderMetadata)),
  ].filter((message) => message.id);

  for (const message of messages) {
    if (!message.order_number) {
      unlinkedMessages.push(message);
      continue;
    }
    const threadId = message.order_number;
    const orderInfo = orderMetadata.byOrderNumber.get(threadId);
    const thread = threadsById.get(threadId) || {
      thread_id: threadId,
      order_number: threadId,
      buyer_name: orderInfo?.buyer_name || message.buyer_name || "",
      buyer_email: orderInfo?.buyer_email || message.buyer_email || "",
      order: orderInfo?.order || null,
      origin: message.direction === "inbound" ? "parser_created" : "inbound",
      messages: [],
      created_at: message.timestamp || "",
      last_message_timestamp: "",
    };
    thread.messages.push(message);
    if (!thread.buyer_name && message.buyer_name) thread.buyer_name = message.buyer_name;
    if (!thread.buyer_email && message.buyer_email) thread.buyer_email = message.buyer_email;
    if (!thread.created_at || String(message.timestamp || "").localeCompare(String(thread.created_at || "")) < 0) {
      thread.created_at = message.timestamp || thread.created_at;
    }
    threadsById.set(threadId, thread);
  }

  const sortByTimestampAsc = (a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || ""));
  const threads = [...threadsById.values()].map((thread) => {
    const messagesForThread = [...thread.messages].sort(sortByTimestampAsc);
    const firstMessage = messagesForThread[0] || null;
    const lastMessage = messagesForThread[messagesForThread.length - 1] || null;
    return {
      ...thread,
      messages: messagesForThread,
      created_at: firstMessage?.timestamp || thread.created_at || "",
      last_message_timestamp: lastMessage?.timestamp || "",
      last_message_preview: buildThreadPreview(lastMessage?.preview_text || lastMessage?.preview || lastMessage?.body || ""),
      inbound_count: messagesForThread.filter((message) => message.direction === "inbound").length,
      outbound_count: messagesForThread.filter((message) => message.direction === "outbound").length,
    };
  }).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  unlinkedMessages.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  return { threads, unlinkedMessages };
}

function mergeThreads(previousThreads = [], builtThreads = []) {
  const builtById = new Map((builtThreads || []).map((thread) => [thread.thread_id, thread]));
  const previousIds = new Set(previousThreads.map((thread) => thread.thread_id));
  const newThreads = (builtThreads || []).filter((thread) => !previousIds.has(thread.thread_id));
  const updatedThreads = previousThreads
    .map((thread) => builtById.has(thread.thread_id) ? { ...thread, ...builtById.get(thread.thread_id) } : null)
    .filter(Boolean);
  return [...newThreads, ...updatedThreads];
}

function mergeUnlinkedMessages(previousMessages = [], builtMessages = []) {
  const builtById = new Map((builtMessages || []).map((message) => [message.id, message]));
  const previousIds = new Set(previousMessages.map((message) => message.id));
  const newMessages = (builtMessages || []).filter((message) => !previousIds.has(message.id));
  const updatedMessages = previousMessages
    .map((message) => builtById.has(message.id) ? { ...message, ...builtById.get(message.id) } : null)
    .filter(Boolean);
  return [...newMessages, ...updatedMessages];
}

function normalizeReplySubject(subject) {
  const value = String(subject || "").trim();
  if (!value) return "Re:";
  return /^re:/i.test(value) ? value : `Re: ${value}`;
}

function formatReplyDate(value) {
  if (!value) return "an unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildReplyBody(item) {
  const cleanedText = String(item?.preview_text || item?.preview || "").trim();
  const quotedText = cleanedText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    "",
    "",
    "--------------------------------",
    `On ${formatReplyDate(item?.timestamp)}, ${item?.sender || "the sender"} wrote:`,
    "",
    quotedText,
  ].join("\n");
}

function buildMailtoLink(item) {
  const target = String(item?.reply_to || "").trim();
  if (!target) return "";
  const subject = normalizeReplySubject(item?.subject || "");
  const body = buildReplyBody(item);
  return `mailto:${target}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildOrderLinkState(item, orders) {
  const candidates = extractOrderNumberCandidates(item?.subject, item?.preview_text, item?.preview);
  if (!candidates.length) {
    return { candidates: [], matches: [], linkedOrder: null };
  }

  const candidateSet = new Set(candidates);
  const byOrderId = new Map();
  for (const order of orders || []) {
    const orderNumber = normalizeOrderNumber(order?.order_number);
    if (!candidateSet.has(orderNumber)) continue;
    const key = String(order?.order_id || order?.id || `${orderNumber}:${byOrderId.size}`);
    if (!byOrderId.has(key)) {
      byOrderId.set(key, { ...order, order_number: orderNumber });
    }
  }
  const matches = [...byOrderId.values()];
  return {
    candidates,
    matches,
    linkedOrder: matches.length === 1 ? matches[0] : null,
  };
}

function buildOrderMatchesByNumber(orderNumbers, orders) {
  const wanted = new Set((orderNumbers || []).map(normalizeOrderNumber).filter(Boolean));
  const matchesByNumber = new Map();
  for (const order of orders || []) {
    const orderNumber = normalizeOrderNumber(order?.order_number);
    if (!wanted.has(orderNumber)) continue;
    const current = matchesByNumber.get(orderNumber) || new Map();
    const key = String(order?.order_id || order?.id || `${orderNumber}:${current.size}`);
    if (!current.has(key)) {
      current.set(key, { ...order, order_number: orderNumber });
    }
    matchesByNumber.set(orderNumber, current);
  }
  return new Map([...matchesByNumber.entries()].map(([orderNumber, values]) => [orderNumber, [...values.values()]]));
}

function renderSubjectWithOrderLinks(subject, orders, onOpenOrder) {
  const source = String(subject || "(No subject)");
  const orderNumbers = extractOrderNumberCandidates(source);
  if (!orderNumbers.length) {
    return source;
  }
  const matchesByNumber = buildOrderMatchesByNumber(orderNumbers, orders);
  const parts = [];
  let lastIndex = 0;
  let match;
  ORDER_NUMBER_PATTERN.lastIndex = 0;
  while ((match = ORDER_NUMBER_PATTERN.exec(source)) !== null) {
    const orderNumber = match[0];
    if (match.index > lastIndex) {
      parts.push(source.slice(lastIndex, match.index));
    }
    const matchingOrder = matchesByNumber.get(orderNumber)?.[0] || null;
    if (matchingOrder) {
      parts.push(
        <a
          key={`${orderNumber}-${match.index}`}
          href="#"
          onClick={(event) => {
            event.preventDefault();
            onOpenOrder?.(matchingOrder);
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.textDecoration = "underline";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.textDecoration = "none";
          }}
          style={{
            color: "#2563eb",
            cursor: "pointer",
            textDecoration: "none",
            fontWeight: 650,
          }}
        >
          {orderNumber}
        </a>
      );
    } else {
      parts.push(
        <span key={`${orderNumber}-${match.index}`} style={{ fontWeight: 500 }}>
          {orderNumber}
        </span>
      );
    }
    lastIndex = match.index + orderNumber.length;
  }
  if (lastIndex < source.length) {
    parts.push(source.slice(lastIndex));
  }
  return parts;
}

function renderPreviewTextWithProof(text, orderLinkState, onOpenOrder) {
  const source = String(text || "");
  const matchesByNumber = new Map();
  for (const order of orderLinkState?.matches || []) {
    const orderNumber = normalizeOrderNumber(order?.order_number);
    if (!orderNumber) continue;
    const existing = matchesByNumber.get(orderNumber) || [];
    existing.push(order);
    matchesByNumber.set(orderNumber, existing);
  }
  const parts = [];
  const pattern = /(https?:\/\/[^\s]+)|(\b\d{6,12}\b)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      parts.push(source.slice(lastIndex, match.index));
    }
    if (match[1]) {
      const url = match[1].replace(/[),.;]+$/, "");
      const suffix = match[1].slice(url.length);
      parts.push(
        <a
          key={`url-${url}-${match.index}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2563eb", textDecoration: "underline" }}
        >
          {url}
        </a>
      );
      if (suffix) parts.push(suffix);
    } else {
      const orderNumber = match[2];
      const orders = matchesByNumber.get(orderNumber) || [];
      if (orders.length === 1) {
        parts.push(
          <button
            key={`order-${orderNumber}-${match.index}`}
            type="button"
            onClick={() => onOpenOrder?.(orders[0])}
            title={`Open linked order ${orderNumber}`}
            style={{
              border: "1px solid #bfdbfe",
              background: "#eff6ff",
              color: "#1d4ed8",
              borderRadius: 6,
              padding: "0 4px",
              cursor: "pointer",
              font: "inherit",
              fontWeight: 800,
            }}
          >
            {orderNumber}
          </button>
        );
      } else if (orders.length > 1) {
        parts.push(
          <span
            key={`order-multi-${orderNumber}-${match.index}`}
            title={`Multiple exact order matches for ${orderNumber}`}
            style={{
              border: "1px solid #fde68a",
              background: "#fffbeb",
              color: "#92400e",
              borderRadius: 6,
              padding: "0 4px",
              fontWeight: 800,
            }}
          >
            {orderNumber}
          </span>
        );
      } else {
        parts.push(orderNumber);
      }
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < source.length) {
    parts.push(source.slice(lastIndex));
  }
  return parts.length ? parts : text;
}

function getMessageClassification(item, orderLinkState) {
  const subject = String(item?.subject || "").toLowerCase();
  const sender = String(item?.sender || "").toLowerCase();
  if (/^re:\s*/i.test(String(item?.subject || ""))) {
    return { label: "Customer reply", detail: "Subject begins with Re:", color: "#475569", bg: "#f8fafc", border: "#e2e8f0" };
  }
  if (/\b(no-?reply|notification|automated|system)\b/.test(sender) || /\b(notification|receipt|shipping update|delivery update)\b/.test(subject)) {
    return { label: "System notification", detail: "Notification-style sender or subject", color: "#475569", bg: "#f8fafc", border: "#e2e8f0" };
  }
  const score = Number(item?.order_score || 0);
  if (score >= 70) {
    return { label: "Likely order", detail: `Pattern score ${score}`, color: "#3f6212", bg: "#ecfccb", border: "#bef264" };
  }
  return null;
}

function isQuotedMessageLine(line) {
  const value = String(line || "").trim();
  return value.startsWith(">")
    || /^On .+ wrote:$/i.test(value)
    || /^(From|Sent|To|Subject|Date):\s+/i.test(value)
    || /^-{3,}\s*(Original Message|Forwarded message)?\s*-*$/i.test(value);
}

function renderReadableMessageBody(text, orderLinkState, onOpenOrder) {
  const lines = String(text || "(No preview available)").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let current = [];
  let currentQuoted = false;

  function flush() {
    if (!current.length) return;
    blocks.push({ quoted: currentQuoted, text: current.join("\n").trimEnd() });
    current = [];
  }

  for (const line of lines) {
    const quoted = isQuotedMessageLine(line);
    if (!line.trim()) {
      flush();
      currentQuoted = false;
      continue;
    }
    if (current.length && quoted !== currentQuoted) {
      flush();
    }
    currentQuoted = quoted;
    current.push(line);
  }
  flush();

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {blocks.map((block, index) => (
        <div
          key={`${block.quoted ? "quote" : "body"}-${index}`}
          style={{
            color: block.quoted ? "#64748b" : "#1f2937",
            background: block.quoted ? "#f8fafc" : "transparent",
            borderLeft: block.quoted ? "3px solid #cbd5e1" : "none",
            padding: block.quoted ? "8px 0 8px 12px" : 0,
            fontSize: block.quoted ? 13 : 15,
            lineHeight: block.quoted ? 1.55 : 1.72,
            whiteSpace: "pre-wrap",
          }}
        >
          {renderPreviewTextWithProof(block.text, orderLinkState, onOpenOrder)}
        </div>
      ))}
    </div>
  );
}

function getEmailAttachments(item) {
  const values = item?.attachments || item?.attachment_paths || item?.attachmentPaths || [];
  return Array.isArray(values) ? values.filter(Boolean) : [];
}

function formatLastUpdated(value, now = Date.now()) {
  if (!value) return "Not updated yet";
  const elapsedMs = Math.max(0, now - value);
  if (elapsedMs < 60000) return "Updated just now";
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours} hr${hours === 1 ? "" : "s"} ago`;
}

function PreviewMenuItem({ children, disabled = false, danger = false, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: "100%",
        border: "none",
        background: "transparent",
        color: disabled ? "#94a3b8" : danger ? "#991b1b" : "#0f172a",
        padding: "8px 12px",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 13,
        fontWeight: 700,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {children}
    </button>
  );
}

export default function WorkspacePage({
  onOpenFile,
  onOpenOrder,
  onWorkspace,
  onSettings,
  onOrders,
  activeCount = 0,
  completedCount = 0,
}) {
  const [workspaceState, setWorkspaceState] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [dropMessage, setDropMessage] = React.useState("");
  const [refreshingInbox, setRefreshingInbox] = React.useState(false);
  const [mode, setMode] = React.useState("inbox");
  const [selectedEmailId, setSelectedEmailId] = React.useState("");
  const [selectedSentId, setSelectedSentId] = React.useState("");
  const [checkedEmailIds, setCheckedEmailIds] = React.useState(() => new Set());
  const [showEmlInstructions, setShowEmlInstructions] = React.useState(false);
  const [inboxContextMenu, setInboxContextMenu] = React.useState(null);
  const [previewContextMenu, setPreviewContextMenu] = React.useState(null);
  const [previewMode, setPreviewMode] = React.useState("clean");
  const [imapConnected, setImapConnected] = React.useState(false);
  const [imapChecking, setImapChecking] = React.useState(false);
  const [lastInboxFetchAt, setLastInboxFetchAt] = React.useState(null);
  const [clockTick, setClockTick] = React.useState(() => Date.now());
  const [ordersForLinking, setOrdersForLinking] = React.useState([]);
  const [threadState, setThreadState] = React.useState({ threads: [], unlinkedMessages: [] });
  const [selectedThreadId, setSelectedThreadId] = React.useState("");
  const inboxFetchInFlightRef = React.useRef(false);
  const lastAutoFetchAtRef = React.useRef(0);
  const previousImapConnectedRef = React.useRef(false);

  const loadWorkspace = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextState, orders] = await Promise.all([
        window.parserApp?.getWorkspaceState?.({
          bucket: "Inbox",
          relativePath: "",
        }),
        fetchOrdersForLinking().catch(() => []),
      ]);
      const processedRefs = buildProcessedEmailRefs(orders);
      const nextInboxItems = filterProcessedInboxItems(nextState?.inboxItems || [], processedRefs);
      if (Array.isArray(orders)) {
        setOrdersForLinking(orders);
      }
      setWorkspaceState((prev) => {
        if (!nextState) return null;
        if (!prev?.inboxItems) {
          return {
            ...nextState,
            inboxItems: nextInboxItems,
          };
        }
        return {
          ...nextState,
          inboxItems: mergeInboxItems(prev.inboxItems, nextInboxItems, processedRefs),
        };
      });
      setError("");
    } catch (nextError) {
      setError(nextError.message || "Could not load workspace.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOrdersForLinking = React.useCallback(async () => {
    try {
      const orders = await fetchOrdersForLinking();
      const processedRefs = buildProcessedEmailRefs(orders);
      setOrdersForLinking(orders);
      setWorkspaceState((prev) => {
        if (!prev?.inboxItems) return prev;
        return {
          ...prev,
          inboxItems: filterProcessedInboxItems(prev.inboxItems, processedRefs),
        };
      });
    } catch (_error) {
      setOrdersForLinking([]);
    }
  }, []);

  const checkImapConnection = React.useCallback(async ({ showError = false } = {}) => {
    if (!workspaceState?.imapConfigured) {
      setImapConnected(false);
      if (showError) {
        setDropMessage("Email connection unavailable. Cannot delete from account.");
      }
      return false;
    }
    setImapChecking(true);
    try {
      const response = await fetch("http://127.0.0.1:8055/inbox/check", { method: "GET" });
      const payload = await response.json().catch(() => ({}));
      const connected = !!(response.ok && payload?.connected);
      setImapConnected(connected);
      if (!connected && showError) {
        setDropMessage("Email connection unavailable. Cannot delete from account.");
      }
      return connected;
    } catch (_error) {
      setImapConnected(false);
      if (showError) {
        setDropMessage("Email connection unavailable. Cannot delete from account.");
      }
      return false;
    } finally {
      setImapChecking(false);
    }
  }, [workspaceState?.imapConfigured]);

  const fetchInbox = React.useCallback(async ({ manual = false, reason = "auto" } = {}) => {
    if (!workspaceState?.imapConfigured || !imapConnected) {
      if (manual) {
        setDropMessage("Email connection unavailable. Cannot refresh inbox.");
      }
      return false;
    }
    const now = Date.now();
    if (!manual && now - lastAutoFetchAtRef.current < 30000) {
      return false;
    }
    if (inboxFetchInFlightRef.current) {
      return false;
    }

    inboxFetchInFlightRef.current = true;
    lastAutoFetchAtRef.current = now;
    setRefreshingInbox(true);
    try {
      const response = await fetch("http://127.0.0.1:8055/inbox/fetch", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "Could not refresh inbox.");
      }
      setLastInboxFetchAt(Date.now());
      setClockTick(Date.now());
      if (manual) {
        setDropMessage(`${payload?.saved || 0} email${payload?.saved === 1 ? "" : "s"} saved to Inbox`);
      }
      await loadWorkspace();
      await checkImapConnection();
      return true;
    } catch (nextError) {
      await checkImapConnection();
      if (manual || reason === "focus") {
        setDropMessage(nextError.message || "Could not refresh inbox.");
      }
      return false;
    } finally {
      inboxFetchInFlightRef.current = false;
      setRefreshingInbox(false);
    }
  }, [checkImapConnection, imapConnected, loadWorkspace, workspaceState?.imapConfigured]);

  const inboxItems = workspaceState?.inboxItems || [];
  const sentMessages = workspaceState?.sentMessages || [];
  const buckets = workspaceState?.buckets || [];
  const inboxPath = workspaceState?.inboxPath || buckets.find((item) => item.key === "Inbox")?.path || "";
  const imapConfigured = !!workspaceState?.imapConfigured;
  const canFetchInbox = imapConfigured && imapConnected;
  const canDeleteFromAccount = canFetchInbox;
  const lastUpdatedLabel = formatLastUpdated(lastInboxFetchAt, clockTick);
  const showInboxEmptyState = !loading && inboxItems.length === 0 && sentMessages.length === 0;
  const displayInboxPath = inboxPath || "C:\\Spaila\\Inbox";
  const inboxModeItems = inboxItems.filter((item) => String(item.direction || "inbound").toLowerCase() === "inbound");
  const sentItems = sentMessages.filter((item) => String(item.direction || "outbound").toLowerCase() === "outbound");
  const checkedInboxItems = inboxItems.filter((item) => checkedEmailIds.has(getInboxItemId(item)));
  const selectedInboxItem = inboxItems.find((item) => getInboxItemId(item) === selectedEmailId) || null;
  const selectedSentItem = sentItems.find((item) => getMessageId(item) === selectedSentId) || null;
  const selectedMailboxItem = mode === "sent" ? selectedSentItem : selectedInboxItem;
  const selectedOrderLinkState = buildOrderLinkState(selectedMailboxItem, ordersForLinking);
  const selectedMessageClassification = mode === "inbox" ? getMessageClassification(selectedInboxItem, selectedOrderLinkState) : null;
  const selectedEmailAttachments = getEmailAttachments(selectedMailboxItem);
  const inboxContextMenuItem = inboxItems.find((item) => getInboxItemId(item) === inboxContextMenu?.emailId) || null;
  const inboxContextOrderLinkState = buildOrderLinkState(inboxContextMenuItem, ordersForLinking);
  const visibleInboxIdKey = inboxItems.map(getInboxItemId).filter(Boolean).join("|");
  const threadItems = threadState.threads || [];
  const unlinkedMessages = threadState.unlinkedMessages || [];
  const selectedThread = threadItems.find((thread) => thread.thread_id === selectedThreadId) || null;
  const selectedThreadMessages = selectedThread?.messages || [];

  function updateInboxOrderLearningState(emailId, updates) {
    setWorkspaceState((prev) => {
      if (!prev?.inboxItems) return prev;
      console.log("[INBOX_UPDATE]", {
        item_id: emailId,
        changed_fields: Object.keys(updates || {}),
      });
      console.log("[INBOX_NO_REORDER]", { verified: true });
      return {
        ...prev,
        inboxItems: prev.inboxItems.map((candidate) => (
          getInboxItemId(candidate) === emailId
            ? { ...candidate, ...updates }
            : candidate
        )),
      };
    });
  }

  React.useEffect(() => {
    loadWorkspace();
    loadOrdersForLinking();
  }, [loadOrdersForLinking, loadWorkspace]);

  React.useEffect(() => {
    const built = buildThreadsFromMessages(inboxItems, sentMessages, ordersForLinking);
    setThreadState((prev) => ({
      threads: mergeThreads(prev.threads, built.threads),
      unlinkedMessages: mergeUnlinkedMessages(prev.unlinkedMessages, built.unlinkedMessages),
    }));
  }, [visibleInboxIdKey, sentMessages, ordersForLinking]);

  React.useEffect(() => {
    if (selectedThreadId && !threadItems.some((thread) => thread.thread_id === selectedThreadId)) {
      setSelectedThreadId("");
    }
  }, [selectedThreadId, threadItems]);

  React.useEffect(() => {
    function handleFocus() {
      fetchInbox({ reason: "focus" });
    }
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [fetchInbox]);

  React.useEffect(() => {
    if (!dropMessage) return undefined;
    const timer = window.setTimeout(() => setDropMessage(""), 2800);
    return () => window.clearTimeout(timer);
  }, [dropMessage]);

  React.useEffect(() => {
    if (inboxItems.length > 0) {
      setShowEmlInstructions(false);
    }
  }, [inboxItems.length]);

  React.useEffect(() => {
    const visibleIds = new Set(inboxItems.map(getInboxItemId).filter(Boolean));
    setCheckedEmailIds((current) => {
      const nextValues = [...current].filter((emailId) => visibleIds.has(emailId));
      if (nextValues.length === current.size) {
        return current;
      }
      return new Set(nextValues);
    });
    if (selectedEmailId && !visibleIds.has(selectedEmailId)) {
      setSelectedEmailId("");
    }
    if (inboxContextMenu?.emailId && !visibleIds.has(inboxContextMenu.emailId)) {
      setInboxContextMenu(null);
    }
  }, [visibleInboxIdKey, selectedEmailId]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    setPreviewMode("clean");
    setPreviewContextMenu(null);
  }, [selectedEmailId]);

  React.useEffect(() => {
    setPreviewMode("clean");
    setPreviewContextMenu(null);
  }, [selectedSentId, mode]);

  React.useEffect(() => {
    if (!inboxContextMenu) return undefined;
    function closeMenu() {
      setInboxContextMenu(null);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [inboxContextMenu]);

  React.useEffect(() => {
    if (!previewContextMenu) return undefined;
    function closeMenu() {
      setPreviewContextMenu(null);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [previewContextMenu]);

  React.useEffect(() => {
    checkImapConnection();
  }, [checkImapConnection]);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      checkImapConnection();
    }, 15000);
    return () => window.clearInterval(interval);
  }, [checkImapConnection]);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTick(Date.now());
    }, 30000);
    return () => window.clearInterval(interval);
  }, []);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      fetchInbox({ reason: "interval" });
    }, 45000);
    return () => window.clearInterval(interval);
  }, [fetchInbox]);

  React.useEffect(() => {
    if (imapConnected && !previousImapConnectedRef.current) {
      fetchInbox({ reason: "connection-restored" });
    }
    previousImapConnectedRef.current = imapConnected;
  }, [fetchInbox, imapConnected]);

  async function handleOpenInboxFolder() {
    if (!inboxPath) {
      setDropMessage("Inbox folder is not available yet.");
      return;
    }
    const result = await window.parserApp?.openFolder?.(inboxPath);
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not open the Inbox folder.");
    }
  }

  async function handleRefreshInbox() {
    await fetchInbox({ manual: true, reason: "manual" });
  }

  function openPreviewContextMenu(event) {
    event.preventDefault();
    if (!selectedInboxItem || selectedThread) return;
    setInboxContextMenu(null);
    setPreviewContextMenu({ x: event.clientX, y: event.clientY });
  }

  function runPreviewContextAction(action) {
    setPreviewContextMenu(null);
    action?.();
  }

  function openInboxContextMenu(event, item) {
    event.preventDefault();
    const emailId = getInboxItemId(item);
    if (!emailId) return;
    setSelectedEmailId(emailId);
    setPreviewContextMenu(null);
    setInboxContextMenu({ x: event.clientX, y: event.clientY, emailId });
  }

  function runInboxContextAction(action) {
    setInboxContextMenu(null);
    action?.();
  }

  async function openInboxItem(item) {
    try {
      const result = await window.parserApp?.openInboxItem?.({ filePath: item.path });
      if (!result?.ok || !result?.path) {
        setDropMessage(result?.error || "Could not open inbox email.");
        return;
      }
      onOpenFile?.(result.path);
    } catch (nextError) {
      setDropMessage(nextError.message || "Could not open inbox email.");
    }
  }

  function hideInboxItemInState(item) {
    const emailId = getInboxItemId(item);
    setSelectedEmailId((current) => (current === emailId ? "" : current));
    setCheckedEmailIds((current) => {
      const next = new Set(current);
      next.delete(emailId);
      return next;
    });
    setWorkspaceState((prev) => {
      if (!prev?.inboxItems) return prev;
      console.log("[INBOX_UPDATE]", {
        item_id: emailId,
        changed_fields: ["removed"],
      });
      console.log("[INBOX_NO_REORDER]", { verified: true });
      return {
        ...prev,
        inboxItems: prev.inboxItems.filter((candidate) => getInboxItemId(candidate) !== emailId),
      };
    });
  }

  async function handleViewInboxItem(item) {
    const result = await window.parserApp?.openFile?.({ filePath: item.path });
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not view email.");
    }
  }

  async function handleReplyInEmail(item) {
    const mailtoLink = buildMailtoLink(item);
    if (!mailtoLink) {
      setDropMessage("No reply email address found.");
      return;
    }
    const result = await window.electronAPI?.openExternal?.(mailtoLink);
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not open email client.");
    }
  }

  function handleOpenLinkedOrder(order) {
    const orderNumber = normalizeOrderNumber(order?.order_number);
    if (!orderNumber) {
      setDropMessage("Linked order number is missing.");
      return;
    }
    onOpenOrder?.(order);
  }

  async function handleRemoveInboxItem(item) {
    const emailId = getInboxItemId(item);
    if (!emailId) {
      setDropMessage("Email id is missing.");
      return;
    }
    const previousIndex = inboxItems.findIndex((candidate) => getInboxItemId(candidate) === emailId);
    hideInboxItemInState(item);
    const result = await window.parserApp?.hideInboxItem?.({ emailId });
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not remove email from Spaila.");
      setWorkspaceState((prev) => {
        if (!prev?.inboxItems || prev.inboxItems.some((candidate) => getInboxItemId(candidate) === emailId)) {
          return prev;
        }
        const inboxItemsWithRestoredItem = [...prev.inboxItems];
        inboxItemsWithRestoredItem.splice(Math.max(0, previousIndex), 0, item);
        console.log("[INBOX_UPDATE]", {
          item_id: emailId,
          changed_fields: ["restore_removed"],
        });
        console.log("[INBOX_NO_REORDER]", { verified: true });
        return { ...prev, inboxItems: inboxItemsWithRestoredItem };
      });
    } else {
      setDropMessage("Email removed from Spaila.");
    }
  }

  async function handleDeleteInboxItem(item) {
    if (!imapConfigured) {
      setDropMessage("Email connection unavailable. Cannot delete from account.");
      return;
    }
    const emailId = getInboxItemId(item);
    if (!emailId) {
      setDropMessage("Email id is missing.");
      return;
    }
    if (!window.confirm("Delete this email from your email account?")) {
      return;
    }
    const connected = await checkImapConnection({ showError: true });
    if (!connected) {
      return;
    }
    try {
      const response = await fetch("http://127.0.0.1:8055/inbox/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_id: emailId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "Could not delete email from account.");
      }
      hideInboxItemInState(item);
      await window.parserApp?.hideInboxItem?.({ emailId });
      setDropMessage("Email deleted from account.");
    } catch (nextError) {
      await checkImapConnection();
      setDropMessage(nextError.message || "Could not delete email from account.");
    }
  }

  async function handleMarkInboxOrder(item) {
    const emailId = getInboxItemId(item);
    if (!emailId) {
      setDropMessage("Email id is missing.");
      return;
    }
    const result = await window.parserApp?.markInboxOrder?.({
      item: {
        email_id: emailId,
        subject: item.subject || "",
        sender: item.sender || "",
        preview: item.preview || "",
      },
    });
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not mark email as order.");
      return;
    }
    updateInboxOrderLearningState(emailId, { order_flagged: true, order_not_order: false, order_score: 100 });
    setDropMessage("Email marked as order.");
  }

  async function handleMarkInboxNotOrder(item) {
    const emailId = getInboxItemId(item);
    if (!emailId) {
      setDropMessage("Email id is missing.");
      return;
    }
    const result = await window.parserApp?.markInboxNotOrder?.({
      item: {
        email_id: emailId,
        subject: item.subject || "",
        sender: item.sender || "",
        preview: item.preview || "",
      },
    });
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not mark email as not order.");
      return;
    }
    updateInboxOrderLearningState(emailId, { order_flagged: false, order_not_order: true, order_score: 0 });
    setDropMessage("Email marked as not order.");
  }

  async function handleUndoInboxOrderMark(item) {
    const emailId = getInboxItemId(item);
    if (!emailId) {
      setDropMessage("Email id is missing.");
      return;
    }
    const result = await window.parserApp?.undoInboxOrderMark?.({
      item: {
        email_id: emailId,
        subject: item.subject || "",
        sender: item.sender || "",
        preview: item.preview || "",
      },
    });
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not undo order mark.");
      return;
    }
    updateInboxOrderLearningState(emailId, {
      order_flagged: false,
      order_not_order: false,
      order_score: Number(result.score || 0),
    });
    setDropMessage("Order mark undone.");
  }

  function selectInboxItem(item) {
    setSelectedEmailId(getInboxItemId(item));
  }

  function toggleCheckedInboxItem(item, checked) {
    const emailId = getInboxItemId(item);
    if (!emailId) return;
    setCheckedEmailIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(emailId);
      } else {
        next.delete(emailId);
      }
      return next;
    });
  }

  async function handleBulkProcess() {
    const firstItem = checkedInboxItems[0];
    if (!firstItem) return;
    await openInboxItem(firstItem);
  }

  async function handleBulkRemove() {
    if (!checkedInboxItems.length) return;
    const itemsToRemove = [...checkedInboxItems];
    for (const item of itemsToRemove) {
      hideInboxItemInState(item);
    }
    for (const item of itemsToRemove) {
      const emailId = getInboxItemId(item);
      if (emailId) {
        await window.parserApp?.hideInboxItem?.({ emailId });
      }
    }
    setDropMessage(`${itemsToRemove.length} email${itemsToRemove.length === 1 ? "" : "s"} removed from Spaila.`);
  }

  async function handleBulkDelete() {
    if (!checkedInboxItems.length) return;
    if (!imapConfigured) {
      setDropMessage("Email connection unavailable. Cannot delete from account.");
      return;
    }
    const itemsToDelete = [...checkedInboxItems];
    if (!window.confirm(`Delete ${itemsToDelete.length} selected email${itemsToDelete.length === 1 ? "" : "s"} from your email account?`)) {
      return;
    }
    const connected = await checkImapConnection({ showError: true });
    if (!connected) {
      return;
    }
    let deleted = 0;
    for (const item of itemsToDelete) {
      const emailId = getInboxItemId(item);
      if (!emailId) continue;
      try {
        const response = await fetch("http://127.0.0.1:8055/inbox/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email_id: emailId }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.detail || payload?.error || "Could not delete email from account.");
        }
        deleted += 1;
        hideInboxItemInState(item);
        await window.parserApp?.hideInboxItem?.({ emailId });
      } catch (nextError) {
        await checkImapConnection();
        setDropMessage(nextError.message || "Could not delete email from account.");
        break;
      }
    }
    if (deleted > 0) {
      setDropMessage(`${deleted} email${deleted === 1 ? "" : "s"} deleted from account.`);
    }
  }

  function renderThreadRow(thread) {
    const isSelected = selectedThreadId === thread.thread_id;
    const label = thread.buyer_name || thread.buyer_email || "Customer";
    // TODO: add unread count when read-state tracking exists
    return (
      <div
        key={thread.thread_id}
        role="button"
        tabIndex={0}
        onClick={() => {
          setSelectedThreadId(thread.thread_id);
          setSelectedEmailId("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSelectedThreadId(thread.thread_id);
            setSelectedEmailId("");
          }
        }}
        style={{
          width: "100%",
          textAlign: "left",
          border: `1px solid ${isSelected ? "#93c5fd" : "#e5e7eb"}`,
          borderLeft: `4px solid ${isSelected ? "#3b82f6" : "#cbd5e1"}`,
          background: isSelected ? "#eff6ff" : "#fff",
          borderRadius: 12,
          padding: 14,
          marginBottom: 10,
          cursor: "pointer",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ minWidth: 0, fontSize: 13, fontWeight: 800, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Order #{thread.order_number}
          </div>
          <div style={{ flexShrink: 0, fontSize: 11, color: "#94a3b8" }}>{formatTimestamp(thread.last_message_timestamp)}</div>
        </div>
        <div style={{ marginTop: 7, fontSize: 12, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.4, color: "#94a3b8", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {thread.last_message_preview}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span style={{ border: "1px solid #dbeafe", background: "#eff6ff", color: "#1d4ed8", borderRadius: 999, padding: "2px 7px", fontSize: 10, fontWeight: 800 }}>
            {thread.inbound_count} in
          </span>
          <span style={{ border: "1px solid #dcfce7", background: "#f0fdf4", color: "#166534", borderRadius: 999, padding: "2px 7px", fontSize: 10, fontWeight: 800 }}>
            {thread.outbound_count} out
          </span>
        </div>
      </div>
    );
  }

  function renderUnlinkedRow(item) {
    const subject = String(item.subject || "").trim() || "(No subject)";
    const sender = String(item.sender || item.from || "").trim() || "(Unknown sender)";
    const preview = String(item.preview || item.preview_text || "").trim() || "(No preview available)";
    const emailId = getInboxItemId(item);
    const isSelected = emailId && selectedEmailId === emailId && !selectedThreadId;
    const isChecked = emailId && checkedEmailIds.has(emailId);
    const orderScore = Number(item.order_score || 0);
    const isFlaggedOrder = item.order_flagged === true;
    const cardTint = isFlaggedOrder ? "#f0fdf4" : orderScore > 70 ? "#f7fee7" : orderScore >= 40 ? "#fbfdf2" : "#fff";
    const borderColor = isFlaggedOrder ? "#86efac" : orderScore > 70 ? "#bef264" : orderScore >= 40 ? "#e2e8a8" : "#e5e7eb";
    return (
      <div
        key={emailId}
        role="button"
        tabIndex={0}
        onClick={() => {
          selectInboxItem(item);
          setSelectedThreadId("");
        }}
        onDoubleClick={() => openInboxItem(item)}
        onContextMenu={(event) => openInboxContextMenu(event, item)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            selectInboxItem(item);
            setSelectedThreadId("");
          }
        }}
        title={item.name}
        style={{
          width: "100%",
          textAlign: "left",
          border: `1px solid ${isSelected ? "#93c5fd" : borderColor}`,
          borderLeft: orderScore >= 40 || isFlaggedOrder ? `4px solid ${borderColor}` : `1px solid ${borderColor}`,
          background: isSelected ? "#eff6ff" : cardTint,
          borderRadius: 12,
          padding: 14,
          marginBottom: 10,
          cursor: "pointer",
          boxSizing: "border-box",
        }}
      >
        <div className="email-card" style={{ display: "grid", gridTemplateColumns: "22px 1fr", gap: 10, alignItems: "start" }}>
          <input
            type="checkbox"
            checked={!!isChecked}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => toggleCheckedInboxItem(item, event.target.checked)}
            aria-label={`Select ${subject}`}
            style={{ marginTop: 2 }}
          />
          <div style={{ minWidth: 0 }}>
            <div className="subject" style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {subject}
              {isFlaggedOrder ? (
                <span style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 4, color: "#166534", fontSize: 10, fontWeight: 800, verticalAlign: "middle", cursor: "default" }}>
                  <span style={{ fontSize: 9 }}>●</span> Order Created
                </span>
              ) : orderScore > 70 ? (
                <span title={`Suggested order score: ${orderScore}`} style={{ marginLeft: 8, color: "#84cc16", fontSize: 11 }}>●</span>
              ) : orderScore >= 40 ? (
                <span title={`Suggested order score: ${orderScore}`} style={{ marginLeft: 8, color: "#a3e635", fontSize: 11 }}>●</span>
              ) : null}
            </div>
            <div className="meta" style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "#64748b" }}>
              <span className="sender" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sender}</span>
              <span className="time" style={{ flexShrink: 0, color: "#94a3b8" }}>{formatTimestamp(item.timestamp)}</span>
            </div>
            <div className="preview" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.4, color: "#94a3b8", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {preview}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderSentRow(item) {
    const subject = String(item.subject || "").trim() || "(No subject)";
    const recipient = String(item.to || "").trim() || "(Unknown recipient)";
    const preview = String(item.preview || item.preview_text || item.body || "").trim() || "(No preview available)";
    const sentId = getMessageId(item);
    const isSelected = sentId && selectedSentId === sentId;
    return (
      <div
        key={sentId}
        role="button"
        tabIndex={0}
        onClick={() => {
          setSelectedSentId(sentId);
          setSelectedEmailId("");
          setSelectedThreadId("");
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSelectedSentId(sentId);
            setSelectedEmailId("");
            setSelectedThreadId("");
          }
        }}
        title={subject}
        style={{
          width: "100%",
          textAlign: "left",
          border: `1px solid ${isSelected ? "#86efac" : "#e5e7eb"}`,
          borderLeft: `4px solid ${isSelected ? "#22c55e" : "#dcfce7"}`,
          background: isSelected ? "#f0fdf4" : "#fff",
          borderRadius: 12,
          padding: 14,
          marginBottom: 10,
          cursor: "pointer",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ minWidth: 0, fontSize: 13, fontWeight: 750, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {subject}
          </div>
          <span style={{ flexShrink: 0, border: "1px solid #dcfce7", background: "#f0fdf4", color: "#166534", borderRadius: 999, padding: "2px 7px", fontSize: 10, fontWeight: 800 }}>
            Sent
          </span>
        </div>
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "#64748b" }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>To: {recipient}</span>
          <span style={{ flexShrink: 0, color: "#94a3b8" }}>{formatTimestamp(item.timestamp)}</span>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.4, color: "#94a3b8", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {preview}
        </div>
      </div>
    );
  }

  function renderThreadListContent() {
    return (
      <div>
        <div style={{ fontSize: 11, fontWeight: 900, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", margin: "0 0 10px" }}>
          Order Threads
        </div>
        {threadItems.length ? threadItems.map(renderThreadRow) : (
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13, marginBottom: 18 }}>
            No linked order threads yet.
          </div>
        )}
        <div style={{ fontSize: 11, fontWeight: 900, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", margin: "18px 0 10px" }}>
          Unlinked Emails
        </div>
        {unlinkedMessages.length ? unlinkedMessages.map(renderUnlinkedRow) : (
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13 }}>
            No unlinked emails.
          </div>
        )}
      </div>
    );
  }

  function renderModeToggle() {
    const toggleButtonStyle = (active) => ({
      border: "none",
      borderBottom: `2px solid ${active ? "#2563eb" : "transparent"}`,
      background: "transparent",
      color: active ? "#1d4ed8" : "#64748b",
      padding: "7px 4px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: active ? 850 : 650,
    });
    return (
      <div className="mode-toggle" style={{ display: "inline-flex", alignItems: "center", gap: 14, marginTop: 12 }}>
        <button
          type="button"
          className={mode === "inbox" ? "active" : ""}
          onClick={() => {
            setMode("inbox");
            setSelectedSentId("");
            setSelectedThreadId("");
          }}
          style={toggleButtonStyle(mode === "inbox")}
        >
          Inbox
        </button>
        <span style={{ color: "#cbd5e1", fontSize: 13 }}>|</span>
        <button
          type="button"
          className={mode === "sent" ? "active" : ""}
          onClick={() => {
            setMode("sent");
            setSelectedEmailId("");
            setCheckedEmailIds(new Set());
            setSelectedThreadId("");
          }}
          style={toggleButtonStyle(mode === "sent")}
        >
          Sent
        </button>
      </div>
    );
  }

  function renderMailboxListContent() {
    if (mode === "sent") {
      return sentItems.length ? sentItems.map(renderSentRow) : (
        <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13 }}>
          No sent emails yet.
        </div>
      );
    }
    return inboxModeItems.length ? inboxModeItems.map(renderUnlinkedRow) : (
      <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13 }}>
        No inbox emails.
      </div>
    );
  }

  function renderTimelineMessage(message) {
    const isOutbound = message.direction === "outbound";
    const orderLinkState = buildOrderLinkState(message, ordersForLinking);
    const attachments = getEmailAttachments(message);
    return (
      <div key={message.id} style={{ display: "flex", justifyContent: isOutbound ? "flex-end" : "flex-start", marginBottom: 18 }}>
        <div style={{
          maxWidth: "78%",
          border: `1px solid ${isOutbound ? "#bbf7d0" : "#dbeafe"}`,
          background: isOutbound ? "#f0fdf4" : "#ffffff",
          borderRadius: isOutbound ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
          padding: "14px 16px",
          boxShadow: "0 8px 20px rgba(15, 23, 42, 0.05)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: isOutbound ? "#166534" : "#1d4ed8" }}>
              {isOutbound ? "Outbound" : "Inbound"}
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap" }}>{formatTimestamp(message.timestamp)}</div>
          </div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", marginBottom: 4, overflowWrap: "anywhere" }}>
            {message.subject || "(No subject)"}
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
            {isOutbound ? `To: ${message.to || "(Unknown recipient)"}` : `From: ${message.sender || message.from || "(Unknown sender)"}`}
          </div>
          {previewMode === "original" && message.preview_html ? (
            <div style={{ color: "#334155", fontSize: 14, lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: message.preview_html }} />
          ) : (
            <div style={{ color: "#1f2937", fontSize: 14, lineHeight: 1.65 }}>
              {renderReadableMessageBody(message.preview_text || message.body || message.preview || "(No preview available)", orderLinkState, handleOpenLinkedOrder)}
            </div>
          )}
          {attachments.length ? (
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
              {attachments.map((attachment, index) => (
                <span key={`${message.id}-${attachment}-${index}`} style={{ display: "inline-flex", alignItems: "center", border: "1px solid #e2e8f0", background: "#fff", color: "#475569", borderRadius: 999, padding: "4px 9px", fontSize: 11, fontWeight: 700 }}>
                  {String(attachment).split(/[/\\]/).pop()}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#f5f7fb", fontFamily: "'Segoe UI', sans-serif" }}>
      <AppHeader
        onSettings={onSettings}
        onWorkspace={onWorkspace}
        onSelectTab={onOrders}
        activeCount={activeCount}
        completedCount={completedCount}
        selectedNav="workspace"
        rightContent={
          <>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={handleRefreshInbox}
                disabled={!canFetchInbox || refreshingInbox}
                title={canFetchInbox ? "Refresh inbox now" : "Email connection unavailable. Cannot refresh inbox."}
                aria-label="Refresh inbox"
                style={{
                  width: 34,
                  height: 34,
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  color: "#0f172a",
                  borderRadius: 999,
                  cursor: canFetchInbox && !refreshingInbox ? "pointer" : "not-allowed",
                  fontSize: 15,
                  fontWeight: 800,
                  opacity: canFetchInbox ? (refreshingInbox ? 0.7 : 1) : 0.5,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {refreshingInbox ? "…" : "🔄"}
              </button>
              <span style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap" }}>
                {refreshingInbox ? "Updating..." : lastUpdatedLabel}
              </span>
            </div>
            <div
              title={canDeleteFromAccount ? "Email account is reachable" : "Email connection unavailable. Cannot delete from account."}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid #e5e7eb",
                background: "#fff",
                color: canDeleteFromAccount ? "#166534" : "#64748b",
                borderRadius: 999,
                padding: "6px 10px",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              <span style={{ color: canDeleteFromAccount ? "#16a34a" : "#ef4444", fontSize: 13 }}>●</span>
              {imapChecking ? "Checking..." : canDeleteFromAccount ? "Connected" : "Offline"}
            </div>
          </>
        }
      />

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "380px 1fr", gap: 18, padding: 18, minHeight: 0 }}>
        <section style={{ ...panelStyle, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>Mail</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
              Select an inbox or sent email to preview.
            </div>
            {renderModeToggle()}
          </div>

          {dropMessage && (
            <div style={{ margin: "0 16px 10px", fontSize: 12, color: "#1d4ed8" }}>{dropMessage}</div>
          )}
          {error && (
            <div style={{ margin: "0 16px 10px", fontSize: 12, color: "#b91c1c" }}>{error}</div>
          )}

          {checkedInboxItems.length > 0 ? (
            <div style={{
              margin: "0 16px 12px",
              border: "1px solid #dbeafe",
              background: "#eff6ff",
              borderRadius: 12,
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1e3a8a" }}>
                {checkedInboxItems.length} selected
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" onClick={handleBulkProcess} style={{ border: "1px solid #bfdbfe", background: "#fff", color: "#0f172a", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                  Process
                </button>
                <button type="button" onClick={handleBulkRemove} style={{ border: "1px solid #bfdbfe", background: "#fff", color: "#475569", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                  Remove
                </button>
                <button
                  type="button"
                  onClick={handleBulkDelete}
                  disabled={!canDeleteFromAccount}
                  title={canDeleteFromAccount ? "Delete selected emails from account" : "Email connection unavailable. Cannot delete from account."}
                  style={{
                    border: "1px solid #fecaca",
                    background: "#fff",
                    color: canDeleteFromAccount ? "#991b1b" : "#94a3b8",
                    borderRadius: 8,
                    padding: "6px 10px",
                    cursor: canDeleteFromAccount ? "pointer" : "not-allowed",
                    opacity: canDeleteFromAccount ? 1 : 0.5,
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : null}

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 16px 16px" }}>
            {loading && !workspaceState ? (
              <div style={{ fontSize: 13, color: "#64748b" }}>Loading workspace…</div>
            ) : showInboxEmptyState ? (
              <div style={{ minHeight: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 8px" }}>
                <div style={{
                  width: "100%",
                  maxWidth: 420,
                  border: "1px solid #e5e7eb",
                  background: "#fff",
                  borderRadius: 18,
                  padding: "28px 24px",
                  boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)",
                  textAlign: "center",
                }}>
                  <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 12 }}>📥</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: "#0f172a" }}>No emails yet</div>
                  <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.55, color: "#64748b", whiteSpace: "pre-line" }}>
                    {"Connect your email to automatically import orders,\nor use .eml files to get started."}
                  </div>
                  <div style={{ display: "grid", gap: 10, marginTop: 18 }}>
                    <button
                      type="button"
                      onClick={() => onSettings?.("emails")}
                      style={{
                        border: "none",
                        background: "#2563eb",
                        color: "#fff",
                        borderRadius: 12,
                        padding: "10px 14px",
                        cursor: "pointer",
                        fontSize: 14,
                        fontWeight: 700,
                      }}
                    >
                      Connect Email
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowEmlInstructions((current) => !current)}
                      style={{
                        border: "1px solid #cbd5e1",
                        background: "#fff",
                        color: "#0f172a",
                        borderRadius: 12,
                        padding: "10px 14px",
                        cursor: "pointer",
                        fontSize: 14,
                        fontWeight: 700,
                      }}
                    >
                      Use .eml Files Instead
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenInboxFolder}
                      style={{
                        border: "1px solid #cbd5e1",
                        background: "#f8fafc",
                        color: "#0f172a",
                        borderRadius: 12,
                        padding: "10px 14px",
                        cursor: "pointer",
                        fontSize: 14,
                        fontWeight: 700,
                      }}
                    >
                      Open Inbox Folder
                    </button>
                    {imapConfigured && (
                      <button
                        type="button"
                        onClick={handleRefreshInbox}
                        disabled={!canFetchInbox || refreshingInbox}
                        title={canFetchInbox ? "Refresh inbox now" : "Email connection unavailable. Cannot refresh inbox."}
                        style={{
                          border: "1px solid #cbd5e1",
                          background: "#fff",
                          color: "#475569",
                          borderRadius: 12,
                          padding: "10px 14px",
                          cursor: canFetchInbox && !refreshingInbox ? "pointer" : "not-allowed",
                          fontSize: 13,
                          fontWeight: 700,
                          opacity: canFetchInbox ? (refreshingInbox ? 0.7 : 1) : 0.5,
                        }}
                      >
                        {refreshingInbox ? "Updating..." : "🔄 Refresh now"}
                      </button>
                    )}
                  </div>
                  {showEmlInstructions && (
                    <div style={{
                      marginTop: 16,
                      border: "1px solid #dbeafe",
                      background: "#eff6ff",
                      color: "#1e3a8a",
                      borderRadius: 12,
                      padding: "14px 16px",
                      textAlign: "left",
                    }}>
                      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                        Save <code style={{ background: "#dbeafe", padding: "1px 5px", borderRadius: 4 }}>.eml</code> files to:
                      </div>
                      <div style={{ marginTop: 8, fontSize: 13, fontWeight: 700, wordBreak: "break-all" }}>
                        {displayInboxPath}
                      </div>
                      <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.6 }}>
                        Then return here to process them.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : renderMailboxListContent()}
          </div>
        </section>

        <section
          onContextMenu={openPreviewContextMenu}
          style={{ ...panelStyle, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          {!selectedMailboxItem && !selectedThread ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 28, color: "#64748b", fontSize: 16, fontWeight: 700 }}>
              Select an email to preview
            </div>
          ) : selectedThread ? (
            <>
              <div style={{ padding: "14px 18px 18px", borderBottom: "1px solid #e5e7eb", background: "#ffffff" }}>
                <div className="preview-header" style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                    Order Conversation
                  </div>
                  <div style={{ fontSize: 25, lineHeight: 1.3, fontWeight: 650, color: "#0f172a", overflowWrap: "anywhere", maxWidth: 920 }}>
                    Order #{selectedThread.order_number}
                  </div>
                  <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 14, color: "#6b7280" }}>
                    <span>{selectedThread.buyer_name || selectedThread.buyer_email || "Customer"}</span>
                    <span>•</span>
                    <span>{selectedThreadMessages.length} message{selectedThreadMessages.length === 1 ? "" : "s"}</span>
                    <span>•</span>
                    <span>{formatTimestamp(selectedThread.last_message_timestamp)}</span>
                  </div>
                </div>
              </div>
              <div style={{ borderBottom: "1px solid #f1f5f9", padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", background: "#fff" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ border: "1px solid #dbeafe", background: "#eff6ff", color: "#1d4ed8", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 800 }}>
                    {selectedThread.inbound_count} inbound
                  </span>
                  <span style={{ border: "1px solid #dcfce7", background: "#f0fdf4", color: "#166534", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 800 }}>
                    {selectedThread.outbound_count} outbound
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" onClick={() => setPreviewMode("clean")} style={{ border: `1px solid ${previewMode === "clean" ? "#93c5fd" : "#e5e7eb"}`, background: previewMode === "clean" ? "#eff6ff" : "#fff", color: "#0f172a", borderRadius: 999, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 800 }}>
                    Clean View
                  </button>
                  <button type="button" onClick={() => setPreviewMode("original")} disabled={!selectedThreadMessages.some((message) => message.preview_html)} style={{ border: `1px solid ${previewMode === "original" ? "#93c5fd" : "#e5e7eb"}`, background: previewMode === "original" ? "#eff6ff" : "#fff", color: selectedThreadMessages.some((message) => message.preview_html) ? "#0f172a" : "#94a3b8", borderRadius: 999, padding: "5px 10px", cursor: selectedThreadMessages.some((message) => message.preview_html) ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 800 }}>
                    Original Email
                  </button>
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "24px 28px", background: "#ffffff" }}>
                {selectedThreadMessages.map(renderTimelineMessage)}
              </div>
            </>
          ) : (
            <>
              <div style={{ padding: "14px 18px 18px", borderBottom: "1px solid #e5e7eb", background: "#ffffff" }}>
                <div
                  className="preview-action-bar"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  {mode === "inbox" ? (
                    <>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => openInboxItem(selectedInboxItem)} style={{ border: "1px solid #dbeafe", background: "#fff", color: "#0f172a", borderRadius: 7, padding: "5px 8px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                          Process Order
                        </button>
                        <button type="button" onClick={() => handleViewInboxItem(selectedInboxItem)} style={{ border: "1px solid #e5e7eb", background: "#fff", color: "#0f172a", borderRadius: 7, padding: "5px 8px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                          View Email
                        </button>
                        <button
                          type="button"
                          disabled={!selectedInboxItem.reply_to}
                          title={selectedInboxItem.reply_to ? `Reply to ${selectedInboxItem.reply_to}` : "No reply email address found"}
                          onClick={() => handleReplyInEmail(selectedInboxItem)}
                          style={{
                            border: "1px solid #dbeafe",
                            background: "#fff",
                            color: selectedInboxItem.reply_to ? "#1d4ed8" : "#94a3b8",
                            borderRadius: 7,
                            padding: "5px 8px",
                            cursor: selectedInboxItem.reply_to ? "pointer" : "not-allowed",
                            opacity: selectedInboxItem.reply_to ? 1 : 0.55,
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          Reply in Email
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <button type="button" onClick={() => handleRemoveInboxItem(selectedInboxItem)} style={{ border: "1px solid #e5e7eb", background: "#fff", color: "#475569", borderRadius: 7, padding: "5px 8px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                          Remove from Spaila
                        </button>
                        <button
                          type="button"
                          disabled={!canDeleteFromAccount}
                          title={canDeleteFromAccount ? "Delete from email account" : "Email connection unavailable. Cannot delete from account."}
                          onClick={() => handleDeleteInboxItem(selectedInboxItem)}
                          style={{
                            border: "1px solid #fecaca",
                            background: "#fff",
                            color: canDeleteFromAccount ? "#991b1b" : "#94a3b8",
                            borderRadius: 7,
                            padding: "5px 8px",
                            cursor: canDeleteFromAccount ? "pointer" : "not-allowed",
                            opacity: canDeleteFromAccount ? 1 : 0.5,
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          Delete from all
                        </button>
                        {!selectedInboxItem.order_flagged ? (
                          <button type="button" onClick={() => handleMarkInboxOrder(selectedInboxItem)} style={{ border: "1px solid #bbf7d0", background: "#fff", color: "#166534", borderRadius: 7, padding: "5px 8px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                            Mark as Order
                          </button>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: 12, fontWeight: 800, color: "#166534" }}>Sent Email</div>
                  )}
                </div>
                <div className="preview-header" style={{ marginTop: 16, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                    Conversation
                  </div>
                  <div style={{ fontSize: 25, lineHeight: 1.3, fontWeight: 600, color: "#0f172a", overflowWrap: "anywhere", maxWidth: 920 }}>
                    {renderSubjectWithOrderLinks(selectedMailboxItem.subject || "(No subject)", ordersForLinking, handleOpenLinkedOrder)}
                  </div>
                  <div style={{ marginTop: 5, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 14, color: "#6b7280" }}>
                    <span>{mode === "sent" ? `To: ${selectedMailboxItem.to || "(Unknown recipient)"}` : selectedMailboxItem.sender || "(Unknown sender)"} • {formatTimestamp(selectedMailboxItem.timestamp)}</span>
                    {mode === "inbox" && selectedMailboxItem.order_flagged ? (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          color: "#166534",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "default",
                        }}
                      >
                        <span style={{ fontSize: 10 }}>●</span>
                        Order Created
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div style={{ borderBottom: "1px solid #f1f5f9", padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", background: "#fff" }}>
                {selectedMessageClassification ? (
                  <div
                    title={selectedMessageClassification.detail}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      border: `1px solid ${selectedMessageClassification.border}`,
                      background: selectedMessageClassification.bg,
                      color: selectedMessageClassification.color,
                      borderRadius: 999,
                      padding: "5px 10px",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "default",
                    }}
                  >
                    <span style={{ fontSize: 10 }}>●</span>
                    {selectedMessageClassification.label}
                  </div>
                ) : (
                  <div />
                )}
                <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setPreviewMode("clean")}
                  style={{
                    border: `1px solid ${previewMode === "clean" ? "#93c5fd" : "#e5e7eb"}`,
                    background: previewMode === "clean" ? "#eff6ff" : "#fff",
                    color: "#0f172a",
                    borderRadius: 999,
                    padding: "5px 10px",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 800,
                  }}
                >
                  Clean View
                </button>
                <button
                  type="button"
                  disabled={!selectedMailboxItem.preview_html}
                  title={selectedMailboxItem.preview_html ? "Show sanitized original email" : "Original email view is not available"}
                  onClick={() => setPreviewMode("original")}
                  style={{
                    border: `1px solid ${previewMode === "original" ? "#93c5fd" : "#e5e7eb"}`,
                    background: previewMode === "original" ? "#eff6ff" : "#fff",
                    color: selectedMailboxItem.preview_html ? "#0f172a" : "#94a3b8",
                    borderRadius: 999,
                    padding: "5px 10px",
                    cursor: selectedMailboxItem.preview_html ? "pointer" : "not-allowed",
                    fontSize: 12,
                    fontWeight: 800,
                  }}
                >
                  Original Email
                </button>
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "24px 28px", background: "#ffffff" }}>
                {previewMode === "original" && selectedMailboxItem.preview_html ? (
                  <div
                    style={{ maxWidth: 860, color: "#334155", fontSize: 14, lineHeight: 1.6 }}
                    dangerouslySetInnerHTML={{ __html: selectedMailboxItem.preview_html }}
                  />
                ) : (
                  <div style={{ maxWidth: 860 }}>
                    {renderReadableMessageBody(
                      selectedMailboxItem.preview_text || selectedMailboxItem.body || selectedMailboxItem.preview || "(No preview available)",
                      selectedOrderLinkState,
                      handleOpenLinkedOrder
                    )}
                  </div>
                )}
              </div>
              {selectedEmailAttachments.length ? (
                <div style={{ borderTop: "1px solid #f1f5f9", padding: "12px 18px", background: "#f8fafc" }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Attachments
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {selectedEmailAttachments.map((attachment, index) => (
                      <span
                        key={`${attachment}-${index}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          border: "1px solid #e2e8f0",
                          background: "#fff",
                          color: "#475569",
                          borderRadius: 999,
                          padding: "5px 10px",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {String(attachment).split(/[/\\]/).pop()}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
      {inboxContextMenu && inboxContextMenuItem ? (
        <div
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: "fixed",
            left: inboxContextMenu.x,
            top: inboxContextMenu.y,
            zIndex: 9999,
            minWidth: 190,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            boxShadow: "0 14px 34px rgba(15, 23, 42, 0.18)",
            overflow: "hidden",
            padding: "5px 0",
          }}
        >
          <PreviewMenuItem onClick={() => runInboxContextAction(() => openInboxItem(inboxContextMenuItem))}>
            Process Order
          </PreviewMenuItem>
          <PreviewMenuItem onClick={() => runInboxContextAction(() => handleViewInboxItem(inboxContextMenuItem))}>
            View Email
          </PreviewMenuItem>
          <PreviewMenuItem
            disabled={!inboxContextMenuItem.reply_to}
            onClick={() => {
              if (inboxContextMenuItem.reply_to) {
                runInboxContextAction(() => handleReplyInEmail(inboxContextMenuItem));
              }
            }}
          >
            Reply in Email
          </PreviewMenuItem>
          <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0" }} />
          <PreviewMenuItem onClick={() => runInboxContextAction(() => handleRemoveInboxItem(inboxContextMenuItem))}>
            Remove from Spaila
          </PreviewMenuItem>
          <PreviewMenuItem
            danger
            disabled={!canDeleteFromAccount}
            onClick={() => {
              if (canDeleteFromAccount) {
                runInboxContextAction(() => handleDeleteInboxItem(inboxContextMenuItem));
              }
            }}
          >
            Delete from all
          </PreviewMenuItem>
          {inboxContextMenuItem.order_flagged !== true ? (
            <>
              <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0" }} />
              <PreviewMenuItem onClick={() => runInboxContextAction(() => handleMarkInboxOrder(inboxContextMenuItem))}>
                Mark as Order
              </PreviewMenuItem>
              {inboxContextMenuItem.order_not_order !== true ? (
                <PreviewMenuItem onClick={() => runInboxContextAction(() => handleMarkInboxNotOrder(inboxContextMenuItem))}>
                  Mark as Not Order
                </PreviewMenuItem>
              ) : null}
            </>
          ) : null}
          {inboxContextMenuItem.order_flagged === true || inboxContextMenuItem.order_not_order === true ? (
            <>
              <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0" }} />
              <PreviewMenuItem onClick={() => runInboxContextAction(() => handleUndoInboxOrderMark(inboxContextMenuItem))}>
                Undo Order
              </PreviewMenuItem>
            </>
          ) : null}
          {inboxContextOrderLinkState.linkedOrder ? (
            <>
              <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0" }} />
              <PreviewMenuItem onClick={() => runInboxContextAction(() => handleOpenLinkedOrder(inboxContextOrderLinkState.linkedOrder))}>
                Open Order
              </PreviewMenuItem>
            </>
          ) : null}
        </div>
      ) : null}
      {previewContextMenu && selectedInboxItem ? (
        <div
          role="menu"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: "fixed",
            left: previewContextMenu.x,
            top: previewContextMenu.y,
            zIndex: 1300,
            minWidth: 190,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            boxShadow: "0 14px 34px rgba(15, 23, 42, 0.18)",
            overflow: "hidden",
            padding: "5px 0",
          }}
        >
          <PreviewMenuItem onClick={() => runPreviewContextAction(() => openInboxItem(selectedInboxItem))}>
            Process Order
          </PreviewMenuItem>
          <PreviewMenuItem onClick={() => runPreviewContextAction(() => handleViewInboxItem(selectedInboxItem))}>
            View Email
          </PreviewMenuItem>
          <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0" }} />
          <PreviewMenuItem onClick={() => runPreviewContextAction(() => handleRemoveInboxItem(selectedInboxItem))}>
            Remove from Spaila
          </PreviewMenuItem>
          <PreviewMenuItem
            danger
            disabled={!canDeleteFromAccount}
            onClick={() => {
              if (canDeleteFromAccount) {
                runPreviewContextAction(() => handleDeleteInboxItem(selectedInboxItem));
              }
            }}
          >
            Delete from all
          </PreviewMenuItem>
          {selectedInboxItem.order_flagged !== true ? (
            <>
              <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0" }} />
              <PreviewMenuItem onClick={() => runPreviewContextAction(() => handleMarkInboxOrder(selectedInboxItem))}>
                Mark as Order
              </PreviewMenuItem>
              {selectedInboxItem.order_not_order !== true ? (
                <PreviewMenuItem onClick={() => runPreviewContextAction(() => handleMarkInboxNotOrder(selectedInboxItem))}>
                  Mark as Not Order
                </PreviewMenuItem>
              ) : null}
            </>
          ) : null}
          {selectedInboxItem.order_flagged === true || selectedInboxItem.order_not_order === true ? (
            <>
              <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0" }} />
              <PreviewMenuItem onClick={() => runPreviewContextAction(() => handleUndoInboxOrderMark(selectedInboxItem))}>
                Undo Order
              </PreviewMenuItem>
            </>
          ) : null}
          {selectedOrderLinkState.linkedOrder ? (
            <>
              <div style={{ height: 1, background: "#f1f5f9", margin: "4px 0" }} />
              <PreviewMenuItem onClick={() => runPreviewContextAction(() => handleOpenLinkedOrder(selectedOrderLinkState.linkedOrder))}>
                Open Order
              </PreviewMenuItem>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
