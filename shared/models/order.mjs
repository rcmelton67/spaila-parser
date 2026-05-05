export const ORDER_STATUSES = Object.freeze({
  active: "active",
  completed: "completed",
  archived: "archived",
});

export const ORDER_LIST_SCOPES = Object.freeze({
  active: "active",
  completed: "completed",
  archive: "archive",
});

export const ORDER_FIELDS = Object.freeze([
  "id",
  "order_number",
  "order_date",
  "buyer_name",
  "shipping_name",
  "buyer_email",
  "shipping_address",
  "phone_number",
  "ship_by",
  "status",
  "platform",
  "pet_name",
  "last_activity_at",
  "updated_at",
]);

export function normalizeOrderStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["completed", "complete", "done"].includes(status)) return ORDER_STATUSES.completed;
  if (status === ORDER_STATUSES.archived) return ORDER_STATUSES.archived;
  return ORDER_STATUSES.active;
}

export function normalizeItemStatus(value) {
  const raw = String(value || "").trim();
  const status = raw.toLowerCase();
  if (!status) return "";
  if (["completed", "complete", "done"].includes(status)) return ORDER_STATUSES.completed;
  // Item status is also used by the configurable workflow picker, so preserve custom keys.
  return raw;
}

export function isActiveOrder(order) {
  return normalizeOrderStatus(order?.status) === ORDER_STATUSES.active;
}

export function isCompletedOrder(order) {
  return normalizeOrderStatus(order?.status) === ORDER_STATUSES.completed;
}
