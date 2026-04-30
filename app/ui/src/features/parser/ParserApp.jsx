import React from "react";
import { createPortal } from "react-dom";
import AppHeader from "../../shared/components/AppHeader.jsx";
import {
  loadFieldConfig,
  buildLabelMap,
  loadParserFieldOrder,
  loadDocumentsConfig,
  normalizeFieldValue,
} from "../../shared/utils/fieldConfig.js";

// Build a key → visibleInParser boolean map from config.
function buildParserVisibilityMap(config) {
  return Object.fromEntries(config.map((f) => [f.key, f.visibleInParser !== false]));
}

// Metadata for order-level fields (multiline flag lives here only).
const _ORDER_FIELD_META = {
  buyer_name:       {},
  shipping_address: { multiline: true },
  order_number:     {},
  quantity:         {},
  order_date:       {},
  ship_by:          {},
  buyer_email:      {},
};
const _ORDER_FIELD_KEYS = Object.keys(_ORDER_FIELD_META).map((key) => ({
  key,
  ...(_ORDER_FIELD_META[key]),
}));
const REQUIRED_ORDER_FIELD_KEYS = new Set(["order_number", "buyer_name", "ship_by"]);
const MONTH_NAME_TO_NUMBER = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function toDateInputValue(value) {
  const raw = normalizeFieldValue(value);
  if (!raw) return "";
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return raw;

  const numericMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (numericMatch) {
    const month = Number(numericMatch[1]);
    const day = Number(numericMatch[2]);
    const rawYear = numericMatch[3];
    const year = rawYear
      ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
      : new Date().getFullYear();
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
    }
  }

  const monthNameMatch = raw.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:,?\s+(\d{2,4}))?$/);
  if (monthNameMatch) {
    const month = MONTH_NAME_TO_NUMBER[monthNameMatch[1].toLowerCase()];
    const day = Number(monthNameMatch[2]);
    const rawYear = monthNameMatch[3];
    const year = rawYear
      ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear)
      : new Date().getFullYear();
    if (month && day >= 1 && day <= 31) {
      return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
    }
  }

  return "";
}

// Metadata for per-item fields.
const _ITEM_FIELD_KEYS = [
  { key: "price" },
  { key: "custom_1" },
  { key: "custom_2" },
  { key: "custom_3" },
  { key: "custom_4" },
  { key: "custom_5" },
  { key: "custom_6" },
  { key: "order_notes" },
];

function textLength(node) {
  if (!node) {
    return 0;
  }
  if (node.nodeType === Node.ELEMENT_NODE && node.getAttribute?.("data-noncontent") === "true") {
    return 0;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentElement?.closest?.('[data-noncontent="true"]')) {
      return 0;
    }
    return node.textContent?.length || 0;
  }

  let total = 0;
  node.childNodes.forEach((child) => {
    total += textLength(child);
  });
  return total;
}

function computeSelectionOffset(container, targetNode, targetOffset) {
  if (!container || !targetNode) {
    return 0;
  }

  const targetElement = targetNode.nodeType === Node.ELEMENT_NODE
    ? targetNode
    : targetNode.parentElement;
  const lineElement = targetElement?.closest?.("[data-line-start]");
  if (lineElement) {
    const lineStart = Number.parseInt(lineElement.getAttribute("data-line-start") || "0", 10);
    const walker = document.createTreeWalker(
      lineElement,
      NodeFilter.SHOW_TEXT,
    );
    let lineOffset = 0;
    let current = walker.nextNode();
    while (current) {
      if (current === targetNode) {
        return lineStart + lineOffset + targetOffset;
      }
      if (targetNode.nodeType === Node.ELEMENT_NODE && targetNode.contains(current)) {
        const childNodes = Array.from(targetNode.childNodes);
        const childIndex = childNodes.indexOf(current.parentNode);
        if (childIndex >= 0 && childIndex < targetOffset) {
          lineOffset += current.textContent?.length || 0;
          current = walker.nextNode();
          continue;
        }
        if (childIndex >= targetOffset) {
          return lineStart + lineOffset;
        }
      }
      lineOffset += current.textContent?.length || 0;
      current = walker.nextNode();
    }
    return lineStart + lineOffset;
  }

  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
  );

  let total = 0;
  let current = walker.nextNode();

  while (current) {
    if (current.parentElement?.closest?.('[data-noncontent="true"]')) {
      current = walker.nextNode();
      continue;
    }
    if (current === targetNode) {
      return total + targetOffset;
    }

    if (targetNode.nodeType === Node.ELEMENT_NODE && targetNode.contains(current)) {
      const parent = current.parentNode;
      const childNodes = Array.from(targetNode.childNodes);
      const childIndex = childNodes.indexOf(parent);

      if (childIndex >= 0 && childIndex < targetOffset) {
        total += current.textContent?.length || 0;
        current = walker.nextNode();
        continue;
      }

      if (childIndex >= targetOffset) {
        return total;
      }
    }

    total += current.textContent?.length || 0;
    current = walker.nextNode();
  }

  if (targetNode.nodeType === Node.ELEMENT_NODE) {
    const childNodes = Array.from(targetNode.childNodes).slice(0, targetOffset);
    return childNodes.reduce((sum, child) => sum + textLength(child), total);
  }

  return total;
}

function renderHighlightedText(text, ranges, showDetectedFields = false, pulseAttention = false) {
  if (!ranges.length) {
    return text;
  }

  const activeRanges = [...ranges]
    .filter((range) => typeof range.start === "number" && typeof range.end === "number" && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!activeRanges.length) {
    return text;
  }

  const boundaries = Array.from(new Set([
    0,
    text.length,
    ...activeRanges.flatMap((range) => [
      Math.max(0, Math.min(text.length, range.start)),
      Math.max(0, Math.min(text.length, range.end)),
    ]),
  ])).sort((a, b) => a - b);

  let elements = [];

  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const segStart = boundaries[i];
    const segEnd = boundaries[i + 1];
    if (segEnd <= segStart) {
      continue;
    }

    const segmentText = text.slice(segStart, segEnd);
    const overlapping = activeRanges.filter((range) => range.start < segEnd && range.end > segStart);
    if (!overlapping.length) {
      elements.push(<span key={`t-${i}`}>{segmentText}</span>);
      continue;
    }

    const decisionRange = overlapping.find((range) => range.kind !== "attention") || null;
    const hasAssigned = overlapping.some((range) => range.decision === "assigned");
    const hasSuggested = overlapping.some((range) => range.decision === "suggested");
    const hasAttention = overlapping.some((range) => range.kind === "attention");

    elements.push(
      <span
        key={`s-${i}`}
        data-start={decisionRange ? String(decisionRange.rawStart ?? decisionRange.start) : undefined}
        data-end={decisionRange ? String(decisionRange.rawEnd ?? decisionRange.end) : undefined}
        className={[
          decisionRange ? "email-range" : "",
          hasAssigned ? "assigned" : "",
          !hasAssigned && hasSuggested ? "suggested" : "",
          decisionRange && showDetectedFields ? "email-range-visible" : "",
          hasAttention ? "email-attention" : "",
          hasAttention && pulseAttention ? "email-attention-pulse" : "",
        ].filter(Boolean).join(" ")}
      >
        {segmentText}
      </span>,
    );
  }

  return elements;
}

function classifyLine(line) {
  const trimmed = String(line || "").trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed) {
    return "default";
  }
  if (lower.includes("order number")) {
    return "order_info";
  }
  if (lower.includes("shipping address")) {
    return "section_header";
  }
  if (
    trimmed.includes("$")
    || lower.includes("total")
    || /^shipping:/i.test(trimmed)
    || /^sales tax:/i.test(trimmed)
  ) {
    return "pricing";
  }
  if (
    trimmed.length > 80
    || lower.includes("learn more")
    || lower.includes("sell with confidence")
    || lower.includes("shipping internationally")
  ) {
    return "noise";
  }
  if (
    /^(size|personalization|shop|transaction id|quantity|processing time|item total|item price|heading|note from buyer|product|listing|pet name|enter type)/i.test(trimmed)
  ) {
    return "item";
  }
  return "default";
}

const HIDDEN_EMAIL_PATTERNS_KEY = "spaila:hidden-email-line-patterns";
const HIDDEN_PATTERN_FILLER_WORDS = new Set([
  "about", "the", "a", "an", "this", "that", "to", "for", "with", "and", "or",
  "learn", "more", "click", "here",
]);

function normalizeHiddenLinePattern(line) {
  return String(line || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generalizeHiddenLinePattern(line) {
  const words = normalizeHiddenLinePattern(line)
    .split(" ")
    .filter((word) => word && !HIDDEN_PATTERN_FILLER_WORDS.has(word));
  return words.slice(0, 6).join(" ");
}

function patternMatch(normalizedLine, storedPattern) {
  const pattern = normalizeHiddenLinePattern(storedPattern);
  if (!normalizedLine || !pattern) {
    return false;
  }
  if (normalizedLine.includes(pattern)) {
    return true;
  }
  const patternWords = pattern.split(" ").filter(Boolean);
  if (!patternWords.length) {
    return false;
  }
  const lineWords = new Set(normalizedLine.split(" ").filter(Boolean));
  const overlap = patternWords.filter((word) => lineWords.has(word)).length;
  return overlap / patternWords.length >= 0.7;
}

function lineMatchesHiddenPattern(line, hiddenPatterns, hiddenExactLines) {
  const normalizedLine = normalizeHiddenLinePattern(line);
  if (!normalizedLine) {
    return false;
  }
  if (hiddenExactLines?.has(normalizedLine)) {
    return true;
  }
  return hiddenPatterns.some((pattern) => patternMatch(normalizedLine, pattern));
}

function trimSelectionToExactText(displayText, start, end) {
  let nextStart = start;
  let nextEnd = end;
  while (nextStart < nextEnd && /\s/.test(displayText[nextStart])) {
    nextStart += 1;
  }
  while (nextEnd > nextStart && /\s/.test(displayText[nextEnd - 1])) {
    nextEnd -= 1;
  }
  return {
    start: nextStart,
    end: nextEnd,
    selectedText: displayText.slice(nextStart, nextEnd),
  };
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (
    typeof aStart !== "number"
    || typeof aEnd !== "number"
    || typeof bStart !== "number"
    || typeof bEnd !== "number"
  ) {
    return false;
  }
  return aStart < bEnd && bStart < aEnd;
}

function isAddressBreakLine(line) {
  const lower = String(line || "").trim().toLowerCase();
  return (
    !lower
    || lower.includes("purchase shipping label")
    || lower.includes("shipping internationally")
    || lower.includes("learn")
    || lower.includes("sell")
  );
}
const ADDRESS_SECTION_KEY = "shipping";

function getSectionMeta(sectionKey) {
  switch (sectionKey) {
    case "order":
      return { key: "order", title: "Order Information", type: "order_info" };
    case "shipping":
      return { key: "shipping", title: "📍 Shipping Address", type: "address" };
    case "item":
      return { key: "item", title: "📦 Item Details", type: "item" };
    case "pricing":
      return { key: "pricing", title: "💲 Pricing", type: "pricing" };
    case "noise":
      return { key: "noise", title: "", type: "additional_info" };
    default:
      return { key: "default", title: "", type: "additional_info" };
  }
}

function deriveSectionKey(type, context) {
  if (type === "order_info") {
    return "order";
  }
  if (type === "section_header" || type === "address") {
    return "shipping";
  }
  if (type === "pricing") {
    return "pricing";
  }
  if (type === "noise") {
    return "noise";
  }
  if (type === "item") {
    return "item";
  }
  if (!context.seenShippingHeader) {
    return "order";
  }
  if (context.seenPricing) {
    return "noise";
  }
  return "item";
}

function shouldStartOrderSection(line) {
  const lower = String(line || "").toLowerCase();
  return lower.includes("your order number") || lower.includes("congratulations");
}

function shouldStartAddressSection(line) {
  return String(line || "").toLowerCase().includes("shipping address");
}

function shouldStartPricingSection(line) {
  const trimmed = String(line || "").trim();
  return /^(?:price|order total|shipping):/i.test(trimmed) || /^order total\b/i.test(trimmed);
}

function isAdditionalInfoLine(line) {
  const lower = String(line || "").trim().toLowerCase();
  return (
    lower.startsWith("learn")
    || lower.startsWith("sell")
    || lower.includes("purchase shipping label")
    || lower.includes("shipping internationally")
    || lower.startsWith("choose")
    || lower.startsWith("double check")
  );
}

function shouldStartItemSection(line) {
  return /^(?:size|personalization|shop|transaction id|quantity|heading|note from buyer|product|listing|pet name|enter type|processing time)/i
    .test(String(line || "").trim());
}

function mergeAdjacentSections(sections) {
  return sections.reduce((merged, section) => {
    const previous = merged[merged.length - 1];
    if (previous && previous.key === section.key) {
      previous.lines.push(...section.lines);
      return merged;
    }
    merged.push(section);
    return merged;
  }, []);
}

function mergeAndOrderSections(sections) {
  const order = ["order", "shipping", "item", "pricing", "noise"];
  const buckets = new Map();

  sections.forEach((section) => {
    const key = section.key === "default" ? "noise" : section.key;
    const existing = buckets.get(key);
    if (existing) {
      existing.lines.push(...section.lines);
      return;
    }
    buckets.set(key, {
      ...getSectionMeta(key),
      lines: [...section.lines],
    });
  });

  return order
    .map((key) => buckets.get(key))
    .filter(Boolean);
}

function sliceRangesForLine(ranges, lineStart, lineEnd) {
  return ranges
    .filter((range) => range.start < lineEnd && range.end > lineStart)
    .map((range) => ({
      ...range,
      start: Math.max(range.start, lineStart) - lineStart,
      end: Math.min(range.end, lineEnd) - lineStart,
    }))
    .filter((range) => range.end > range.start);
}

function buildStructuredEmailSections(text) {
  const sections = [];
  let offset = 0;
  let currentSection = null;
  let currentSectionKey = null;
  let addressBlockClosed = false;
  const rawLines = String(text || "").split("\n");

  function ensureSection(sectionKey) {
    if (currentSection && currentSectionKey === sectionKey) {
      return currentSection;
    }
    currentSectionKey = sectionKey;
    currentSection = {
      ...getSectionMeta(sectionKey),
      lines: [],
    };
    sections.push(currentSection);
    return currentSection;
  }

  rawLines.forEach((line, index) => {
    const trimmed = line.trim();
    const isBlank = trimmed.length === 0;
    let type = classifyLine(line);
    let nextSectionKey = currentSectionKey;

    if (currentSectionKey === ADDRESS_SECTION_KEY) {
      if (isAddressBreakLine(line)) {
        addressBlockClosed = true;
        nextSectionKey = "noise";
        type = isBlank ? "default" : "noise";
      } else {
        nextSectionKey = ADDRESS_SECTION_KEY;
        type = "address";
      }
    } else if (shouldStartAddressSection(line)) {
      nextSectionKey = ADDRESS_SECTION_KEY;
      type = "section_header";
      addressBlockClosed = false;
    } else if (shouldStartOrderSection(line)) {
      nextSectionKey = "order";
      type = "order_info";
    } else if (shouldStartPricingSection(line)) {
      nextSectionKey = "pricing";
      type = "pricing";
    } else if (isAdditionalInfoLine(line)) {
      nextSectionKey = "noise";
      type = "noise";
    } else if (shouldStartItemSection(line) || (addressBlockClosed && !isBlank && type !== "noise")) {
      nextSectionKey = "item";
      addressBlockClosed = false;
      if (type === "default") {
        type = "item";
      }
    } else if (!nextSectionKey) {
      nextSectionKey = "order";
    }

    ensureSection(nextSectionKey).lines.push({
      id: `line-${index}`,
      text: line,
      type,
      start: offset,
      end: offset + line.length,
      hasTrailingNewline: index < rawLines.length - 1,
    });

    offset += line.length + 1;
  });

  return mergeAndOrderSections(mergeAdjacentSections(sections));
}

function renderStructuredEmail(
  text,
  ranges,
  showDetectedFields = false,
  pulseAttention = false,
  showFullEmail = false,
  hiddenPatterns = [],
  hiddenExactLines = new Set(),
  showHiddenContent = false,
  onLineContextMenu = null,
) {
  const sections = buildStructuredEmailSections(text);
  function renderLine(line) {
    const hiddenByUser = lineMatchesHiddenPattern(line.text, hiddenPatterns, hiddenExactLines);
    if (hiddenByUser && !showHiddenContent) {
      return null;
    }
    const lineRanges = sliceRangesForLine(ranges, line.start, line.end);
    const emphasize = /order number|\$/i.test(line.text);
    const renderTextPart = (partText, partStart = 0) => {
      const partRanges = lineRanges
        .filter((range) => range.start < partStart + partText.length && range.end > partStart)
        .map((range) => ({
          ...range,
          start: Math.max(range.start, partStart) - partStart,
          end: Math.min(range.end, partStart + partText.length) - partStart,
        }));
      const rendered = partRanges.length
        ? renderHighlightedText(partText, partRanges, showDetectedFields, pulseAttention)
        : partText;
      return emphasize ? <strong>{rendered}</strong> : rendered;
    };

    let lineBody;
    const priceMatch = line.type === "pricing" ? line.text.match(/^([^:]+:)(.*)$/) : null;
    if (priceMatch) {
      const labelText = priceMatch[1];
      const valueText = priceMatch[2];
      lineBody = (
        <span className="price-row">
          <span className="label">{renderTextPart(labelText, 0)}</span>
          <span className="value">{renderTextPart(valueText, labelText.length)}</span>
        </span>
      );
    } else {
      lineBody = renderTextPart(line.text, 0);
    }

    return (
      <React.Fragment key={line.id}>
        <span
          data-line-start={line.start}
          data-line-end={line.end}
          onContextMenu={(event) => {
            if (!line.text.trim()) {
              return;
            }
            onLineContextMenu?.(event, line.text);
          }}
          className={[
            "email-line",
            `email-line-${line.type}`,
            line.type === "noise" ? "email-noise" : "",
            hiddenByUser ? "email-hidden-line-visible" : "",
          ].filter(Boolean).join(" ")}
        >
          {lineBody}
        </span>
        {line.hasTrailingNewline ? "\n" : null}
      </React.Fragment>
    );
  }

  return sections.map((section) => {
    const isFooterSection = section.type === "additional_info";
    const sectionClassName = [
      "email-section",
      `email-section-${section.type}`,
      isFooterSection ? "email-footer-info" : "",
      isFooterSection && !showFullEmail ? "email-section-collapsed" : "",
    ].filter(Boolean).join(" ");

    const headerLines = section.key === ADDRESS_SECTION_KEY
      ? section.lines.filter((line) => line.type === "section_header")
      : [];
    const addressLines = section.key === ADDRESS_SECTION_KEY
      ? section.lines.filter((line) => line.type !== "section_header")
      : [];
    const content = section.key === ADDRESS_SECTION_KEY
      ? (
        <>
          {headerLines.map(renderLine)}
          <div className="address-box">
            {addressLines.map(renderLine)}
          </div>
        </>
      )
      : section.lines.map(renderLine);

    return (
      <div key={section.lines[0]?.id || section.key} className={sectionClassName}>
        {!isFooterSection && section.title ? (
          <div className="section-header" data-noncontent="true">{section.title}</div>
        ) : null}
        {content}
      </div>
    );
  });
}

function buildHighlights(decisions, suppressedFields) {
  return [
    ...decisions
    .filter((decision) => !suppressedFields.includes(decision.field))
    .filter((decision) => typeof decision.start === "number" && typeof decision.end === "number" && decision.end > decision.start)
    .map((decision) => ({
      start: decision.start,
      end: decision.end,
      field: decision.field,
      decision: decision.decision,
      kind: "decision",
    })),
  ];
}

function manualItemHighlights(items) {
  return items.flatMap((item) => Object.entries(item)
    .filter(([, value]) => value && typeof value === "object" && value.start !== undefined && value.end !== undefined)
    .map(([field, value]) => ({
      start: value.start,
      end: value.end,
      field,
      decision: "assigned",
      kind: "decision",
    })));
}

function manualGiftMessageHighlight(giftMessage) {
  if (!giftMessage || typeof giftMessage.start !== "number" || typeof giftMessage.end !== "number" || giftMessage.end <= giftMessage.start) {
    return [];
  }
  return [{
    start: giftMessage.start,
    end: giftMessage.end,
    field: "gift_message",
    decision: "assigned",
    kind: "decision",
  }];
}

function buildUnifiedHighlights(decisions, suppressedFields, items, giftMessage) {
  return [
    ...buildHighlights(decisions, suppressedFields),
    ...manualItemHighlights(items),
    ...manualGiftMessageHighlight(giftMessage),
  ];
}

function buildGiftAttentionHighlights(meta) {
  const ranges = Array.isArray(meta?.gift_attention_ranges) ? meta.gift_attention_ranges : [];
  return ranges
    .filter((range) => typeof range?.start === "number" && typeof range?.end === "number" && range.end > range.start)
    .map((range) => ({
      start: range.start,
      end: range.end,
      rawStart: range.start,
      rawEnd: range.end,
      kind: "attention",
    }));
}

function itemFieldValue(value) {
  if (value && typeof value === "object") {
    return normalizeFieldValue(value.value || "");
  }
  return normalizeFieldValue(value || "");
}

/** True when any meaningful field on an item has been filled. */
function itemHasContent(item) {
  const keys = ["price", "custom_1", "custom_2", "custom_3", "custom_4", "custom_5", "custom_6", "order_notes"];
  return keys.some((k) => {
    const v = item[k];
    if (!v) return false;
    if (typeof v === "object") return !!v.value;
    return v.trim() !== "";
  });
}

function itemFieldDecision(meta, value) {
  if (value && typeof value === "object") {
    return "assigned";
  }
  return meta?.decision || "";
}

function actionAlreadyApplied(action, decision) {
  if (!decision) {
    return false;
  }

  if (action === "save_assignment") {
    // Any assigned decision — hard-learned, confidence-promoted, or anchor —
    // is already in the "assigned" state; the Accept button should be inactive.
    return decision.decision === "assigned"
      || decision.signals.includes("assigned_value(+5.0)")
      || decision.signals.includes("anchor_override(+∞)");
  }

  if (action === "save_rejection") {
    return decision.signals.includes("rejected_value(−∞)");
  }

  return false;
}

function emptyItem() {
  return {
    price: null,
    custom_1: "",
    custom_2: "",
    custom_3: "",
    custom_4: "",
    custom_5: "",
    custom_6: "",
    order_notes: "",
  };
}

function emptyItemMeta() {
  return {
    price: null,
    custom_1: null,
    custom_2: null,
    custom_3: null,
    custom_4: null,
    custom_5: null,
    custom_6: null,
    order_notes: null,
  };
}

function parseQuantity(decisions) {
  const quantityDecision = decisions.find((decision) => decision.field === "quantity");
  const parsed = Number.parseInt(quantityDecision?.value || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildItemState(decisions, previousItems = [], previousItemMeta = [], priceCandidateCount = 0) {
  const quantity = parseQuantity(decisions);
  const priceDecision = decisions.find((decision) => decision.field === "price") || null;
  const items = [];
  const itemMeta = [];

  for (let index = 0; index < quantity; index += 1) {
    const priorItem = previousItems[index] || emptyItem();
    const priorMeta = previousItemMeta[index] || emptyItemMeta();

    // Each item is a completely independent object — no shared references.
    const nextItem = {
      ...emptyItem(),
      custom_1: priorItem.custom_1 || "",
      custom_2: priorItem.custom_2 || "",
      custom_3: priorItem.custom_3 || "",
      custom_4: priorItem.custom_4 || "",
      custom_5: priorItem.custom_5 || "",
      custom_6: priorItem.custom_6 || "",
    };
    const nextMeta = {
      ...emptyItemMeta(),
      custom_1: priorMeta.custom_1,
      custom_2: priorMeta.custom_2,
      custom_3: priorMeta.custom_3,
      custom_4: priorMeta.custom_4,
      custom_5: priorMeta.custom_5,
      custom_6: priorMeta.custom_6,
    };

    if (priorMeta.price?.source === "manual") {
      // Always preserve a price the user explicitly assigned for this item.
      nextItem.price = priorItem.price;
      nextMeta.price = priorMeta.price;
    } else if (priceDecision && index === 0) {
      // Only item 0 receives the parser price suggestion.
      // Items 1+ must always start empty so each is independently assigned.
      nextItem.price = priceDecision.value;
      nextMeta.price = {
        source: "parser",
        decision: priceDecision.decision,
        start: priceDecision.start,
        end: priceDecision.end,
        value: priceDecision.value,
      };
    } else {
      // Item index > 0, or no price decision: always empty.
      nextItem.price = null;
      nextMeta.price = null;
    }

    items.push(nextItem);
    itemMeta.push(nextMeta);
  }

  if (quantity > 1) {
    console.log("ITEM_STATE_CHECK", {
      item_1_price: items[0]?.price ?? null,
      item_2_price: items[1]?.price ?? null,
      same_reference: items[0] === items[1],
    });
  }

  return { quantity, items, itemMeta };
}

/* ── Tooltip helpers ──────────────────────────────────────────────────── */

const _SIGNAL_CONTEXT_MAP = [
  ["inside_line_item_block",  "line item block"],
  ["line_item_proximity",     "line item block"],
  ["near_quantity",           "near quantity field"],
  ["aligned_with_quantity",   "near quantity field"],
  ["order_keyword_near",      "near order label"],
  ["order_date_context",      "order details"],
  ["header_date_base",        "email header"],
  ["ship_by_keyword",         "ship-by line"],
  ["quantity_label",          "quantity label"],
  ["structured_quantity",     "quantity label"],
  ["customer_context",        "customer section"],
  ["shipping_label_context",  "shipping block"],
  ["dollar_prefix",           "inline price"],
  ["explicit_currency",       "inline price"],
];

function _inferContext(signals) {
  for (const sig of (signals || [])) {
    for (const [key, label] of _SIGNAL_CONTEXT_MAP) {
      if (sig.includes(key)) return label;
    }
  }
  return null;
}

function _hasSignal(signals, key) {
  return (signals || []).some((s) => s.includes(key));
}

function buildTooltipLines(decision, fieldKey, priceCandidateCount) {
  if (!decision || !decision.decision) return [];

  const lines = [];
  const { decision: status, decision_source, streak_count, signals } = decision;

  // ── quantity ────────────────────────────────────────────────────────────
  if (fieldKey === "quantity") {
    if (status === "assigned" && decision_source === "confidence_promotion") {
      lines.push("Learned from your correction");
      lines.push("Now matched automatically");
    } else if (status === "assigned") {
      lines.push("You corrected this value");
      lines.push("System will use this pattern moving forward");
    } else if (status === "suggested") {
      lines.push("Suggested based on pattern match");
      lines.push("Click to confirm");
    }
    return lines;
  }

  // ── order_date ──────────────────────────────────────────────────────────
  if (fieldKey === "order_date") {
    if (status === "assigned") {
      if (decision_source === "manual") {
        lines.push("Manually confirmed");
      } else {
        // Always deterministically extracted — never confidence-promoted.
        const fromHeader = _hasSignal(signals, "header_date_base")
          || _hasSignal(signals, "email_header")
          || _hasSignal(signals, "order_date_context");
        lines.push(fromHeader ? "Extracted from email header" : "Auto-extracted from email");
        lines.push("Matched order date pattern");
      }
    } else if (status === "suggested") {
      const fromHeader = _hasSignal(signals, "header_date_base")
        || _hasSignal(signals, "email_header")
        || _hasSignal(signals, "order_date_context");
      lines.push(fromHeader ? "Extracted from email header" : "Suggested based on pattern match");
      lines.push("Click to confirm");
    }
    return lines;
  }

  // ── ship_by ─────────────────────────────────────────────────────────────
  if (fieldKey === "ship_by") {
    if (status === "assigned") {
      if (decision_source === "manual") {
        lines.push("Manually confirmed");
      } else {
        // Always deterministically extracted — never confidence-promoted.
        const fromSubject = _hasSignal(signals, "ship_by_keyword")
          || _hasSignal(signals, "subject_date")
          || _hasSignal(signals, "header_date_base");
        lines.push(fromSubject ? "Found in subject line" : "Auto-extracted from email");
        lines.push("Matched 'Ship by' date");
      }
    } else if (status === "suggested") {
      const fromSubject = _hasSignal(signals, "ship_by_keyword")
        || _hasSignal(signals, "subject_date")
        || _hasSignal(signals, "header_date_base");
      lines.push(fromSubject ? "Found in subject line" : "Suggested based on pattern match");
      lines.push("Click to confirm");
    }
    return lines;
  }

  // ── all other fields ─────────────────────────────────────────────────────
  if (status === "assigned" && decision_source === "confidence_promotion") {
    lines.push("Auto-filled from learned pattern");
    if (streak_count > 0) {
      lines.push(`Seen in ${streak_count} similar email${streak_count !== 1 ? "s" : ""}`);
    }
    const ctx = _inferContext(signals);
    if (ctx) lines.push(`Matched: ${ctx}`);
  } else if (status === "assigned") {
    lines.push("Manually confirmed");
  } else if (status === "suggested") {
    lines.push("Suggested based on pattern match");
    lines.push("Click to confirm");
  }

  if (fieldKey === "price" && (priceCandidateCount ?? 0) > 1) {
    lines.push("Multiple possible matches found");
    lines.push("Selected best candidate");
    lines.push("You can choose another");
  }

  return lines;
}

function useTooltip(delayMs = 160) {
  const [visible, setVisible] = React.useState(false);
  const [anchorRect, setAnchorRect] = React.useState(null);
  const timer = React.useRef(null);
  const ref = React.useRef(null);

  const show = React.useCallback(() => {
    timer.current = setTimeout(() => {
      if (ref.current) setAnchorRect(ref.current.getBoundingClientRect());
      setVisible(true);
    }, delayMs);
  }, [delayMs]);

  const hide = React.useCallback(() => {
    clearTimeout(timer.current);
    setVisible(false);
  }, []);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  return { visible, anchorRect, show, hide, ref };
}

function FieldTooltip({ lines, anchorRect }) {
  if (!lines || lines.length === 0 || !anchorRect) return null;

  // Position: centered above the row, using fixed coords from getBoundingClientRect.
  // Rendered into document.body via portal so no overflow container can clip it.
  const left = anchorRect.left + anchorRect.width / 2;
  const top  = anchorRect.top - 8;

  return createPortal(
    <div style={{
      position: "fixed",
      top,
      left,
      transform: "translate(-50%, -100%)",
      background: "#1c1917",
      color: "#e7e5e4",
      borderRadius: "6px",
      padding: "7px 11px",
      fontSize: "11px",
      lineHeight: 1.55,
      whiteSpace: "nowrap",
      zIndex: 99999,
      pointerEvents: "none",
      boxShadow: "0 4px 14px rgba(0,0,0,0.32)",
    }}>
      {lines.map((line, i) => <div key={i}>{line}</div>)}
      <div style={{
        position: "absolute",
        top: "100%",
        left: "50%",
        transform: "translateX(-50%)",
        width: 0,
        height: 0,
        borderLeft: "5px solid transparent",
        borderRight: "5px solid transparent",
        borderTop: "5px solid #1c1917",
      }} />
    </div>,
    document.body,
  );
}

function formatAddressForDisplay(value) {
  let display = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!display) {
    return "";
  }

  display = display.replace(
    /\s+([A-Z][A-Z\s]+,\s?[A-Z]{2}\s?\d{5}(?:-\d{4})?)/g,
    "\n$1",
  );
  display = display.replace(
    /\s+(\d{3,6}\s[A-Za-z])/g,
    "\n$1",
  );
  display = display.replace(/\s+(United States)\b/gi, "\n$1");

  return display
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function FieldRow({
  label,
  fieldKey,
  decision,
  manualValue,
  hasSelection,
  loading,
  selected,
  onSelect,
  onTeach,
  onManualChange,
  multiline,
  priceCandidateCount,
  isKeyActive,
  navKey,
  required,
}) {
  const value = normalizeFieldValue(decision?.value ?? "");
  const isAddressField = fieldKey === "shipping_address";
  const isManualOverride = manualValue !== undefined;
  const effectiveValue = isManualOverride ? manualValue : value;
  const displayValue = isAddressField ? formatAddressForDisplay(effectiveValue) : effectiveValue;
  const canAccept = !!decision && !loading && !actionAlreadyApplied("save_assignment", decision);
  const canReject = !!decision && !loading && !actionAlreadyApplied("save_rejection", decision);
  const inputState = isManualOverride && normalizeFieldValue(manualValue)
    ? "assigned-state"
    : decision?.decision === "assigned"
    ? "assigned-state"
    : decision?.decision === "suggested"
      ? "suggested-state"
      : "";
  const isEditable = typeof onManualChange === "function";
  const isDatePickerField = fieldKey === "ship_by";
  const inputValue = isDatePickerField ? toDateInputValue(effectiveValue) : effectiveValue;

  const lineCount = displayValue ? displayValue.split("\n").length : 1;
  const addressFieldRef = React.useRef(null);
  const tooltip = useTooltip();
  const tooltipLines = buildTooltipLines(decision, fieldKey, priceCandidateCount);

  React.useEffect(() => {
    if (!isAddressField || !addressFieldRef.current) {
      return;
    }
    const node = addressFieldRef.current;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [displayValue, isAddressField]);

  console.log("UI_RENDER_DECISION", { field: fieldKey, decision: decision?.decision ?? null, inputState });

  return (
    <div
      ref={tooltip.ref}
      data-nav-key={navKey ?? fieldKey}
      className={`field-row compact-row${multiline ? " multiline-row" : ""}${selected || isKeyActive ? " active-field" : ""}`}
      onMouseEnter={tooltipLines.length > 0 ? tooltip.show : undefined}
      onMouseLeave={tooltipLines.length > 0 ? tooltip.hide : undefined}
      onClick={() => onSelect(decision, fieldKey)}
      onKeyDown={(event) => {
        const tag = event.target.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || tag === "select") {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(decision, fieldKey);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <label className="compact-label" htmlFor={`field-${fieldKey}`}>{label}</label>
      {multiline ? (
        <textarea
          ref={isAddressField ? addressFieldRef : null}
          id={`field-${fieldKey}`}
          className={[
            "field-input",
            "field-textarea",
            isAddressField ? "field-address" : "",
            inputState,
          ].filter(Boolean).join(" ")}
          value={displayValue}
          placeholder="(empty)"
          rows={isAddressField ? Math.max(3, Math.min(lineCount, 4)) : lineCount}
          readOnly={!isEditable}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(decision, fieldKey);
          }}
          onFocus={() => onSelect(decision, fieldKey)}
          onChange={(event) => onManualChange?.(fieldKey, event.target.value)}
        />
      ) : (
        <input
          id={`field-${fieldKey}`}
          className={`field-input ${isDatePickerField ? "field-date-input" : ""} ${inputState}`}
          type={isDatePickerField ? "date" : "text"}
          value={inputValue}
          placeholder={required ? "Required" : "(empty)"}
          readOnly={!isEditable}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(decision, fieldKey);
          }}
          onFocus={() => onSelect(decision, fieldKey)}
          onChange={(event) => onManualChange?.(fieldKey, event.target.value)}
          aria-required={required || undefined}
          title={isDatePickerField && effectiveValue && !inputValue ? `Current value: ${effectiveValue}` : undefined}
        />
      )}
      <div className="compact-actions">
        <button
          type="button"
          className="action-button compact-button"
          disabled={loading || (!canAccept && !hasSelection)}
          onClick={(event) => {
            event.stopPropagation();
            if (decision) {
              onTeach("save_assignment", decision);
              return;
            }
            onSelect(null, fieldKey);
          }}
          title="Accept"
        >
          ✓
        </button>
        <button
          type="button"
          className="action-button reject compact-button"
          disabled={!canReject}
          onClick={(event) => {
            event.stopPropagation();
            console.log("REJECT_CLICK", { field: fieldKey, value: decision?.value ?? "" });
            if (!decision) {
              console.log("REJECT_SKIPPED", { reason: "no_decision", field: fieldKey });
              return;
            }
            if (loading) {
              console.log("REJECT_SKIPPED", { reason: "loading", field: fieldKey });
              return;
            }
            if (!canReject) {
              console.log("REJECT_SKIPPED", { reason: "already_rejected_or_disabled", field: fieldKey });
              return;
            }
            onTeach("save_rejection", decision);
          }}
          title="Reject"
        >
          ✕
        </button>
      </div>
      {tooltip.visible && <FieldTooltip lines={tooltipLines} anchorRect={tooltip.anchorRect} />}
    </div>
  );
}

function ItemFieldRow({
  label,
  fieldKey,
  value,
  meta,
  hasSelection,
  loading,
  selected,
  onSelect,
  onAccept,
  onReject,
  isKeyActive,
  navKey,
}) {
  const itemDecision = itemFieldDecision(meta, value);
  const inputState = itemDecision === "assigned"
    ? "assigned-state"
    : itemDecision === "suggested"
      ? "suggested-state"
      : "";
  const canAccept = !loading && (!!hasSelection || (fieldKey === "price" && meta?.source === "parser"));
  const canReject = !loading && !!itemFieldValue(value);

  const itemTooltip = useTooltip();
  const itemTooltipLines = buildTooltipLines(
    meta && meta[fieldKey] ? meta[fieldKey] : null,
    fieldKey,
    meta?.priceCandidateCount,
  );

  return (
    <div
      ref={itemTooltip.ref}
      data-nav-key={navKey ?? `item-${fieldKey}`}
      className={`field-row compact-row${selected || isKeyActive ? " active-field" : ""}`}
      onMouseEnter={itemTooltipLines.length > 0 ? itemTooltip.show : undefined}
      onMouseLeave={itemTooltipLines.length > 0 ? itemTooltip.hide : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <label className="compact-label" htmlFor={`item-field-${fieldKey}`}>{label}</label>
      <input
        id={`item-field-${fieldKey}`}
        className={`field-input ${inputState}`}
        type="text"
        value={itemFieldValue(value)}
        placeholder="(empty)"
        readOnly
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onFocus={onSelect}
        onChange={() => {}}
      />
      <div className="compact-actions">
        <button
          type="button"
          className="action-button compact-button"
          disabled={!canAccept}
          onClick={(event) => {
            event.stopPropagation();
            onAccept();
          }}
          title="Accept"
        >
          ✓
        </button>
        <button
          type="button"
          className="action-button reject compact-button"
          disabled={!canReject}
          onClick={(event) => {
            event.stopPropagation();
            console.log("REJECT_CLICK", { field: fieldKey, value: itemFieldValue(value) });
            if (loading) {
              console.log("REJECT_SKIPPED", { reason: "loading", field: fieldKey });
              return;
            }
            if (!canReject) {
              console.log("REJECT_SKIPPED", { reason: "cannot_reject_item_field", field: fieldKey });
              return;
            }
            onReject();
          }}
          title="Reject"
        >
          ✕
        </button>
      </div>
      {itemTooltip.visible && <FieldTooltip lines={itemTooltipLines} anchorRect={itemTooltip.anchorRect} />}
    </div>
  );
}

export default function App({
  onCreated,
  onOrderCreated,
  onBack,
  onWorkspace,
  onSettings,
  ordersTab = "active",
  onOrdersTabChange,
  selectedFilePath = "",
  selectedFileRequestKey = 0,
}) {
  // Field label config — reloads whenever the user saves Settings.
  const [fieldConfig, setFieldConfig] = React.useState(() => loadFieldConfig());
  React.useEffect(() => {
    function onConfigChange() { setFieldConfig(loadFieldConfig()); }
    window.addEventListener("spaila:fieldconfig", onConfigChange);
    return () => window.removeEventListener("spaila:fieldconfig", onConfigChange);
  }, []);

  // Parser field order — reloads when user saves Settings.
  const [parserFieldOrder, setParserFieldOrder] = React.useState(() => loadParserFieldOrder());
  React.useEffect(() => {
    function onOrderChange() { setParserFieldOrder(loadParserFieldOrder()); }
    window.addEventListener("spaila:parserfieldorder", onOrderChange);
    return () => window.removeEventListener("spaila:parserfieldorder", onOrderChange);
  }, []);

  const [documentsConfig, setDocumentsConfig] = React.useState(() => loadDocumentsConfig());
  React.useEffect(() => {
    function onDocsChange() { setDocumentsConfig(loadDocumentsConfig()); }
    window.addEventListener("spaila:documentsconfig", onDocsChange);
    return () => window.removeEventListener("spaila:documentsconfig", onDocsChange);
  }, []);

  // Derive label and visibility arrays from live config so changes propagate everywhere.
  const _labels = buildLabelMap(fieldConfig);
  const _parserVisible = buildParserVisibilityMap(fieldConfig);

  // Build _ORDER_FIELD_KEYS lookup for fast metadata access.
  const _orderKeyMeta = Object.fromEntries(_ORDER_FIELD_KEYS.map((f) => [f.key, f]));
  const _itemKeyMeta  = Object.fromEntries(_ITEM_FIELD_KEYS.map((f)  => [f.key, f]));

  // Apply user-preferred order, falling back to default array order for any key not in parserFieldOrder.
  const orderedFields = parserFieldOrder
    .filter((key) => key in _orderKeyMeta && (_parserVisible[key] !== false || REQUIRED_ORDER_FIELD_KEYS.has(key)))
    .map((key) => {
      const { multiline } = _orderKeyMeta[key];
      return [_labels[key] ?? key, key, !!multiline];
    });

  const itemFieldOrder = parserFieldOrder
    .filter((key) => key in _itemKeyMeta && _parserVisible[key] !== false)
    .map((key) => [_labels[key] ?? key, key]);

  const [state, setState] = React.useState({
    text: "",
    subject: "",
    decisions: [],
    filePath: "",
    error: "",
    loading: false,
    quantity: 1,
    items: [emptyItem()],
    trustReport: null,
  });
  const [flags, setFlags] = React.useState({});
  const [meta, setMeta] = React.useState({});
  const [segments, setSegments] = React.useState([]);
  const [suppressedFields, setSuppressedFields] = React.useState([]);
  const [selectedField, setSelectedField] = React.useState(null);
  const [selection, setSelection] = React.useState(null);
  const [activeItemIndex, setActiveItemIndex] = React.useState(0);
  const [itemMeta, setItemMeta] = React.useState([emptyItemMeta()]);
  const [giftMessage, setGiftMessage] = React.useState(null);
  const [giftMessageMeta, setGiftMessageMeta] = React.useState(null);
  const [giftOptions, setGiftOptions] = React.useState({ is_gift: false, gift_wrap: false });
  const [activeKeyField, setActiveKeyField] = React.useState(null);
  const [createToast, setCreateToast] = React.useState("");
  const [manualOrderFields, setManualOrderFields] = React.useState({});
  const [showDetectedFields, setShowDetectedFields] = React.useState(false);
  const [showFullEmail, setShowFullEmail] = React.useState(false);
  const [showHiddenContent, setShowHiddenContent] = React.useState(false);
  const [userHiddenPatterns, setUserHiddenPatterns] = React.useState(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_EMAIL_PATTERNS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch {
      return [];
    }
  });
  const [hiddenExactLines, setHiddenExactLines] = React.useState(() => new Set());
  const [lineContextMenu, setLineContextMenu] = React.useState(null);
  const [pulseGiftAttention, setPulseGiftAttention] = React.useState(false);
  React.useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_EMAIL_PATTERNS_KEY, JSON.stringify(userHiddenPatterns));
    } catch {
      // UI-only preference; ignore storage failures.
    }
  }, [userHiddenPatterns]);
  React.useEffect(() => {
    if (!lineContextMenu) {
      return undefined;
    }
    function closeMenu() {
      setLineContextMenu(null);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") {
        closeMenu();
      }
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [lineContextMenu]);
  const actionLockRef = React.useRef("");
  const debounceRef = React.useRef(null);
  const textRef = React.useRef(null);
  const applyResultRef = React.useRef(null);
  const clearSelectionRef = React.useRef(null);
  const resetParserUiRef = React.useRef(null);
  const latestSelectedFileLoadRef = React.useRef(0);
  const activeKeyFieldRef = React.useRef(null);
  const giftPulseTimerRef = React.useRef(null);
  const lastGiftPulseFileRef = React.useRef("");
  // Synchronous mirror of selection state. Written before React schedules a
  // re-render so field click handlers always read the live value regardless of
  // whether the async state update has propagated yet.
  const lastSelectionRef = React.useRef(null);
  // Tracks how many leading characters are trimmed from the displayed email so
  // captureSelection can validate against the trimmed text and convert positions
  // back to original coordinates before passing them to the backend.
  const emailTrimOffsetRef = React.useRef(0);

  const visibleDecisions = state.decisions.filter(
    (decision) => !suppressedFields.includes(decision.field),
  );
  const decisionMap = Object.fromEntries(
    visibleDecisions.map((decision) => [decision.field, decision]),
  );
  const highlights = buildUnifiedHighlights(state.decisions, suppressedFields, state.items, giftMessage);
  const attentionHighlights = buildGiftAttentionHighlights(meta);
  const currentOrderNumber = decisionMap.order_number?.value || "";

  // Only blue (user-confirmed) values — used by Create Order
  const assignedFields = Object.fromEntries(
    visibleDecisions
      .filter((d) => d.decision === "assigned")
      .map((d) => [d.field, normalizeFieldValue(d.value)]),
  );
  const manualShipByTouched = Object.prototype.hasOwnProperty.call(manualOrderFields, "ship_by");
  const effectiveAssignedFields = {
    ...assignedFields,
    ship_by: manualShipByTouched
      ? normalizeFieldValue(manualOrderFields.ship_by)
      : normalizeFieldValue(assignedFields.ship_by || ""),
  };

  const priceCandidateCount = meta?.price_candidate_count ?? 0;
  // Combine state and ref so hasSelection is true the moment text is highlighted,
  // even before the async state update propagates.
  const hasSelection = !!(selection?.selected_text || lastSelectionRef.current?.selected_text);

  const scrollToRange = React.useCallback((field, start, end) => {
    if (typeof start !== "number" || typeof end !== "number" || end <= start) {
      return;
    }
    const selector = `[data-start="${String(start)}"][data-end="${String(end)}"]`;
    const el = textRef.current?.querySelector(selector) || document.querySelector(selector);
    if (!el) {
      console.warn("Range not found for field", field);
      return;
    }
    el.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    el.classList.remove("email-flash");
    void el.offsetWidth;
    el.classList.add("email-flash");
    window.setTimeout(() => {
      el.classList.remove("email-flash");
    }, 1500);
  }, []);

  const scrollToDecisionRange = React.useCallback((field, source) => {
    if (!source) {
      return;
    }
    scrollToRange(field, source.start, source.end);
  }, [scrollToRange]);

  const handleManualOrderFieldChange = React.useCallback((field, value) => {
    setManualOrderFields((current) => ({
      ...current,
      [field]: value,
    }));
    setSelectedField(field);
  }, []);

  // ── Keyboard navigation ────────────────────────────────────────────────────

  // Flat ordered list of every navigable field key.
  const navFields = React.useMemo(() => [
    ...orderedFields.map(([, key]) => key),
    "gift_message",
    ...itemFieldOrder.map(([, key]) => `item:${activeItemIndex}:${key}`),
  ], [activeItemIndex]);

  // Keep refs in sync every render so the single keydown closure always
  // reads the latest state without being re-registered.
  React.useEffect(() => { activeKeyFieldRef.current = activeKeyField; }, [activeKeyField]);

  const _kbRef = React.useRef(null);

  // Register once, never re-register. All mutable state is read via _kbRef.
  React.useEffect(() => {
    function _scroll(key) {
      requestAnimationFrame(() => {
        document.querySelector(`[data-nav-key="${CSS.escape(key)}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }

    function _accept(key, kb) {
      if (!key) return;
      if (key.startsWith("item:")) {
        const [, idxStr, field] = key.split(":");
        const itemIndex = parseInt(idxStr, 10);
        if (field === "price" && kb.itemMeta[itemIndex]?.price?.source === "parser" && kb.decisionMap.price) {
          kb.teach("save_assignment", kb.decisionMap.price);
        } else {
          kb.assignSelectionToItemField(field, itemIndex);
        }
      } else if (key === "gift_message") {
        kb.assignGiftMessage();
      } else {
        const dec = kb.decisionMap[key];
        if (dec) kb.teach("save_assignment", dec);
      }
    }

    function _reject(key, kb) {
      if (!key) return;
      if (key.startsWith("item:")) {
        const [, idxStr, field] = key.split(":");
        const itemIndex = parseInt(idxStr, 10);
        if (field === "price" && kb.itemMeta[itemIndex]?.price?.source === "parser" && kb.decisionMap.price) {
          kb.teach("save_rejection", kb.decisionMap.price);
        } else {
          kb.rejectItemField(field, itemIndex);
        }
      } else if (key === "gift_message") {
        kb.rejectGiftMessage();
      } else {
        const dec = kb.decisionMap[key];
        if (dec) kb.teach("save_rejection", dec);
      }
    }

    function onKeyDown(e) {
      const kb = _kbRef.current;
      const { navFields, setActiveKeyField } = kb;

      // Use e.target to detect typing — more reliable than document.activeElement.
      const tag = e.target.tagName.toLowerCase();
      const isTyping = tag === "input" || tag === "textarea" || tag === "select";

      const cur = activeKeyFieldRef.current;
      const idx = cur ? navFields.indexOf(cur) : -1;

      // ↑ ↓ — activate / move nav (always, unless typing).
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (isTyping) return;
        e.preventDefault();
        const next = e.key === "ArrowDown"
          ? (idx < navFields.length - 1 ? idx + 1 : 0)
          : (idx > 0 ? idx - 1 : navFields.length - 1);
        setActiveKeyField(navFields[next]);
        _scroll(navFields[next]);
        return;
      }

      // Tab / Shift+Tab — always navigate fields (unless typing in an input).
      // When nothing is active yet, Tab starts at the first field; Shift+Tab at the last.
      if (e.key === "Tab" && !isTyping) {
        e.preventDefault();
        const next = !e.shiftKey
          ? (idx < navFields.length - 1 ? idx + 1 : 0)
          : (idx > 0 ? idx - 1 : navFields.length - 1);
        setActiveKeyField(navFields[next]);
        _scroll(navFields[next]);
        return;
      }

      // All remaining shortcuts need a selected field and no typing context.
      if (!cur || isTyping) return;

      if (e.key === "Enter") {
        e.preventDefault();
        _accept(cur, kb);
      } else if (e.key.toLowerCase() === "x") {
        e.preventDefault();
        _reject(cur, kb);
      } else if (e.key.toLowerCase() === "a") {
        e.preventDefault();
        _accept(cur, kb);
        const next = idx < navFields.length - 1 ? idx + 1 : 0;
        setActiveKeyField(navFields[next]);
        _scroll(navFields[next]);
      } else if (e.key.toLowerCase() === "e") {
        e.preventDefault();
        document.querySelector(
          `[data-nav-key="${CSS.escape(cur)}"] input, [data-nav-key="${CSS.escape(cur)}"] textarea`
        )?.focus();
      } else if (e.key === "Escape") {
        setActiveKeyField(null);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []); // ← empty deps: register once, read live values via _kbRef

  // ── End keyboard navigation ────────────────────────────────────────────────

  const requiredFields = Array.from(REQUIRED_ORDER_FIELD_KEYS);
  const requiredFieldLabels = {
    order_number: "Order number",
    buyer_name: "Buyer name",
    ship_by: "Ship by date",
  };
  const missingRequiredFields = requiredFields.filter((f) => {
    const val = effectiveAssignedFields[f];
    return !val || val.trim() === "";
  });
  const canCreateOrder = requiredFields.every((f) => {
    const val = effectiveAssignedFields[f];
    return val && val.trim() !== "";
  });
  const unresolvedGiftFlags = React.useMemo(() => {
    const unresolved = [];
    if (flags.gift && !giftOptions.is_gift) {
      unresolved.push({ key: "gift", label: "Gift detected" });
    }
    if (flags.gift_wrap && !giftOptions.gift_wrap) {
      unresolved.push({ key: "gift_wrap", label: "Gift wrap detected" });
    }
    if (flags.gift_message && !normalizeFieldValue(giftMessage?.value || "")) {
      unresolved.push({ key: "gift_message", label: "Gift message detected" });
    }
    return unresolved;
  }, [flags.gift, flags.gift_message, flags.gift_wrap, giftMessage, giftOptions.gift_wrap, giftOptions.is_gift]);

  function buildOrderPayload() {
    return {
      order: {
        order_number: normalizeFieldValue(effectiveAssignedFields.order_number || ""),
        order_date: normalizeFieldValue(effectiveAssignedFields.order_date || ""),
        buyer_name: normalizeFieldValue(effectiveAssignedFields.buyer_name || ""),
        buyer_email: normalizeFieldValue(effectiveAssignedFields.buyer_email || ""),
        shipping_address: normalizeFieldValue(effectiveAssignedFields.shipping_address || ""),
        ship_by: normalizeFieldValue(effectiveAssignedFields.ship_by || ""),
        gift_message: normalizeFieldValue(giftMessage?.value || ""),
        is_gift: !!giftOptions.is_gift,
        gift_wrap: !!giftOptions.gift_wrap,
      },
      items: state.items.map((item, index) => ({
        item_index: index + 1,
        quantity: 1,
        price: normalizeFieldValue((typeof item.price === "object" ? item.price?.value : item.price) || ""),
        order_notes: normalizeFieldValue((typeof item.order_notes === "object" ? item.order_notes?.value : item.order_notes) || ""),
        custom_fields: {
          custom_1: normalizeFieldValue((typeof item.custom_1 === "object" ? item.custom_1?.value : item.custom_1) || ""),
          custom_2: normalizeFieldValue((typeof item.custom_2 === "object" ? item.custom_2?.value : item.custom_2) || ""),
          custom_3: normalizeFieldValue((typeof item.custom_3 === "object" ? item.custom_3?.value : item.custom_3) || ""),
          custom_4: normalizeFieldValue((typeof item.custom_4 === "object" ? item.custom_4?.value : item.custom_4) || ""),
          custom_5: normalizeFieldValue((typeof item.custom_5 === "object" ? item.custom_5?.value : item.custom_5) || ""),
          custom_6: normalizeFieldValue((typeof item.custom_6 === "object" ? item.custom_6?.value : item.custom_6) || ""),
        },
      })),
      meta: {
        source: "eml",
        platform: meta.platform || "unknown",
        source_eml_path: state.filePath || null,
        created_at: new Date().toISOString(),
      },
    };
  }

  React.useEffect(() => {
    if (!createToast) {
      return undefined;
    }

    const timer = setTimeout(() => setCreateToast(""), 2200);
    return () => clearTimeout(timer);
  }, [createToast]);

  async function createOrder() {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const payload = buildOrderPayload();
      console.log("CREATE ORDER PAYLOAD:", payload);
      const res = await fetch("http://127.0.0.1:8055/orders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || data?.detail || "Failed to create order");
      }
      console.log("ORDER CREATED:", data);
      setCreateToast("Order created");
      onOrderCreated?.();
      setState((current) => ({ ...current, loading: false }));
      if (onCreated) onCreated();
    } catch (err) {
      console.error("CREATE ORDER FAILED:", err);
      setState((current) => ({ ...current, loading: false }));
      alert("Failed to create order");
    }
  }

  async function handleCreateOrder() {
    if (!canCreateOrder) {
      const missing = missingRequiredFields
        .map((field) => requiredFieldLabels[field] || field)
        .join(", ");
      setState((current) => ({
        ...current,
        error: `Complete required fields before creating the order: ${missing}.`,
      }));
      return;
    }
    if (unresolvedGiftFlags.length) {
      const unresolvedList = unresolvedGiftFlags.map((flag) => `- ${flag.label}`).join("\n");
      const proceed = window.confirm(
        `Gift details detected but not fully confirmed.\n\n${unresolvedList}\n\nPress OK to proceed anyway, or Cancel to fix.`,
      );
      if (!proceed) {
        setState((current) => ({
          ...current,
          error: `Gift details detected but not fully confirmed: ${unresolvedGiftFlags.map((flag) => flag.label).join(", ")}.`,
        }));
        return;
      }
    }
    await createOrder();
  }

  React.useEffect(() => {
    console.log("DECISIONS:", visibleDecisions);
    console.log("FIELDS_RENDER:", orderedFields.map(([, key]) => decisionMap[key] || null));
    console.log("HIGHLIGHTS:", highlights);
  }, [decisionMap, highlights, visibleDecisions]);

  React.useEffect(() => () => {
    if (giftPulseTimerRef.current) {
      window.clearTimeout(giftPulseTimerRef.current);
    }
  }, []);

  const applyResult = React.useCallback((result) => {
    const nextFlags = result.flags || {};
    const nextAttentionRanges = Array.isArray(result.meta?.gift_attention_ranges) ? result.meta.gift_attention_ranges : [];
    setFlags(nextFlags);
    setMeta(result.meta || {});

    if (result.filePath) {
      if (result.filePath !== lastGiftPulseFileRef.current) {
        lastGiftPulseFileRef.current = result.filePath;
        if (giftPulseTimerRef.current) {
          window.clearTimeout(giftPulseTimerRef.current);
        }
        if (nextAttentionRanges.length) {
          setPulseGiftAttention(true);
          giftPulseTimerRef.current = window.setTimeout(() => {
            setPulseGiftAttention(false);
            giftPulseTimerRef.current = null;
          }, 1500);
        } else {
          setPulseGiftAttention(false);
          giftPulseTimerRef.current = null;
        }
      }
    } else {
      setPulseGiftAttention(false);
    }

    // Auto-scroll to gift controls when gift-related content is detected.
    if (nextFlags.gift || nextFlags.gift_wrap || nextFlags.gift_message) {
      requestAnimationFrame(() => {
        document.querySelector('[data-nav-key="gift_options"]')
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
    setSegments(result.segments || []);
    setState((current) => {
      let nextItemState;
      try {
        nextItemState = buildItemState(
          result.decisions || [],
          current.items || [],
          itemMeta,
          result.meta?.price_candidate_count ?? 0,
        );
      } catch (err) {
        console.error("APPLY_RESULT_BUILD_FAILED", err);
        return {
          ...current,
          loading: false,
          error: err?.message || "Failed to apply parse result",
        };
      }
      setItemMeta(nextItemState.itemMeta);
      setActiveItemIndex((currentIndex) => Math.min(currentIndex, nextItemState.quantity - 1));

      return {
        text: result.clean_text || "",
        subject: result.subject || "",
        decisions: result.decisions || [],
        filePath: result.filePath || "",
        trustReport: result.trust_report || null,
        error: "",
        loading: false,
        quantity: nextItemState.quantity,
        items: nextItemState.items,
      };
    });
    setSelectedField((current) => {
      if (!current) {
        // On initial import prefer buyer_name as a logical starting point.
        // Fall back to null (clean state) if buyer_name is not in this result.
        const hasBuyerName = result.decisions?.some(
          (d) => d.field === "buyer_name" && !suppressedFields.includes(d.field),
        );
        return hasBuyerName ? "buyer_name" : null;
      }
      // Keep the current selection across re-parses (accept / reject flows).
      return current;
    });
    actionLockRef.current = "";
  }, [itemMeta, suppressedFields]);

  const resolveCurrentParserPath = React.useCallback(async () => {
    const resolved = await window.parserApp.resolvePath({
      filePath: state.filePath,
      orderNumber: currentOrderNumber,
    });
    const path = resolved?.path || null;
    console.log("ASSIGN USING PATH:", path);
    if (!path) {
      throw new Error("Email file not found. It may have been moved.");
    }
    return path;
  }, [currentOrderNumber, state.filePath]);

  const clearSelection = React.useCallback(() => {
    const browserSelection = window.getSelection();
    if (browserSelection) {
      browserSelection.removeAllRanges();
    }
    lastSelectionRef.current = null;
    setSelection(null);
  }, []);

  const resetParserUi = React.useCallback(({ loading = false, error = "" } = {}) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    actionLockRef.current = "";
    clearSelection();
    setFlags({});
    setMeta({});
    setSegments([]);
    setSuppressedFields([]);
    setSelectedField(null);
    setActiveItemIndex(0);
    setItemMeta([emptyItemMeta()]);
    setGiftMessage(null);
    setGiftMessageMeta(null);
    setGiftOptions({ is_gift: false, gift_wrap: false });
    setManualOrderFields({});
    setActiveKeyField(null);
    setState({
      text: "",
      subject: "",
      decisions: [],
      filePath: "",
      error,
      loading,
      quantity: 1,
      items: [emptyItem()],
      trustReport: null,
    });
  }, [clearSelection]);

  applyResultRef.current = applyResult;
  clearSelectionRef.current = clearSelection;
  resetParserUiRef.current = resetParserUi;

  const captureSelection = React.useCallback(() => {
    const container = textRef.current;
    const browserSelection = window.getSelection();

    // If the browser has no selection (e.g. user already clicked a field and
    // the browser cleared it), do NOT wipe the stored selection — the pending
    // field-click handler still needs it.
    if (!container || !browserSelection || browserSelection.rangeCount === 0) {
      return;
    }

    const range = browserSelection.getRangeAt(0);
    if (range.collapsed || !container.contains(range.commonAncestorContainer)) {
      lastSelectionRef.current = null;
      setSelection(null);
      return;
    }

    // Positions are relative to the DISPLAYED text (which may be trimStart()-ed).
    const displayStart = computeSelectionOffset(container, range.startContainer, range.startOffset);
    const selectedText = range.toString();
    const displayEnd = computeSelectionOffset(container, range.endContainer, range.endOffset);

    // Validate against the displayed text (not the raw original) because the
    // <pre> renders the trimmed version. Using state.text here was the bug —
    // it caused an offset mismatch that silently cleared every selection.
    const trimOffset = emailTrimOffsetRef.current;
    const displayText = trimOffset > 0 ? state.text.trimStart() : state.text;
    if (displayText.slice(displayStart, displayEnd) !== selectedText) {
      lastSelectionRef.current = null;
      setSelection(null);
      return;
    }

    const trimmed = trimSelectionToExactText(displayText, displayStart, displayEnd);
    if (!trimmed.selectedText || displayText.slice(trimmed.start, trimmed.end) !== trimmed.selectedText) {
      lastSelectionRef.current = null;
      setSelection(null);
      return;
    }

    // Convert back to original (backend) coordinates by adding the trim offset.
    const start = trimmed.start + trimOffset;
    const end   = trimmed.end   + trimOffset;

    const segment = segments.find((seg) => start >= seg.start && end <= seg.end);

    const captured = {
      start,
      end,
      selected_text: trimmed.selectedText,
      segment_id: segment?.id || "",
    };
    console.log("[SELECTION_CAPTURE]", {
      value: captured.selected_text,
      start: captured.start,
      end: captured.end,
      length: captured.selected_text.length,
    });
    lastSelectionRef.current = captured; // synchronous — always read by click handlers
    setSelection(captured);             // async — drives the UI indicator
  }, [segments, state.text]);

  const assignSelectionToField = React.useCallback(async (field) => {
    // Use the ref first (synchronous, survives browser selection clearing on click).
    const sel = lastSelectionRef.current || selection;
    if (!state.filePath || !sel?.selected_text) {
      return;
    }
    const exactValue = sel.selected_text;
    if (!exactValue) {
      return;
    }
    const counterpart = field === "buyer_name"
      ? decisionMap.shipping_address
      : field === "shipping_address"
        ? decisionMap.buyer_name
        : null;
    if (
      counterpart
      && rangesOverlap(sel.start, sel.end, counterpart.start, counterpart.end)
    ) {
      setState((current) => ({
        ...current,
        error: `${field === "buyer_name" ? "Buyer name" : "Shipping address"} selection overlaps ${field === "buyer_name" ? "shipping address" : "buyer name"}. Select only the exact text for this field.`,
      }));
      return;
    }
    console.log("ASSIGNED VALUE:", `"${exactValue}"`);
    console.log("[ASSIGNMENT_APPLIED]", { field, value: exactValue, start: sel.start, end: sel.end });
    const actionKey = `manual:${field}:${sel.start}:${sel.end}:${exactValue}`;
    if (actionLockRef.current === actionKey) {
      return;
    }

    actionLockRef.current = actionKey;
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const parserPath = await resolveCurrentParserPath();
      const nextSuppressed = suppressedFields.filter((value) => value !== field);
      const result = await window.parserApp.saveAssignment({
        filePath: parserPath,
        orderNumber: currentOrderNumber,
        decision: {
          field,
          value: exactValue,
          segment_id: sel.segment_id,
          start: sel.start,
          end: sel.end,
          selected_text: sel.selected_text,
          suppressed_fields: nextSuppressed,
        },
      });
      const assignedDecision = result.decisions?.find((decision) => decision.field === field) || null;
      const nextHighlights = buildUnifiedHighlights(result.decisions || [], nextSuppressed, state.items, giftMessage);
      console.log("DECISIONS_AFTER_ASSIGN:", result.decisions);
      console.log("HIGHLIGHTS:", nextHighlights);
      console.log("ASSIGNED_FIELD_AFTER_ASSIGN:", assignedDecision
        ? {
          field: assignedDecision.field,
          value: assignedDecision.value,
          start: assignedDecision.start,
          end: assignedDecision.end,
          decision: assignedDecision.decision,
        }
        : {
          field,
          value: exactValue,
          start: sel.start,
          end: sel.end,
          decision: null,
        });
      setSuppressedFields(nextSuppressed);
      applyResult(result);
      setSelectedField(field);
      clearSelection();
    } catch (error) {
      actionLockRef.current = "";
      setState((current) => ({
        ...current,
        loading: false,
        error: error.message || "Failed to save assignment",
      }));
    }
  }, [applyResult, clearSelection, currentOrderNumber, decisionMap.buyer_name, decisionMap.shipping_address, resolveCurrentParserPath, selection, suppressedFields]);

  // Fields whose manual assignment must also teach the backend parser so that
  // future emails of the same template auto-parse them correctly.
  const ITEM_PARSER_TEACHABLE = React.useMemo(() => new Set(["price"]), []);

  const assignSelectionToItemField = React.useCallback(async (field, itemIndex) => {
    const sel = lastSelectionRef.current || selection;
    if (!sel?.selected_text) {
      return;
    }
    const exactValue = sel.selected_text;
    if (!exactValue) {
      return;
    }
    console.log("ASSIGNED VALUE:", `"${exactValue}"`);
    console.log("[ASSIGNMENT_APPLIED]", { field, value: exactValue, start: sel.start, end: sel.end });

    setState((current) => ({
      ...current,
      items: current.items.map((item, index) => {
        if (index !== itemIndex) {
          return item;
        }
        return {
          ...item,
          [field]: {
            value: exactValue,
            start: sel.start,
            end: sel.end,
          },
        };
      }),
    }));
    setItemMeta((current) => current.map((item, index) => {
      if (index !== itemIndex) {
        return item;
      }
      return {
        ...item,
        [field]: {
          source: "manual",
          decision: "assigned",
          start: sel.start,
          end: sel.end,
          value: exactValue,
        },
      };
    }));
    console.log("DECISIONS_AFTER_ASSIGN:", state.decisions);
    console.log("HIGHLIGHTS:", highlights);
    console.log("ASSIGNED_FIELD_AFTER_ASSIGN:", {
      field,
      value: exactValue,
      start: sel.start,
      end: sel.end,
      decision: "assigned",
    });
    setSelectedField(`item:${itemIndex}:${field}`);
    clearSelection();

    // Route parser-teachable item fields through the backend so the learning
    // store is updated and future emails of the same template benefit.
    if (ITEM_PARSER_TEACHABLE.has(field) && state.filePath) {
      try {
        const parserPath = await resolveCurrentParserPath();
        await window.parserApp.saveAssignment({
          filePath: parserPath,
          orderNumber: currentOrderNumber,
          decision: {
            field,
            value: exactValue,
            segment_id: sel.segment_id || "",
            start: sel.start,
            end: sel.end,
            selected_text: sel.selected_text,
            suppressed_fields: suppressedFields,
          },
        });
        console.log("[ITEM_FIELD_LEARNED]", { field, value: exactValue, itemIndex });
      } catch (err) {
        console.error("[ITEM_LEARN_FAILED]", { field, error: err?.message });
      }
    }
  }, [
    ITEM_PARSER_TEACHABLE,
    clearSelection,
    currentOrderNumber,
    highlights,
    resolveCurrentParserPath,
    selection,
    state.decisions,
    state.filePath,
    suppressedFields,
  ]);

  const rejectItemField = React.useCallback((field, itemIndex) => {
    if (field === "price" && decisionMap.price) {
      return;
    }

    setState((current) => ({
      ...current,
      items: current.items.map((item, index) => {
        if (index !== itemIndex) {
          return item;
        }
        return {
          ...item,
          [field]: field === "price" ? null : "",
        };
      }),
    }));
    setItemMeta((current) => current.map((item, index) => {
      if (index !== itemIndex) {
        return item;
      }
      return {
        ...item,
        [field]: null,
      };
    }));
  }, [decisionMap.price]);

  const handleFieldClick = React.useCallback((decision, fallbackField) => {
    const field = decision?.field || fallbackField || null;
    if (!field) {
      return;
    }
    setSelectedField(field);
    scrollToDecisionRange(field, decision);
    // Check ref first — state may not have propagated yet when the click fires.
    const sel = lastSelectionRef.current || selection;
    if (sel?.selected_text) {
      assignSelectionToField(field);
    }
  }, [assignSelectionToField, scrollToDecisionRange, selection]);

  const assignGiftMessage = React.useCallback(() => {
    const sel = lastSelectionRef.current || selection;
    if (!sel?.selected_text) return;
    const exactValue = sel.selected_text;
    if (!exactValue) return;
    console.log("ASSIGNED VALUE:", `"${exactValue}"`);
    console.log("[ASSIGNMENT_APPLIED]", { field: "gift_message", value: exactValue, start: sel.start, end: sel.end });
    setGiftMessage({ value: exactValue, start: sel.start, end: sel.end });
    setGiftMessageMeta({ decision: "assigned", source: "manual", value: exactValue });
    setSelectedField("gift_message");
    clearSelection();
  }, [clearSelection, selection]);

  const rejectGiftMessage = React.useCallback(() => {
    setGiftMessage(null);
    setGiftMessageMeta(null);
    setSelectedField(null);
  }, []);

  const handleItemFieldClick = React.useCallback((field, itemIndex) => {
    setSelectedField(`item:${itemIndex}:${field}`);
    const itemValue = state.items[itemIndex]?.[field];
    const itemSource = (itemValue && typeof itemValue === "object")
      ? itemValue
      : itemMeta[itemIndex]?.[field] || null;
    scrollToDecisionRange(`item:${itemIndex}:${field}`, itemSource);
    const sel = lastSelectionRef.current || selection;
    if (sel?.selected_text) {
      assignSelectionToItemField(field, itemIndex);
    }
  }, [assignSelectionToItemField, itemMeta, scrollToDecisionRange, selection, state.items]);

  React.useEffect(() => {
    if (!selectedFilePath) {
      return;
    }
    const loadId = latestSelectedFileLoadRef.current + 1;
    latestSelectedFileLoadRef.current = loadId;
    let cancelled = false;
    async function openSelectedFile() {
      resetParserUiRef.current?.({ loading: true });
      try {
        const result = await window.parserApp?.parseFile?.({ filePath: selectedFilePath });
        if (!cancelled && latestSelectedFileLoadRef.current === loadId) {
          setSuppressedFields([]);
          setActiveItemIndex(0);
          setGiftMessage(null);
          setGiftMessageMeta(null);
          setActiveKeyField(null);
          clearSelectionRef.current?.();
          applyResultRef.current?.(result);
        }
      } catch (error) {
        if (!cancelled && latestSelectedFileLoadRef.current === loadId) {
          setState((current) => ({
            ...current,
            loading: false,
            error: error.message || "Failed to open email",
          }));
        }
      }
    }
    openSelectedFile();
    return () => {
      cancelled = true;
    };
  }, [selectedFilePath, selectedFileRequestKey]);


  const teach = async (action, decision) => {
    if (!state.filePath || !decision) {
      const skip = { reason: !state.filePath ? "no_file_path" : "no_decision", action, field: decision?.field };
      console.log(action === "save_rejection" ? "REJECT_SKIPPED" : "TEACH_SKIPPED", skip);
      return;
    }

    const normalizedDecisionValue = normalizeFieldValue(decision.value);
    const actionKey = `${action}:${decision.field}:${decision.segment_id}:${normalizedDecisionValue}`;
    if (actionLockRef.current === actionKey) {
      const skip = { reason: "duplicate_action_lock", action, field: decision.field, actionKey };
      console.log(action === "save_rejection" ? "REJECT_SKIPPED" : "TEACH_SKIPPED", skip);
      return;
    }
    if (actionAlreadyApplied(action, decision)) {
      const skip = { reason: "action_already_applied", action, field: decision.field };
      console.log(action === "save_rejection" ? "REJECT_SKIPPED" : "TEACH_SKIPPED", skip);
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      actionLockRef.current = actionKey;
      setState((current) => ({ ...current, loading: true, error: "" }));
      try {
        const parserPath = await resolveCurrentParserPath();
        const nextSuppressed = action === "save_rejection"
          ? [...new Set([...suppressedFields, decision.field])]
          : suppressedFields.filter((field) => field !== decision.field);
        const payload = {
          filePath: parserPath,
          orderNumber: currentOrderNumber,
          decision: {
            ...decision,
            value: normalizedDecisionValue,
            suppressed_fields: nextSuppressed,
          },
        };
        const result = action === "save_assignment"
          ? await window.parserApp.saveAssignment(payload)
          : await window.parserApp.saveRejection(payload);
        if (action === "save_assignment") {
          const assignedDecision = result.decisions?.find((row) => row.field === decision.field) || null;
          const nextHighlights = buildUnifiedHighlights(result.decisions || [], nextSuppressed, state.items, giftMessage);
          console.log("DECISIONS_AFTER_ASSIGN:", result.decisions);
          console.log("HIGHLIGHTS:", nextHighlights);
          console.log("ASSIGNED_FIELD_AFTER_ASSIGN:", assignedDecision
            ? {
              field: assignedDecision.field,
              value: assignedDecision.value,
              start: assignedDecision.start,
              end: assignedDecision.end,
              decision: assignedDecision.decision,
            }
            : {
              field: decision.field,
              value: normalizedDecisionValue,
              start: decision.start,
              end: decision.end,
              decision: null,
            });
        }
        setSuppressedFields(nextSuppressed);
        if (action === "save_rejection") {
          setSelectedField(decision.field);
          clearSelection();
        }
        applyResult(result);
        if (action === "save_rejection") {
          console.log("REJECT_COMPLETE", { field: decision.field });
        }
      } catch (error) {
        setState((current) => ({
          ...current,
          loading: false,
          error: error.message || "Failed to update learning",
        }));
      } finally {
        debounceRef.current = null;
        actionLockRef.current = "";
        setState((current) => ({ ...current, loading: false }));
      }
    }, 120);
  };

  const activeItem = state.items[activeItemIndex] || emptyItem();
  const activeItemMeta = itemMeta[activeItemIndex] || emptyItemMeta();

  // Updated on every render so the single keydown closure always sees fresh values.
  // Must be after all function definitions to avoid temporal dead zone errors.
  _kbRef.current = {
    navFields,
    activeKeyField,
    setActiveKeyField,
    decisionMap,
    itemMeta,
    teach,
    assignSelectionToItemField,
    rejectItemField,
    assignGiftMessage,
    rejectGiftMessage,
  };

  const openLineContextMenu = React.useCallback((event, lineText) => {
    event.preventDefault();
    event.stopPropagation();
    setLineContextMenu({
      x: event.clientX,
      y: event.clientY,
      lineText,
    });
  }, []);

  const hideLineOnce = React.useCallback((lineText) => {
    const normalized = normalizeHiddenLinePattern(lineText);
    if (!normalized) {
      setLineContextMenu(null);
      return;
    }
    setHiddenExactLines((current) => {
      const next = new Set(current);
      next.add(normalized);
      return next;
    });
    setLineContextMenu(null);
  }, []);

  const alwaysHideSimilarLine = React.useCallback((lineText) => {
    const pattern = generalizeHiddenLinePattern(lineText) || normalizeHiddenLinePattern(lineText);
    if (!pattern) {
      setLineContextMenu(null);
      return;
    }
    setUserHiddenPatterns((current) => (
      current.includes(pattern) ? current : [...current, pattern]
    ));
    setLineContextMenu(null);
  }, []);

  const resetHiddenPatterns = React.useCallback(() => {
    setUserHiddenPatterns([]);
    setHiddenExactLines(new Set());
    setLineContextMenu(null);
  }, []);

  // Compute trim offset once per render so both the JSX and captureSelection
  // use exactly the same value. The ref keeps captureSelection in sync without
  // needing it in that callback's dependency array.
  const _rawEmail = state.text || "";
  const _emailTrimOffset = _rawEmail.length - _rawEmail.trimStart().length;
  const _displayEmail = _emailTrimOffset > 0 ? _rawEmail.trimStart() : _rawEmail;
  emailTrimOffsetRef.current = _emailTrimOffset;
  const displayHighlights = React.useMemo(
    () => (_emailTrimOffset > 0
      ? [...highlights, ...attentionHighlights]
          .map((h) => ({
            ...h,
            rawStart: h.start,
            rawEnd: h.end,
            start: h.start - _emailTrimOffset,
            end: h.end - _emailTrimOffset,
          }))
          .filter((h) => h.end > 0 && h.start < _displayEmail.length)
      : [...highlights, ...attentionHighlights].map((h) => ({
          ...h,
          rawStart: h.start,
          rawEnd: h.end,
        }))),
    [_displayEmail.length, _emailTrimOffset, attentionHighlights, highlights]
  );
  const isOpeningSelectedEmail = Boolean(selectedFilePath) && !state.filePath && !state.error;
  const trustReport = state.trustReport || null;
  const trustSummary = trustReport?.summary || {};
  const trustFields = trustReport?.fields || {};
  const trustFieldCount = Object.keys(trustFields).length;
  const trustSafetyFailedCount = Number(trustSummary.safety_failed_field_count || 0);
  const trustReportArtifactPath = String(trustReport?.artifact_path || "").trim();
  const trustReportJson = trustReport ? JSON.stringify(trustReport, null, 2) : "";

  const copyTrustReport = React.useCallback(async () => {
    if (!trustReportJson) return;
    try {
      await navigator.clipboard.writeText(trustReportJson);
      setCreateToast("Trust report copied");
    } catch (error) {
      console.error("COPY_TRUST_REPORT_FAILED", error);
      setCreateToast("Could not copy trust report");
    }
  }, [trustReportJson]);

  const openTrustReportArtifact = React.useCallback(async () => {
    if (!trustReportArtifactPath) return;
    try {
      const result = await window.parserApp?.openFile?.({ filePath: trustReportArtifactPath });
      if (!result?.ok) {
        setCreateToast(result?.error || "Could not open trust report");
      }
    } catch (error) {
      console.error("OPEN_TRUST_REPORT_FAILED", error);
      setCreateToast("Could not open trust report");
    }
  }, [trustReportArtifactPath]);

  const openTrustReportFolder = React.useCallback(async () => {
    if (!trustReportArtifactPath) return;
    try {
      const result = await window.parserApp?.openFolder?.(trustReportArtifactPath);
      if (!result?.ok) {
        setCreateToast(result?.error || "Could not open trust report folder");
      }
    } catch (error) {
      console.error("OPEN_TRUST_REPORT_FOLDER_FAILED", error);
      setCreateToast("Could not open trust report folder");
    }
  }, [trustReportArtifactPath]);

  return (
    <div className="app-shell">
      <AppHeader
        canSave={false}
        saveTitle="Nothing to save yet"
        onSettings={onSettings}
        onWorkspace={onWorkspace}
        documentsConfig={documentsConfig}
        activeTab={ordersTab}
        selectedNav=""
        onSelectTab={(nextTab) => {
          onOrdersTabChange?.(nextTab);
          onBack?.(nextTab);
        }}
        showCounts={false}
      />

      {state.filePath && (
        <div className="parser-context-bar">
          <div className="parser-subject-meta" title={state.subject || "(no subject)"}>
            <span className="subject-label">Subject:</span>{" "}
            <span>{state.subject || "(no subject)"}</span>
          </div>
        </div>
      )}

      {state.error ? <div className="error-banner">{state.error}</div> : null}
      {createToast ? <div className="create-feedback-toast">{createToast}</div> : null}

      {/* ── Empty state — shown when no file is loaded ── */}
      {!state.filePath && isOpeningSelectedEmail && (
        <div className="eml-empty-state">
          <div className="eml-empty-icon">⏳</div>
          <div className="eml-empty-title">Opening selected email</div>
          <div className="eml-empty-hint">Loading the message from Workspace…</div>
        </div>
      )}
      {!state.filePath && !state.loading && !isOpeningSelectedEmail && (
        <div className="eml-empty-state">
          <div className="eml-empty-icon">📧</div>
          <div className="eml-empty-title">No email selected</div>
          <div className="eml-empty-hint">Choose an Inbox item from Workspace to open it here.</div>
          <button
            type="button"
            className="parser-secondary-action"
            onClick={() => onWorkspace?.()}
          >
            Go to Workspace
          </button>
        </div>
      )}

      <main className={`split-view${!state.filePath ? " split-view-hidden" : ""}`}>
        <section className="panel text-panel">
          <div className="panel-title panel-title-row">
            <span>Email Content</span>
            <div className="email-panel-toggles">
              <label className="email-visibility-toggle">
                <input
                  type="checkbox"
                  checked={showDetectedFields}
                  onChange={(event) => setShowDetectedFields(event.target.checked)}
                />
                <span>Show detected fields</span>
              </label>
              <label className="email-visibility-toggle">
                <input
                  type="checkbox"
                  checked={showFullEmail}
                  onChange={(event) => setShowFullEmail(event.target.checked)}
                />
                <span>Show full email</span>
              </label>
              <label className="email-visibility-toggle">
                <input
                  type="checkbox"
                  checked={showHiddenContent}
                  onChange={(event) => setShowHiddenContent(event.target.checked)}
                />
                <span>Show hidden content</span>
              </label>
              <button
                type="button"
                className="email-reset-hidden"
                onClick={resetHiddenPatterns}
                disabled={!userHiddenPatterns.length && !hiddenExactLines.size}
                title="Clear hidden email line patterns"
              >
                Reset hidden patterns
              </button>
            </div>
          </div>
          <div
            ref={textRef}
            className="email-content"
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
          >
            {_displayEmail
              ? renderStructuredEmail(
                  _displayEmail,
                  displayHighlights,
                  showDetectedFields,
                  pulseGiftAttention,
                  showFullEmail,
                  userHiddenPatterns,
                  hiddenExactLines,
                  showHiddenContent,
                  openLineContextMenu,
                )
              : "(import an .eml file to view content)"
            }
          </div>
        </section>

        <aside className="panel fields-panel">
          <div className="panel-title">Detected Fields</div>
          <div className="fields-list">
            {unresolvedGiftFlags.length ? (
              <div className="gift-flag-panel">
                <div className="gift-flag-panel-title">Gift Flags</div>
                {unresolvedGiftFlags.map((flag) => (
                  <div key={flag.key} className="gift-flag-alert">
                    {`⚠ ${flag.label}`}
                  </div>
                ))}
              </div>
            ) : null}

            {orderedFields.slice(0, 2).map(([label, key, multiline]) => (
              <FieldRow
                key={key}
                label={label}
                fieldKey={key}
                decision={decisionMap[key]}
                hasSelection={hasSelection}
                loading={state.loading}
                selected={selectedField === key}
                onSelect={handleFieldClick}
                onTeach={teach}
                manualValue={key === "ship_by" && manualShipByTouched ? manualOrderFields.ship_by : undefined}
                onManualChange={key === "ship_by" ? handleManualOrderFieldChange : undefined}
                multiline={!!multiline}
                priceCandidateCount={priceCandidateCount}
                isKeyActive={activeKeyField === key}
                navKey={key}
                required={requiredFields.includes(key)}
              />
            ))}

            <div className="divider" />

            {orderedFields.slice(2).map(([label, key, multiline]) => (
              <FieldRow
                key={key}
                label={label}
                fieldKey={key}
                decision={decisionMap[key]}
                hasSelection={hasSelection}
                loading={state.loading}
                selected={selectedField === key}
                onSelect={handleFieldClick}
                onTeach={teach}
                manualValue={key === "ship_by" && manualShipByTouched ? manualOrderFields.ship_by : undefined}
                onManualChange={key === "ship_by" ? handleManualOrderFieldChange : undefined}
                multiline={!!multiline}
                priceCandidateCount={priceCandidateCount}
                isKeyActive={activeKeyField === key}
                navKey={key}
                required={requiredFields.includes(key)}
              />
            ))}

            <div className="gift-option-row" data-nav-key="gift_options">
              <label className="gift-option-toggle">
                <input
                  type="checkbox"
                  checked={!!giftOptions.is_gift}
                  onChange={(event) => {
                    setGiftOptions((current) => ({ ...current, is_gift: event.target.checked }));
                  }}
                />
                <span>Mark as gift</span>
              </label>
              <label className="gift-option-toggle">
                <input
                  type="checkbox"
                  checked={!!giftOptions.gift_wrap}
                  onChange={(event) => {
                    setGiftOptions((current) => ({ ...current, gift_wrap: event.target.checked }));
                  }}
                />
                <span>Gift wrap</span>
              </label>
            </div>

            <ItemFieldRow
              label="Gift Message"
              fieldKey="gift_message"
              value={giftMessage}
              meta={giftMessageMeta}
              hasSelection={hasSelection}
              loading={state.loading}
              selected={selectedField === "gift_message"}
              onSelect={() => {
                setSelectedField("gift_message");
                scrollToDecisionRange("gift_message", giftMessage || giftMessageMeta);
                if (selection?.selected_text) assignGiftMessage();
              }}
              onAccept={assignGiftMessage}
              onReject={rejectGiftMessage}
              isKeyActive={activeKeyField === "gift_message"}
              navKey="gift_message"
            />

            <div className="section-divider" />
            <div className="section-header">Items</div>

            {state.quantity > 1 ? (
              <>
                <div className="item-tabs">
                  {state.items.map((item, index) => (
                    <button
                      key={index}
                      type="button"
                      className={`item-tab${index === activeItemIndex ? " active" : ""}`}
                      onClick={() => setActiveItemIndex(index)}
                    >
                      {index + 1}
                      {itemHasContent(item) && (
                        <span className="item-tab-check">✓</span>
                      )}
                    </button>
                  ))}
                  <span className="item-count-badge">{state.quantity} Items</span>
                </div>
                <div className="item-context">
                  Editing Item {activeItemIndex + 1} of {state.quantity}
                </div>
              </>
            ) : null}

            {itemFieldOrder.map(([label, fieldKey]) => {
              const itemNavKey = `item:${activeItemIndex}:${fieldKey}`;
              return (
                <ItemFieldRow
                  key={fieldKey}
                  label={label}
                  fieldKey={fieldKey}
                  value={activeItem[fieldKey] ?? ""}
                  meta={activeItemMeta[fieldKey]}
                  hasSelection={hasSelection}
                  loading={state.loading}
                  selected={selectedField === itemNavKey}
                  onSelect={() => handleItemFieldClick(fieldKey, activeItemIndex)}
                  onAccept={() => {
                    if (fieldKey === "price" && activeItemMeta.price?.source === "parser" && decisionMap.price) {
                      teach("save_assignment", decisionMap.price);
                      return;
                    }
                    assignSelectionToItemField(fieldKey, activeItemIndex);
                  }}
                  onReject={() => {
                    if (fieldKey === "price" && activeItemMeta.price?.source === "parser" && decisionMap.price) {
                      teach("save_rejection", decisionMap.price);
                      return;
                    }
                    rejectItemField(fieldKey, activeItemIndex);
                  }}
                  isKeyActive={activeKeyField === itemNavKey}
                  navKey={itemNavKey}
                />
              );
            })}

            {!canCreateOrder ? (
              <div className="required-fields-hint">
                Required before order creation:{" "}
                {missingRequiredFields
                  .map((field) => requiredFieldLabels[field] || field)
                  .join(", ")}
              </div>
            ) : null}

            {trustReport ? (
              <details className="trust-report-panel">
                <summary>
                  <span>Trust Report</span>
                  <span className={trustSafetyFailedCount ? "trust-report-badge warning" : "trust-report-badge"}>
                    {trustSafetyFailedCount ? `${trustSafetyFailedCount} safety flags` : "Ready"}
                  </span>
                </summary>
                <div className="trust-report-grid">
                  <div>
                    <span className="trust-report-label">Parse run</span>
                    <code>{trustReport.parse_run_id || "n/a"}</code>
                  </div>
                  <div>
                    <span className="trust-report-label">Fields</span>
                    <strong>{trustFieldCount}</strong>
                  </div>
                  <div>
                    <span className="trust-report-label">Assigned</span>
                    <strong>{trustSummary.assigned_count ?? 0}</strong>
                  </div>
                  <div>
                    <span className="trust-report-label">Suggested</span>
                    <strong>{trustSummary.suggested_count ?? 0}</strong>
                  </div>
                  <div>
                    <span className="trust-report-label">Blocked candidates</span>
                    <strong>{trustSummary.blocked_candidate_count ?? 0}</strong>
                  </div>
                  <div>
                    <span className="trust-report-label">Schema</span>
                    <strong>{trustReport.schema_version ?? "n/a"}</strong>
                  </div>
                </div>
                <div className="trust-report-path" title={trustReportArtifactPath || "No artifact path"}>
                  {trustReportArtifactPath || "No artifact file was written for this parse."}
                </div>
                <div className="trust-report-actions">
                  <button type="button" onClick={copyTrustReport}>Copy JSON</button>
                  <button type="button" onClick={openTrustReportArtifact} disabled={!trustReportArtifactPath}>
                    Open JSON
                  </button>
                  <button type="button" onClick={openTrustReportFolder} disabled={!trustReportArtifactPath}>
                    Open Folder
                  </button>
                </div>
              </details>
            ) : null}

            <button
              type="button"
              onClick={handleCreateOrder}
              disabled={!canCreateOrder || state.loading}
              style={{
                marginTop: "12px",
                padding: "10px 16px",
                background: canCreateOrder && !state.loading ? "#2563eb" : "#ccc",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: canCreateOrder && !state.loading ? "pointer" : "not-allowed",
                width: "100%",
                fontWeight: 600,
                fontSize: "14px",
              }}
            >
              Create Order
            </button>
          </div>
        </aside>
      </main>

      {lineContextMenu ? (
        <div
          className="email-line-context-menu"
          style={{ left: lineContextMenu.x, top: lineContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => hideLineOnce(lineContextMenu.lineText)}
          >
            Hide this line
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => alwaysHideSimilarLine(lineContextMenu.lineText)}
          >
            Always hide similar lines
          </button>
        </div>
      ) : null}
    </div>
  );
}
