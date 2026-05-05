import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { OPERATIONAL_ORDER_FIELDS, ORDER_FIELD_STORAGE } from "../../../../../shared/models/orderFields.mjs";
import { normalizeStatusConfig } from "../../../../../shared/models/statusConfig.mjs";
import { api, attachmentsApi, ordersApi } from "../../api.js";
import AttachmentCard from "../attachments/AttachmentCard.jsx";

function formatMessageLabel(message) {
  const direction = String(message?.direction || message?.type || "message").replace(/_/g, " ");
  const timestamp = message?.timestamp || message?.created_at || "";
  return timestamp ? `${direction} · ${formatBusinessTimestamp(timestamp)}` : direction;
}

function formatBusinessTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Not recorded";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date).replace(",", " •");
}

function text(value) {
  return value === null || value === undefined ? "" : String(value);
}

function boolValue(value) {
  return value === true || value === 1 || value === "1";
}

function buildLabelMap(layout) {
  const labels = {};
  for (const field of layout?.fields || []) {
    if (field?.key && field?.label) labels[field.key] = field.label;
  }
  labels.custom_1 ||= "Pet name";
  labels.custom_2 ||= "Pet type";
  labels.custom_3 ||= "Epitaph";
  labels.custom_4 ||= "Dates of life";
  labels.custom_5 ||= "Stone color";
  labels.custom_6 ||= "Stone type";
  return labels;
}

function getFieldLabel(field, labelMap) {
  if (field.key !== field.storageKey) {
    return labelMap[field.storageKey] || labelMap[field.key] || field.label;
  }
  return labelMap[field.key] || field.label;
}

function chooseActiveItem(order, initialItemId, previousItemId = "") {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (!items.length) return null;
  return items.find((item) => item.id === previousItemId)
    || items.find((item) => item.id === initialItemId)
    || items[0];
}

function formFromOrder(order, item) {
  const form = {
    order_id: text(order?.order_id || order?.id),
    id: text(item?.id),
    item_status: text(item?.item_status),
    status: text(order?.status || "active"),
    is_gift: boolValue(order?.is_gift),
    gift_wrap: boolValue(order?.gift_wrap),
    base_updated_at: text(order?.updated_at),
  };
  for (const field of OPERATIONAL_ORDER_FIELDS) {
    if (field.storage === ORDER_FIELD_STORAGE.orders) {
      form[field.key] = text(order?.[field.storageKey]);
    } else if (field.storage === ORDER_FIELD_STORAGE.items) {
      form[field.key] = text(item?.[field.storageKey]);
    }
  }
  if (!form.pet_name) form.pet_name = text(order?.pet_name);
  return form;
}

function applyPricingTypeFallback(form, pricingRules) {
  if (!form || form.stone_type || !pricingRules?.length) return form;
  const price = parseFloat(String(form.price || "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(price)) return form;
  const priceRule = pricingRules.find((rule) => {
    const rulePrice = parseFloat(String(rule.price || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(rulePrice) && Math.abs(rulePrice - price) < 0.001;
  });
  return priceRule?.typeValue ? { ...form, stone_type: String(priceRule.typeValue) } : form;
}

function buildSavePayload(form) {
  return {
    order_id: form.order_id,
    id: form.id,
    base_updated_at: form.base_updated_at,
    status: form.status || "active",
    is_gift: !!form.is_gift,
    gift_wrap: !!form.gift_wrap,
    item_status: form.item_status || null,
    buyer_name: form.buyer_name,
    shipping_name: form.shipping_name,
    buyer_email: form.buyer_email,
    shipping_address: form.shipping_address,
    phone_number: form.phone_number,
    order_number: form.order_number,
    order_date: form.order_date,
    ship_by: form.ship_by,
    pet_name: form.pet_name,
    quantity: form.quantity === "" ? null : form.quantity,
    price: form.price,
    custom_1: form.pet_name,
    custom_2: form.pet_type,
    custom_3: form.epitaph,
    custom_4: form.dates_of_life,
    custom_5: form.stone_color,
    custom_6: form.stone_type,
    order_notes: form.order_notes,
    gift_message: form.gift_message,
  };
}

function stableForm(value) {
  return JSON.stringify(value || {});
}

function draftStorageKey(orderId) {
  return `spaila.web.orderDraft.${orderId || "unknown"}`;
}

function FieldInput({ field, label, value, onChange }) {
  const commonProps = {
    value,
    onChange: (event) => onChange(field.key, event.target.value),
    placeholder: label,
  };
  return (
    <label className={`order-editor-field${field.multiline ? " multiline" : ""}`}>
      {field.multiline ? (
        <textarea {...commonProps} aria-label={label} rows={field.key === "shipping_address" ? 4 : 3} />
      ) : (
        <input {...commonProps} aria-label={label} type={field.inputType || "text"} />
      )}
    </label>
  );
}

export default function OrderDetail({ orderId, initialItemId = "", onBack }) {
  const [order, setOrder] = React.useState(null);
  const [attachments, setAttachments] = React.useState([]);
  const [form, setForm] = React.useState(null);
  const [loadedForm, setLoadedForm] = React.useState(null);
  const [activeItemId, setActiveItemId] = React.useState(initialItemId);
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", conflict: null });
  const [messageDraft, setMessageDraft] = React.useState("");
  const [messageState, setMessageState] = React.useState({ sending: false, error: "", message: "" });
  const [statusConfig, setStatusConfig] = React.useState(() => normalizeStatusConfig(null));
  const [labelMap, setLabelMap] = React.useState({});
  const [pricingRules, setPricingRules] = React.useState([]);

  const dirty = form && loadedForm ? stableForm(form) !== stableForm(loadedForm) : false;
  const dirtyRef = React.useRef(false);
  const activeItemIdRef = React.useRef(initialItemId);
  const retryTimerRef = React.useRef(null);

  React.useEffect(() => {
    dirtyRef.current = !!dirty;
  }, [dirty]);

  React.useEffect(() => {
    activeItemIdRef.current = activeItemId;
  }, [activeItemId]);

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get(API_ENDPOINTS.orderFieldLayout).catch(() => null),
      api.get(API_ENDPOINTS.pricingRules).catch(() => null),
    ]).then(([layout, pricing]) => {
      if (!cancelled) {
        setStatusConfig(normalizeStatusConfig(layout?.status));
        setLabelMap(buildLabelMap(layout));
        setPricingRules(Array.isArray(pricing?.rules) ? pricing.rules : []);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const hydrateOrder = React.useCallback((nextOrder, attachmentResult, preferredItemId = "") => {
    const nextItem = chooseActiveItem(nextOrder, preferredItemId, activeItemIdRef.current);
    const nextForm = applyPricingTypeFallback(formFromOrder(nextOrder, nextItem), pricingRules);
    setOrder(nextOrder);
    setAttachments(attachmentResult);
    setActiveItemId(nextItem?.id || "");
    setForm(nextForm);
    setLoadedForm(nextForm);
  }, [pricingRules]);

  const loadOrder = React.useCallback(async ({ preserveDirty = false, attempt = 0 } = {}) => {
    if (!orderId) return;
    if (preserveDirty && dirtyRef.current) {
      const discard = window.confirm("Discard unsaved changes and refresh this order?");
      if (!discard) return;
    }
    setState((current) => ({ ...current, loading: true, error: "", conflict: null }));
    try {
      const [result, attachmentResult] = await Promise.all([
        ordersApi.get(orderId),
        attachmentsApi.listForOrder(orderId).catch(() => []),
      ]);
      hydrateOrder(result, attachmentResult, activeItemIdRef.current || initialItemId);
      setState({ loading: false, saving: false, error: "", conflict: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error?.message || "Could not load order.",
      }));
      if (!order && attempt < 3) {
        if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = window.setTimeout(() => {
          loadOrder({ attempt: attempt + 1 });
        }, Math.min(7000, 1200 * (attempt + 1)));
      }
    }
  }, [hydrateOrder, initialItemId, order, orderId]);

  React.useEffect(() => {
    loadOrder();
    return () => {
      if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
    };
  }, [orderId]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    try {
      setMessageDraft(window.localStorage?.getItem(draftStorageKey(orderId)) || "");
    } catch {
      setMessageDraft("");
    }
    setMessageState({ sending: false, error: "", message: "" });
  }, [orderId]);

  React.useEffect(() => {
    try {
      if (messageDraft) {
        window.localStorage?.setItem(draftStorageKey(orderId), messageDraft);
      } else {
        window.localStorage?.removeItem(draftStorageKey(orderId));
      }
    } catch {
      // Draft persistence is a browser convenience; the order thread is the source of truth.
    }
  }, [messageDraft, orderId]);

  React.useEffect(() => {
    if (!initialItemId) return;
    setActiveItemId((current) => current || initialItemId);
  }, [initialItemId]);

  function setField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function changeActiveItem(itemId) {
    if (dirty) {
      const discard = window.confirm("Discard unsaved changes and switch items?");
      if (!discard) return;
    }
    const nextItem = (order?.items || []).find((item) => item.id === itemId) || null;
    const nextForm = applyPricingTypeFallback(formFromOrder(order, nextItem), pricingRules);
    setActiveItemId(itemId);
    setForm(nextForm);
    setLoadedForm(nextForm);
    setState((current) => ({ ...current, error: "", conflict: null }));
  }

  async function saveOrder() {
    if (!form || !dirty) return;
    setState((current) => ({ ...current, saving: true, error: "", conflict: null }));
    try {
      await ordersApi.saveOperationalOrder(buildSavePayload(form));
      const [result, attachmentResult] = await Promise.all([
        ordersApi.get(orderId),
        attachmentsApi.listForOrder(orderId).catch(() => []),
      ]);
      hydrateOrder(result, attachmentResult, activeItemId);
      setState({ loading: false, saving: false, error: "", conflict: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        saving: false,
        error: error?.status === 409 ? "" : (error?.message || "Could not save order."),
        conflict: error?.status === 409 ? error.detail : null,
      }));
    }
  }

  function revertChanges() {
    setForm(loadedForm);
    setState((current) => ({ ...current, error: "", conflict: null }));
  }

  function cancelEdit() {
    if (dirty) {
      const discard = window.confirm("Discard unsaved changes and return to orders?");
      if (!discard) return;
    }
    onBack?.();
  }

  async function saveReplyDraft() {
    setMessageState({ sending: false, error: "", message: "Draft saved on this browser." });
  }

  async function sendReply() {
    const body = String(messageDraft || "").trim();
    if (!body) {
      setMessageState({ sending: false, error: "Write a reply before saving it to the thread.", message: "" });
      return;
    }
    setMessageState({ sending: true, error: "", message: "" });
    try {
      const response = await api.post(API_ENDPOINTS.orderMessages(orderId), {
        message: {
          id: `web-${Date.now()}`,
          direction: "outbound",
          type: "outbound",
          subject: `Order ${form?.order_number || order?.order_number || ""}`.trim(),
          to: form?.buyer_email || order?.buyer_email || "",
          body,
          source: "web",
          delivery_status: "draft_saved",
          attachments: [],
        },
      });
      const nextOrder = await ordersApi.get(orderId);
      hydrateOrder(nextOrder, await attachmentsApi.listForOrder(orderId).catch(() => []), activeItemId);
      setMessageDraft("");
      setMessageState({
        sending: false,
        error: "",
        message: response?.message?.delivery_status === "sent" ? "Reply sent." : "Reply saved to the shared thread.",
      });
    } catch (error) {
      setMessageState({ sending: false, error: error?.message || "Could not save reply.", message: "" });
    }
  }

  if (state.loading && !order) {
    return (
      <section className="detail-page order-editor-page">
        <button className="ghost-button" type="button" onClick={cancelEdit}>Back to orders</button>
        <div className="table-state"><div className="spinner" /><span>Loading order...</span></div>
      </section>
    );
  }

  if (!order || !form) {
    return (
      <section className="detail-page order-editor-page">
        <button className="ghost-button" type="button" onClick={cancelEdit}>Back to orders</button>
        <div className="error-banner web-recovery-banner">
          <span>{state.error || "Order not found."}</span>
          <button type="button" className="ghost-button" onClick={() => loadOrder()}>
            Retry order
          </button>
        </div>
      </section>
    );
  }

  const items = order.items || [];
  const activeItem = items.find((item) => item.id === activeItemId) || items[0];
  const statusStates = Array.isArray(statusConfig?.states) ? statusConfig.states : [];
  const conversationMessages = order.messages || [];

  return (
    <section className="detail-page order-editor-page">
      <div className="order-editor-header">
        <button className="ghost-button" type="button" onClick={cancelEdit}>Back to orders</button>
        <div className="order-editor-title">
          <span className="section-eyebrow">Order Workspace</span>
          <h2>Order #{form.order_number || "Unnumbered"}</h2>
          <p>{form.buyer_name || "Unknown buyer"} · {order.platform || "unknown"}</p>
        </div>
        <label className="order-editor-status">
          <span>{statusConfig.columnLabel || "Status"}</span>
          <select value={form.item_status || ""} onChange={(event) => setField("item_status", event.target.value)}>
            <option value="" hidden></option>
            {statusStates.map((status) => (
              <option key={status.key} value={status.key}>{status.label}</option>
            ))}
          </select>
        </label>
        <div className="order-editor-actions">
          <button className="ghost-button" type="button" onClick={() => loadOrder({ preserveDirty: true })} disabled={state.saving}>Reload Saved Order</button>
          <button className="ghost-button" type="button" disabled title="Print support is planned for the next phase">Print</button>
          <button className="primary-button" type="button" onClick={saveOrder} disabled={!dirty || state.saving}>
            {state.saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>

      {state.error ? <div className="error-banner">{state.error}</div> : null}
      {state.conflict ? (
        <div className="error-banner">
          This order changed since you opened it. Refresh to load the latest version before saving.
          {state.conflict?.current_updated_at ? <span> Latest update: {state.conflict.current_updated_at}</span> : null}
        </div>
      ) : null}
      {dirty ? <div className="info-banner">Unsaved changes</div> : null}

      <div className="order-editor-shell">
        <aside className="order-editor-left section-card">
          {items.length > 1 ? (
            <label className="order-editor-field">
              <span>Editing item</span>
              <select value={activeItem?.id || ""} onChange={(event) => changeActiveItem(event.target.value)}>
                {items.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    Item {index + 1}: {item.custom_1 || item.custom_2 || item.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="order-editor-fields">
            {OPERATIONAL_ORDER_FIELDS.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                label={getFieldLabel(field, labelMap)}
                value={form[field.key] || ""}
                onChange={setField}
              />
            ))}
          </div>

          <div className="order-editor-gift-row">
            <label>
              <input type="checkbox" checked={!!form.is_gift} onChange={(event) => setField("is_gift", event.target.checked)} />
              <span>Mark as gift</span>
            </label>
            <label>
              <input type="checkbox" checked={!!form.gift_wrap} onChange={(event) => setField("gift_wrap", event.target.checked)} />
              <span>Gift wrap</span>
            </label>
          </div>
          <div className="order-editor-footer-actions">
            <button className="ghost-button" type="button" onClick={cancelEdit} disabled={state.saving}>
              Cancel
            </button>
            <button className="ghost-button" type="button" onClick={revertChanges} disabled={!dirty || state.saving}>
              Revert Changes
            </button>
            <button className="primary-button" type="button" onClick={saveOrder} disabled={!dirty || state.saving}>
              {state.saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </aside>

        <main className="order-editor-right">
          <section className="section-card order-editor-panel">
            <div className="section-eyebrow">Conversation</div>
            {conversationMessages.length ? (
              <div className="order-thread">
                {conversationMessages.map((message, index) => {
                  const outbound = String(message.direction || message.type || "").toLowerCase() === "outbound";
                  return (
                    <article className={`order-thread-message${outbound ? " outbound" : ""}`} key={message.id || message.message_id || index}>
                      <strong>{formatMessageLabel(message)}</strong>
                      <p>{message.body || message.preview || message.text || "No message body."}</p>
                      {Array.isArray(message.attachments) && message.attachments.length ? (
                        <div className="attachment-row">
                          {message.attachments.map((attachment, attachmentIndex) => (
                            <span key={`${attachment.name || attachment.path || attachmentIndex}`}>
                              {attachment.name || attachment.filename || "Attachment"}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="order-editor-empty-state">
                <strong>No conversation yet</strong>
                <span>Customer messages and saved replies will appear here when they are associated with this order.</span>
              </div>
            )}
          </section>

          <section className="section-card order-editor-panel">
            <div className="section-eyebrow">Attachments</div>
            {attachments.length ? (
              <div className="attachment-grid">
                {attachments.map((attachment) => (
                  <AttachmentCard key={attachment.id || attachment.name} attachment={attachment} />
                ))}
              </div>
            ) : (
              <div className="order-editor-empty-state">
                <strong>No browser-accessible attachments are currently available for this order.</strong>
                <span>Production files may still be available in the desktop workspace.</span>
              </div>
            )}
          </section>

          <section className="section-card order-editor-panel">
            <div className="section-eyebrow">Draft And History</div>
            <div className="order-editor-placeholder">
              <strong>Web reply draft</strong>
              <span>Drafts save locally as you type. Sending saves the reply to the shared order thread for desktop and web visibility.</span>
            </div>
            <label className="order-editor-field multiline">
              <textarea
                value={messageDraft}
                onChange={(event) => setMessageDraft(event.target.value)}
                placeholder="Write a reply or internal communication note..."
                aria-label="Reply draft"
                rows={5}
              />
            </label>
            {messageState.error ? <div className="error-banner">{messageState.error}</div> : null}
            {messageState.message ? <div className="success-banner">{messageState.message}</div> : null}
            <div className="order-editor-footer-actions" style={{ position: "static", borderTop: "none", padding: 0 }}>
              <button className="ghost-button" type="button" onClick={saveReplyDraft} disabled={!messageDraft || messageState.sending}>
                Save Draft
              </button>
              <button className="primary-button" type="button" onClick={sendReply} disabled={!messageDraft.trim() || messageState.sending}>
                {messageState.sending ? "Saving..." : "Save To Thread"}
              </button>
            </div>
            <div className="order-editor-history">
              <span>Last activity: {formatBusinessTimestamp(order.last_activity_at)}</span>
              <span>Last updated: {formatBusinessTimestamp(order.updated_at)}</span>
            </div>
          </section>
        </main>
      </div>
    </section>
  );
}

