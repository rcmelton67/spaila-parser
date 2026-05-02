import React from "react";
import AppHeader from "../../shared/components/AppHeader.jsx";
import AttachmentPreviewCard from "../../shared/components/AttachmentPreviewCard.jsx";
import { loadShopConfig } from "../../shared/utils/fieldConfig.js";
import {
  extractEmlUid,
  filterProcessedInboxItems as filterProcessedInboxItemsBase,
  getInboxItemId,
  getProcessedEmailRefVariants,
  mergeInboxItems as mergeInboxItemsBase,
  normalizeProcessedEmailRef,
} from "./inboxMerge.mjs";

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

function sortByTimestamp(a, b) {
  return new Date(a?.timestamp || 0) - new Date(b?.timestamp || 0);
}

function extractReply(text) {
  const value = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!value) return "";
  const lines = value.split("\n");
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
      // order_update = customer reply appended to an existing order.
      // These must remain visible in the inbox as new activity, so we do NOT
      // add their identifiers to processedRefs.
      if (String(msg?.inbox_type || "").toLowerCase() === "order_update") continue;
      for (const value of [msg?.email_id, msg?.message_id, msg?.id]) {
        for (const ref of getProcessedEmailRefVariants(value)) {
          refs.add(ref);
        }
      }
    }
  }
  return refs;
}

function filterProcessedInboxItems(items = [], processedRefs = new Set()) {
  return filterProcessedInboxItemsBase(items, processedRefs, {
    onProcessedRefsExpanded: saveProcessedInboxMemory,
  });
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
  return mergeInboxItemsBase(previousItems, fetchedItems, processedRefs, {
    onProcessedRefsExpanded: saveProcessedInboxMemory,
  });
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

function extractSenderName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const bracketIndex = raw.indexOf("<");
  const candidate = (bracketIndex > 0 ? raw.slice(0, bracketIndex) : raw).replace(/["']/g, "").trim();
  if (!candidate || /@/.test(candidate)) return "";
  return candidate;
}

function normalizeInboundMessage(item, orderMetadata) {
  const id = getInboxItemId(item);
  const orderNumber = resolveMessageOrderNumber(item, orderMetadata);
  const orderInfo = orderNumber ? orderMetadata.byOrderNumber.get(orderNumber) : null;
  const senderEmail = extractEmailAddress(item?.sender_email || item?.reply_to || item?.sender || item?.from || "").toLowerCase();
  const senderName = String(item?.sender_name || "").trim() || extractSenderName(item?.sender || item?.from || "");
  return {
    ...item,
    id,
    message_id: String(item?.message_id || ""),
    email_id: String(item?.email_id || id || ""),
    imap_uid: String(item?.imap_uid || ""),
    direction: "inbound",
    thread_source: "inbox",
    order_number: orderNumber,
    buyer_name: orderInfo?.buyer_name || "",
    buyer_email: orderInfo?.buyer_email || "",
    sender_name: senderName,
    sender_email: senderEmail,
    from: senderEmail || item?.sender || item?.from || "",
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
  const senderEmail = extractEmailAddress(item?.sender_email || item?.from || "").toLowerCase();
  const senderName = String(item?.sender_name || "").trim() || extractSenderName(item?.from || "") || "Spaila";
  return {
    ...item,
    id,
    message_id: String(item?.message_id || id),
    direction: "outbound",
    thread_source: "sent",
    order_number: orderNumber,
    buyer_name: item?.buyer_name || orderInfo?.buyer_name || "",
    buyer_email: item?.buyer_email || orderInfo?.buyer_email || "",
    sender_name: senderName,
    sender_email: senderEmail,
    sender: senderName || senderEmail || "Spaila",
    from: senderEmail || item?.from || "Spaila",
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
  const senderEmail = extractEmailAddress(message?.sender_email || message?.sender || message?.from || order?.buyer_email || "").toLowerCase();
  const senderName = String(message?.sender_name || "").trim() || extractSenderName(message?.sender || message?.from || "");
  return {
    ...message,
    id,
    message_id: String(message?.message_id || message?.id || ""),
    email_id: String(message?.email_id || ""),
    imap_uid: String(message?.imap_uid || ""),
    direction: message?.direction || message?.type || "outbound",
    type: message?.type || message?.direction || "outbound",
    thread_source: "persisted",
    order_number: normalizeOrderNumber(order?.order_number),
    buyer_name: order?.buyer_name || "",
    buyer_email: order?.buyer_email || "",
    sender_name: senderName,
    sender_email: senderEmail,
    from: senderEmail || message?.from || message?.sender || "",
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
  const senderEmail = extractEmailAddress(item?.sender_email || item?.reply_to || item?.sender || item?.from || "").toLowerCase();
  const senderName = String(item?.sender_name || "").trim() || extractSenderName(item?.sender || item?.from || "");
  return {
    ...item,
    id,
    message_id: String(item?.message_id || ""),
    email_id: String(item?.email_id || id || ""),
    imap_uid: String(item?.imap_uid || ""),
    direction,
    type: direction,
    order_number: normalizeOrderNumber(linkedOrder?.order_number),
    buyer_name: linkedOrder?.buyer_name || "",
    buyer_email: linkedOrder?.buyer_email || "",
    thread_source: mode === "sent" ? "sent" : "inbox",
    sender_name: senderName,
    sender_email: senderEmail,
    from: senderEmail || item?.sender || item?.from || "",
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
  const senderEmail = extractEmailAddress(item?.sender_email || item?.from || "").toLowerCase();
  const senderName = String(item?.sender_name || "").trim() || extractSenderName(item?.from || "") || "Spaila";
  return {
    ...item,
    id: messageId,
    message_id: String(item?.message_id || messageId),
    status: "sent",
    direction: "outbound",
    type: "outbound",
    thread_source: "sent",
    order_number: normalizeOrderNumber(linkedOrder?.order_number),
    buyer_name: linkedOrder?.buyer_name || item?.buyer_name || "",
    buyer_email: linkedOrder?.buyer_email || item?.buyer_email || "",
    sender_name: senderName,
    sender_email: senderEmail,
    from: senderEmail || item?.from || "Spaila",
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

function parseMessageTimeMs(message) {
  const raw = message?.timestamp || message?.received_at || "";
  const ms = Date.parse(String(raw || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizeMessageBodyForMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hashThreadBody(value) {
  const text = normalizeMessageBodyForMatch(value).toLowerCase();
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return String(hash >>> 0);
}

function normalizeThreadTimestamp(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return "";
  return new Date(Math.round(ms / 1000) * 1000).toISOString();
}

function getCanonicalMessageSignature(message) {
  const normalizedMessageId = normalizeMessageIdForLink(message?.message_id || message?.id || "");
  if (normalizedMessageId && normalizedMessageId.includes("@")) {
    return `message-id:${normalizedMessageId}`;
  }

  for (const value of [
    message?.email_id,
    message?.imap_uid,
    message?.source_item?.email_id,
    message?.source_item?.imap_uid,
    normalizedMessageId && !normalizedMessageId.startsWith("temp_") && !normalizedMessageId.startsWith("order-message:")
      ? normalizedMessageId
      : "",
  ]) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) return `mailbox-id:${normalized}`;
  }

  const senderEmail = extractEmailAddress(message?.sender_email || message?.from || message?.sender || "").toLowerCase();
  const timestamp = normalizeThreadTimestamp(message?.timestamp || message?.received_at || "");
  const body = message?.body || message?.preview_text || message?.preview || "";
  const bodyHash = body ? hashThreadBody(body) : "";
  if (senderEmail && timestamp && bodyHash) {
    return `fallback:${senderEmail}:${timestamp}:${bodyHash}`;
  }
  return "";
}

function getThreadSource(message) {
  return String(message?.thread_source || message?.source || "").trim().toLowerCase() || "unknown";
}

function getThreadSourcePriority(message) {
  const source = getThreadSource(message);
  if (source === "persisted" || source === "order") return 4;
  if (source === "sent") return 3;
  if (source === "inbox") return 2;
  return 1;
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
  score += getThreadSourcePriority(message) * 10;
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

function chooseRemovedDuplicate(existing, incoming) {
  return messageConfidenceScore(incoming) >= messageConfidenceScore(existing) ? existing : incoming;
}

function logThreadDedupe({ signature, sourceRemoved, duplicatesRemoved }) {
  if (!duplicatesRemoved) return;
  console.log("[THREAD DEDUPE]", {
    signature,
    source_removed: sourceRemoved,
    duplicates_removed: duplicatesRemoved,
  });
}

function dedupeMessages(messages = []) {
  const merged = [];
  const signatureIndexes = new Map();
  for (const candidate of messages) {
    const signature = getCanonicalMessageSignature(candidate);
    let index = signature ? signatureIndexes.get(signature) : -1;
    if (index === undefined) index = -1;
    if (index === -1) {
      index = merged.findIndex((existing) => areLikelySameOutboundMessage(existing, candidate));
    }
    if (index === -1) {
      merged.push(candidate);
      if (signature) signatureIndexes.set(signature, merged.length - 1);
      continue;
    }
    const existing = merged[index];
    const removed = chooseRemovedDuplicate(existing, candidate);
    const mergedRecord = mergeMessageRecord(existing, candidate);
    merged[index] = mergedRecord;
    const nextSignature = getCanonicalMessageSignature(mergedRecord) || signature;
    if (nextSignature) signatureIndexes.set(nextSignature, index);
    logThreadDedupe({
      signature: nextSignature || signature || "(likely-outbound)",
      sourceRemoved: getThreadSource(removed),
      duplicatesRemoved: 1,
    });
  }
  return merged;
}

function dedupeConversationMessages(messages = []) {
  return dedupeMessages(messages);
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
  const messageKey = (message) => getCanonicalMessageSignature(message) || String(message?.id || "").trim();
  const builtById = new Map((builtMessages || []).map((message) => [messageKey(message), message]).filter(([key]) => key));
  const previousIds = new Set(previousMessages.map(messageKey).filter(Boolean));
  const newMessages = (builtMessages || []).filter((message) => {
    const key = messageKey(message);
    return key && !previousIds.has(key);
  });
  const updatedMessages = previousMessages
    .map((message) => {
      const key = messageKey(message);
      return key && builtById.has(key) ? mergeMessageRecord(message, builtById.get(key)) : null;
    })
    .filter(Boolean);
  return dedupeMessages([...newMessages, ...updatedMessages]);
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

function normalizeTextForActivityMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function getInboxItemLinkedOrder(item, orders, orderUpdateLinks) {
  const emailId = getInboxItemId(item);
  const imapUid = String(item?.imap_uid || "").trim().toLowerCase();
  const messageId = normalizeMessageIdForLink(item?.message_id || "");
  return (
    (emailId && orderUpdateLinks?.get(String(emailId).toLowerCase())) ||
    (imapUid && orderUpdateLinks?.get(imapUid)) ||
    (messageId && orderUpdateLinks?.get(messageId)) ||
    buildOrderLinkState(item, orders).linkedOrder ||
    null
  );
}

function doOrdersReferToSameOrder(left, right) {
  const leftId = String(left?.order_id || left?.id || "").trim();
  const rightId = String(right?.order_id || right?.id || "").trim();
  if (leftId && rightId && leftId === rightId) return true;
  const leftNumber = normalizeOrderNumber(left?.order_number);
  const rightNumber = normalizeOrderNumber(right?.order_number);
  return Boolean(leftNumber && rightNumber && leftNumber === rightNumber);
}

function doesInboxItemMatchActivityEvent(item, event, orders, orderUpdateLinks) {
  if (String(event?.type || "").toLowerCase() !== "order_update") return false;
  const linkedOrder = getInboxItemLinkedOrder(item, orders, orderUpdateLinks);
  if (!doOrdersReferToSameOrder(linkedOrder, event)) return false;

  const eventPreview = normalizeTextForActivityMatch(event?.preview);
  const itemPreview = normalizeTextForActivityMatch(item?.preview_text || item?.preview || item?.body);
  if (eventPreview && itemPreview) {
    const shortPreview = eventPreview.slice(0, Math.min(80, Math.max(24, eventPreview.length)));
    const shortItemPreview = itemPreview.slice(0, Math.min(80, Math.max(24, itemPreview.length)));
    return itemPreview.includes(shortPreview) || eventPreview.includes(shortItemPreview);
  }

  const eventMs = parseMsForMatch(event?.timestamp || event?.created_at);
  const itemMs = parseMsForMatch(item?.timestamp || item?.received_at || item?.created_at);
  const SAME_REPLY_WINDOW_MS = 5 * 60 * 1000;
  return !Number.isNaN(eventMs) && !Number.isNaN(itemMs) && Math.abs(eventMs - itemMs) <= SAME_REPLY_WINDOW_MS;
}

function doesOrderMessageMatchActivityEvent(message, event) {
  if (String(message?.type || message?.direction || "").toLowerCase() !== "inbound") return { matched: false, reason: "" };
  if (String(message?.inbox_type || "").toLowerCase() !== "order_update") return { matched: false, reason: "" };
  const eventPreview = normalizeTextForActivityMatch(event?.preview);
  const messagePreview = normalizeTextForActivityMatch(message?.body || message?.preview_text || message?.preview);
  if (eventPreview && messagePreview) {
    const shortPreview = eventPreview.slice(0, Math.min(80, Math.max(24, eventPreview.length)));
    const shortMessagePreview = messagePreview.slice(0, Math.min(80, Math.max(24, messagePreview.length)));
    if (messagePreview.includes(shortPreview) || eventPreview.includes(shortMessagePreview)) {
      return { matched: true, reason: "preview" };
    }
  }

  const eventMs = parseMsForMatch(event?.timestamp || event?.created_at);
  const messageMs = parseMsForMatch(message?.timestamp || message?.received_at || message?.created_at);
  const SAME_REPLY_WINDOW_MS = 5 * 60 * 1000;
  if (!Number.isNaN(eventMs) && !Number.isNaN(messageMs) && Math.abs(eventMs - messageMs) <= SAME_REPLY_WINDOW_MS) {
    return { matched: true, reason: "timestamp" };
  }
  return { matched: false, reason: "" };
}

function findOrderLinkedActivityMessage(event, orders) {
  if (String(event?.type || "").toLowerCase() !== "order_update") return null;
  for (const order of orders || []) {
    if (!doOrdersReferToSameOrder(order, event)) continue;
    const messages = Array.isArray(order?.messages) ? order.messages : [];
    for (const message of messages) {
      const match = doesOrderMessageMatchActivityEvent(message, event);
      if (match.matched) {
        return { order, message, reason: match.reason };
      }
    }
  }
  return null;
}

function doInboxItemAndOrderMessageRepresentSameEmail(item, message) {
  const itemEmailId = String(getInboxItemId(item) || "").trim().toLowerCase();
  const itemImapUid = String(item?.imap_uid || "").trim().toLowerCase();
  const itemMessageId = normalizeMessageIdForLink(item?.message_id || itemEmailId);
  const messageEmailId = String(message?.email_id || "").trim().toLowerCase();
  const messageMessageId = normalizeMessageIdForLink(message?.message_id || message?.id);

  if (itemMessageId && messageMessageId && itemMessageId === messageMessageId) {
    return { matched: true, reason: "message_id" };
  }
  if (itemEmailId && messageMessageId && itemEmailId === messageMessageId) {
    return { matched: true, reason: "message_id" };
  }
  if (itemImapUid && messageEmailId && itemImapUid === messageEmailId) {
    return { matched: true, reason: "imap_uid" };
  }
  if (itemEmailId && messageEmailId && itemEmailId === messageEmailId) {
    return { matched: true, reason: "email_id" };
  }

  const itemSender = extractEmailAddress(item?.sender_email || item?.reply_to || item?.sender || item?.from || "").toLowerCase();
  const messageSender = extractEmailAddress(message?.sender_email || message?.reply_to || message?.sender || message?.from || "").toLowerCase();
  const itemMs = parseMsForMatch(item?.timestamp || item?.received_at || item?.created_at);
  const messageMs = parseMsForMatch(message?.timestamp || message?.received_at || message?.created_at);
  const itemBody = item?.body || item?.preview_text || item?.preview || "";
  const messageBody = message?.body || message?.preview_text || message?.preview || "";
  const itemBodyHash = itemBody ? hashThreadBody(itemBody) : "";
  const messageBodyHash = messageBody ? hashThreadBody(messageBody) : "";
  const SIGNATURE_WINDOW_MS = 10 * 1000;
  if (
    itemSender
    && messageSender
    && itemSender === messageSender
    && itemBodyHash
    && messageBodyHash
    && itemBodyHash === messageBodyHash
    && !Number.isNaN(itemMs)
    && !Number.isNaN(messageMs)
    && Math.abs(itemMs - messageMs) <= SIGNATURE_WINDOW_MS
  ) {
    return { matched: true, reason: "sender_body_timestamp" };
  }

  return { matched: false, reason: "" };
}

function isTrashEntryActive(entry) {
  return Boolean(entry && (entry.deleted_at || String(entry.status || "").toLowerCase() === "trash" || entry.item));
}

function findTrashEntryForMessage(message, trashMap) {
  for (const [emailId, entry] of Object.entries(trashMap || {})) {
    if (!isTrashEntryActive(entry)) continue;
    const trashItem = entry.item || {};
    const signatureMatch = doInboxItemAndOrderMessageRepresentSameEmail(trashItem, message);
    if (signatureMatch.matched) {
      return { emailId, entry, reason: signatureMatch.reason };
    }
  }
  return null;
}

function findTrashEntryForInboxItem(item, trashMap) {
  const emailId = getInboxItemId(item);
  const imapUid = String(item?.imap_uid || "").trim();
  if (emailId && isTrashEntryActive(trashMap?.[emailId])) {
    return { emailId, entry: trashMap[emailId], reason: "email_id" };
  }
  for (const [trashEmailId, entry] of Object.entries(trashMap || {})) {
    if (!isTrashEntryActive(entry)) continue;
    const trashItem = entry.item || {};
    const trashItemId = getInboxItemId(trashItem);
    const trashImapUid = String(trashItem?.imap_uid || "").trim();
    if (emailId && trashItemId && String(emailId).toLowerCase() === String(trashItemId).toLowerCase()) {
      return { emailId: trashEmailId, entry, reason: "email_id" };
    }
    if (imapUid && trashImapUid && imapUid.toLowerCase() === trashImapUid.toLowerCase()) {
      return { emailId: trashEmailId, entry, reason: "imap_uid" };
    }
    const signatureMatch = doInboxItemAndOrderMessageRepresentSameEmail(item, trashItem);
    if (signatureMatch.matched) {
      return { emailId: trashEmailId, entry, reason: signatureMatch.reason };
    }
  }
  return null;
}

function findTrashEntryForActivityEvent(event, trashMap, orders, orderUpdateLinks) {
  for (const [emailId, entry] of Object.entries(trashMap || {})) {
    if (!isTrashEntryActive(entry)) continue;
    const trashItem = entry.item || {};
    if (doesInboxItemMatchActivityEvent(trashItem, event, orders, orderUpdateLinks)) {
      return { emailId, entry, reason: "activity_signature" };
    }
  }

  const orderLinkedMessageMatch = findOrderLinkedActivityMessage(event, orders);
  if (!orderLinkedMessageMatch) return null;
  const trashMatch = findTrashEntryForMessage(orderLinkedMessageMatch.message, trashMap);
  if (!trashMatch) return null;
  return {
    ...trashMatch,
    order: orderLinkedMessageMatch.order,
    message: orderLinkedMessageMatch.message,
    reason: `order_message_${trashMatch.reason}`,
  };
}

function findSourceDeletedInboxItemForActivityEvent(event, sourceDeletedItems, orders, orderUpdateLinks) {
  for (const item of sourceDeletedItems || []) {
    if (doesInboxItemMatchActivityEvent(item, event, orders, orderUpdateLinks)) {
      return { item, reason: "activity_signature" };
    }
  }

  const orderLinkedMessageMatch = findOrderLinkedActivityMessage(event, orders);
  if (!orderLinkedMessageMatch) return null;
  for (const item of sourceDeletedItems || []) {
    const linkedOrder = getInboxItemLinkedOrder(item, orders, orderUpdateLinks);
    if (!doOrdersReferToSameOrder(linkedOrder, orderLinkedMessageMatch.order)) continue;
    const signatureMatch = doInboxItemAndOrderMessageRepresentSameEmail(item, orderLinkedMessageMatch.message);
    if (signatureMatch.matched) {
      return {
        item,
        order: orderLinkedMessageMatch.order,
        message: orderLinkedMessageMatch.message,
        reason: `order_message_${signatureMatch.reason}`,
      };
    }
  }
  return null;
}

function getInboxItemHandledState(item, orders) {
  if (item?.manual_imported === true) {
    return { handled: false, reason: "manual_import" };
  }
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
      // order_update messages are customer replies that must remain visible in the
      // inbox as new activity.  Skip them in all handled-state checks so they are
      // never silently hidden.
      if (String(msg?.inbox_type || "").toLowerCase() === "order_update") continue;
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

function isAbsoluteLocalPath(value) {
  const raw = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\");
}

function localFileSrc(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw || !isAbsoluteLocalPath(raw)) return "";
  return `file:///${raw.replace(/\\/g, "/").replace(/^\/+/, "")}`;
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

function isImageAttachment(attachment) {
  const name = getAttachmentDisplayName(attachment).toLowerCase();
  const type = getAttachmentType(attachment);
  return type.includes("image") || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}

function attachmentPreviewSrc(attachment) {
  const openPath = getAttachmentOpenPath(attachment);
  if (!openPath || !isAbsoluteLocalPath(openPath) || !isImageAttachment(attachment)) return "";
  return localFileSrc(openPath);
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
      path: getAttachmentOpenPath(attachment),
    };
  }) : [];
}

function normalizeOutboundAttachmentsForHistory(paths, timestamp = new Date().toISOString()) {
  return (Array.isArray(paths) ? paths : [])
    .map((filePath) => String(filePath || "").trim())
    .filter(Boolean)
    .map((filePath) => ({
      file: getAttachmentDisplayName(filePath),
      filename: getAttachmentDisplayName(filePath),
      name: getAttachmentDisplayName(filePath),
      path: filePath,
      original_path: filePath,
      mime_type: getAttachmentType(filePath),
      type: getAttachmentType(filePath),
      source: "outbound_send",
      direction: "outbound",
      timestamp,
    }));
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

function WorkspaceIdentityPanel({ shopName, shopLogoPath }) {
  const logoSrc = localFileSrc(shopLogoPath);
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
      <div style={{ width: "100%", maxWidth: 520, transform: "translateY(-54px)" }}>
        {logoSrc ? (
          <div style={{ marginBottom: 20 }}>
            <img
              src={logoSrc}
              alt={`${shopName} logo`}
              style={{
                maxWidth: 320,
                maxHeight: 213,
                objectFit: "contain",
              }}
            />
          </div>
        ) : null}
        <h1 style={{
          margin: 0,
          fontSize: 36,
          lineHeight: 1.15,
          fontWeight: 800,
          color: "#0f172a",
          letterSpacing: "-0.03em",
          textShadow: "0 3px 5px rgba(0,0,0,0.28)",
        }}>
          {shopName}
        </h1>
        <div style={{ marginTop: 8, fontSize: 13, fontWeight: 650, color: "#94a3b8" }}>
          Powered by Spaila
        </div>
        <div style={{ maxWidth: 540, margin: "28px auto 0", fontSize: 13, lineHeight: 1.55, color: "#6b7280", textAlign: "center" }}>
          <p style={{ margin: 0 }}>
            Workspace is your communication hub for customer conversations and orders in Spaila.
          </p>
          <p style={{ margin: "9px 0 0" }}>
            Use it to review emails, manage orders, and respond efficiently—while your full email client remains available when needed.
          </p>
        </div>
        <div style={{ marginTop: 28, fontSize: 15, fontWeight: 650, color: "#cbd5e1", display: "inline-flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 24, lineHeight: 1, color: "#94a3b8" }}>←</span>
          <span>Select an email to begin</span>
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
          <AttachmentPreviewCard
            key={`${attachment.name || "attachment"}-${attachment.path || attachment.url || (attachment.attachmentIndex ?? index)}`}
            attachment={attachment}
            compact={compact}
            maxWidth={compact ? 260 : 340}
            onOpen={onOpen}
          />
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
  onOpenAttachment,
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
              <AttachmentPreviewCard
                key={`${file.name || "attachment"}-${file.size || 0}-${file.lastModified || index}`}
                attachment={file}
                compact
                removable
                maxWidth={290}
                onOpen={onOpenAttachment}
                onRemove={() => onRemoveAttachment?.(index)}
              />
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

// ── Email trash (localStorage) ───────────────────────────────────────────────
const TRASH_KEY = "spaila.emailTrash";
const DEFAULT_TRASH_RETENTION_DAYS = 30;
const TRASH_PURGE_INTERVAL_MS = 60 * 60 * 1000;
const TRASH_DELETE_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const MAIL_SERVICE_STATUS_INTERVAL_MS = 90 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function loadTrashFromStorage() {
  try {
    const raw = localStorage.getItem(TRASH_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}

function saveTrashToStorage(map) {
  try { localStorage.setItem(TRASH_KEY, JSON.stringify(map)); } catch {}
}

function getExpiredTrashEntries(trashMap, retentionDays, now = Date.now()) {
  const retentionMs = (Number(retentionDays) || DEFAULT_TRASH_RETENTION_DAYS) * DAY_MS;
  return Object.entries(trashMap || {}).filter(([, entry]) => {
    if (!entry?.deleted_at) return false;
    const deletedAt = new Date(entry.deleted_at).getTime();
    if (Number.isNaN(deletedAt)) return false;
    if (deletedAt > now) return false;
    const ageMs = now - deletedAt;
    return ageMs >= retentionMs;
  });
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
  const [mailSearchQuery, setMailSearchQuery] = React.useState("");
  const [searchSelectedSource, setSearchSelectedSource] = React.useState("inbox");
  const [checkedEmailIds, setCheckedEmailIds] = React.useState(() => new Set());
  const [showEmlInstructions, setShowEmlInstructions] = React.useState(false);
  const [inboxContextMenu, setInboxContextMenu] = React.useState(null);
  const [previewContextMenu, setPreviewContextMenu] = React.useState(null);
  const [imapConnected, setImapConnected] = React.useState(false);
  const [imapChecking, setImapChecking] = React.useState(false);
  const [mailServiceState, setMailServiceState] = React.useState(null);
  const [lastInboxFetchAt, setLastInboxFetchAt] = React.useState(null);
  const [clockTick, setClockTick] = React.useState(() => Date.now());
  const [ordersForLinking, setOrdersForLinking] = React.useState([]);
  const [inboxEvents, setInboxEvents] = React.useState([]);
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
  const [emailTrash, setEmailTrash] = React.useState({});
  const trashRef = React.useRef({});
  const previousImapConnectedRef = React.useRef(false);
  const startupInboxFetchRef = React.useRef(false);
  const previewScrollRef = React.useRef(null);
  const bottomRef = React.useRef(null);
  const lastConversationKeyRef = React.useRef("");
  const lastMessageCountRef = React.useRef(0);
  const hasRestoredSelectionRef = React.useRef(false);

  const loadWorkspace = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextState, ordersRaw, refsData, eventsRaw] = await Promise.all([
        window.parserApp?.getWorkspaceState?.({
          bucket: "Inbox",
          relativePath: "",
        }),
        fetchOrdersForLinking().catch(() => []),
        fetch("http://127.0.0.1:8055/inbox/processed-refs")
          .then((r) => r.json())
          .catch(() => ({})),
        fetch("http://127.0.0.1:8055/inbox/events")
          .then((r) => r.json())
          .catch(() => []),
      ]);
      if (Array.isArray(eventsRaw)) setInboxEvents(eventsRaw);

      // Merge backend-persisted refs (written during filesystem archive offloads)
      // into localStorage BEFORE buildProcessedEmailRefs seeds from it.
      // This guarantees inbox filtering works even when the Workspace never
      // loaded the order that was archived.
      if (Array.isArray(refsData?.refs) && refsData.refs.length > 0) {
        const mem = loadProcessedInboxMemory();
        let added = 0;
        for (const ref of refsData.refs) {
          const n = String(ref || "").trim().toLowerCase();
          if (n && !mem.has(n)) { mem.add(n); added += 1; }
        }
        if (added > 0) {
          saveProcessedInboxMemory(mem);
          console.log("[INBOX_REFS_MERGED_FROM_BACKEND]", { added, total: mem.size });
        }
      }

      const orders = (Array.isArray(ordersRaw) ? ordersRaw : []).filter(
        (o) => String(o?.status || "").toLowerCase() !== "archived"
      );
      const processedRefs = buildProcessedEmailRefs(orders);
      const nextInboxItems = filterProcessedInboxItems(nextState?.inboxItems || [], processedRefs);
      const visibilityDiagnostics = nextState?.inboxVisibilityDiagnostics || {};
      if (
        Number(visibilityDiagnostics.inboxEmlCount || 0) === 0
        && Number(visibilityDiagnostics.unmatchedEmlCount || 0) > 0
      ) {
        console.warn("[INBOX_VISIBILITY_INVARIANT]", {
          reason: "visible_inbox_empty_with_unmatched_files",
          ...visibilityDiagnostics,
        });
      }
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

      // Before updating state, persist all email refs belonging to orders that are
      // about to disappear from the active list (e.g. hard-deleted by filesystem archive).
      // This ensures inbox filtering keeps working even after those DB rows are gone.
      setOrdersForLinking((prevOrders) => {
        const newIds = new Set(orders.map((o) => o.order_id));
        const departed = prevOrders.filter((o) => !newIds.has(o.order_id));
        if (departed.length > 0) {
          const existingRefs = loadProcessedInboxMemory();
          for (const order of departed) {
            for (const emlPath of [order?.source_eml_path, order?.eml_path]) {
              for (const ref of getProcessedEmailRefVariants(emlPath)) {
                existingRefs.add(ref);
              }
              const uid = extractEmlUid(emlPath);
              if (uid) existingRefs.add(uid);
            }
            const messages = Array.isArray(order?.messages) ? order.messages : [];
            for (const msg of messages) {
              const dir = String(msg?.type || msg?.direction || "").toLowerCase();
              if (dir !== "inbound") continue;
              for (const value of [msg?.email_id, msg?.message_id, msg?.id]) {
                for (const ref of getProcessedEmailRefVariants(value)) {
                  existingRefs.add(ref);
                }
              }
            }
          }
          saveProcessedInboxMemory(existingRefs);
          console.log("[INBOX_ARCHIVE_REFS_SAVED]", {
            departed_orders: departed.length,
            total_refs: existingRefs.size,
          });
        }
        return orders;
      });

      const processedRefs = buildProcessedEmailRefs(orders);
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
        filePath: item?.path,
        path: item?.path,
      });
      return { ok: !!result?.ok, error: result?.error, workspaceOnly: true };
    }
    const result = await window.parserApp?.hideInboxItem?.({
      emailId,
      email_id: emailId,
      imap_uid: item?.imap_uid,
      filePath: item?.path,
      path: item?.path,
    });
    return { ok: !!result?.ok, error: result?.error, workspaceOnly: false };
  }, [ordersForLinking]);

  const checkImapConnection = React.useCallback(async ({ showError = false } = {}) => {
    if (!workspaceState?.imapConfigured) {
      setImapConnected(false);
      setMailServiceState(null);
      if (showError) {
        setDropMessage("Email connection unavailable. Cannot delete from account.");
      }
      return false;
    }
    setImapChecking(true);
    try {
      const response = await fetch("http://127.0.0.1:8055/inbox/service/status", { method: "GET" });
      const payload = await response.json().catch(() => ({}));
      const connected = !!(response.ok && payload?.connected);
      setMailServiceState(payload);
      setImapConnected(connected);
      if (!connected && showError) {
        setDropMessage("Email connection unavailable. Cannot delete from account.");
      }
      return connected;
    } catch (_error) {
      setImapConnected(false);
      setMailServiceState(null);
      if (showError) {
        setDropMessage("Email connection unavailable. Cannot delete from account.");
      }
      return false;
    } finally {
      setImapChecking(false);
    }
  }, [workspaceState?.imapConfigured]);

  const fetchInbox = React.useCallback(async ({ manual = false, reason = "auto" } = {}) => {
    if (!workspaceState?.imapConfigured) {
      if (manual) {
        setDropMessage("Email connection unavailable. Cannot refresh inbox.");
      }
      return false;
    }

    setRefreshingInbox(true);
    try {
      if (!imapConnected) {
        await fetch("http://127.0.0.1:8055/inbox/service/start", { method: "POST" }).catch(() => null);
      }
      const response = await fetch("http://127.0.0.1:8055/inbox/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true }),
      });

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
    } catch (err) {
      console.error("[INBOX FETCH ERROR]", err);
      setDropMessage(err.message || "Could not refresh inbox.");
      return false;
    } finally {
      setRefreshingInbox(false);
    }
  }, [checkImapConnection, imapConnected, loadWorkspace, workspaceState?.imapConfigured]);

  React.useEffect(() => {
    if (startupInboxFetchRef.current || !workspaceState?.imapConfigured) return;
    startupInboxFetchRef.current = true;
    fetchInbox({ manual: false, reason: "startup" });
  }, [fetchInbox, workspaceState?.imapConfigured]);

  const inboxItems = workspaceState?.inboxItems || [];
  const sourceDeletedInboxItems = React.useMemo(
    () => inboxItems.filter((item) => item?.source_deleted === true),
    [inboxItems],
  );

  // Map: normalised email_id / imap_uid → order, built from inbox_type='order_update' messages.
  // Used by renderUnlinkedRow to show "Reply for Order #XXX" and offer a direct link.
  const orderUpdateLinks = React.useMemo(() => {
    const map = new Map();
    for (const order of ordersForLinking || []) {
      const messages = Array.isArray(order?.messages) ? order.messages : [];
      for (const msg of messages) {
        if (String(msg?.inbox_type || "").toLowerCase() !== "order_update") continue;
        for (const key of [msg?.email_id, msg?.message_id, msg?.id, normalizeMessageIdForLink(msg?.message_id || msg?.id)]) {
          const k = String(key || "").trim().toLowerCase();
          if (k) map.set(k, order);
        }
      }
    }
    return map;
  }, [ordersForLinking]);

  const displayInboxItems = React.useMemo(() => {
    const out = [];
    for (const item of inboxItems) {
      const emailId = getInboxItemId(item);
      const imapUid = String(item?.imap_uid || "").trim();
      const trashMatch = findTrashEntryForInboxItem(item, emailTrash);
      if (trashMatch) {
        console.log("[SIGNATURE_TRASH_MATCH]", { email_id: emailId || "(unknown)", trash_email_id: trashMatch.emailId, reason: trashMatch.reason });
        console.log("[MESSAGE_HIDDEN_BY_TRASH]", { email_id: emailId || "(unknown)", trash_email_id: trashMatch.emailId, surface: "inbox" });
        console.log("[TRASH_VISIBILITY_SUPPRESS]", { email_id: emailId || "(unknown)", reason: "local_trash" });
        continue;
      }
      if ((emailId && pendingRemovals[emailId]) || (imapUid && pendingRemovals[imapUid])) {
        console.log("[INBOX_FILTER]", { email_id: emailId || "(unknown)", reason: "pending_removal" });
        continue;
      }
      if (item?.source_deleted === true && item?.manual_imported !== true) {
        console.log("[INBOX_SUPPRESS_PROVIDER_DELETE]", {
          email_id: emailId || "(unknown)",
          imap_uid: imapUid,
          surface: "inbox",
        });
        const { handled } = getInboxItemHandledState(item, ordersForLinking);
        if (handled) {
          console.log("[THREAD_RETAIN_LOCAL]", {
            email_id: emailId || "(unknown)",
            imap_uid: imapUid,
            reason: "source_deleted_active_suppressed",
          });
        }
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
  }, [emailTrash, inboxItems, ordersForLinking, pendingRemovals]);
  const displayInboxIdKey = React.useMemo(
    () => displayInboxItems.map(getInboxItemId).filter(Boolean).join("|"),
    [displayInboxItems],
  );
  const visibleInboxActivityEvents = React.useMemo(
    () => inboxEvents.filter((event) => {
      const trashMatch = findTrashEntryForActivityEvent(event, emailTrash, ordersForLinking, orderUpdateLinks);
      if (trashMatch) {
        console.log("[SIGNATURE_TRASH_MATCH]", {
          event_id: event?.id || "",
          trash_email_id: trashMatch.emailId,
          reason: trashMatch.reason,
        });
        console.log("[MESSAGE_HIDDEN_BY_TRASH]", {
          event_id: event?.id || "",
          trash_email_id: trashMatch.emailId,
          surface: "activity",
        });
        console.log("[ACTIVITY_TRASH_FILTER]", { event_id: event?.id || "", trash_email_id: trashMatch.emailId });
        console.log("[TRASH_VISIBILITY_SUPPRESS]", { event_id: event?.id || "", reason: "local_trash" });
        return false;
      }

      const sourceDeletedMatch = findSourceDeletedInboxItemForActivityEvent(
        event,
        sourceDeletedInboxItems,
        ordersForLinking,
        orderUpdateLinks,
      );
      if (sourceDeletedMatch) {
        const suppressedItemId = getInboxItemId(sourceDeletedMatch.item);
        console.log("[SOURCE_DELETED_PROVIDER]", {
          event_id: event?.id || "",
          email_id: suppressedItemId || "",
          imap_uid: sourceDeletedMatch.item?.imap_uid || "",
        });
        console.log("[PROVIDER_MISSING_MESSAGE]", {
          event_id: event?.id || "",
          email_id: suppressedItemId || "",
          reason: sourceDeletedMatch.reason,
        });
        console.log("[INBOX_SUPPRESS_PROVIDER_DELETE]", {
          event_id: event?.id || "",
          email_id: suppressedItemId || "",
          surface: "activity",
          reason: sourceDeletedMatch.reason,
        });
        if (sourceDeletedMatch.order || String(sourceDeletedMatch.item?.linked_order_id || "").trim()) {
          console.log("[THREAD_RETAIN_LOCAL]", {
            event_id: event?.id || "",
            email_id: suppressedItemId || "",
            reason: "source_deleted_active_suppressed",
          });
        }
        return false;
      }

      const directInboxMatch = displayInboxItems.some((item) => doesInboxItemMatchActivityEvent(item, event, ordersForLinking, orderUpdateLinks));
      if (directInboxMatch) {
        console.log("[ACTIVITY_SUPPRESSED]", { event_id: event?.id || "", reason: "display_inbox_match" });
        return false;
      }

      const orderLinkedMessageMatch = findOrderLinkedActivityMessage(event, ordersForLinking);
      if (!orderLinkedMessageMatch) return true;

      const representedByLinkedInbox = displayInboxItems.some((item) => {
        const linkedOrder = getInboxItemLinkedOrder(item, ordersForLinking, orderUpdateLinks);
        if (!doOrdersReferToSameOrder(linkedOrder, orderLinkedMessageMatch.order)) return false;
        const signatureMatch = doInboxItemAndOrderMessageRepresentSameEmail(item, orderLinkedMessageMatch.message);
        if (signatureMatch.matched) {
          console.log("[MESSAGE_SIGNATURE_MATCH]", {
            event_id: event?.id || "",
            email_id: getInboxItemId(item) || "",
            order_id: orderLinkedMessageMatch.order?.order_id || orderLinkedMessageMatch.order?.id || "",
            reason: signatureMatch.reason,
          });
        }
        return signatureMatch.matched;
      });

      if (representedByLinkedInbox) {
        console.log("[ORDER_LINKED_PRIORITY]", {
          event_id: event?.id || "",
          order_id: orderLinkedMessageMatch.order?.order_id || orderLinkedMessageMatch.order?.id || "",
        });
        console.log("[INBOX_DEDUPE]", { event_id: event?.id || "", reason: "order_linked_priority" });
        console.log("[ACTIVITY_SUPPRESSED]", { event_id: event?.id || "", reason: "order_linked_priority" });
        return false;
      }

      return true;
    }),
    [displayInboxItems, emailTrash, inboxEvents, orderUpdateLinks, ordersForLinking, sourceDeletedInboxItems],
  );
  const sentMessages = workspaceState?.sentMessages || [];
  const buckets = workspaceState?.buckets || [];
  const inboxPath = workspaceState?.inboxPath || buckets.find((item) => item.key === "Inbox")?.path || "";
  const imapConfigured = !!workspaceState?.imapConfigured;
  const canFetchInbox = imapConfigured && imapConnected;
  const canDeleteFromAccount = canFetchInbox;
  const lastUpdatedLabel = formatLastUpdated(lastInboxFetchAt, clockTick);
  const mailServiceRunning = !!mailServiceState?.running;
  const mailServiceBusy = !!mailServiceState?.in_flight || refreshingInbox;
  const showInboxEmptyState = !loading && inboxItems.length === 0 && sentMessages.length === 0;
  const displayInboxPath = inboxPath || "C:\\Spaila\\Inbox";
  const inboxModeItems = displayInboxItems.filter((item) => String(item.direction || "inbound").toLowerCase() === "inbound");
  const sentItems = sentMessages.filter((item) => String(item.direction || "outbound").toLowerCase() === "outbound");
  const checkedInboxItems = displayInboxItems.filter((item) => checkedEmailIds.has(getInboxItemId(item)));

  const mailSearchResults = React.useMemo(() => {
    const q = mailSearchQuery.toLowerCase().trim();
    if (!q) return [];
    const seen = new Set();
    const results = [];
    function matchItem(item, source) {
      if (!item) return false;
      const linkedOrder = source === "inbox" || source === "trash"
        ? getInboxItemLinkedOrder(item, ordersForLinking, orderUpdateLinks)
        : null;
      return [
        item.subject,
        item.sender,
        item.from,
        item.to,
        item.preview_text,
        item.preview,
        item.name,
        item.buyer_name,
        item.order_number,
        linkedOrder?.order_number,
        linkedOrder?.buyer_name,
        linkedOrder?.buyer_email,
      ]
        .some((f) => String(f || "").toLowerCase().includes(q));
    }
    for (const item of displayInboxItems) {
      const id = getInboxItemId(item);
      if (id && !seen.has(id) && matchItem(item, "inbox")) { seen.add(id); results.push({ item, source: "inbox" }); }
    }
    for (const item of sentItems) {
      const id = getMessageId(item);
      if (id && !seen.has(id) && matchItem(item, "sent")) { seen.add(id); results.push({ item, source: "sent" }); }
    }
    for (const [emailId, entry] of Object.entries(emailTrash)) {
      if (!seen.has(emailId) && matchItem(entry.item, "trash")) { seen.add(emailId); results.push({ item: entry.item, source: "trash" }); }
    }
    return results;
  }, [mailSearchQuery, displayInboxItems, sentItems, emailTrash, ordersForLinking, orderUpdateLinks]);

  const effectivePreviewSource = mode === "search" ? searchSelectedSource : mode;
  const selectedInboxItem = (mode === "trash" || (mode === "search" && searchSelectedSource === "trash"))
    ? (emailTrash[selectedEmailId]?.item || null)
    : (displayInboxItems.find((item) => getInboxItemId(item) === selectedEmailId) || null);
  const selectedSentItem = sentItems.find((item) => getMessageId(item) === selectedSentId) || null;
  const selectedMailboxItem = effectivePreviewSource === "sent" ? selectedSentItem : selectedInboxItem;
  const selectedOrderLinkState = buildOrderLinkState(selectedMailboxItem, ordersForLinking);
  const selectedMessageClassification = effectivePreviewSource === "inbox" ? getMessageClassification(selectedInboxItem, selectedOrderLinkState) : null;
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

  // Keep opened conversations focused on the newest populated email.
  const _conversationMessageCount = selectedThreadMessagesWithReplies.length + selectedMailboxThreadMessagesWithReplies.length;
  React.useEffect(() => {
    const key = currentConversationKey;
    const count = _conversationMessageCount;
    const isSame = key && key === lastConversationKeyRef.current;
    const isNew = count > lastMessageCountRef.current;
    lastConversationKeyRef.current = key;
    lastMessageCountRef.current = count;
    if (!isSame || !isNew) return;
    const node = previewScrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Scroll to newest message instantly whenever a conversation is opened.
  React.useEffect(() => {
    window.requestAnimationFrame(() => {
      const node = previewScrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
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
      checkImapConnection();
      loadWorkspace();
    }
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [checkImapConnection, loadWorkspace]);

  React.useEffect(() => {
    if (!dropMessage) return undefined;
    const timer = window.setTimeout(() => setDropMessage(""), 2800);
    return () => window.clearTimeout(timer);
  }, [dropMessage]);

  // Keep trashRef current so the purge interval never reads stale state
  React.useEffect(() => {
    trashRef.current = emailTrash;
  }, [emailTrash]);

  // On mount: restore trash into pendingRemovals so trashed items stay hidden from inbox
  React.useEffect(() => {
    const stored = loadTrashFromStorage();
    if (!Object.keys(stored).length) return;
    setEmailTrash(stored);
    setPendingRemovals((prev) => {
      const next = { ...prev };
      for (const [emailId, entry] of Object.entries(stored)) {
        next[emailId] = true;
        const imapUid = String(entry.item?.imap_uid || "").trim();
        if (imapUid) next[imapUid] = true;
      }
      return next;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (selectedEmailId && !visibleIds.has(selectedEmailId) && !emailTrash[selectedEmailId]) {
      setSelectedEmailId("");
    }
    if (inboxContextMenu?.emailId && !visibleIds.has(inboxContextMenu.emailId)) {
      setInboxContextMenu(null);
    }
  }, [displayInboxIdKey, selectedEmailId]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    setPreviewContextMenu(null);
  }, [selectedEmailId]);

  React.useEffect(() => {
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
    }, MAIL_SERVICE_STATUS_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [checkImapConnection]);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      setClockTick(Date.now());
    }, 30000);
    return () => window.clearInterval(interval);
  }, []);

  React.useEffect(() => {
    if (imapConnected && !previousImapConnectedRef.current) {
      loadWorkspace();
    }
    previousImapConnectedRef.current = imapConnected;
  }, [imapConnected, loadWorkspace]);

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

  async function handleResyncInbox() {
    if (!workspaceState?.imapConfigured) {
      setDropMessage("Email connection unavailable. Cannot resync inbox.");
      return;
    }
    setRefreshingInbox(true);
    try {
      const response = await fetch("http://127.0.0.1:8055/inbox/resync?limit=100", { method: "GET" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "Could not resync inbox.");
      }
      setLastInboxFetchAt(Date.now());
      setClockTick(Date.now());
      setDropMessage(`${payload?.saved || 0} email${payload?.saved === 1 ? "" : "s"} saved to Inbox`);
      await loadWorkspace();
      await checkImapConnection();
      window.dispatchEvent(new CustomEvent("order-thread-updated", { detail: {} }));
    } catch (err) {
      console.error("[INBOX RESYNC ERROR]", err);
      setDropMessage(err.message || "Could not resync inbox.");
    } finally {
      setRefreshingInbox(false);
    }
  }

  async function handleDisconnectInboxService() {
    try {
      await fetch("http://127.0.0.1:8055/inbox/service/stop", { method: "POST" });
      setImapConnected(false);
      await checkImapConnection();
      setDropMessage("Mail service disconnected.");
    } catch (err) {
      setDropMessage(err.message || "Could not disconnect mail service.");
    }
  }

  async function handleOpenAttachment(attachment) {
    try {
      console.log("[ATTACHMENT_RENDER]", {
        action: "open",
        name: getAttachmentDisplayName(attachment),
        path: getAttachmentOpenPath(attachment),
      });
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
    const attachmentMetadata = normalizeOutboundAttachmentsForHistory(attachmentPaths, optimisticTimestamp);
    const optimisticMessage = {
      id: optimisticId,
      client_temp_id: optimisticId,
      type: "outbound",
      direction: "outbound",
      to,
      subject,
      body,
      attachments: attachmentMetadata,
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
      attachments: normalizeOutboundAttachmentsForHistory(attachmentPaths, result.timestamp || new Date().toISOString()),
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

  function restoreInboxItemInState(item, previousIndex = 0) {
    const emailId = getInboxItemId(item);
    if (!emailId) return;
    setWorkspaceState((prev) => {
      if (!prev?.inboxItems) return prev;
      if (prev.inboxItems.some((candidate) => getInboxItemId(candidate) === emailId)) {
        return prev;
      }
      const nextInboxItems = [...prev.inboxItems];
      nextInboxItems.splice(Math.max(0, previousIndex), 0, item);
      console.log("[INBOX_UPDATE]", {
        item_id: emailId,
        changed_fields: ["undo_removed"],
      });
      console.log("[INBOX_NO_REORDER]", { verified: true });
      return { ...prev, inboxItems: nextInboxItems };
    });
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

  // ── Trash purge: permanently IMAP-delete items whose retention period has expired ─
  const executeTrashPurge = React.useCallback(async (emailId, entry, { force = false } = {}) => {
    const now = Date.now();
    const lastAttemptAt = Number(entry?.last_delete_attempt_at || 0);
    if (!force && lastAttemptAt && now - lastAttemptAt < TRASH_DELETE_RETRY_COOLDOWN_MS) {
      return "skipped";
    }
    let deleted = false;
    try {
      const providerTrashFolder = String(entry?.provider_trash_folder || entry?.server_trash_folder || "").trim();
      const providerTrashMethod = String(entry?.provider_trash_method || "").trim();
      const alreadySourceDeleted = entry?.source_deleted === true || entry?.item?.source_deleted === true || entry?.server_delete_status === "deleted" || entry?.server_delete_status === "trashed";
      const providerCopyAlreadyGone = alreadySourceDeleted && (providerTrashMethod === "expunge" || providerTrashMethod === "missing");
      setEmailTrash((prev) => {
        if (!prev[emailId]) return prev;
        const next = {
          ...prev,
          [emailId]: {
            ...prev[emailId],
            last_delete_attempt_at: now,
          },
        };
        saveTrashToStorage(next);
        return next;
      });
      if (providerCopyAlreadyGone) {
        console.log("[TRASH_PERMANENT_DELETE]", { email_id: emailId, already_source_deleted: true, provider_copy: "gone" });
        await removeInboxFromSpailaStorage(entry.item);
        deleted = true;
      } else {
        const permanentDeleteId = providerTrashFolder
          ? String(entry?.item?.email_id || emailId || entry?.item?.imap_uid || "").trim()
          : String(entry?.item?.imap_uid || entry?.item?.email_id || emailId || "").trim();
        const mailboxQuery = providerTrashFolder ? `&mailbox=${encodeURIComponent(providerTrashFolder)}` : "";
        console.log("[PERMANENT_DELETE_PROVIDER]", { email_id: emailId, server_email_id: permanentDeleteId, mailbox: providerTrashFolder || "default" });
        const response = await fetch(
          `http://127.0.0.1:8055/inbox?email_id=${encodeURIComponent(permanentDeleteId)}${mailboxQuery}`,
          { method: "DELETE" }
        );
        if (response.ok) {
          console.log("[TRASH_PROVIDER_SUCCESS]", { email_id: emailId, server_email_id: permanentDeleteId, mailbox: providerTrashFolder || "default", action: "permanent_delete" });
          await removeInboxFromSpailaStorage(entry.item);
          deleted = true;
        } else {
          console.error("[TRASH_PROVIDER_FAIL]", { email_id: emailId, server_email_id: permanentDeleteId, status: response.status, action: "permanent_delete" });
        }
      }
    } catch (err) {
      console.error("[TRASH_PROVIDER_FAIL]", { email_id: emailId, error: err?.message || String(err), action: "permanent_delete" });
    }
    if (deleted) {
      setEmailTrash((prev) => {
        const next = { ...prev };
        delete next[emailId];
        saveTrashToStorage(next);
        return next;
      });
      setPendingRemovals((prev) => {
        const next = { ...prev };
        delete next[emailId];
        const imapUid = String(entry.item?.imap_uid || "").trim();
        if (imapUid) delete next[imapUid];
        return next;
      });
    }
    return deleted;
  }, [removeInboxFromSpailaStorage]);

  const runTrashPurge = React.useCallback(async ({ force = false } = {}) => {
    console.log("[TRASH PURGE] starting");
    const current = trashRef.current || {};
    const expired = force
      ? Object.entries(current)
      : getExpiredTrashEntries(current, shopConfig?.trashRetentionDays);
    let deletedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    for (const [emailId, entry] of expired) {
      const didDelete = await executeTrashPurge(emailId, entry, { force });
      if (didDelete) deletedCount += 1;
      else if (didDelete === "skipped") skippedCount += 1;
      else errorCount += 1;
    }
    console.log("[TRASH PURGE] deleted count =", deletedCount);
    if (skippedCount) {
      console.log("[TRASH PURGE] skipped retry count =", skippedCount);
    }
    if (errorCount) {
      console.error("[TRASH PURGE] errors", errorCount);
    }
    return { deletedCount, errorCount, skippedCount };
  }, [executeTrashPurge, shopConfig?.trashRetentionDays]);

  const requestTrashProviderMove = React.useCallback(async (emailId, item) => {
    const serverEmailId = String(item?.imap_uid || item?.email_id || emailId || "").trim();
    if (!serverEmailId) return false;
    const now = Date.now();
    console.log("[TRASH_PROVIDER_MOVE]", { email_id: emailId, server_email_id: serverEmailId });
    setEmailTrash((prev) => {
      if (!prev[emailId]) return prev;
      const next = {
        ...prev,
        [emailId]: {
          ...prev[emailId],
          source_deleted: false,
          server_delete_status: "pending",
          last_delete_attempt_at: now,
        },
      };
      saveTrashToStorage(next);
      return next;
    });
    try {
      const response = await fetch(
        "http://127.0.0.1:8055/inbox/trash",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email_id: serverEmailId }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || `Provider trash move failed (${response.status})`);
      }
      console.log("[TRASH_PROVIDER_SUCCESS]", { email_id: emailId, server_email_id: serverEmailId, provider_trash_folder: payload?.provider_trash_folder || "" });
      console.log("[SOURCE_DELETED_UPDATE]", { email_id: emailId, server_email_id: serverEmailId, source_deleted: true });
      setEmailTrash((prev) => {
        if (!prev[emailId]) return prev;
        const entry = prev[emailId];
        const nextItem = { ...(entry.item || item), source_deleted: true };
        const next = {
          ...prev,
          [emailId]: {
            ...entry,
            item: nextItem,
            source_deleted: true,
            source_deleted_at: Date.now(),
            server_delete_status: "trashed",
            provider_trash_folder: payload?.provider_trash_folder || "",
            provider_trash_method: payload?.provider_trash_method || "",
            last_server_delete_error: "",
          },
        };
        saveTrashToStorage(next);
        return next;
      });
      return true;
    } catch (err) {
      console.error("[TRASH_PROVIDER_FAIL]", { email_id: emailId, server_email_id: serverEmailId, error: err?.message || String(err) });
      console.log("[SOURCE_DELETED_UPDATE]", { email_id: emailId, server_email_id: serverEmailId, source_deleted: false });
      setEmailTrash((prev) => {
        if (!prev[emailId]) return prev;
        const entry = prev[emailId];
        const next = {
          ...prev,
          [emailId]: {
            ...entry,
            source_deleted: false,
            server_delete_status: "failed",
            last_delete_attempt_at: Date.now(),
            last_server_delete_error: err?.message || "Provider trash move failed",
          },
        };
        saveTrashToStorage(next);
        return next;
      });
      setDropMessage("Moved to Trash. Provider trash move failed and will retry.");
      return false;
    }
  }, []);

  const retryPendingProviderTrashMoves = React.useCallback(async ({ force = false } = {}) => {
    const current = trashRef.current || {};
    for (const [emailId, entry] of Object.entries(current)) {
      const alreadyMoved = entry?.source_deleted === true || entry?.item?.source_deleted === true || entry?.server_delete_status === "trashed";
      if (alreadyMoved) continue;
      const lastAttemptAt = Number(entry?.last_delete_attempt_at || 0);
      if (!force && lastAttemptAt && Date.now() - lastAttemptAt < TRASH_DELETE_RETRY_COOLDOWN_MS) {
        continue;
      }
      await requestTrashProviderMove(emailId, entry.item);
    }
  }, [requestTrashProviderMove]);

  // Background purge: runs on startup and hourly for items past their retention window.
  React.useEffect(() => {
    retryPendingProviderTrashMoves();
    runTrashPurge();
    const interval = window.setInterval(() => {
      retryPendingProviderTrashMoves();
      runTrashPurge();
    }, TRASH_PURGE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [retryPendingProviderTrashMoves, runTrashPurge]);

  async function emptyTrashNow() {
    const result = await runTrashPurge({ force: true });
    if (result.deletedCount > 0 && result.errorCount === 0) {
      setDropMessage(`${result.deletedCount} email${result.deletedCount === 1 ? "" : "s"} permanently deleted.`);
    } else if (result.deletedCount > 0) {
      setDropMessage(`${result.deletedCount} email${result.deletedCount === 1 ? "" : "s"} permanently deleted. Some items could not be deleted.`);
    } else if (result.errorCount > 0) {
      setDropMessage("Could not empty Trash. Items were kept for retry.");
    } else {
      setDropMessage("Trash is already empty.");
    }
  }

  function handleMoveToTrash(item) {
    const emailId = getInboxItemId(item);
    if (!emailId) { setDropMessage("Email id is missing."); return; }

    console.log("[TRASH_REQUEST]", { email_id: emailId, imap_uid: item?.imap_uid || "" });
    const previousIndex = inboxItems.findIndex((c) => getInboxItemId(c) === emailId);

    // Remove from inbox immediately
    hideInboxItemInState(item);
    setPendingRemovals((prev) => {
      const next = { ...prev };
      next[emailId] = true;
      const imapUid = String(item?.imap_uid || "").trim();
      if (imapUid) next[imapUid] = true;
      return next;
    });

    // Add to trash
    setEmailTrash((prev) => {
      const next = {
        ...prev,
        [emailId]: {
          item,
          status: "trash",
          deleted_at: Date.now(),
          source_deleted: false,
          server_delete_status: "pending",
          provider_trash_folder: "",
          provider_trash_method: "",
          last_delete_attempt_at: 0,
          previousIndex,
        },
      };
      saveTrashToStorage(next);
      return next;
    });
    console.log("[TRASH_LOCAL]", { email_id: emailId });

    setDropMessage("Moved to Trash.");
    requestTrashProviderMove(emailId, item);
  }

  // Keep the old name as an alias so all call sites work unchanged
  function handleDeleteInboxItem(item) {
    handleMoveToTrash(item);
  }

  function handleRestoreFromTrash(emailId) {
    const entry = trashRef.current[emailId];
    if (!entry) return;
    console.log("[TRASH_RESTORE]", {
      email_id: emailId,
      source_deleted: entry.source_deleted === true || entry.item?.source_deleted === true,
    });

    setEmailTrash((prev) => {
      const next = { ...prev };
      delete next[emailId];
      saveTrashToStorage(next);
      return next;
    });
    setPendingRemovals((prev) => {
      const next = { ...prev };
      delete next[emailId];
      const imapUid = String(entry.item?.imap_uid || "").trim();
      if (imapUid) delete next[imapUid];
      return next;
    });
    restoreInboxItemInState(entry.item, entry.previousIndex);
    setDropMessage(
      entry.source_deleted === true || entry.item?.source_deleted === true
        ? "Email restored locally. Server inbox copy was already removed."
        : "Email restored to Inbox.",
    );
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

  function handleBulkDelete() {
    if (!checkedInboxItems.length) return;
    const itemsToDelete = [...checkedInboxItems];
    const now = Date.now();

    setEmailTrash((prev) => {
      const next = { ...prev };
      for (const item of itemsToDelete) {
        const emailId = getInboxItemId(item);
        if (!emailId) continue;
        const previousIndex = inboxItems.findIndex((c) => getInboxItemId(c) === emailId);
        next[emailId] = { item, deleted_at: now, previousIndex };
      }
      saveTrashToStorage(next);
      return next;
    });
    setPendingRemovals((prev) => {
      const next = { ...prev };
      for (const item of itemsToDelete) {
        const emailId = getInboxItemId(item);
        const imapUid = String(item?.imap_uid || "").trim();
        if (emailId) next[emailId] = true;
        if (imapUid) next[imapUid] = true;
      }
      return next;
    });
    for (const item of itemsToDelete) {
      hideInboxItemInState(item);
    }
    const count = itemsToDelete.length;
    setDropMessage(`${count} email${count === 1 ? "" : "s"} moved to Trash.`);
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
          border: `${isSelected ? "2px" : "1px"} solid ${isSelected ? "#3b82f6" : "#e5e7eb"}`,
          borderLeft: `4px solid ${isSelected ? "#2563eb" : "#cbd5e1"}`,
          background: isSelected ? "#dbeafe" : "#fff",
          borderRadius: 12,
          padding: isSelected ? 13 : 14,
          marginBottom: 10,
          cursor: "pointer",
          boxSizing: "border-box",
          boxShadow: isSelected ? "0 2px 12px rgba(37,99,235,0.18)" : "none",
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

    const linkedOrder = getInboxItemLinkedOrder(item, ordersForLinking, orderUpdateLinks);
    const linkedOrderNumber = linkedOrder
      ? (normalizeOrderNumber(linkedOrder.order_number) || String(linkedOrder.order_id || linkedOrder.id || "").trim())
      : "";
    const linkedOrderBadge = linkedOrderNumber ? `#${linkedOrderNumber}` : "Linked Order";

    function openInboxCard() {
      if (linkedOrder) {
        handleOpenLinkedOrder(linkedOrder);
        return;
      }
      selectInboxItem(item);
      setSelectedThreadId("");
    }

    const cardTint = linkedOrder ? "#eff6ff" : isFlaggedOrder ? "#f0fdf4" : orderScore > 70 ? "#f7fee7" : orderScore >= 40 ? "#fbfdf2" : "#fff";
    const borderColor = linkedOrder ? "#93c5fd" : isFlaggedOrder ? "#86efac" : orderScore > 70 ? "#bef264" : orderScore >= 40 ? "#e2e8a8" : "#e5e7eb";
    return (
      <div
        key={emailId}
        role="button"
        tabIndex={0}
        onClick={openInboxCard}
        onDoubleClick={() => {
          if (linkedOrder) {
            handleOpenLinkedOrder(linkedOrder);
            return;
          }
          openInboxItem(item);
        }}
        onContextMenu={(event) => openInboxContextMenu(event, item)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openInboxCard();
          }
        }}
        title={item.name}
        style={{
          width: "100%",
          textAlign: "left",
          border: `${isSelected ? "2px" : "1px"} solid ${isSelected ? "#3b82f6" : borderColor}`,
          borderLeft: isSelected ? "4px solid #2563eb" : orderScore >= 40 || isFlaggedOrder ? `4px solid ${borderColor}` : `1px solid ${borderColor}`,
          background: isSelected ? "#dbeafe" : cardTint,
          borderRadius: 12,
          padding: isSelected ? 13 : 14,
          marginBottom: 10,
          cursor: "pointer",
          boxSizing: "border-box",
          boxShadow: isSelected ? "0 2px 12px rgba(37,99,235,0.18)" : "none",
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
            <div className="subject" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {subject}
              </span>
              {linkedOrder ? (
                <span
                  title={linkedOrderNumber ? `Linked to Order #${linkedOrderNumber}` : "Linked to an existing order"}
                  style={{
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    border: "1px solid #bfdbfe",
                    background: "#dbeafe",
                    color: "#1d4ed8",
                    borderRadius: 999,
                    padding: "2px 7px",
                    fontSize: 10,
                    fontWeight: 850,
                    lineHeight: 1.2,
                    cursor: "pointer",
                  }}
                >
                  Order Reply {linkedOrderBadge}
                </span>
              ) : isFlaggedOrder ? (
                <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4, color: "#166534", fontSize: 10, fontWeight: 800, verticalAlign: "middle", cursor: "default" }}>
                  <span style={{ fontSize: 9 }}>●</span> Order Created
                </span>
              ) : orderScore > 70 ? (
                <span title={`Suggested order score: ${orderScore}`} style={{ flexShrink: 0, color: "#84cc16", fontSize: 11 }}>●</span>
              ) : orderScore >= 40 ? (
                <span title={`Suggested order score: ${orderScore}`} style={{ flexShrink: 0, color: "#a3e635", fontSize: 11 }}>●</span>
              ) : null}
              {item.source_deleted === true ? (
                <span
                  title="This email no longer exists in the connected email account."
                  style={{ flexShrink: 0, color: "#94a3b8", fontSize: 10, fontWeight: 750, verticalAlign: "middle" }}
                >
                  Deleted from email account
                </span>
              ) : null}
            </div>
            <div className="meta" style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 11, color: "#64748b" }}>
              <span className="sender" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sender}</span>
              <span className="time" style={{ flexShrink: 0, color: "#94a3b8" }}>{formatTimestamp(item.timestamp)}</span>
            </div>
            {linkedOrder && linkedOrderNumber ? (
              <div style={{ marginTop: 5, color: "#2563eb", fontSize: 11, fontWeight: 700 }}>
                Linked to Order #{linkedOrderNumber}
              </div>
            ) : null}
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
          border: `${isSelected ? "2px" : "1px"} solid ${isSelected ? "#22c55e" : "#e5e7eb"}`,
          borderLeft: `4px solid ${isSelected ? "#16a34a" : "#dcfce7"}`,
          background: isSelected ? "#dcfce7" : "#fff",
          borderRadius: 12,
          padding: isSelected ? 13 : 14,
          boxShadow: isSelected ? "0 2px 12px rgba(22,163,74,0.18)" : "none",
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
        <span style={{ color: "#cbd5e1", fontSize: 13 }}>|</span>
        <button
          type="button"
          className={mode === "trash" ? "active" : ""}
          onClick={() => {
            setMode("trash");
            setSelectedEmailId("");
            setSelectedSentId("");
            setCheckedEmailIds(new Set());
            setSelectedThreadId("");
          }}
          style={{
            ...toggleButtonStyle(mode === "trash"),
            color: mode === "trash" ? "#dc2626" : "#64748b",
            borderBottom: `2px solid ${mode === "trash" ? "#dc2626" : "transparent"}`,
          }}
        >
          Trash
        </button>
        <span style={{ color: "#cbd5e1", fontSize: 13 }}>|</span>
        <button
          type="button"
          className={mode === "search" ? "active" : ""}
          onClick={() => {
            setMode("search");
            setSelectedEmailId("");
            setSelectedSentId("");
            setCheckedEmailIds(new Set());
            setSelectedThreadId("");
          }}
          style={{
            ...toggleButtonStyle(mode === "search"),
            color: mode === "search" ? "#7c3aed" : "#64748b",
            borderBottom: `2px solid ${mode === "search" ? "#7c3aed" : "transparent"}`,
          }}
        >
          Search
        </button>
      </div>
    );
  }

  function markEventRead(eventId) {
    // Optimistic: flip flag immediately so badge count updates instantly.
    setInboxEvents((prev) => prev.map((e) => e.id === eventId ? { ...e, unread: false } : e));
    fetch(`http://127.0.0.1:8055/inbox/events/${eventId}/read`, { method: "PATCH" })
      .catch((err) => console.error("[INBOX] mark-read failed", eventId, err));
  }

  function dismissEvent(eventId) {
    // Optimistic: remove from UI immediately so the × feels instant.
    setInboxEvents((prev) => prev.filter((e) => e.id !== eventId));
    fetch(`http://127.0.0.1:8055/inbox/events/${eventId}`, { method: "DELETE" })
      .then((res) => {
        if (!res.ok) console.error("[INBOX] delete failed", eventId, res.status);
      })
      .catch((err) => console.error("[INBOX] delete error", eventId, err));
  }

  function renderActivityFeed() {
    if (!visibleInboxActivityEvents.length) return null;
    const unreadCount = visibleInboxActivityEvents.filter((e) => e.unread).length;
    return (
      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#64748b", letterSpacing: 1, textTransform: "uppercase" }}>
            Activity {unreadCount > 0 && (
              <span style={{ background: "#2563eb", color: "#fff", borderRadius: 8, padding: "1px 6px", fontSize: 10, marginLeft: 4 }}>
                {unreadCount}
              </span>
            )}
          </span>
        </div>
        {visibleInboxActivityEvents.map((ev) => {
          const linkedOrder = ordersForLinking.find((o) => o.order_id === ev.order_id || o.id === ev.order_id);
          const isUpdate = ev.type === "order_update";
          const ts = ev.timestamp || ev.created_at || "";
          const displayTs = ts ? new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
          return (
            <div
              key={ev.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                border: `1px solid ${ev.unread ? "#bfdbfe" : "#e5e7eb"}`,
                borderLeft: `4px solid ${isUpdate ? "#2563eb" : "#16a34a"}`,
                borderRadius: 10,
                padding: "10px 12px",
                marginBottom: 8,
                background: ev.unread ? "#eff6ff" : "#fafafa",
                cursor: linkedOrder ? "pointer" : "default",
              }}
              onClick={() => {
                markEventRead(ev.id);
                if (linkedOrder) onOpenOrder?.(linkedOrder);
              }}
            >
              <span style={{
                flexShrink: 0,
                marginTop: 2,
                fontSize: 10,
                fontWeight: 800,
                padding: "2px 7px",
                borderRadius: 6,
                background: isUpdate ? "#dbeafe" : "#dcfce7",
                color: isUpdate ? "#1d4ed8" : "#15803d",
                whiteSpace: "nowrap",
              }}>
                {isUpdate ? "Reply" : "New Order"}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: ev.unread ? 700 : 500, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ev.buyer_name || "(Unknown)"}{ev.order_number ? ` — #${ev.order_number}` : ""}
                  </span>
                  <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>{displayTs}</span>
                </div>
                {ev.preview && (
                  <div style={{ fontSize: 12, color: "#64748b", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ev.preview}
                  </div>
                )}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); dismissEvent(ev.id); }}
                title="Dismiss"
                style={{
                  flexShrink: 0,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: "#94a3b8",
                  fontSize: 18,
                  width: 32,
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 6,
                  padding: 0,
                  lineHeight: 1,
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.06)"; e.currentTarget.style.color = "#475569"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#94a3b8"; }}
              >
                ×
              </button>
            </div>
          );
        })}
        <div style={{ borderBottom: "1px solid #e5e7eb", marginBottom: 14 }} />
      </div>
    );
  }

  function renderMailboxListContent() {
    if (mode === "search") {
      if (!mailSearchQuery.trim()) {
        return (
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 18, color: "#94a3b8", fontSize: 13, textAlign: "center" }}>
            Type above to search all mailboxes.
          </div>
        );
      }
      if (!mailSearchResults.length) {
        return (
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13 }}>
            No results for &ldquo;{mailSearchQuery}&rdquo;.
          </div>
        );
      }
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {mailSearchResults.map(({ item, source }, idx) => {
            const emailId = source === "sent" ? getMessageId(item) : getInboxItemId(item);
            const isSelected = source === "sent" ? selectedSentId === emailId : selectedEmailId === emailId;
            const subject = String(item?.subject || item?.preview_text || "(no subject)").trim();
            const sender = String(item?.sender || item?.from || item?.to || "Unknown").trim();
            const preview = String(item?.preview_text || item?.preview || "").trim();
            const tag = source === "inbox"
              ? { text: "Inbox", color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe" }
              : source === "sent"
                ? { text: "Sent", color: "#166534", bg: "#f0fdf4", border: "#bbf7d0" }
                : { text: "Trash", color: "#dc2626", bg: "#fff1f2", border: "#fecaca" };
            function selectResult() {
              if (source === "sent") {
                setSelectedSentId(emailId);
                setSelectedEmailId("");
              } else {
                setSelectedEmailId(emailId);
                setSelectedSentId("");
              }
              setSearchSelectedSource(source);
            }
            return (
              <div
                key={`${source}-${emailId || idx}`}
                role="button"
                tabIndex={0}
                onClick={selectResult}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectResult(); } }}
                style={{
                  border: `${isSelected ? "2px" : "1px"} solid ${isSelected ? "#7c3aed" : "#e5e7eb"}`,
                  borderLeft: `4px solid ${isSelected ? "#6d28d9" : tag.border}`,
                  borderRadius: 10,
                  padding: isSelected ? "9px 11px" : "10px 12px",
                  background: isSelected ? "#ede9fe" : "#fff",
                  cursor: "pointer",
                  boxShadow: isSelected ? "0 2px 12px rgba(124,58,237,0.18)" : "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                }}
              >
                <div style={{ marginBottom: 2 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: tag.color, background: tag.bg, border: `1px solid ${tag.border}`, borderRadius: 4, padding: "1px 5px" }}>
                    {tag.text}
                  </span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {subject}
                </div>
                <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {sender}
                </div>
                {preview && (
                  <div style={{ fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {preview}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    if (mode === "sent") {
      return sentItems.length ? sentItems.map(renderSentRow) : (
        <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13 }}>
          No sent emails yet.
        </div>
      );
    }
    if (mode === "trash") {
      const trashEntries = Object.entries(emailTrash);
      if (!trashEntries.length) {
        return (
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13 }}>
            Trash is empty.
          </div>
        );
      }
      const retentionDays = shopConfig?.trashRetentionDays || 30;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 2 }}>
            <div style={{ fontSize: 11, color: "#9ca3af" }}>
              Items are permanently deleted after {retentionDays} day{retentionDays === 1 ? "" : "s"}.
            </div>
            <button
              type="button"
              onClick={emptyTrashNow}
              style={{
                border: "1px solid #fecaca",
                background: "#fff",
                color: "#991b1b",
                borderRadius: 7,
                padding: "4px 8px",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 800,
                flexShrink: 0,
              }}
            >
              Empty Trash
            </button>
          </div>
          {trashEntries
            .sort((a, b) => b[1].deleted_at - a[1].deleted_at)
            .map(([emailId, entry]) => {
              const subject = String(entry.item?.subject || entry.item?.preview_text || "(no subject)").trim();
              const sender = String(entry.item?.sender || entry.item?.from || "Unknown").trim();
              const daysAgo = Math.floor((Date.now() - entry.deleted_at) / (1000 * 60 * 60 * 24));
              const daysLeft = retentionDays - daysAgo;
              const isSelected = selectedEmailId === emailId;
              return (
                <div
                  key={emailId}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedEmailId(emailId)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedEmailId(emailId); } }}
                  style={{
                    border: `${isSelected ? "2px" : "1px"} solid ${isSelected ? "#3b82f6" : "#fee2e2"}`,
                    borderLeft: `4px solid ${isSelected ? "#2563eb" : "#fca5a5"}`,
                    borderRadius: 10,
                    padding: isSelected ? "9px 11px" : "10px 12px",
                    background: isSelected ? "#dbeafe" : "#fff",
                    boxShadow: isSelected ? "0 2px 12px rgba(37,99,235,0.18)" : "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1f2937", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {subject}
                  </div>
                  <div style={{ fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sender}
                  </div>
                  <div style={{ fontSize: 11, color: daysLeft <= 3 ? "#dc2626" : "#9ca3af" }}>
                    {daysAgo === 0 ? "deleted today" : `deleted ${daysAgo}d ago`} · {daysLeft > 0 ? `${daysLeft}d left` : "expires soon"}
                  </div>
                </div>
              );
            })}
        </div>
      );
    }
    return (
      <>
        {renderActivityFeed()}
        {inboxModeItems.length ? inboxModeItems.map(renderUnlinkedRow) : (
          <div style={{ border: "1px dashed #cbd5e1", borderRadius: 12, padding: 14, color: "#64748b", fontSize: 13 }}>
            No inbox emails.
          </div>
        )}
      </>
    );
  }

  function renderTimelineMessage(message) {
    const isOutbound = (message.direction || message.type) === "outbound";
    const outboundStatus = isOutbound ? String(message.status || "sent") : "";
    const orderLinkState = buildOrderLinkState(message, ordersForLinking);
    const attachments = getEmailAttachments(message);
    const rawText = String(message.preview_text || message.body || message.preview || "").trim();
    const contentText = extractReply(rawText) || rawText;
    const fallbackText = attachments.length ? "Attachment sent" : "";
    const displayText = contentText || fallbackText;
    const senderEmail = extractEmailAddress(message.sender_email || message.from || message.sender || message.reply_to || message.buyer_email || "").toLowerCase();
    const senderName = String(message.sender_name || "").replace(/<[^<>]+>/g, "").trim();
    const inboundLabel = senderName || senderEmail || String(message.buyer_name || message.buyer_email || "").trim();
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
        {displayText ? (
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
        selectedNav="workspace"
        rightContent={
          <>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={handleRefreshInbox}
                disabled={!imapConfigured || refreshingInbox}
                title={imapConfigured ? "Refresh inbox now" : "Email connection unavailable. Cannot refresh inbox."}
                aria-label="Refresh inbox"
                style={{
                  width: 34,
                  height: 34,
                  border: "1px solid #cbd5e1",
                  background: "#fff",
                  color: "#0f172a",
                  borderRadius: 999,
                  cursor: imapConfigured && !refreshingInbox ? "pointer" : "not-allowed",
                  fontSize: 15,
                  fontWeight: 800,
                  opacity: imapConfigured ? (refreshingInbox ? 0.7 : 1) : 0.5,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {refreshingInbox ? "..." : "↻"}
              </button>
              <span style={{ fontSize: 11, color: "#64748b", whiteSpace: "nowrap" }}>
                {refreshingInbox ? "Updating..." : lastUpdatedLabel}
              </span>
            </div>
            <div
              title={canDeleteFromAccount ? "Mail service connected" : mailServiceRunning ? "Mail service running, account offline" : "Mail service stopped"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid #e5e7eb",
                background: "#fff",
                color: canDeleteFromAccount ? "#166534" : mailServiceRunning ? "#92400e" : "#64748b",
                borderRadius: 999,
                padding: "6px 10px",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              <span style={{ color: canDeleteFromAccount ? "#16a34a" : mailServiceRunning ? "#f59e0b" : "#ef4444", fontSize: 13 }}>●</span>
              {imapChecking ? "Checking..." : canDeleteFromAccount ? "Connected" : mailServiceRunning ? "Sync Ready" : "Offline"}
            </div>
          </>
        }
      />

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "380px 1fr", gap: 18, padding: 18, minHeight: 0 }}>
        <section style={{ ...panelStyle, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>Mail</div>
            {renderModeToggle()}
            {mode === "search" && (
              <div style={{ marginTop: 10 }}>
                <input
                  autoFocus
                  type="text"
                  placeholder="Search subject, sender, name, order…"
                  value={mailSearchQuery}
                  onChange={(e) => setMailSearchQuery(e.target.value)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    border: "1px solid #cbd5e1",
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: 13,
                    outline: "none",
                    color: "#0f172a",
                  }}
                />
              </div>
            )}
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
                <button
                  type="button"
                  onClick={handleBulkDelete}
                  title="Move selected emails to Trash"
                  style={{
                    border: "1px solid #fecaca",
                    background: "#fff",
                    color: "#991b1b",
                    borderRadius: 8,
                    padding: "6px 10px",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  🗑 Trash
                </button>
              </div>
            </div>
          ) : null}

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 16px 16px" }}>
            {loading && !workspaceState ? (
              <div style={{ fontSize: 13, color: "#64748b" }}>Loading workspace…</div>
            ) : showInboxEmptyState && mode !== "search" ? (
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
                      <>
                        <button
                          type="button"
                          onClick={handleRefreshInbox}
                          disabled={refreshingInbox}
                          title="Refresh inbox now"
                          style={{
                            border: "1px solid #cbd5e1",
                            background: "#fff",
                            color: "#475569",
                            borderRadius: 12,
                            padding: "10px 14px",
                            cursor: !refreshingInbox ? "pointer" : "not-allowed",
                            fontSize: 13,
                            fontWeight: 700,
                            opacity: refreshingInbox ? 0.7 : 1,
                          }}
                        >
                          {refreshingInbox ? "Updating..." : "Refresh now"}
                        </button>
                        <button
                          type="button"
                          onClick={handleResyncInbox}
                          disabled={mailServiceBusy}
                          title="Force a larger inbox resync"
                          style={{
                            border: "1px solid #cbd5e1",
                            background: "#fff",
                            color: "#475569",
                            borderRadius: 12,
                            padding: "10px 14px",
                            cursor: !mailServiceBusy ? "pointer" : "not-allowed",
                            fontSize: 13,
                            fontWeight: 700,
                            opacity: mailServiceBusy ? 0.7 : 1,
                          }}
                        >
                          Resync
                        </button>
                        <button
                          type="button"
                          onClick={handleDisconnectInboxService}
                          title="Disconnect background mail service"
                          style={{
                            border: "1px solid #fecaca",
                            background: "#fff",
                            color: "#991b1b",
                            borderRadius: 12,
                            padding: "10px 14px",
                            cursor: "pointer",
                            fontSize: 13,
                            fontWeight: 700,
                          }}
                        >
                          Disconnect
                        </button>
                      </>
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
              shopLogoPath={shopConfig.shopLogoPath}
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
              <div style={{ borderBottom: "1px solid #f1f5f9", padding: "12px 18px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#fff" }}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ border: "1px solid #dbeafe", background: "#eff6ff", color: "#1d4ed8", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 800 }}>
                    {selectedThread.inbound_count} inbound
                  </span>
                  <span style={{ border: "1px solid #dcfce7", background: "#f0fdf4", color: "#166534", borderRadius: 999, padding: "5px 10px", fontSize: 12, fontWeight: 800 }}>
                    {selectedThread.outbound_count} outbound
                  </span>
                </div>
              </div>
              <div ref={previewScrollRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 18px", background: "#ffffff" }}>
                <div style={conversationStackStyle}>
                  {[...selectedThreadMessagesWithReplies].sort(sortByTimestamp).map(renderTimelineMessage)}
                </div>
                <div ref={bottomRef} style={{ height: 0 }} />
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
                  onOpenAttachment={handleOpenAttachment}
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
                  {mode === "trash" ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                      <button
                        type="button"
                        onClick={() => { handleRestoreFromTrash(selectedEmailId); setMode("inbox"); }}
                        style={{ border: "1px solid #bbf7d0", background: "#fff", color: "#166534", borderRadius: 7, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}
                      >
                        Restore to Inbox
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!window.confirm("Permanently delete this email from your account now?")) return;
                          const didDelete = await executeTrashPurge(selectedEmailId, emailTrash[selectedEmailId], { force: true });
                          if (didDelete) {
                            setSelectedEmailId("");
                          } else {
                            setDropMessage("Could not delete email. Item was kept in Trash.");
                          }
                        }}
                        style={{ border: "1px solid #fecaca", background: "#fff", color: "#dc2626", borderRadius: 7, padding: "5px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}
                      >
                        Delete Now
                      </button>
                    </div>
                  ) : effectivePreviewSource === "inbox" ? (
                    <>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <button type="button" onClick={() => openInboxItem(selectedInboxItem)} style={{ border: "1px solid #dbeafe", background: "#fff", color: "#0f172a", borderRadius: 7, padding: "5px 8px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                          Process Order
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
                        <button
                          type="button"
                          title="Move to Trash"
                          onClick={() => handleDeleteInboxItem(selectedInboxItem)}
                          style={{
                            border: "1px solid #fecaca",
                            background: "#fff",
                            color: "#991b1b",
                            borderRadius: 7,
                            padding: "5px 8px",
                            cursor: "pointer",
                            fontSize: 12,
                            fontWeight: 700,
                          }}
                        >
                          🗑 Trash
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
                    <span>{effectivePreviewSource === "sent" ? `To: ${selectedMailboxItem.to || "(Unknown recipient)"}` : selectedMailboxItem.sender || "(Unknown sender)"} • {formatTimestamp(selectedMailboxItem.timestamp)}</span>
                    {effectivePreviewSource === "inbox" && selectedMailboxItem.order_flagged ? (
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
                    {effectivePreviewSource === "inbox" && selectedMailboxItem.source_deleted === true ? (
                      <span
                        title="This email no longer exists in the connected email account."
                        style={{
                          color: "#94a3b8",
                          fontSize: 12,
                          fontWeight: 700,
                          cursor: "default",
                        }}
                      >
                        Deleted from email account
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              {selectedMessageClassification ? (
                <div style={{ borderBottom: "1px solid #f1f5f9", padding: "12px 18px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#fff" }}>
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
                </div>
              ) : null}
              <div ref={previewScrollRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "20px 18px", background: "#ffffff" }}>
                {selectedMailboxThreadMessagesWithReplies.length ? (
                  <div style={conversationStackStyle}>
                    {[...selectedMailboxThreadMessagesWithReplies].sort(sortByTimestamp).map(renderTimelineMessage)}
                  </div>
                ) : (
                  <>
                    <div style={{ maxWidth: "100%", minWidth: 0 }}>
                      {renderReadableMessageBody(
                        selectedMailboxItem.preview_text || selectedMailboxItem.body || selectedMailboxItem.preview || "(No preview available)",
                        selectedOrderLinkState,
                        handleOpenLinkedOrder
                      )}
                    </div>
                    {selectedMailboxReplies.length ? (
                      <div style={conversationStackStyle}>
                        {selectedMailboxReplies.map(renderTimelineMessage)}
                      </div>
                    ) : null}
                  </>
                )}
                <div ref={bottomRef} style={{ height: 0 }} />
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
                  onOpenAttachment={handleOpenAttachment}
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
          <PreviewMenuItem
            danger
            onClick={() => runInboxContextAction(() => handleDeleteInboxItem(inboxContextMenuItem))}
          >
            Move to Trash
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
          <PreviewMenuItem
            danger
            onClick={() => runPreviewContextAction(() => handleDeleteInboxItem(selectedInboxItem))}
          >
            Move to Trash
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
