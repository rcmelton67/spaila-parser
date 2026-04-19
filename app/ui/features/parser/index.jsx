import React from "react";

const orderedFields = [
  ["Buyer Name", "buyer_name"],
  ["Shipping Address", "shipping_address", true],
  ["Order Number", "order_number"],
  ["Quantity", "quantity"],
  ["Order Date", "order_date"],
  ["Ship By", "ship_by"],
  ["Buyer Email", "buyer_email"],
];

const settings = {
  custom_1: "Field 1",
  custom_2: "Field 2",
  custom_3: "Field 3",
  custom_4: "Field 4",
  custom_5: "Field 5",
  custom_6: "Field 6",
};

const itemFieldOrder = [
  ["Price", "price"],
  [settings.custom_1, "custom_1"],
  [settings.custom_2, "custom_2"],
  [settings.custom_3, "custom_3"],
  [settings.custom_4, "custom_4"],
  [settings.custom_5, "custom_5"],
  [settings.custom_6, "custom_6"],
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

  console.log("UI_RENDER_DECISION", { field: fieldKey, decision: decision?.decision ?? null, inputState });

  return (
    <div
      className={`field-row compact-row${selected ? " selected" : ""}${multiline ? " multiline-row" : ""}`}
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
}) {
  const itemDecision = itemFieldDecision(meta, value);
  const inputState = itemDecision === "assigned"
    ? "assigned-state"
    : itemDecision === "suggested"
      ? "suggested-state"
      : "";
  const canAccept = !loading && (!!hasSelection || (fieldKey === "price" && meta?.source === "parser"));
  const canReject = !loading && !!itemFieldValue(value);

  return (
    <div
      className={`field-row compact-row${selected ? " selected" : ""}`}
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
    </div>
  );
}

export default function App({ onCreated }) {
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
  const actionLockRef = React.useRef("");
  const debounceRef = React.useRef(null);
  const textRef = React.useRef(null);

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
      },
      items: state.items.map((item, index) => ({
        item_index: index + 1,
        quantity: 1,
        price: (typeof item.price === "object" ? item.price?.value : item.price) || "",
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
    setFlags(result.flags || {});
    setMeta(result.meta || {});
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
        return result.decisions?.find((decision) => !suppressedFields.includes(decision.field))?.field || null;
      }
      return result.decisions?.some((decision) => decision.field === current && !suppressedFields.includes(decision.field))
        ? current
        : current;
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
    setSelection(null);
  }, []);

  const captureSelection = React.useCallback(() => {
    const container = textRef.current;
    const browserSelection = window.getSelection();
    if (!container || !browserSelection || browserSelection.rangeCount === 0) {
      setSelection(null);
      return;
    }

    const range = browserSelection.getRangeAt(0);
    if (range.collapsed || !container.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }

    const start = computeSelectionOffset(container, range.startContainer, range.startOffset);
    const selectedText = range.toString();
    const end = computeSelectionOffset(container, range.endContainer, range.endOffset);

    if (state.text.slice(start, end) !== selectedText) {
      setSelection(null);
      return;
    }

    const segment = segments.find((seg) => start >= seg.start && end <= seg.end);

    setSelection({
      start,
      end,
      selected_text: selectedText,
      segment_id: segment?.id || "",
    });
  }, [segments, state.text]);

  const assignSelectionToField = React.useCallback(async (field) => {
    if (!state.filePath || !selection?.selected_text) {
      return;
    }
    const actionKey = `manual:${field}:${selection.start}:${selection.end}:${selection.selected_text}`;
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
          value: selection.selected_text,
          segment_id: selection.segment_id,
          start: selection.start,
          end: selection.end,
          selected_text: selection.selected_text,
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
          value: selection.selected_text,
          start: selection.start,
          end: selection.end,
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
    if (!selection?.selected_text) {
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
            value: selection.selected_text,
            start: selection.start,
            end: selection.end,
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
          start: selection.start,
          end: selection.end,
          value: selection.selected_text,
        },
      };
    }));
    console.log("DECISIONS_AFTER_ASSIGN:", state.decisions);
    console.log("HIGHLIGHTS:", highlights);
    console.log("ASSIGNED_FIELD_AFTER_ASSIGN:", {
      field,
      value: selection.selected_text,
      start: selection.start,
      end: selection.end,
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
    if (selection?.selected_text) {
      assignSelectionToField(field);
    }
  }, [assignSelectionToField, selection]);

  const handleItemFieldClick = React.useCallback((field, itemIndex) => {
    setSelectedField(`item:${itemIndex}:${field}`);
    if (selection?.selected_text) {
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="import-button" onClick={importEml} disabled={state.loading}>
          {state.loading ? "Loading..." : "Import EML"}
        </button>
        <div className="file-path">{state.filePath || "No file loaded"}</div>
      </header>

      {state.error ? <div className="error-banner">{state.error}</div> : null}

      <div className="subject-line">
        <span className="subject-label">Subject:</span>{" "}
        <span>{state.subject || "(no subject)"}</span>
      </div>

      {(flags.is_gift || flags.has_personalization) ? (
        <div className="banner-stack">
          {flags.is_gift ? <div className="banner gift">GIFT ORDER</div> : null}
          {flags.has_personalization ? (
            <div className="banner personalization">PERSONALIZATION REQUIRED</div>
          ) : null}
        </div>
      ) : null}

      <main className="split-view">
        <section className="panel text-panel">
          <div className="panel-title">Email Content</div>
          <pre
            ref={textRef}
            className="email-content"
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
          >
            {renderHighlightedText(
              state.text || "(import an .eml file to view content)",
              highlights,
            )}
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
                hasSelection={!!selection?.selected_text}
                loading={state.loading}
                selected={selectedField === key}
                onSelect={handleFieldClick}
                onTeach={teach}
                multiline={!!multiline}
              />
            ))}

            <div className="divider" />

            {orderedFields.slice(2).map(([label, key, multiline]) => (
              <FieldRow
                key={key}
                label={label}
                fieldKey={key}
                decision={decisionMap[key]}
                hasSelection={!!selection?.selected_text}
                loading={state.loading}
                selected={selectedField === key}
                onSelect={handleFieldClick}
                onTeach={teach}
                multiline={!!multiline}
              />
            ))}

            <div className="section-divider" />
            <div className="section-header">Items</div>

            {state.quantity > 1 ? (
              <div className="item-picker-row">
                <label className="compact-label" htmlFor="item-picker">Item</label>
                <select
                  id="item-picker"
                  className="item-picker"
                  value={activeItemIndex}
                  onChange={(event) => setActiveItemIndex(Number(event.target.value))}
                >
                  {state.items.map((_, index) => (
                    <option key={`item-${index + 1}`} value={index}>
                      {`Item ${index + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {itemFieldOrder.map(([label, fieldKey]) => (
              <ItemFieldRow
                key={fieldKey}
                label={label}
                fieldKey={fieldKey}
                value={activeItem[fieldKey] ?? ""}
                meta={activeItemMeta[fieldKey]}
                hasSelection={!!selection?.selected_text}
                loading={state.loading}
                selected={selectedField === `item:${activeItemIndex}:${fieldKey}`}
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
              />
            ))}

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
