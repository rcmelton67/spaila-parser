export const MESSAGE_DIRECTIONS = Object.freeze({
  inbound: "inbound",
  outbound: "outbound",
});

export const INBOX_MESSAGE_TYPES = Object.freeze({
  newOrder: "new_order",
  orderUpdate: "order_update",
});

export const ATTACHMENT_ACCESS_MODES = Object.freeze({
  metadataOnly: "metadata_only",
  download: "download",
  desktopOpen: "desktop_open",
});

export function normalizeMessageDirection(value) {
  const direction = String(value || "").trim().toLowerCase();
  return direction === MESSAGE_DIRECTIONS.outbound
    ? MESSAGE_DIRECTIONS.outbound
    : MESSAGE_DIRECTIONS.inbound;
}
