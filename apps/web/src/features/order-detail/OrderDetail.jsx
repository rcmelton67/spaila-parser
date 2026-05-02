import React from "react";
import { attachmentsApi, ordersApi } from "../../api.js";
import AttachmentCard from "../attachments/AttachmentCard.jsx";
import OrderStatusBadge from "../orders/OrderStatusBadge.jsx";

const ITEM_STATUS_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

function Field({ label, value }) {
  return (
    <div className="detail-field">
      <dt>{label}</dt>
      <dd>{value || "Not set"}</dd>
    </div>
  );
}

function formatMessageLabel(message) {
  const direction = String(message?.direction || message?.type || "message").replace(/_/g, " ");
  const timestamp = message?.timestamp || message?.created_at || "";
  return timestamp ? `${direction} · ${timestamp}` : direction;
}

export default function OrderDetail({ orderId, onBack }) {
  const [order, setOrder] = React.useState(null);
  const [attachments, setAttachments] = React.useState([]);
  const [state, setState] = React.useState({ loading: true, error: "" });
  const [savingItemId, setSavingItemId] = React.useState("");

  const loadOrder = React.useCallback(async () => {
    if (!orderId) return;
    setState({ loading: true, error: "" });
    try {
      const [result, attachmentResult] = await Promise.all([
        ordersApi.get(orderId),
        attachmentsApi.listForOrder(orderId).catch(() => []),
      ]);
      setOrder(result);
      setAttachments(attachmentResult);
      setState({ loading: false, error: "" });
    } catch (error) {
      setState({ loading: false, error: error?.message || "Could not load order." });
    }
  }, [orderId]);

  React.useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  async function updateItemStatus(itemId, nextStatus) {
    setSavingItemId(itemId);
    try {
      await ordersApi.updateItemStatus(itemId, nextStatus);
      setOrder((current) => ({
        ...current,
        items: (current?.items || []).map((item) => (
          item.id === itemId ? { ...item, item_status: nextStatus } : item
        )),
      }));
    } catch (error) {
      setState({ loading: false, error: error?.message || "Could not update item status." });
    } finally {
      setSavingItemId("");
    }
  }

  if (state.loading) {
    return (
      <section className="detail-page">
        <button className="ghost-button" type="button" onClick={onBack}>Back to orders</button>
        <div className="table-state"><div className="spinner" /><span>Loading order...</span></div>
      </section>
    );
  }

  if (!order) {
    return (
      <section className="detail-page">
        <button className="ghost-button" type="button" onClick={onBack}>Back to orders</button>
        <div className="error-banner">{state.error || "Order not found."}</div>
      </section>
    );
  }

  return (
    <section className="detail-page">
      <div className="detail-topbar">
        <button className="ghost-button" type="button" onClick={onBack}>Back to orders</button>
        <button className="ghost-button" type="button" onClick={loadOrder}>Refresh detail</button>
      </div>

      {state.error ? <div className="error-banner">{state.error}</div> : null}

      <div className="detail-hero">
        <div>
          <span className="section-eyebrow">Order Detail</span>
          <h2>Order #{order.order_number || "Unnumbered"}</h2>
          <p>{order.buyer_name || "Unknown buyer"} · {order.platform || "unknown"}</p>
        </div>
        <OrderStatusBadge status={order.status} />
      </div>

      <div className="detail-grid">
        <section className="section-card">
          <div className="section-eyebrow">Summary</div>
          <dl className="detail-list">
            <Field label="Order date" value={order.order_date} />
            <Field label="Ship by" value={order.ship_by} />
            <Field label="Pet name" value={order.pet_name} />
            <Field label="Gift order" value={order.is_gift ? "Yes" : "No"} />
            <Field label="Gift wrap" value={order.gift_wrap ? "Yes" : "No"} />
          </dl>
        </section>

        <section className="section-card">
          <div className="section-eyebrow">Buyer And Shipping</div>
          <dl className="detail-list">
            <Field label="Buyer" value={order.buyer_name} />
            <Field label="Email" value={order.buyer_email} />
            <Field label="Shipping" value={order.shipping_address} />
          </dl>
        </section>
      </div>

      <section className="section-card detail-section">
        <div className="section-eyebrow">Items</div>
        <div className="item-list">
          {(order.items || []).map((item, index) => (
            <article className="item-card" key={item.id || index}>
              <div>
                <strong>{item.custom_1 || item.custom_2 || `Item ${index + 1}`}</strong>
                <span>Qty {item.quantity || 0} · {item.price ? `$${item.price}` : "No price"}</span>
              </div>
              <div className="item-meta">
                {[item.custom_2, item.custom_3, item.custom_4, item.custom_5, item.custom_6].filter(Boolean).join(" · ")}
              </div>
              {item.order_notes ? <p className="note-block">{item.order_notes}</p> : null}
              {item.gift_message ? <p className="note-block gift-note">{item.gift_message}</p> : null}
              <label className="status-select">
                <span>Item status</span>
                <select
                  value={item.item_status || ""}
                  disabled={savingItemId === item.id}
                  onChange={(event) => updateItemStatus(item.id, event.target.value)}
                >
                  {ITEM_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </article>
          ))}
        </div>
      </section>

      <section className="section-card detail-section">
        <div className="section-eyebrow">Conversations</div>
        {(order.messages || []).length ? (
          <div className="message-list">
            {order.messages.map((message, index) => (
              <article className="message-card" key={message.id || message.message_id || index}>
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
            ))}
          </div>
        ) : (
          <div className="table-state table-state-empty">
            <strong>No conversation yet</strong>
            <span>Messages will appear here when they are attached to this order.</span>
          </div>
        )}
      </section>

      <section className="section-card detail-section">
        <div className="section-eyebrow">Attachments</div>
        {attachments.length ? (
          <div className="attachment-grid">
            {attachments.map((attachment) => (
              <AttachmentCard key={attachment.id || attachment.name} attachment={attachment} />
            ))}
          </div>
        ) : (
          <div className="table-state table-state-empty">
            <strong>No web-safe attachments</strong>
            <span>Desktop-only or unavailable files remain protected from browser access.</span>
          </div>
        )}
      </section>
    </section>
  );
}
