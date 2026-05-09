export const ARCHIVE_SEARCH_FIELDS = Object.freeze([
  "order_number",
  "buyer_name",
  "billing_name",
  "buyer_email",
  "billing_email",
  "billing_address",
  "recipient_name",
  "shipping_address",
  "pet_name",
  "order_date",
  "product_text",
  "notes_text",
  "conversation_text",
]);

export const ARCHIVE_STATUSES = Object.freeze({
  archived: "archived",
  restored: "restored",
});

export function normalizeArchiveQuery(value) {
  return String(value || "").trim();
}
