export const API_ENDPOINTS = Object.freeze({
  health: "/health",
  account: "/account/profile",
  accountCapabilities: "/account/capabilities",
  thankYouTemplate: "/account/thank-you-template",
  thankYouTemplateFile: "/account/thank-you-template/file",
  orderFieldLayout: "/account/order-field-layout",
  dateConfig: "/account/date-config",
  pricingRules: "/account/pricing-rules",
  printConfig: "/account/print-config",
  webSettings: "/account/web-settings",
  ordersList: "/orders/list",
  orderDetail: (orderId) => `/orders/${encodeURIComponent(orderId)}`,
  orderUpdate: (orderId) => `/orders/${encodeURIComponent(orderId)}`,
  orderMessages: (orderId) => `/orders/${encodeURIComponent(orderId)}/messages`,
  orderAttachments: (orderId) => `/orders/${encodeURIComponent(orderId)}/attachments`,
  itemStatus: (itemId) => `/items/${encodeURIComponent(itemId)}/status`,
  archiveSearch: "/orders/archive/search",
  inboxEvents: "/inbox/events",
});

export const DEFAULT_LOCAL_API_BASE = "http://127.0.0.1:8055";
