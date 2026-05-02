export const SURFACES = Object.freeze({
  desktop: "desktop",
  web: "web",
});

export const DESKTOP_ONLY_CAPABILITIES = Object.freeze([
  "parser",
  "inbox_ingestion",
  "helper",
  "backup_restore",
  "local_filesystem",
]);

export const WEB_MVP_CAPABILITIES = Object.freeze([
  "active_orders",
  "completed_orders",
  "archive_search",
  "order_detail",
  "conversations",
  "attachments",
  "settings",
  "account",
  "subscription_billing",
  "support",
]);

export const CAPABILITY_COPY = Object.freeze({
  parser: "Desktop parser authority",
  inbox_ingestion: "Desktop inbox ingestion authority",
  helper: "Desktop helper authority",
  backup_restore: "Desktop backup and restore authority",
  local_filesystem: "Desktop local filesystem authority",
});
