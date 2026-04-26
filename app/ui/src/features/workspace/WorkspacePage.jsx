import React from "react";
import AppHeader from "../../shared/components/AppHeader.jsx";
import { loadShopConfig } from "../../shared/utils/fieldConfig.js";

const panelStyle = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
};
const ORDER_NUMBER_PATTERN = /\b\d{6,12}\b/g;
const WORKSPACE_SELECTED_EMAIL_ID_KEY = "workspace_selected_email_id";
const WORKSPACE_SELECTED_THREAD_ID_KEY = "workspace_selected_thread_id";
const WORKSPACE_SELECTED_SENT_ID_KEY = "workspace_selected_sent_id";
const WORKSPACE_SCROLL_Y_KEY = "workspace_scroll_y";

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

function getFilenameFromPath(filePath) {
  const value = String(filePath || "").trim();
  if (!value) return "";
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

function setLocalStorageValue(key, value) {
  try {
    if (value === null || value === undefined || value === "") {
      window.localStorage?.removeItem(key);
    } else {
      window.localStorage?.setItem(key, String(value));
    }
  } catch (_error) {
    // Best-effort persistence for UX continuity.
  }
}

function getLocalStorageValue(key) {
  try {
    return String(window.localStorage?.getItem(key) || "").trim();
  } catch (_error) {
    return "";
  }
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

/** Extract the bare IMAP UID from a {timestamp}_{uid}.eml filename or path. */
function extractEmlUid(filePath) {
  const name = String(filePath || "").replace(/\\/g, "/").split("/").pop();
  const m = name.match(/^\d+_([A-Za-z0-9]+)\.eml$/i);
  return m ? m[1].toLowerCase() : "";
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
    for (const value of [order?.source_eml_path, order?.eml_path]) {
      for (const ref of getProcessedEmailRefVariants(value)) {
        refs.add(ref);
      }
      const uid = extractEmlUid(value);
      if (uid) refs.add(uid);
    }
    const messages = Array.isArray(order?.messages) ? order.messages : [];
    for (const msg of messages) {
      const dir = String(msg?.type || msg?.direction || "").toLowerCase();
      if (dir !== "inbound") continue;
      for (const value of [msg?.email_id, msg?.message_id, msg?.id]) {
        for (const ref of getProcessedEmailRefVariants(value)) {
          refs.add(ref);
        }
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

async function persistOrderMessage(orderId, message) {
  const response = await fetch(`http://127.0.0.1:8055/orders/${encodeURIComponent(orderId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.error || "Could not save reply to order.");
  }
  return payload?.message || message;
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

function normalizePersistedOrderMessage(message, order) {
  const timestamp = message?.timestamp || "";
  const id = String(message?.id || `order-message:${order?.order_id || order?.id || order?.order_number}:${timestamp}:${String(message?.body || "").slice(0, 24)}`);
  return {
    ...message,
    id,
    message_id: id,
    direction: message?.direction || message?.type || "outbound",
    type: message?.type || message?.direction || "outbound",
    order_number: normalizeOrderNumber(order?.order_number),
    buyer_name: order?.buyer_name || "",
    buyer_email: order?.buyer_email || "",
    body: message?.body || "",
    preview_text: message?.body || "",
    preview: buildThreadPreview(message?.body || ""),
    timestamp,
    received_at: timestamp,
    source_item: message,
  };
}

function normalizeSelectedMailboxMessage(item, linkedOrder, mode) {
  const id = mode === "sent" ? getMessageId(item) : getInboxItemId(item);
  const timestamp = item?.timestamp || item?.received_at || "";
  const direction = mode === "sent" ? "outbound" : "inbound";
  return {
    ...item,
    id,
    message_id: String(item?.message_id || item?.email_id || id),
    direction,
    type: direction,
    order_number: normalizeOrderNumber(linkedOrder?.order_number),
    buyer_name: linkedOrder?.buyer_name || "",
    buyer_email: linkedOrder?.buyer_email || "",
    from: item?.sender || item?.from || "",
    to: item?.to || "",
    body: item?.preview_text || item?.body || item?.preview || "",
    preview_text: item?.preview_text || item?.body || item?.preview || "",
    preview: item?.preview || buildThreadPreview(item?.preview_text || item?.body || ""),
    timestamp,
    received_at: timestamp,
    source_item: item,
    source_eml_path: item?.source_eml_path || item?.path || "",
  };
}

function normalizeSelectedOrderSentMessage(item, linkedOrder) {
  const messageId = getMessageId(item);
  return {
    ...item,
    id: messageId,
    message_id: String(item?.message_id || messageId),
    status: "sent",
    direction: "outbound",
    type: "outbound",
    order_number: normalizeOrderNumber(linkedOrder?.order_number),
    buyer_name: linkedOrder?.buyer_name || item?.buyer_name || "",
    buyer_email: linkedOrder?.buyer_email || item?.buyer_email || "",
    from: item?.from || "Spaila",
    to: item?.to || linkedOrder?.buyer_email || "",
    body: item?.body || item?.preview_text || "",
    preview_text: item?.preview_text || item?.body || item?.preview || "",
    preview: item?.preview || buildThreadPreview(item?.preview_text || item?.body || ""),
    timestamp: item?.timestamp || item?.received_at || "",
    received_at: item?.received_at || item?.timestamp || "",
    attachments: item?.attachments || [],
    source_item: item,
  };
}

function dedupeMessages(messages = []) {
  const seen = new Set();
  return messages.filter((message) => {
    const key = String(message?.id || message?.message_id || `${message?.timestamp || ""}:${message?.body || ""}`).trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseMessageTimeMs(message) {
  const raw = message?.timestamp || message?.received_at || "";
  const ms = Date.parse(String(raw || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeMessageBodyForMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeRecipientForMatch(value) {
  return String(value || "").trim().toLowerCase();
}

function isTemporaryMessage(message) {
  const id = String(message?.id || "").trim();
  return id.startsWith("temp_");
}

function areLikelySameOutboundMessage(a, b) {
  if ((a?.direction || a?.type) !== "outbound" || (b?.direction || b?.type) !== "outbound") return false;
  const bodyA = normalizeMessageBodyForMatch(a?.body || a?.preview_text || a?.preview);
  const bodyB = normalizeMessageBodyForMatch(b?.body || b?.preview_text || b?.preview);
  if (!bodyA || !bodyB || bodyA !== bodyB) return false;
  const toA = normalizeRecipientForMatch(a?.to || a?.buyer_email);
  const toB = normalizeRecipientForMatch(b?.to || b?.buyer_email);
  if (toA && toB && toA !== toB) return false;
  const timeA = parseMessageTimeMs(a);
  const timeB = parseMessageTimeMs(b);
  if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && Math.abs(timeA - timeB) > 10000) return false;
  return true;
}

function messageConfidenceScore(message) {
  let score = 0;
  if (!isTemporaryMessage(message)) score += 3;
  if (String(message?.status || "").toLowerCase() === "sent") score += 2;
  if (String(message?.message_id || "").trim()) score += 1;
  if (String(message?.body || message?.preview_text || "").trim()) score += 1;
  if (Array.isArray(message?.attachments) && message.attachments.length) score += 1;
  return score;
}

function mergeMessageRecord(existing, incoming) {
  const keepIncoming = messageConfidenceScore(incoming) >= messageConfidenceScore(existing);
  return keepIncoming ? { ...existing, ...incoming } : { ...incoming, ...existing };
}

function dedupeConversationMessages(messages = []) {
  const merged = [];
  for (const candidate of messages) {
    const candidateId = String(candidate?.id || candidate?.message_id || "").trim();
    const index = merged.findIndex((existing) => {
      const existingId = String(existing?.id || existing?.message_id || "").trim();
      if (candidateId && existingId && candidateId === existingId) return true;
      return areLikelySameOutboundMessage(existing, candidate);
    });
    if (index === -1) {
      merged.push(candidate);
      continue;
    }
    merged[index] = mergeMessageRecord(merged[index], candidate);
  }
  return merged;
}

function getMailboxParticipantAddress(item, mode) {
  if (mode === "sent") {
    return String(item?.to || item?.buyer_email || "").trim().toLowerCase();
  }
  return String(item?.reply_to || item?.sender || item?.from || item?.buyer_email || "").trim().toLowerCase();
}

function getPersistedOrderMessages(orders = []) {
  const seenOrders = new Set();
  const messages = [];
  for (const order of orders || []) {
    const orderId = String(order?.order_id || order?.id || order?.order_number || "").trim();
    if (!orderId || seenOrders.has(orderId)) continue;
    seenOrders.add(orderId);
    for (const message of Array.isArray(order?.messages) ? order.messages : []) {
      messages.push(normalizePersistedOrderMessage(message, order));
    }
  }
  return messages;
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
  const messages = dedupeMessages([
    ...(inboxItems || []).map((item) => normalizeInboundMessage(item, orderMetadata)),
    ...(sentMessages || []).map((item) => normalizeOutboundMessage(item, orderMetadata)),
    ...getPersistedOrderMessages(orders),
  ]);

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

function normalizeConversationSubject(subject) {
  return String(subject || "")
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

function extractEmailAddress(value) {
  const source = String(value || "").trim();
  const bracketMatch = source.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracketMatch?.[1]) return bracketMatch[1].trim();
  const emailMatch = source.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return (emailMatch?.[0] || source).trim();
}

function getEmailDomain(value) {
  const email = extractEmailAddress(value).toLowerCase();
  return email.includes("@") ? email.split("@").pop() : "";
}

function getReplyTarget({ selectedThread, selectedThreadMessages, selectedMailboxItem }) {
  if (selectedThread) {
    const lastInbound = [...(selectedThreadMessages || [])].reverse().find((message) => (
      (message.direction || message.type) !== "outbound"
    ));
    return extractEmailAddress(
      lastInbound?.reply_to
      || lastInbound?.buyer_email
      || selectedThread.buyer_email
      || lastInbound?.from
      || lastInbound?.sender
    );
  }
  return extractEmailAddress(selectedMailboxItem?.reply_to || selectedMailboxItem?.from || selectedMailboxItem?.sender || selectedMailboxItem?.to);
}

function getReplySubject({ selectedThread, selectedThreadMessages, selectedMailboxItem }) {
  if (selectedThread) {
    const lastSubject = [...(selectedThreadMessages || [])].reverse().find((message) => message.subject)?.subject;
    return normalizeReplySubject(lastSubject || `Order ${selectedThread.order_number || ""}`.trim());
  }
  return normalizeReplySubject(selectedMailboxItem?.subject || "");
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

function normalizeMessageIdForLink(value) {
  return String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

function isHiddenInWorkspace(item) {
  const h = item?.hidden_in_workspace;
  return h === true || h === 1 || String(h).toLowerCase() === "true";
}

/**
 * Workspace inbox display only: email is "handled" if hidden, explicitly linked to an order,
 * or already appears on an order's inbound messages (email_id / message_id).
 */
/** Collapse whitespace and lowercase for subject comparison. */
function normalizeSubjectForMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parse an ISO / RFC-date string to ms-since-epoch, or NaN on failure. */
function parseMsForMatch(value) {
  const s = String(value || "").trim();
  if (!s) return Number.NaN;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function getInboxItemHandledState(item, orders) {
  if (isHiddenInWorkspace(item)) {
    return { handled: true, reason: "hidden" };
  }
  if (String(item?.linked_order_id || "").trim()) {
    return { handled: true, reason: "linked_to_order" };
  }
  const itemPath = String(item?.path || "").trim().toLowerCase();
  if (itemPath) {
    for (const order of orders || []) {
      const sp = String(order?.source_eml_path || "").trim().toLowerCase();
      const ep = String(order?.eml_path || "").trim().toLowerCase();
      if ((sp && sp === itemPath) || (ep && ep === itemPath)) {
        return { handled: true, reason: "source_eml_path_match" };
      }
    }
  }
  const emailId = getInboxItemId(item);
  // eid = Message-ID header value (preferred by inferInboxEmailId in Electron)
  const eid = String(emailId || "").trim().toLowerCase();
  // imapUid = filename-derived IMAP UID token; matches msg.email_id stored by Python inbox_service
  const imapUid = String(item?.imap_uid || "").trim().toLowerCase();
  // Pair D: compare item.imap_uid against the UID embedded in order.source_eml_path / eml_path.
  // Catches re-fetched emails where the timestamp prefix differs but the IMAP UID is stable.
  if (imapUid) {
    for (const order of orders || []) {
      for (const emlPath of [order?.source_eml_path, order?.eml_path]) {
        if (extractEmlUid(emlPath) === imapUid) {
          return { handled: true, reason: "eml_path_uid_match" };
        }
      }
    }
  }
  // msgId = item.message_id — not set by Electron's extractEmailMetadata, but kept for future sources
  const msgId = normalizeMessageIdForLink(item?.message_id || "");
  // Subject + timestamp fallback (used when all ID pairs fail)
  const itemSubject = normalizeSubjectForMatch(item?.subject);
  const itemTs = parseMsForMatch(item?.timestamp || item?.received_at);
  const SUBJECT_TS_WINDOW_MS = 5 * 60 * 1000; // ±5 minutes

  for (const order of orders || []) {
    const messages = Array.isArray(order?.messages) ? order.messages : [];
    for (const msg of messages) {
      const dir = String(msg?.type || msg?.direction || "").toLowerCase();
      if (dir !== "inbound") continue;
      // me = msg.email_id = IMAP UID string as stored by Python inbox_service
      const me = String(msg?.email_id || "").trim().toLowerCase();
      // Pair A-1: both sides are Message-ID (when Electron falls back to filename token same as UID)
      if (eid && me && me === eid) {
        return { handled: true, reason: "already_in_messages" };
      }
      // Pair A-2: item.imap_uid (filename token) vs msg.email_id (IMAP UID stored by Python)
      if (imapUid && me && imapUid === me) {
        return { handled: true, reason: "already_in_messages" };
      }
      // mm = msg.message_id / msg.id = Message-ID header as stored by Python inbox_service
      const mm = normalizeMessageIdForLink(msg?.message_id || msg?.id);
      // Pair B-1: item.message_id (future sources) vs msg.message_id/msg.id
      // Pair B-2: item.email_id (= Message-ID when header present) vs msg.message_id/msg.id
      if ((msgId && mm && mm === msgId) || (eid && mm && mm === eid)) {
        return { handled: true, reason: "already_in_messages" };
      }
      // Pair C — subject + timestamp proximity fallback (platform-agnostic)
      // Covers cases where IDs differ between Electron / Python / platform (e.g. Woo).
      if (itemSubject) {
        const msgSubject = normalizeSubjectForMatch(msg?.subject);
        if (msgSubject && msgSubject === itemSubject) {
          const msgTs = parseMsForMatch(msg?.timestamp);
          const tsMatch =
            !Number.isNaN(itemTs) && !Number.isNaN(msgTs) && Math.abs(itemTs - msgTs) <= SUBJECT_TS_WINDOW_MS;
          const itemSender = String(item?.sender || item?.from || "").trim().toLowerCase();
          const msgSender = String(msg?.sender || msg?.from || "").trim().toLowerCase();
          const senderMatch = Boolean(itemSender && msgSender && itemSender === msgSender);
          if (tsMatch || (Number.isNaN(msgTs) && senderMatch)) {
            return { handled: true, reason: "already_in_messages" };
          }
        }
      }
    }
  }
  return { handled: false, reason: "" };
}

function isInboxEmailLinkedToOrder(item, orders) {
  const linkId = String(item?.linked_order_id || "").trim();
  if (linkId) {
    return { linked: true, linked_order_id: linkId };
  }
  const state = buildOrderLinkState(item, orders);
  if (state.linkedOrder) {
    const oid = String(state.linkedOrder.order_id || state.linkedOrder.id || "").trim();
    return { linked: true, linked_order_id: oid };
  }
  const emailId = getInboxItemId(item);
  const msgId = String(item?.message_id || "").trim();
  const eid = String(emailId || "").trim().toLowerCase();
  const mid = normalizeMessageIdForLink(msgId);
  for (const order of orders || []) {
    const messages = Array.isArray(order?.messages) ? order.messages : [];
    for (const msg of messages) {
      const dir = String(msg?.type || msg?.direction || "").toLowerCase();
      if (dir !== "inbound") continue;
      const me = String(msg?.email_id || "").trim().toLowerCase();
      if (eid && me === eid) {
        const oid = String(order?.order_id || order?.id || "").trim();
        return { linked: true, linked_order_id: oid || "from_messages" };
      }
      const mm = normalizeMessageIdForLink(msg?.message_id || msg?.id);
      if (mid && mm && mm === mid) {
        const oid = String(order?.order_id || order?.id || "").trim();
        return { linked: true, linked_order_id: oid || "from_messages" };
      }
    }
  }
  return { linked: false, linked_order_id: "" };
}

function buildOrderLinkState(item, orders) {
  const manualOrderId = String(item?.linked_order_id || "").trim();
  if (manualOrderId) {
    const seen = new Set();
    const matches = [];
    for (const order of orders || []) {
      const oid = String(order?.order_id || order?.id || "").trim();
      if (!oid || oid !== manualOrderId || seen.has(oid)) continue;
      seen.add(oid);
      const orderNumber = normalizeOrderNumber(order?.order_number);
      matches.push({ ...order, order_number: orderNumber });
    }
    if (matches.length >= 1) {
      return { candidates: [], matches, linkedOrder: matches[0] };
    }
  }

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
          style={{ color: "#2563eb", textDecoration: "underline", wordBreak: "break-all", overflowWrap: "anywhere" }}
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
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
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
            wordBreak: "break-word",
            overflowWrap: "anywhere",
            minWidth: 0,
          }}
        >
          {renderPreviewTextWithProof(block.text, orderLinkState, onOpenOrder)}
        </div>
      ))}
    </div>
  );
}

function getAttachmentDisplayName(attachment) {
  if (typeof attachment === "string") {
    return attachment.split(/[/\\]/).pop() || "Attachment";
  }
  return String(
    attachment?.name
    || attachment?.filename
    || attachment?.fileName
    || attachment?.path
    || attachment?.url
    || "Attachment"
  ).split(/[/\\]/).pop();
}

function getAttachmentType(attachment) {
  if (typeof attachment === "string") {
    const extension = attachment.split(".").pop()?.toLowerCase() || "";
    return extension ? `.${extension}` : "file";
  }
  return String(attachment?.type || attachment?.mimeType || attachment?.contentType || "").toLowerCase();
}

function getAttachmentIcon(attachment) {
  const name = getAttachmentDisplayName(attachment).toLowerCase();
  const type = getAttachmentType(attachment);
  if (type.includes("image") || /\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return "IMG";
  if (type.includes("pdf") || /\.pdf$/i.test(name)) return "PDF";
  if (type.includes("zip") || /\.(zip|rar|7z)$/i.test(name)) return "ZIP";
  if (type.includes("spreadsheet") || /\.(csv|xlsx?)$/i.test(name)) return "XLS";
  if (type.includes("word") || /\.(docx?|rtf)$/i.test(name)) return "DOC";
  return "FILE";
}

function getEmailAttachments(item) {
  const values = item?.attachments || item?.attachment_paths || item?.attachmentPaths || [];
  return Array.isArray(values) ? values.filter(Boolean).map((attachment) => {
    if (typeof attachment === "string") {
      return {
        name: getAttachmentDisplayName(attachment),
        path: attachment,
        type: getAttachmentType(attachment),
      };
    }
    return {
      ...attachment,
      name: getAttachmentDisplayName(attachment),
      type: getAttachmentType(attachment),
    };
  }) : [];
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

function WorkspaceIdentityPanel({ shopName }) {
  // TODO: support dynamic messages (first use, caught up, etc.)
  return (
    <div style={{
      flex: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 32,
      textAlign: "center",
    }}>
      <div style={{ width: "100%", maxWidth: 520 }}>
        <h1 style={{ margin: 0, fontSize: 36, lineHeight: 1.15, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.03em" }}>
          {shopName}
        </h1>
        <div style={{ marginTop: 8, fontSize: 13, fontWeight: 650, color: "#94a3b8" }}>
          Powered by Spaila
        </div>
        <div style={{ marginTop: 20, fontSize: 15, fontWeight: 650, color: "#cbd5e1" }}>
          Select an email to begin
        </div>
        <div style={{ maxWidth: 540, margin: "28px auto 0", fontSize: 13, lineHeight: 1.55, color: "#6b7280", textAlign: "center" }}>
          <p style={{ margin: 0 }}>
            Workspace is your communication hub for customer conversations and orders in Spaila.
          </p>
          <p style={{ margin: "9px 0 0" }}>
            Use it to review emails, manage orders, and respond efficiently—while your full email client remains available when needed.
          </p>
        </div>
      </div>
    </div>
  );
}

function AttachmentList({ attachments, onOpen, compact = false }) {
  if (!attachments.length) return null;
  return (
    <div style={{ marginTop: compact ? 12 : 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280" }}>
        Attachments ({attachments.length})
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {attachments.map((attachment, index) => (
          <button
            key={`${attachment.name || "attachment"}-${attachment.path || attachment.url || (attachment.attachmentIndex ?? index)}`}
            type="button"
            onClick={() => onOpen?.(attachment)}
            title={attachment.path || attachment.url || attachment.name}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              border: "1px solid #e5e7eb",
              background: "#fff",
              color: "#334155",
              borderRadius: 999,
              padding: compact ? "4px 10px" : "4px 10px",
              fontSize: compact ? 11 : 12,
              fontWeight: 600,
              cursor: "pointer",
              maxWidth: compact ? 240 : 320,
            }}
          >
            <span style={{ color: "#64748b", fontSize: 12, lineHeight: 1 }}>
              {getAttachmentIcon(attachment)}
            </span>
            <span style={{ minWidth: 0, whiteSpace: "normal", wordBreak: "break-word", overflowWrap: "anywhere" }}>
              {attachment.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function InlineReplyBox({
  value,
  onChange,
  onSend,
  attachments = [],
  onAttachFiles,
  onAttachOrderFiles,
  onSelectOrderFile,
  onCloseOrderFilePicker,
  orderFilePicker = { open: false, loading: false, files: [], error: "" },
  onRemoveAttachment,
  isSending = false,
}) {
  const fileInputRef = React.useRef(null);
  return (
    <div className="reply-box" style={{ marginTop: 20, borderTop: "1px solid #e5e7eb", paddingTop: 14 }}>
      <textarea
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        placeholder="Write a reply..."
        style={{
          width: "100%",
          minHeight: 88,
          resize: "vertical",
          boxSizing: "border-box",
          border: "1px solid #cbd5e1",
          borderRadius: 12,
          padding: "11px 12px",
          color: "#0f172a",
          fontSize: 14,
          lineHeight: 1.5,
          fontFamily: "inherit",
          outline: "none",
          background: "#fff",
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          if (files.length) {
            onAttachFiles?.(files);
          }
          event.target.value = "";
        }}
      />
      {attachments.length ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 7 }}>
            Attached:
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {attachments.map((file, index) => (
              <span
                key={`${file.name || "attachment"}-${file.size || 0}-${file.lastModified || index}`}
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
                  maxWidth: 260,
                }}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file.name || "Attachment"}
                </span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment?.(index)}
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
        </div>
      ) : null}
      <div className="reply-actions" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 10 }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <button
            className="attach"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title={attachments.length ? `${attachments.length} file${attachments.length === 1 ? "" : "s"} attached` : "Attach file"}
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
            className="attach-order"
            type="button"
            onClick={() => onAttachOrderFiles?.()}
            title="Attach from Order"
            aria-label="Attach from Order"
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
            📁
          </button>
        </div>
        <button
          className="send"
          type="button"
          disabled={isSending}
          onClick={onSend}
          style={{
            border: "none",
            background: "#2563eb",
            color: "#fff",
            borderRadius: 10,
            padding: "8px 14px",
            cursor: isSending ? "not-allowed" : "pointer",
            fontSize: 13,
            fontWeight: 800,
            opacity: isSending ? 0.72 : 1,
          }}
        >
          {isSending ? "Sending..." : "Send"}
        </button>
      </div>
      {orderFilePicker?.open ? (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.35)",
          zIndex: 2000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 18,
        }}>
          <div style={{
            width: "100%",
            maxWidth: 540,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            boxShadow: "0 20px 40px rgba(15, 23, 42, 0.2)",
            overflow: "hidden",
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>Order Files</div>
              <button
                type="button"
                onClick={() => onCloseOrderFilePicker?.()}
                style={{ border: "none", background: "transparent", color: "#64748b", fontSize: 18, cursor: "pointer", lineHeight: 1 }}
                aria-label="Close order files"
              >
                ×
              </button>
            </div>
            <div style={{ maxHeight: 320, overflowY: "auto", padding: 12 }}>
              {orderFilePicker.loading ? (
                <div style={{ fontSize: 13, color: "#64748b", padding: "10px 6px" }}>Loading files...</div>
              ) : orderFilePicker.error ? (
                <div style={{ fontSize: 13, color: "#b91c1c", padding: "10px 6px" }}>{orderFilePicker.error}</div>
              ) : orderFilePicker.files?.length ? (
                orderFilePicker.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => onSelectOrderFile?.(file)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      border: "1px solid #e5e7eb",
                      background: "#fff",
                      color: "#1f2937",
                      borderRadius: 10,
                      padding: "8px 10px",
                      cursor: "pointer",
                      marginBottom: 8,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, wordBreak: "break-word", overflowWrap: "anywhere" }}>
                      {file.name}
                    </span>
                    <span style={{ fontSize: 11, color: "#64748b", flexShrink: 0 }}>{file.type || "file"}</span>
                  </button>
                ))
              ) : (
                <div style={{ fontSize: 13, color: "#64748b", padding: "10px 6px" }}>No files found in this order folder.</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
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
  archivedCount = 0,
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
  const [shopConfig, setShopConfig] = React.useState(() => loadShopConfig());
  const [replyText, setReplyText] = React.useState("");
  const [attachments, setAttachments] = React.useState([]);
  const [orderFilePicker, setOrderFilePicker] = React.useState({
    open: false,
    loading: false,
    files: [],
    error: "",
    folderPath: "",
  });
  const [assignToOrderOpen, setAssignToOrderOpen] = React.useState(false);
  const [assignToOrderQuery, setAssignToOrderQuery] = React.useState("");
  const [assignToOrderPickId, setAssignToOrderPickId] = React.useState("");
  const [assignToOrderBusy, setAssignToOrderBusy] = React.useState(false);
  const [replyMessagesByConversation, setReplyMessagesByConversation] = React.useState({});
  const [isSendingReply, setIsSendingReply] = React.useState(false);
  const [pendingRemovals, setPendingRemovals] = React.useState({});
  const inboxFetchInFlightRef = React.useRef(false);
  const lastAutoFetchAtRef = React.useRef(0);
  const previousImapConnectedRef = React.useRef(false);
  const previewScrollRef = React.useRef(null);
  const hasRestoredSelectionRef = React.useRef(false);

  const loadWorkspace = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextState, ordersRaw] = await Promise.all([
        window.parserApp?.getWorkspaceState?.({
          bucket: "Inbox",
          relativePath: "",
        }),
        fetchOrdersForLinking().catch(() => []),
      ]);
      const orders = (Array.isArray(ordersRaw) ? ordersRaw : []).filter(
        (o) => String(o?.status || "").toLowerCase() !== "archived"
      );
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
      const raw = await fetchOrdersForLinking();
      const orders = raw.filter((o) => String(o?.status || "").toLowerCase() !== "archived");
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

  const removeInboxFromSpailaStorage = React.useCallback(async (item) => {
    const emailId = getInboxItemId(item);
    if (!emailId) {
      return { ok: false, error: "Email id is missing.", workspaceOnly: false };
    }
    const link = isInboxEmailLinkedToOrder(item, ordersForLinking);
    if (link.linked) {
      console.log("[WORKSPACE_REMOVE]", {
        email_id: emailId,
        linked_order_id: link.linked_order_id || "",
        action: "hidden_only",
      });
      const result = await window.parserApp?.hideInboxWorkspaceOnly?.({
        emailId,
        email_id: emailId,
        imap_uid: item?.imap_uid,
      });
      return { ok: !!result?.ok, error: result?.error, workspaceOnly: true };
    }
    const result = await window.parserApp?.hideInboxItem?.({ emailId });
    return { ok: !!result?.ok, error: result?.error, workspaceOnly: false };
  }, [ordersForLinking]);

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
      try {
        window.dispatchEvent(new CustomEvent("order-thread-updated", { detail: {} }));
      } catch (_) {
        /* ignore */
      }
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
  const displayInboxItems = React.useMemo(() => {
    const out = [];
    for (const item of inboxItems) {
      const emailId = getInboxItemId(item);
      const imapUid = String(item?.imap_uid || "").trim();
      if ((emailId && pendingRemovals[emailId]) || (imapUid && pendingRemovals[imapUid])) {
        console.log("[INBOX_FILTER]", { email_id: emailId || "(unknown)", reason: "pending_removal" });
        continue;
      }
      const { handled, reason } = getInboxItemHandledState(item, ordersForLinking);
      if (handled) {
        console.log("[INBOX_FILTER]", { email_id: emailId || "(unknown)", reason });
        continue;
      }
      out.push(item);
    }
    return out;
  }, [inboxItems, ordersForLinking, pendingRemovals]);
  const displayInboxIdKey = React.useMemo(
    () => displayInboxItems.map(getInboxItemId).filter(Boolean).join("|"),
    [displayInboxItems],
  );
  const sentMessages = workspaceState?.sentMessages || [];
  const buckets = workspaceState?.buckets || [];
  const inboxPath = workspaceState?.inboxPath || buckets.find((item) => item.key === "Inbox")?.path || "";
  const imapConfigured = !!workspaceState?.imapConfigured;
  const canFetchInbox = imapConfigured && imapConnected;
  const canDeleteFromAccount = canFetchInbox;
  const lastUpdatedLabel = formatLastUpdated(lastInboxFetchAt, clockTick);
  const showInboxEmptyState = !loading && inboxItems.length === 0 && sentMessages.length === 0;
  const displayInboxPath = inboxPath || "C:\\Spaila\\Inbox";
  const inboxModeItems = displayInboxItems.filter((item) => String(item.direction || "inbound").toLowerCase() === "inbound");
  const sentItems = sentMessages.filter((item) => String(item.direction || "outbound").toLowerCase() === "outbound");
  const checkedInboxItems = displayInboxItems.filter((item) => checkedEmailIds.has(getInboxItemId(item)));
  const selectedInboxItem = displayInboxItems.find((item) => getInboxItemId(item) === selectedEmailId) || null;
  const selectedSentItem = sentItems.find((item) => getMessageId(item) === selectedSentId) || null;
  const selectedMailboxItem = mode === "sent" ? selectedSentItem : selectedInboxItem;
  const selectedOrderLinkState = buildOrderLinkState(selectedMailboxItem, ordersForLinking);
  const selectedMessageClassification = mode === "inbox" ? getMessageClassification(selectedInboxItem, selectedOrderLinkState) : null;
  const selectedEmailAttachments = getEmailAttachments(selectedMailboxItem);
  const selectedLinkedOrder = selectedOrderLinkState.linkedOrder || null;
  const selectedLinkedOrderNumber = normalizeOrderNumber(selectedLinkedOrder?.order_number);
  const selectedLinkedSentMessages = selectedLinkedOrderNumber
    ? sentMessages
      .filter((message) => normalizeOrderNumber(message?.order_number) === selectedLinkedOrderNumber)
      .map((message) => normalizeSelectedOrderSentMessage(message, selectedLinkedOrder))
    : [];
  const selectedMailboxSubjectKey = normalizeConversationSubject(selectedMailboxItem?.subject || "");
  const selectedMailboxParticipant = getMailboxParticipantAddress(selectedMailboxItem, mode);
  const selectedSubjectSentMessages = selectedMailboxSubjectKey
    ? sentMessages
      .filter((message) => {
        const subjectMatches = normalizeConversationSubject(message?.subject || "") === selectedMailboxSubjectKey;
        if (!subjectMatches) return false;
        if (!selectedMailboxParticipant) return true;
        const sentTo = String(message?.to || message?.buyer_email || "").trim().toLowerCase();
        return !!sentTo && sentTo.includes(selectedMailboxParticipant);
      })
      .map((message) => normalizeSelectedOrderSentMessage(message, selectedLinkedOrder || {}))
    : [];
  const selectedMailboxThreadMessages = selectedMailboxItem
    ? dedupeMessages([
      normalizeSelectedMailboxMessage(selectedMailboxItem, selectedLinkedOrder, mode),
      ...(Array.isArray(selectedLinkedOrder?.messages) ? selectedLinkedOrder.messages : [])
        .map((message) => normalizePersistedOrderMessage(message, selectedLinkedOrder)),
      ...selectedLinkedSentMessages,
      ...selectedSubjectSentMessages,
    ]).sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")))
    : [];
  const inboxContextMenuItem = displayInboxItems.find((item) => getInboxItemId(item) === inboxContextMenu?.emailId) || null;
  const inboxContextOrderLinkState = buildOrderLinkState(inboxContextMenuItem, ordersForLinking);
  const threadItems = threadState.threads || [];
  const unlinkedMessages = threadState.unlinkedMessages || [];
  const selectedThread = threadItems.find((thread) => thread.thread_id === selectedThreadId) || null;
  const selectedThreadMessages = selectedThread?.messages || [];
  const currentConversationKey = selectedThread
    ? `thread:${selectedThread.thread_id}`
    : selectedMailboxItem
      ? `email:${mode}:${getMessageId(selectedMailboxItem) || getInboxItemId(selectedMailboxItem)}`
      : "";
  const currentConversationReplies = currentConversationKey ? replyMessagesByConversation[currentConversationKey] || [] : [];
  const selectedThreadMessagesWithReplies = selectedThread
    ? dedupeConversationMessages([...selectedThreadMessages, ...currentConversationReplies])
    : selectedThreadMessages;
  const selectedMailboxReplies = !selectedThread && selectedMailboxItem ? currentConversationReplies : [];
  const selectedMailboxThreadMessagesWithReplies = selectedMailboxThreadMessages.length
    ? dedupeConversationMessages([...selectedMailboxThreadMessages, ...selectedMailboxReplies])
    : [];
  const assignableOrders = React.useMemo(() => {
    const q = assignToOrderQuery.trim().toLowerCase();
    const byId = new Map();
    for (const row of ordersForLinking || []) {
      const oid = String(row?.order_id || row?.id || "").trim();
      if (!oid || byId.has(oid)) continue;
      byId.set(oid, row);
    }
    let rows = [...byId.values()];
    if (q) {
      rows = rows.filter((row) => {
        const name = String(row?.buyer_name || "").toLowerCase();
        const num = String(row?.order_number || "").toLowerCase();
        return name.includes(q) || num.includes(q);
      });
    }
    return rows.slice(0, 200);
  }, [ordersForLinking, assignToOrderQuery]);
  const activeReplyOrder = selectedThread?.order || selectedLinkedOrder || null;
  const displayShopName = String(shopConfig.shop_name || shopConfig.shopName || "").trim() || "Your Workspace";
  const conversationStackStyle = {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: 20,
  };

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
    if (loading || hasRestoredSelectionRef.current) return;
    hasRestoredSelectionRef.current = true;
    const savedThreadId = getLocalStorageValue(WORKSPACE_SELECTED_THREAD_ID_KEY);
    const savedEmailId = getLocalStorageValue(WORKSPACE_SELECTED_EMAIL_ID_KEY);
    const savedSentId = getLocalStorageValue(WORKSPACE_SELECTED_SENT_ID_KEY);

    if (savedThreadId && threadItems.some((thread) => thread.thread_id === savedThreadId)) {
      setSelectedThreadId(savedThreadId);
      setSelectedEmailId("");
      setSelectedSentId("");
      setMode("inbox");
    } else if (savedEmailId && displayInboxItems.some((item) => getInboxItemId(item) === savedEmailId)) {
      setSelectedEmailId(savedEmailId);
      setSelectedThreadId("");
      setSelectedSentId("");
      setMode("inbox");
    } else if (savedSentId && sentItems.some((item) => getMessageId(item) === savedSentId)) {
      setSelectedSentId(savedSentId);
      setSelectedEmailId("");
      setSelectedThreadId("");
      setMode("sent");
    } else {
      return;
    }

    const savedScrollTop = Number(getLocalStorageValue(WORKSPACE_SCROLL_Y_KEY));
    if (!Number.isNaN(savedScrollTop) && savedScrollTop > 0) {
      window.requestAnimationFrame(() => {
        const node = previewScrollRef.current;
        if (node) {
          node.scrollTop = savedScrollTop;
        }
      });
    }
  }, [displayInboxItems, loading, sentItems, threadItems]);

  React.useEffect(() => {
    if (selectedThreadId) {
      setLocalStorageValue(WORKSPACE_SELECTED_THREAD_ID_KEY, selectedThreadId);
      setLocalStorageValue(WORKSPACE_SELECTED_EMAIL_ID_KEY, "");
      setLocalStorageValue(WORKSPACE_SELECTED_SENT_ID_KEY, "");
      return;
    }
    if (selectedEmailId) {
      setLocalStorageValue(WORKSPACE_SELECTED_EMAIL_ID_KEY, selectedEmailId);
      setLocalStorageValue(WORKSPACE_SELECTED_THREAD_ID_KEY, "");
      setLocalStorageValue(WORKSPACE_SELECTED_SENT_ID_KEY, "");
      return;
    }
    if (selectedSentId) {
      setLocalStorageValue(WORKSPACE_SELECTED_SENT_ID_KEY, selectedSentId);
      setLocalStorageValue(WORKSPACE_SELECTED_THREAD_ID_KEY, "");
      setLocalStorageValue(WORKSPACE_SELECTED_EMAIL_ID_KEY, "");
    }
  }, [selectedEmailId, selectedSentId, selectedThreadId]);

  React.useEffect(() => {
    const node = previewScrollRef.current;
    if (!node) return undefined;
    const handleScroll = () => {
      setLocalStorageValue(WORKSPACE_SCROLL_Y_KEY, String(node.scrollTop || 0));
    };
    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => node.removeEventListener("scroll", handleScroll);
  }, [selectedEmailId, selectedSentId, selectedThreadId]);

  React.useEffect(() => {
    function handleShopConfigChange() {
      setShopConfig(loadShopConfig());
    }

    window.addEventListener("spaila:shopconfig", handleShopConfigChange);
    return () => window.removeEventListener("spaila:shopconfig", handleShopConfigChange);
  }, []);

  React.useEffect(() => {
    const built = buildThreadsFromMessages(displayInboxItems, sentMessages, ordersForLinking);
    setThreadState((prev) => ({
      threads: mergeThreads(prev.threads, built.threads),
      unlinkedMessages: mergeUnlinkedMessages(prev.unlinkedMessages, built.unlinkedMessages),
    }));
  }, [displayInboxIdKey, sentMessages, ordersForLinking]);

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
    const visibleIds = new Set(displayInboxItems.map(getInboxItemId).filter(Boolean));
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
  }, [displayInboxIdKey, selectedEmailId]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    setPreviewMode("clean");
    setPreviewContextMenu(null);
  }, [selectedEmailId]);

  React.useEffect(() => {
    setPreviewMode("clean");
    setPreviewContextMenu(null);
  }, [selectedSentId, mode]);

  React.useEffect(() => {
    closeOrderFilePicker();
  }, [selectedEmailId, selectedSentId, selectedThreadId]);

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

  async function handleOpenAttachment(attachment) {
    try {
      const result = await window.parserApp?.openAttachment?.({ attachment });
      if (!result?.ok) {
        setDropMessage(result?.error || "Could not open attachment.");
      }
    } catch (nextError) {
      setDropMessage(nextError.message || "Could not open attachment.");
    }
  }

  async function handleAttachInlineReplyFiles(files) {
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
    setAttachments((current) => [...current, ...nextAttachments]);
  }

  function closeOrderFilePicker() {
    setOrderFilePicker((current) => ({ ...current, open: false }));
  }

  async function handleOpenOrderFilePicker() {
    const folderPath = String(activeReplyOrder?.order_folder_path || "").trim();
    if (!folderPath) {
      setDropMessage("This conversation has no order folder yet.");
      return;
    }
    setOrderFilePicker({ open: true, loading: true, files: [], error: "", folderPath });
    try {
      const result = await window.parserApp?.listAttachments?.({
        folderPath,
        mode: "all",
        extensions: [],
      });
      if (!result) {
        throw new Error("Could not load order files.");
      }
      const nextFiles = (Array.isArray(result.files) ? result.files : [])
        .map((filePath) => {
          const fullPath = String(filePath || "").trim();
          const name = getFilenameFromPath(fullPath) || "Attachment";
          const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "file";
          return { name, path: fullPath, type: ext };
        })
        .filter((file) => file.path);
      setOrderFilePicker({
        open: true,
        loading: false,
        files: nextFiles,
        error: "",
        folderPath,
      });
    } catch (error) {
      setOrderFilePicker({
        open: true,
        loading: false,
        files: [],
        error: error?.message || "Could not load order files.",
        folderPath,
      });
    }
  }

  function handleAttachOrderFile(file) {
    const filePath = String(file?.path || "").trim();
    if (!filePath) return;
    setAttachments((current) => {
      if (current.some((item) => String(item.path || "").trim() === filePath)) {
        return current;
      }
      return [
        ...current,
        {
          name: file?.name || getFilenameFromPath(filePath) || "Attachment",
          size: 0,
          lastModified: 0,
          path: filePath,
        },
      ];
    });
    closeOrderFilePicker();
  }

  function handleRemoveInlineReplyAttachment(indexToRemove) {
    setAttachments((current) => current.filter((_file, index) => index !== indexToRemove));
  }

  function scrollConversationToBottom() {
    window.requestAnimationFrame(() => {
      const node = previewScrollRef.current;
      if (node) {
        node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
      }
    });
  }

  function updateReplyMessage(conversationKey, messageId, updates) {
    setReplyMessagesByConversation((current) => ({
      ...current,
      [conversationKey]: (current[conversationKey] || []).map((message) => (
        message.id === messageId ? { ...message, ...updates } : message
      )),
    }));
  }

  async function handleSendInlineReply() {
    if (isSendingReply) return;
    const body = replyText;
    const attachmentPaths = attachments.map((attachment) => String(attachment.path || "").trim()).filter(Boolean);
    if ((!body.trim() && !attachments.length) || !currentConversationKey) return;
    const to = getReplyTarget({ selectedThread, selectedThreadMessages, selectedMailboxItem });
    const subject = getReplySubject({ selectedThread, selectedThreadMessages, selectedMailboxItem });
    if (!to) {
      setDropMessage("No reply email address found.");
      return;
    }
    const from = String(shopConfig?.smtpEmailAddress || "").trim();
    const smtpUsername = String(shopConfig?.smtpUsername || "").trim();
    if (!from) {
      setDropMessage("SMTP sender email is missing in Settings.");
      return;
    }
    const fromDomain = getEmailDomain(from);
    const usernameDomain = getEmailDomain(smtpUsername);
    if (usernameDomain && fromDomain && usernameDomain !== fromDomain) {
      setDropMessage("SMTP username must match the sender email domain.");
      return;
    }
    const linkedOrder = selectedThread?.order || selectedLinkedOrder || null;
    const linkedOrderId = linkedOrder?.order_id || linkedOrder?.id || "";
    if (attachments.length && attachmentPaths.length !== attachments.length) {
      setDropMessage("One or more attachments could not be read.");
      return;
    }
    const optimisticId = `temp_${Date.now()}`;
    const optimisticTimestamp = new Date().toISOString();
    const optimisticMessage = {
      id: optimisticId,
      client_temp_id: optimisticId,
      type: "outbound",
      direction: "outbound",
      to,
      subject,
      body,
      attachments: attachmentPaths,
      timestamp: optimisticTimestamp,
      status: "sending",
    };
    setReplyMessagesByConversation((current) => ({
      ...current,
      [currentConversationKey]: [...(current[currentConversationKey] || []), optimisticMessage],
    }));
    setReplyText("");
    setAttachments([]);
    setIsSendingReply(true);
    scrollConversationToBottom();
    console.log("[SEND_DEBUG]", { from, to, subject });
    let result;
    try {
      result = await window.parserApp?.sendDockEmail?.({
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
        orderFolderPath: linkedOrder?.order_folder_path || "",
        orderNumber: selectedThread?.order_number || linkedOrder?.order_number || "",
        buyerName: selectedThread?.buyer_name || linkedOrder?.buyer_name || "",
        buyerEmail: selectedThread?.buyer_email || linkedOrder?.buyer_email || to,
      });
    } catch (error) {
      setDropMessage(error?.message || "Could not send reply.");
      updateReplyMessage(currentConversationKey, optimisticId, { status: "failed" });
      setIsSendingReply(false);
      return;
    }
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not send reply.");
      updateReplyMessage(currentConversationKey, optimisticId, { status: "failed" });
      setIsSendingReply(false);
      return;
    }
    const serverMessageId = String(result.messageId || result.message_id || "").trim();
    const message = {
      id: serverMessageId || optimisticId,
      message_id: serverMessageId || optimisticId,
      client_temp_id: optimisticId,
      type: "outbound",
      direction: "outbound",
      to,
      subject,
      body,
      attachments: attachmentPaths,
      timestamp: result.timestamp || new Date().toISOString(),
      status: "sent",
    };
    console.log("[REPLY_SENT]", body);
    updateReplyMessage(currentConversationKey, optimisticId, { ...message, status: "sent" });
    setDropMessage("Reply sent.");
    setIsSendingReply(false);
    scrollConversationToBottom();
    let persistedMessage = message;
    let persistenceWarning = "";
    if (linkedOrderId) {
      try {
        persistedMessage = await persistOrderMessage(linkedOrderId, message);
      } catch (error) {
        persistenceWarning = error?.message || "Reply sent, but could not save it to the order.";
      }
    }
    if (persistenceWarning) {
      setDropMessage(persistenceWarning);
    } else if (persistedMessage !== message) {
      updateReplyMessage(currentConversationKey, optimisticId, { ...persistedMessage, status: "sent" });
    }
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

  function openAssignToOrderModal(itemOverride = null) {
    const target = itemOverride || selectedInboxItem;
    if (itemOverride && target) {
      const id = getInboxItemId(target);
      if (id) {
        setSelectedEmailId(id);
        setSelectedThreadId("");
        setSelectedSentId("");
        setMode("inbox");
      }
    }
    setAssignToOrderQuery("");
    setAssignToOrderPickId("");
    setAssignToOrderOpen(true);
  }

  async function confirmAssignToOrder() {
    const orderId = String(assignToOrderPickId || "").trim();
    const item = selectedInboxItem;
    if (!orderId || !item) {
      setDropMessage("Select an order to assign this email.");
      return;
    }
    const emailId = getInboxItemId(item);
    if (!emailId) {
      setDropMessage("Email id is missing.");
      return;
    }
    const body = String(item.preview_text || item.body || item.preview || "").trim();
    const subject = String(item.subject || "").trim();
    const sender = String(item.sender || item.from || item.reply_to || "").trim();
    const timestamp = String(item.timestamp || item.received_at || "").trim() || new Date().toISOString();
    const messageId = String(item.message_id || "").trim();
    if (!body && !subject) {
      setDropMessage("This email has no subject or body text to save.");
      return;
    }
    setAssignToOrderBusy(true);
    try {
      const response = await fetch(
        `http://127.0.0.1:8055/orders/${encodeURIComponent(orderId)}/messages/manual-assign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email_id: emailId,
            subject,
            body,
            sender,
            timestamp,
            ...(messageId ? { message_id: messageId } : {}),
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload?.detail;
        const msg = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((d) => d?.msg || d).join(", ") : payload?.error;
        throw new Error(msg || `Server error ${response.status}`);
      }
      if (payload?.status === "duplicate") {
        setDropMessage("That email is already on this order's conversation.");
        setAssignToOrderOpen(false);
        return;
      }
      const persistLink = await window.parserApp?.setInboxLinkedOrder?.({
        item: { email_id: emailId, emailId },
        order_id: orderId,
      });
      await loadWorkspace();
      await loadOrdersForLinking();
      if (!persistLink?.ok) {
        updateInboxOrderLearningState(emailId, { linked_order_id: orderId });
      }
      try {
        window.dispatchEvent(new CustomEvent("order-thread-updated", { detail: { order_id: orderId } }));
      } catch (_e) {
        /* ignore */
      }
      setDropMessage("Email assigned to order.");
      setAssignToOrderOpen(false);
    } catch (err) {
      setDropMessage(err?.message || "Could not assign email to order.");
    } finally {
      setAssignToOrderBusy(false);
    }
  }

  async function handleRemoveInboxItem(item) {
    const emailId = getInboxItemId(item);
    if (!emailId) {
      setDropMessage("Email id is missing.");
      return;
    }
    const imapUid = String(item?.imap_uid || "").trim();
    const previousIndex = inboxItems.findIndex((candidate) => getInboxItemId(candidate) === emailId);
    setPendingRemovals((prev) => {
      const next = { ...prev };
      next[emailId] = true;
      if (imapUid) next[imapUid] = true;
      return next;
    });
    hideInboxItemInState(item);
    const result = await removeInboxFromSpailaStorage(item);
    if (!result?.ok) {
      setDropMessage(result?.error || "Could not remove email from Spaila.");
      setPendingRemovals((prev) => {
        const next = { ...prev };
        delete next[emailId];
        if (imapUid) delete next[imapUid];
        return next;
      });
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
      setPendingRemovals((prev) => {
        const next = { ...prev };
        delete next[emailId];
        if (imapUid) delete next[imapUid];
        return next;
      });
      setDropMessage(
        result.workspaceOnly
          ? "Email hidden from Inbox. It stays on the order conversation."
          : "Email removed from Spaila.",
      );
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
      await removeInboxFromSpailaStorage(item);
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
    setPendingRemovals((prev) => {
      const next = { ...prev };
      for (const item of itemsToRemove) {
        const eid = getInboxItemId(item);
        const uid = String(item?.imap_uid || "").trim();
        if (eid) next[eid] = true;
        if (uid) next[uid] = true;
      }
      return next;
    });
    for (const item of itemsToRemove) {
      hideInboxItemInState(item);
    }
    for (const item of itemsToRemove) {
      const emailId = getInboxItemId(item);
      const imapUid = String(item?.imap_uid || "").trim();
      if (emailId) {
        await removeInboxFromSpailaStorage(item);
      }
      setPendingRemovals((prev) => {
        const next = { ...prev };
        if (emailId) delete next[emailId];
        if (imapUid) delete next[imapUid];
        return next;
      });
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
        await removeInboxFromSpailaStorage(item);
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
    const isOutbound = (message.direction || message.type) === "outbound";
    const outboundStatus = isOutbound ? String(message.status || "sent") : "";
    const orderLinkState = buildOrderLinkState(message, ordersForLinking);
    const attachments = getEmailAttachments(message);
    const contentText = String(message.preview_text || message.body || message.preview || "").trim();
    const fallbackText = attachments.length ? "Attachment sent" : "";
    const displayText = contentText || fallbackText;
    const inboundLabel = String(
      message.sender
      || message.from
      || message.reply_to
      || message.buyer_name
      || message.buyer_email
      || ""
    ).trim();
    const bubbleLabel = isOutbound ? "You" : inboundLabel || "Unknown sender";
    return (
      <div
        key={message.id}
        className={isOutbound ? "message-outbound" : "message-inbound"}
        style={{
          alignSelf: isOutbound ? "flex-end" : "flex-start",
          maxWidth: isOutbound ? "92%" : "90%",
          marginLeft: isOutbound ? "auto" : 0,
          marginRight: isOutbound ? 0 : "auto",
          width: "auto",
        }}
      >
        <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 4, fontWeight: 600 }}>
          {bubbleLabel}
        </div>
        <div style={{
          background: isOutbound ? "#e7efff" : "#f3f7f5",
          border: isOutbound ? "1px solid #c6d7ff" : "1px solid #e1ebe6",
          color: isOutbound ? "#1f2937" : "#0f172a",
          borderRadius: isOutbound ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
          padding: "11px 12px",
          boxShadow: "0 6px 16px rgba(15, 23, 42, 0.06)",
        }}
      >
        {previewMode === "original" && message.preview_html && contentText ? (
          <div
            style={{ color: isOutbound ? "#1f2937" : "#334155", fontSize: 14, lineHeight: 1.6, wordBreak: "break-word", overflowWrap: "anywhere" }}
            dangerouslySetInnerHTML={{ __html: message.preview_html }}
          />
        ) : displayText ? (
          <div style={{ color: isOutbound ? "#1f2937" : "#1f2937", fontSize: 14, lineHeight: 1.55, wordBreak: "break-word", overflowWrap: "anywhere", minWidth: 0 }}>
            {renderReadableMessageBody(displayText, orderLinkState, handleOpenLinkedOrder)}
          </div>
        ) : null}
        <AttachmentList attachments={attachments} onOpen={handleOpenAttachment} compact />
        <div style={{
          marginTop: 8,
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          fontSize: 11,
          color: outboundStatus === "failed" ? "#b91c1c" : isOutbound ? "#475569" : "#94a3b8",
          fontWeight: 700,
        }}>
          {isOutbound ? (
            <span>{outboundStatus === "sending" ? "Sending..." : outboundStatus === "failed" ? "Failed" : "Sent"}</span>
          ) : null}
          <span>{formatTimestamp(message.timestamp)}</span>
        </div>
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
        archivedCount={archivedCount}
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
            <WorkspaceIdentityPanel
              shopName={displayShopName}
            />
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
                    <span>{selectedThreadMessagesWithReplies.length} message{selectedThreadMessagesWithReplies.length === 1 ? "" : "s"}</span>
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
              <div ref={previewScrollRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 18px", background: "#ffffff" }}>
                <div style={conversationStackStyle}>
                  {selectedThreadMessagesWithReplies.map(renderTimelineMessage)}
                </div>
                <InlineReplyBox
                  value={replyText}
                  onChange={setReplyText}
                  onSend={handleSendInlineReply}
                  attachments={attachments}
                  onAttachFiles={handleAttachInlineReplyFiles}
                  onAttachOrderFiles={handleOpenOrderFilePicker}
                  onSelectOrderFile={handleAttachOrderFile}
                  onCloseOrderFilePicker={closeOrderFilePicker}
                  orderFilePicker={orderFilePicker}
                  onRemoveAttachment={handleRemoveInlineReplyAttachment}
                  isSending={isSendingReply}
                />
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
                        <button
                          type="button"
                          onClick={openAssignToOrderModal}
                          style={{
                            border: "1px solid #e0e7ff",
                            background: "#fff",
                            color: "#4338ca",
                            borderRadius: 7,
                            padding: "5px 8px",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          Assign to Order
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
              <div ref={previewScrollRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 18px", background: "#ffffff" }}>
                {selectedMailboxThreadMessagesWithReplies.length ? (
                  <div style={conversationStackStyle}>
                    {selectedMailboxThreadMessagesWithReplies.map(renderTimelineMessage)}
                  </div>
                ) : (
                  <>
                    {previewMode === "original" && selectedMailboxItem.preview_html ? (
                      <div
                        style={{ maxWidth: "100%", color: "#334155", fontSize: 14, lineHeight: 1.6, wordBreak: "break-word", overflowWrap: "anywhere" }}
                        dangerouslySetInnerHTML={{ __html: selectedMailboxItem.preview_html }}
                      />
                    ) : (
                      <div style={{ maxWidth: "100%", minWidth: 0 }}>
                        {renderReadableMessageBody(
                          selectedMailboxItem.preview_text || selectedMailboxItem.body || selectedMailboxItem.preview || "(No preview available)",
                          selectedOrderLinkState,
                          handleOpenLinkedOrder
                        )}
                      </div>
                    )}
                    {selectedMailboxReplies.length ? (
                      <div style={conversationStackStyle}>
                        {selectedMailboxReplies.map(renderTimelineMessage)}
                      </div>
                    ) : null}
                  </>
                )}
                <InlineReplyBox
                  value={replyText}
                  onChange={setReplyText}
                  onSend={handleSendInlineReply}
                  attachments={attachments}
                  onAttachFiles={handleAttachInlineReplyFiles}
                  onAttachOrderFiles={handleOpenOrderFilePicker}
                  onSelectOrderFile={handleAttachOrderFile}
                  onCloseOrderFilePicker={closeOrderFilePicker}
                  orderFilePicker={orderFilePicker}
                  onRemoveAttachment={handleRemoveInlineReplyAttachment}
                  isSending={isSendingReply}
                />
              </div>
              {selectedEmailAttachments.length ? (
                <div style={{ borderTop: "1px solid #f1f5f9", padding: "12px 18px", background: "#f8fafc" }}>
                  <AttachmentList attachments={selectedEmailAttachments} onOpen={handleOpenAttachment} />
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
              <PreviewMenuItem onClick={() => runInboxContextAction(() => openAssignToOrderModal(inboxContextMenuItem))}>
                Assign to Order
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
              <PreviewMenuItem onClick={() => runPreviewContextAction(() => openAssignToOrderModal())}>
                Assign to Order
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
      {assignToOrderOpen ? (
        <div
          role="presentation"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.45)",
            zIndex: 2000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={() => !assignToOrderBusy && setAssignToOrderOpen(false)}
          onKeyDown={(e) => e.key === "Escape" && !assignToOrderBusy && setAssignToOrderOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="assign-order-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(480px, 100%)",
              maxHeight: "min(560px, 90vh)",
              background: "#fff",
              borderRadius: 12,
              boxShadow: "0 24px 48px rgba(15, 23, 42, 0.2)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "16px 18px", borderBottom: "1px solid #e5e7eb" }}>
              <div id="assign-order-title" style={{ fontSize: 16, fontWeight: 800, color: "#0f172a" }}>
                Assign email to order
              </div>
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 6, lineHeight: 1.45 }}>
                {String(selectedInboxItem?.subject || "(No subject)").slice(0, 120)}
                {String(selectedInboxItem?.subject || "").length > 120 ? "…" : ""}
              </div>
            </div>
            <div style={{ padding: "12px 18px", borderBottom: "1px solid #f1f5f9" }}>
              <label htmlFor="assign-order-search" style={{ fontSize: 11, fontWeight: 700, color: "#64748b", display: "block", marginBottom: 6 }}>
                Search by buyer name or order number
              </label>
              <input
                id="assign-order-search"
                autoFocus
                value={assignToOrderQuery}
                onChange={(e) => setAssignToOrderQuery(e.target.value)}
                placeholder="Type to filter…"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  fontSize: 14,
                }}
              />
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px" }}>
              {assignableOrders.length ? (
                assignableOrders.map((row) => {
                  const oid = String(row?.order_id || row?.id || "").trim();
                  const picked = oid === assignToOrderPickId;
                  return (
                    <button
                      key={oid}
                      type="button"
                      onClick={() => setAssignToOrderPickId(oid)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 12px",
                        marginBottom: 6,
                        borderRadius: 8,
                        border: picked ? "1px solid #6366f1" : "1px solid #e5e7eb",
                        background: picked ? "#eef2ff" : "#fff",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>
                        {String(row?.order_number || "").trim() || "—"}
                      </div>
                      <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                        {String(row?.buyer_name || "").trim() || "—"}
                        {row?.buyer_email ? ` · ${row.buyer_email}` : ""}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div style={{ padding: 16, fontSize: 13, color: "#64748b" }}>No orders match your search.</div>
              )}
            </div>
            <div style={{ padding: "14px 18px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                disabled={assignToOrderBusy}
                onClick={() => setAssignToOrderOpen(false)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  cursor: assignToOrderBusy ? "not-allowed" : "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={assignToOrderBusy || !assignToOrderPickId}
                onClick={() => confirmAssignToOrder()}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "none",
                  background: assignToOrderBusy || !assignToOrderPickId ? "#94a3b8" : "#4338ca",
                  color: "#fff",
                  cursor: assignToOrderBusy || !assignToOrderPickId ? "not-allowed" : "pointer",
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                {assignToOrderBusy ? "Saving…" : "Assign"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
