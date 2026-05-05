import { API_ENDPOINTS } from "./endpoints.mjs";
import { normalizeItemStatus, normalizeOrderStatus } from "../models/order.mjs";

function buildQuery(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const normalized = String(value ?? "").trim();
    if (normalized) query.set(key, normalized);
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : "";
}

function toBool(value) {
  return value === true || value === 1 || value === "1";
}

export function normalizeOrderListRow(row = {}) {
  return {
    ...row,
    id: String(row.id || "").trim(),
    item_id: String(row.id || "").trim(),
    order_id: String(row.order_id || row.id || "").trim(),
    order_number: String(row.order_number || "").trim(),
    buyer_name: String(row.buyer_name || "").trim(),
    shipping_name: String(row.shipping_name || "").trim(),
    buyer_email: String(row.buyer_email || "").trim(),
    shipping_address: String(row.shipping_address || "").trim(),
    phone_number: String(row.phone_number || "").trim(),
    order_date: String(row.order_date || "").trim(),
    ship_by: String(row.ship_by || "").trim(),
    status: normalizeOrderStatus(row.status),
    item_status: normalizeItemStatus(row.item_status),
    platform: String(row.platform || "unknown").trim() || "unknown",
    quantity: Number(row.quantity || 0) || 0,
    price: String(row.price || "").trim(),
    is_gift: toBool(row.is_gift),
    gift_wrap: toBool(row.gift_wrap),
    messages: Array.isArray(row.messages) ? row.messages : [],
  };
}

export function normalizeOrderDetail(order = {}) {
  return {
    ...order,
    id: String(order.id || order.order_id || "").trim(),
    order_id: String(order.order_id || order.id || "").trim(),
    order_number: String(order.order_number || "").trim(),
    buyer_name: String(order.buyer_name || "").trim(),
    shipping_name: String(order.shipping_name || "").trim(),
    buyer_email: String(order.buyer_email || "").trim(),
    shipping_address: String(order.shipping_address || "").trim(),
    phone_number: String(order.phone_number || "").trim(),
    order_date: String(order.order_date || "").trim(),
    ship_by: String(order.ship_by || "").trim(),
    status: normalizeOrderStatus(order.status),
    platform: String(order.platform || "unknown").trim() || "unknown",
    is_gift: toBool(order.is_gift),
    gift_wrap: toBool(order.gift_wrap),
    pet_name: String(order.pet_name || "").trim(),
    updated_at: String(order.updated_at || "").trim(),
    last_activity_at: String(order.last_activity_at || "").trim(),
    messages: Array.isArray(order.messages) ? order.messages : [],
    items: Array.isArray(order.items) ? order.items.map((item) => ({
      ...item,
      id: String(item.id || "").trim(),
      quantity: Number(item.quantity || 0) || 0,
      price: String(item.price || "").trim(),
      custom_1: String(item.custom_1 || "").trim(),
      custom_2: String(item.custom_2 || "").trim(),
      custom_3: String(item.custom_3 || "").trim(),
      custom_4: String(item.custom_4 || "").trim(),
      custom_5: String(item.custom_5 || "").trim(),
      custom_6: String(item.custom_6 || "").trim(),
      item_status: normalizeItemStatus(item.item_status),
      order_notes: String(item.order_notes || "").trim(),
      gift_message: String(item.gift_message || "").trim(),
    })) : [],
  };
}

export function createOrdersApi(apiClient) {
  return {
    async list({ status = "", search = "", sort = "newest" } = {}) {
      const payload = await apiClient.get(`${API_ENDPOINTS.ordersList}${buildQuery({ status, search, sort })}`);
      return Array.isArray(payload) ? payload.map(normalizeOrderListRow) : [];
    },
    async get(orderId) {
      const payload = await apiClient.get(API_ENDPOINTS.orderDetail(orderId));
      return normalizeOrderDetail(payload);
    },
    async update(orderId, patch = {}) {
      const payload = await apiClient.patch(API_ENDPOINTS.orderUpdate(orderId), patch);
      return payload || { status: "ok" };
    },
    async saveOperationalOrder(payload = {}) {
      return apiClient.post(API_ENDPOINTS.orderUpdateFull, payload);
    },
    async delete(orderId) {
      const payload = await apiClient.delete(API_ENDPOINTS.orderDetail(orderId));
      return payload || { status: "ok" };
    },
    async updateItemStatus(itemId, status) {
      const payload = await apiClient.patch(API_ENDPOINTS.itemStatus(itemId), { item_status: status });
      return payload || { status: "ok" };
    },
  };
}
