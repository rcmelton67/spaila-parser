/**
 * features/status
 *
 * Status column feature domain.
 *
 * Currently, status cell rendering and toggle logic lives in:
 *   features/orders/OrdersPage.jsx  →  visibleColumns.map → c.key === "status"
 *
 * Future extractions planned:
 *   - StatusCell.jsx   — status cell renderer + dropdown component
 *
 * Status configuration UI lives in:
 *   settings/SettingsModal.jsx  →  StatusTab component
 */
