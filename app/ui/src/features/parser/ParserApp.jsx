import React from "react";
import { createPortal } from "react-dom";
import { loadFieldConfig, buildLabelMap, loadParserFieldOrder } from "../../shared/utils/fieldConfig.js";

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
  if (node.nodeType === Node.TEXT_NODE) {
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

  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
  );

  let total = 0;
  let current = walker.nextNode();

  while (current) {
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

function renderHighlightedText(text, highlights) {
  if (!highlights.length) {
    return text;
  }

  const ranges = [...highlights].sort((a, b) => a.start - b.start);
  let elements = [];
  let lastIndex = 0;

  ranges.forEach((range, i) => {
    if (range.start > lastIndex) {
      elements.push(
        <span key={`t-${i}`}>
          {text.slice(lastIndex, range.start)}
        </span>,
      );
    }

    const segmentText = text.slice(range.start, range.end);
    let className = "";

    if (range.decision === "assigned") {
      className = "assigned";
    } else if (range.decision === "suggested") {
      className = "suggested";
    }

    elements.push(
      <span key={`s-${i}`} className={className}>
        {segmentText}
      </span>,
    );

    lastIndex = range.end;
  });

  if (lastIndex < text.length) {
    elements.push(
      <span key="end">
        {text.slice(lastIndex)}
      </span>,
    );
  }

  return elements;
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
    })));
}

function buildUnifiedHighlights(decisions, suppressedFields, items) {
  return [
    ...buildHighlights(decisions, suppressedFields),
    ...manualItemHighlights(items),
  ];
}

function itemFieldValue(value) {
  if (value && typeof value === "object") {
    return value.value || "";
  }
  return value || "";
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

function FieldRow({
  label,
  fieldKey,
  decision,
  hasSelection,
  loading,
  selected,
  onSelect,
  onTeach,
  multiline,
  priceCandidateCount,
  isKeyActive,
  navKey,
}) {
  const value = decision?.value ?? "";
  const canAccept = !!decision && !loading && !actionAlreadyApplied("save_assignment", decision);
  const canReject = !!decision && !loading && !actionAlreadyApplied("save_rejection", decision);
  const inputState = decision?.decision === "assigned"
    ? "assigned-state"
    : decision?.decision === "suggested"
      ? "suggested-state"
      : "";

  const lineCount = value ? value.split("\n").length : 1;
  const tooltip = useTooltip();
  const tooltipLines = buildTooltipLines(decision, fieldKey, priceCandidateCount);

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
          id={`field-${fieldKey}`}
          className={`field-input field-textarea ${inputState}`}
          value={value}
          placeholder="(empty)"
          rows={lineCount}
          readOnly
          onClick={(event) => {
            event.stopPropagation();
            onSelect(decision, fieldKey);
          }}
          onFocus={() => onSelect(decision, fieldKey)}
          onChange={() => {}}
        />
      ) : (
        <input
          id={`field-${fieldKey}`}
          className={`field-input ${inputState}`}
          type="text"
          value={value}
          placeholder="(empty)"
          readOnly
          onClick={(event) => {
            event.stopPropagation();
            onSelect(decision, fieldKey);
          }}
          onFocus={() => onSelect(decision, fieldKey)}
          onChange={() => {}}
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

export default function App({ onCreated }) {
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

  // Derive label and visibility arrays from live config so changes propagate everywhere.
  const _labels = buildLabelMap(fieldConfig);
  const _parserVisible = buildParserVisibilityMap(fieldConfig);

  // Build _ORDER_FIELD_KEYS lookup for fast metadata access.
  const _orderKeyMeta = Object.fromEntries(_ORDER_FIELD_KEYS.map((f) => [f.key, f]));
  const _itemKeyMeta  = Object.fromEntries(_ITEM_FIELD_KEYS.map((f)  => [f.key, f]));

  // Apply user-preferred order, falling back to default array order for any key not in parserFieldOrder.
  const orderedFields = parserFieldOrder
    .filter((key) => key in _orderKeyMeta && _parserVisible[key] !== false)
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
  const [activeKeyField, setActiveKeyField] = React.useState(null);
  const actionLockRef = React.useRef("");
  const debounceRef = React.useRef(null);
  const textRef = React.useRef(null);
  const importEmlRef = React.useRef(null);
  const activeKeyFieldRef = React.useRef(null);
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
  const highlights = buildUnifiedHighlights(state.decisions, suppressedFields, state.items);
  const currentOrderNumber = decisionMap.order_number?.value || "";

  // Only blue (user-confirmed) values — used by Create Order
  const assignedFields = Object.fromEntries(
    visibleDecisions
      .filter((d) => d.decision === "assigned")
      .map((d) => [d.field, d.value]),
  );

  const priceCandidateCount = meta?.price_candidate_count ?? 0;
  // Combine state and ref so hasSelection is true the moment text is highlighted,
  // even before the async state update propagates.
  const hasSelection = !!(selection?.selected_text || lastSelectionRef.current?.selected_text);

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

  const requiredFields = ["order_number", "buyer_name"];
  const canCreateOrder = requiredFields.every((f) => {
    const val = assignedFields[f];
    return val && val.trim() !== "";
  });

  function buildOrderPayload() {
    return {
      order: {
        order_number: assignedFields.order_number || "",
        order_date: assignedFields.order_date || "",
        buyer_name: assignedFields.buyer_name || "",
        buyer_email: assignedFields.buyer_email || "",
        shipping_address: assignedFields.shipping_address || "",
        ship_by: assignedFields.ship_by || "",
        gift_message: giftMessage?.value || "",
      },
      items: state.items.map((item, index) => ({
        item_index: index + 1,
        quantity: 1,
        price: (typeof item.price === "object" ? item.price?.value : item.price) || "",
        order_notes: (typeof item.order_notes === "object" ? item.order_notes?.value : item.order_notes) || "",
        custom_fields: {
          custom_1: (typeof item.custom_1 === "object" ? item.custom_1?.value : item.custom_1) || "",
          custom_2: (typeof item.custom_2 === "object" ? item.custom_2?.value : item.custom_2) || "",
          custom_3: (typeof item.custom_3 === "object" ? item.custom_3?.value : item.custom_3) || "",
          custom_4: (typeof item.custom_4 === "object" ? item.custom_4?.value : item.custom_4) || "",
          custom_5: (typeof item.custom_5 === "object" ? item.custom_5?.value : item.custom_5) || "",
          custom_6: (typeof item.custom_6 === "object" ? item.custom_6?.value : item.custom_6) || "",
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

  async function handleCreateOrder() {
    try {
      const payload = buildOrderPayload();
      console.log("CREATE ORDER PAYLOAD:", payload);
      const res = await fetch("http://127.0.0.1:8055/orders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      console.log("ORDER CREATED:", data);
      alert("Order created successfully");
      if (onCreated) onCreated();
    } catch (err) {
      console.error("CREATE ORDER FAILED:", err);
      alert("Failed to create order");
    }
  }

  React.useEffect(() => {
    console.log("DECISIONS:", visibleDecisions);
    console.log("FIELDS_RENDER:", orderedFields.map(([, key]) => decisionMap[key] || null));
    console.log("HIGHLIGHTS:", highlights);
  }, [decisionMap, highlights, visibleDecisions]);

  const applyResult = React.useCallback((result) => {
    const nextFlags = result.flags || {};
    setFlags(nextFlags);
    setMeta(result.meta || {});

    // Auto-scroll to Gift Message field when gift/personalization is detected.
    if (nextFlags.is_gift || nextFlags.has_personalization) {
      requestAnimationFrame(() => {
        document.querySelector('[data-nav-key="gift_message"]')
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

    // Convert back to original (backend) coordinates by adding the trim offset.
    const start = displayStart + trimOffset;
    const end   = displayEnd   + trimOffset;

    const segment = segments.find((seg) => start >= seg.start && end <= seg.end);

    const captured = {
      start,
      end,
      selected_text: selectedText,
      segment_id: segment?.id || "",
    };
    lastSelectionRef.current = captured; // synchronous — always read by click handlers
    setSelection(captured);             // async — drives the UI indicator
  }, [segments, state.text]);

  const assignSelectionToField = React.useCallback(async (field) => {
    // Use the ref first (synchronous, survives browser selection clearing on click).
    const sel = lastSelectionRef.current || selection;
    if (!state.filePath || !sel?.selected_text) {
      return;
    }
    const actionKey = `manual:${field}:${sel.start}:${sel.end}:${sel.selected_text}`;
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
          value: sel.selected_text,
          segment_id: sel.segment_id,
          start: sel.start,
          end: sel.end,
          selected_text: sel.selected_text,
          suppressed_fields: nextSuppressed,
        },
      });
      const assignedDecision = result.decisions?.find((decision) => decision.field === field) || null;
      const nextHighlights = buildUnifiedHighlights(result.decisions || [], nextSuppressed, state.items);
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
          value: sel.selected_text,
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
  }, [applyResult, clearSelection, currentOrderNumber, resolveCurrentParserPath, selection, suppressedFields]);

  const assignSelectionToItemField = React.useCallback((field, itemIndex) => {
    const sel = lastSelectionRef.current || selection;
    if (!sel?.selected_text) {
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
          [field]: {
            value: sel.selected_text,
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
          value: sel.selected_text,
        },
      };
    }));
    console.log("DECISIONS_AFTER_ASSIGN:", state.decisions);
    console.log("HIGHLIGHTS:", highlights);
    console.log("ASSIGNED_FIELD_AFTER_ASSIGN:", {
      field,
      value: sel.selected_text,
      start: sel.start,
      end: sel.end,
      decision: "assigned",
    });
    setSelectedField(`item:${itemIndex}:${field}`);
    clearSelection();
  }, [clearSelection, highlights, selection, state.decisions]);

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
    // Check ref first — state may not have propagated yet when the click fires.
    const sel = lastSelectionRef.current || selection;
    if (sel?.selected_text) {
      assignSelectionToField(field);
    }
  }, [assignSelectionToField, selection]);

  const assignGiftMessage = React.useCallback(() => {
    const sel = lastSelectionRef.current || selection;
    if (!sel?.selected_text) return;
    setGiftMessage({ value: sel.selected_text, start: sel.start, end: sel.end });
    setGiftMessageMeta({ decision: "assigned", source: "manual", value: sel.selected_text });
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
    const sel = lastSelectionRef.current || selection;
    if (sel?.selected_text) {
      assignSelectionToItemField(field, itemIndex);
    }
  }, [assignSelectionToItemField, selection]);

  const importEml = async () => {
    setState((current) => ({ ...current, loading: true, error: "" }));
    try {
      const result = await window.parserApp.importEml();
      if (!result) {
        setState((current) => ({ ...current, loading: false }));
        return;
      }
      setSuppressedFields([]);
      setActiveItemIndex(0);
      setGiftMessage(null);
      setGiftMessageMeta(null);
      setActiveKeyField(null);
      clearSelection();
      applyResult(result);
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error.message || "Failed to import EML",
      }));
    }
  };

  // Keep ref up to date so the mount effect always calls the latest version.
  importEmlRef.current = importEml;

  // Automatically open the file picker when the modal first opens.
  React.useEffect(() => {
    importEmlRef.current();
  }, []);

  const teach = async (action, decision) => {
    if (!state.filePath || !decision) {
      const skip = { reason: !state.filePath ? "no_file_path" : "no_decision", action, field: decision?.field };
      console.log(action === "save_rejection" ? "REJECT_SKIPPED" : "TEACH_SKIPPED", skip);
      return;
    }

    const actionKey = `${action}:${decision.field}:${decision.segment_id}:${decision.value}`;
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
            suppressed_fields: nextSuppressed,
          },
        };
        const result = action === "save_assignment"
          ? await window.parserApp.saveAssignment(payload)
          : await window.parserApp.saveRejection(payload);
        if (action === "save_assignment") {
          const assignedDecision = result.decisions?.find((row) => row.field === decision.field) || null;
      const nextHighlights = buildUnifiedHighlights(result.decisions || [], nextSuppressed, state.items);
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
              value: decision.value,
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

  // Compute trim offset once per render so both the JSX and captureSelection
  // use exactly the same value. The ref keeps captureSelection in sync without
  // needing it in that callback's dependency array.
  const _rawEmail = state.text || "";
  const _emailTrimOffset = _rawEmail.length - _rawEmail.trimStart().length;
  const _displayEmail = _emailTrimOffset > 0 ? _rawEmail.trimStart() : _rawEmail;
  emailTrimOffsetRef.current = _emailTrimOffset;

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="import-button" onClick={importEml} disabled={state.loading}>
          {state.loading ? "Loading..." : "Import EML"}
        </button>
        <div className="topbar-subject">
          <span className="subject-label">Subject:</span>{" "}
          <span>{state.subject || "(no subject)"}</span>
        </div>
        {state.filePath ? (
          <div className="topbar-file-info" title={state.filePath}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          </div>
        ) : null}
      </header>

      {state.error ? <div className="error-banner">{state.error}</div> : null}


      <main className="split-view">
        <section className="panel text-panel">
          <div className="panel-title">Email Content</div>
          <pre
            ref={textRef}
            className="email-content"
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
          >
            {_displayEmail
              ? renderHighlightedText(
                  _displayEmail,
                  _emailTrimOffset > 0
                    ? highlights
                        .map((h) => ({ ...h, start: h.start - _emailTrimOffset, end: h.end - _emailTrimOffset }))
                        .filter((h) => h.end > 0 && h.start < _displayEmail.length)
                    : highlights,
                )
              : "(import an .eml file to view content)"
            }
          </pre>
        </section>

        <aside className="panel fields-panel">
          <div className="panel-title">Parsed Fields</div>
          <div className="fields-list">
            {meta.gift_message ? (
              <div className="personalization-box">
                <div className="compact-label">Personalization</div>
                <div className="personalization-text">{meta.gift_message}</div>
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
                multiline={!!multiline}
                priceCandidateCount={priceCandidateCount}
                isKeyActive={activeKeyField === key}
                navKey={key}
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
                multiline={!!multiline}
                priceCandidateCount={priceCandidateCount}
                isKeyActive={activeKeyField === key}
                navKey={key}
              />
            ))}

            <ItemFieldRow
              label={
                <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  Gift Message
                  {(flags.is_gift || flags.has_personalization) && (
                    <span
                      className="field-flag-badge"
                      title={
                        flags.is_gift && flags.has_personalization
                          ? "Gift order — personalization needed"
                          : flags.is_gift
                            ? "Gift order detected"
                            : "Personalization needed"
                      }
                    >
                      {flags.is_gift ? "🎁" : "✏️"}
                    </span>
                  )}
                </span>
              }
              fieldKey="gift_message"
              value={giftMessage}
              meta={giftMessageMeta}
              hasSelection={hasSelection}
              loading={state.loading}
              selected={selectedField === "gift_message"}
              onSelect={() => {
                setSelectedField("gift_message");
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

            <button
              type="button"
              onClick={handleCreateOrder}
              disabled={!canCreateOrder}
              style={{
                marginTop: "12px",
                padding: "10px 16px",
                background: canCreateOrder ? "#2563eb" : "#ccc",
                color: "white",
                border: "none",
                borderRadius: "6px",
                cursor: canCreateOrder ? "pointer" : "not-allowed",
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
    </div>
  );
}
