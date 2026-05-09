/**
 * Unified support / bug-report modal — Webapp build.
 *
 * Entry points:
 *   - Global "Report a Bug" button (bottom-left, all pages)
 *   - Account "Contact Support" button
 *   - Settings/Support page
 *
 * Submits to POST /support/report via the shared api client.
 * Collects rich diagnostics: user identity, API faults, console errors,
 * unhandled promise rejections, screen name, build info.
 */
import React from "react";
import { api, getApiFaultBuffer, getConsoleErrorBuffer, getPromiseRejectBuffer } from "../../api.js";

const TYPE_OPTIONS = [
  { value: "bug_report",       label: "Bug Report" },
  { value: "support_request",  label: "Contact Support" },
  { value: "feature_request",  label: "Feature Request" },
  { value: "billing_help",     label: "Billing Help" },
];

const SEVERITY_OPTIONS = [
  { value: "low",      label: "Low" },
  { value: "normal",   label: "Normal" },
  { value: "high",     label: "High" },
  { value: "blocking", label: "Blocking" },
];

/** Map route/tab state to a readable screen name. */
function resolveScreenName(route, ordersTab) {
  if (!route || route === "orders") {
    if (ordersTab === "completed") return "Completed Orders";
    if (ordersTab === "inventory") return "Inventory Needed";
    return "Active Orders";
  }
  const map = {
    archive: "Archive Search",
    settings: "Settings",
    thankyou: "Thank-You Letter",
    "reset-password": "Password Reset",
  };
  return map[route] || route;
}

/**
 * Build a safe user identity block.
 *
 * sessionUser — from GET /account/session  → { id, account_id, email, name }
 * profile     — from GET /account/profile  → { account_id, account_email, shop_name,
 *                                              subscription_state, entitlements: {...} }
 *
 * Auth email (sessionUser.email) is the login credential and is always preferred.
 * account_email is the business contact field and used as a fallback.
 */
function buildUserBlock(sessionUser, profile) {
  const ent = (profile || {}).entitlements || {};
  const rawSubState = ent.subscription_state || (profile || {}).subscription_state || null;
  const trialExpired = ent.trial_expired ?? false;
  const trialActive = rawSubState === "trial" && !trialExpired;

  return {
    account_id:           (profile || {}).account_id || (sessionUser || {}).account_id || null,
    email:                (sessionUser || {}).email || (profile || {}).account_email || (profile || {}).email || null,
    display_name:         (profile || {}).shop_name || (profile || {}).owner_name || (sessionUser || {}).name || null,
    subscription_state:   rawSubState,
    trial_active:         trialActive,
    trial_days_remaining: ent.trial_days_remaining ?? null,
    entitlement_state:    ent.account_status || null,
    billing_state:        ent.billing_state || rawSubState,
    payment_failed:       Boolean(ent.payment_failed || ent.past_due || rawSubState === "past_due"),
    trial_expired:        Boolean(trialExpired),
    canceled:             Boolean(ent.canceled || ent.cancelled || rawSubState === "canceled"),
    billing_retry:        Boolean(ent.billing_retry || ent.retrying_payment),
    subscription_locked:  Boolean(ent.subscription_locked || (Array.isArray(ent.locked_features) && ent.locked_features.length > 0)),
  };
}

function fileToScreenshotPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      mime: file.type || "image/png",
      size: file.size,
      data: String(reader.result || ""),
    });
    reader.onerror = () => reject(reader.error || new Error("Could not read screenshot."));
    reader.readAsDataURL(file);
  });
}

export default function SupportModal({ initialType = "bug_report", account = null, screenName = "", ordersTab = "", onClose }) {
  const [type, setType] = React.useState(initialType || "bug_report");
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [steps, setSteps] = React.useState("");
  const [screenshots, setScreenshots] = React.useState([]);
  const [severity, setSeverity] = React.useState("normal");
  const [includeDiagnostics, setIncludeDiagnostics] = React.useState(true);
  const [state, setState] = React.useState({ saving: false, done: false, error: "", reportId: "", notification: null });
  const submitRef = React.useRef(false);
  // Resolved session user — fetched fresh when modal opens
  const sessionRef = React.useRef({ user: null, error: null, ready: false });

  React.useEffect(() => {
    setType(initialType || "bug_report");
  }, [initialType]);

  // Fetch /account/session on mount to get the authenticated user's email
  React.useEffect(() => {
    let cancelled = false;
    async function fetchSession() {
      try {
        const data = await api.get("/account/session");
        if (!cancelled) {
          sessionRef.current = {
            user: data?.user || null,
            profile: data?.profile || null,
            entitlements: data?.entitlements || null,
            error: data?.user ? null : "No active session",
            ready: true,
          };
        }
      } catch (err) {
        if (!cancelled) {
          sessionRef.current = { user: null, error: err?.message || "Session fetch failed", ready: true };
        }
      }
    }
    fetchSession();
    return () => { cancelled = true; };
  }, []);

  const resolvedScreen = screenName || resolveScreenName(null, ordersTab);

  async function handleSubmit() {
    if (submitRef.current) return;
    const trimMessage = message.trim();
    const trimSubject = subject.trim();
    if (!trimSubject) {
      setState((s) => ({ ...s, error: "Please enter a subject." }));
      return;
    }
    if (!trimMessage) {
      setState((s) => ({ ...s, error: "Please describe your issue or request." }));
      return;
    }

    submitRef.current = true;
    setState({ saving: true, done: false, error: "" });

    try {
      // ── Context ──────────────────────────────────────────────────────────
      const context = {
        app_source: "web",
        screen: resolvedScreen,
        route: window.location.pathname + window.location.hash,
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
        language: navigator.language,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        screenResolution: `${window.screen?.width}x${window.screen?.height}`,
        // Build info injected at build time (may be undefined in dev)
        buildVersion: typeof __SPAILA_BUILD__ !== "undefined" ? __SPAILA_BUILD__ : "dev",
        environment: window.location.hostname === "localhost" ? "development" : "production",
      };

      // ── User identity (safe fields only) ─────────────────────────────────
      // Prefer the live session fetch (has auth email); fall back to the
      // profile prop passed from App.jsx; include a lookup_error when neither works.
      const sess = sessionRef.current;
      const resolvedProfile = sess.profile || account;
      const user = buildUserBlock(sess.user, resolvedProfile);
      const userLookupError = (!user?.email && !user?.account_id)
        ? (sess.error || "Account data unavailable")
        : (sess.error && !sess.user ? `Session error: ${sess.error}` : null);

      // ── Diagnostics ───────────────────────────────────────────────────────
      const diagnostics = includeDiagnostics
        ? {
            recentConsoleErrors: getConsoleErrorBuffer(),
            recentApiFailures: getApiFaultBuffer(),
            recentPromiseRejections: getPromiseRejectBuffer(),
          }
        : {};

      const payload = {
        type,
        severity,
        subject: trimSubject,
        message: trimMessage,
        steps_to_reproduce: steps.trim(),
        app_source: "web",
        user,
        user_lookup_error: userLookupError || undefined,
        billing: {
          state: user.billing_state || user.subscription_state || "unknown",
          active: user.subscription_state === "active" || user.trial_active,
          trial_active: Boolean(user.trial_active),
          trial_expired: Boolean(user.trial_expired),
          payment_failed: Boolean(user.payment_failed),
          canceled: Boolean(user.canceled),
          billing_retry: Boolean(user.billing_retry),
          subscription_locked: Boolean(user.subscription_locked),
        },
        context,
        diagnostics,
        screenshots: await Promise.all(screenshots.map(fileToScreenshotPayload)),
      };

      const result = await api.post("/support/report", payload);

      if (result?.status === "received") {
        setState({ saving: false, done: true, error: "", reportId: result.ticket_id || result.report_id || "", notification: result.notification || null });
      } else {
        setState({ saving: false, done: false, error: "Unexpected response. Please try again.", reportId: "", notification: null });
        submitRef.current = false;
      }
    } catch (err) {
      const msg = err?.message || "Could not reach Spaila. Please try again.";
      setState({ saving: false, done: false, error: msg });
      submitRef.current = false;
    }
  }

  const typeLabel = TYPE_OPTIONS.find((o) => o.value === type)?.label || "Support";
  const isBug = type === "bug_report";
  const addScreenshotFiles = React.useCallback((files) => {
    setScreenshots((prev) => [...prev, ...Array.from(files || [])].slice(0, 5));
  }, []);

  return (
    <div
      className="support-modal-backdrop"
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); addScreenshotFiles(e.dataTransfer?.files || []); }}
    >
      <div className="support-modal-dialog">
        {/* Header */}
        <div className="support-modal-header">
          <div>
            <div className="support-modal-title">
              {isBug ? "Report a Bug" : typeLabel}
            </div>
            <div className="support-modal-subtitle">
              Spaila web
              {resolvedScreen ? ` · ${resolvedScreen}` : ""}
            </div>
          </div>
          <button type="button" className="support-modal-close" onClick={onClose}>×</button>
        </div>

        {/* Body */}
        <div className="support-modal-body">
          {state.done ? (
            <div className="support-modal-done">
              <div className="support-modal-done-check">✓</div>
              <div className="support-modal-done-title">
                {isBug ? "Report sent" : "Support request sent"}
              </div>
              {state.reportId && (
                <div className="support-modal-done-msg" style={{ marginTop: 4 }}>
                  Ticket ID: <code style={{ background: "#e0f2fe", padding: "1px 6px", borderRadius: 4 }}>{state.reportId}</code>
                </div>
              )}
              {state.notification ? (
                <div style={{
                  marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.6,
                  background: state.notification.email_sent ? "#f0fdf4" : "#fefce8",
                  border: `1px solid ${state.notification.email_sent ? "#bbf7d0" : "#fde68a"}`,
                  color: state.notification.email_sent ? "#166534" : "#92400e",
                }}>
                  {state.notification.email_sent
                    ? "Report saved successfully. Support notified."
                    : "Report saved successfully."
                  }
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="support-modal-row2">
                <div className="support-modal-field support-modal-field--flex2">
                  <label className="support-modal-label">Request type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="support-modal-input"
                  >
                    {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="support-modal-field support-modal-field--flex1">
                  <label className="support-modal-label">Severity</label>
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value)}
                    className="support-modal-input"
                  >
                    {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>

              <div className="support-modal-field">
                <label className="support-modal-label">
                  Subject <span className="support-modal-required">*</span>
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={isBug ? "Brief description of what went wrong" : "What do you need help with?"}
                  className="support-modal-input"
                  maxLength={500}
                />
              </div>

              <div className="support-modal-field">
                <label className="support-modal-label">
                  Message <span className="support-modal-required">*</span>
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={isBug
                    ? "Describe what happened and what you expected to happen."
                    : "Describe what you need help with."}
                  rows={5}
                  className="support-modal-input support-modal-textarea"
                />
              </div>

              {isBug && (
                <div className="support-modal-field">
                  <label className="support-modal-label">
                    Steps to reproduce <span className="support-modal-optional">(optional)</span>
                  </label>
                  <textarea
                    value={steps}
                    onChange={(e) => setSteps(e.target.value)}
                    placeholder={"1. Go to...\n2. Click...\n3. See error"}
                    rows={3}
                    className="support-modal-input support-modal-textarea support-modal-textarea--sm"
                  />
                </div>
              )}

              <div className="support-modal-field">
                <label className="support-modal-label">
                  Screenshots <span className="support-modal-optional">(optional, up to 5)</span>
                </label>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => addScreenshotFiles(e.target.files || [])}
                  className="support-modal-input"
                />
                {screenshots.length ? (
                  <div className="support-modal-optional" style={{ marginTop: 6 }}>
                    {screenshots.length} screenshot{screenshots.length === 1 ? "" : "s"} selected
                  </div>
                ) : null}
              </div>

              <div className="support-modal-diagnostics">
                <label className="support-modal-diag-label">
                  <input
                    type="checkbox"
                    checked={includeDiagnostics}
                    onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                    className="support-modal-checkbox"
                  />
                  <span>
                    <strong>Include diagnostic files</strong>
                    {" — "}
                    Attaches browser info, current page, and recent errors.
                    Sensitive keys and tokens are automatically removed.
                  </span>
                </label>
              </div>

              {state.error && (
                <div className="support-modal-error">{state.error}</div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="support-modal-footer">
          {state.done ? (
            <button type="button" className="support-modal-btn-submit" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button type="button" className="support-modal-btn-cancel" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="support-modal-btn-submit"
                onClick={handleSubmit}
                disabled={state.saving}
              >
                {state.saving ? "Sending…" : "Submit"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
