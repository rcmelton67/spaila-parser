/**
 * features/email
 *
 * Email compose feature domain.
 *
 * Currently, email compose logic lives in:
 *   features/orders/OrdersPage.jsx  →  handleComposeEmail()
 *
 * Future extractions planned:
 *   - EmailIcon.jsx        — email icon button component
 *   - useEmailCompose.js   — compose hook (template select, var replace, attachments)
 *   - composeEmail.js      — platform-level compose (Outlook COM / mailto fallback)
 *
 * Template configuration UI lives in:
 *   settings/email/EmailsTab.jsx  (currently inside settings/SettingsModal.jsx)
 */
