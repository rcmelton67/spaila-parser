/**
 * Unified support / bug-report modal — Electron desktop build.
 *
 * Entry points:
 *   - Global "Report a Bug" button (bottom-left, all screens)
 *   - Settings/Account "Contact Support" button
 *
 * Submits via IPC → support:submit-report → backend POST /support/report.
 * Falls back to direct fetch if IPC bridge is unavailable.
 */
import React from "react";

const API_BASE = "http://127.0.0.1:8055";

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

const ROUTE_SCREEN_MAP = {
  "/":          "Active Orders",
  "/parser":    "Order Processor",
  "/workspace": "Workspace",
  "/settings":               "Settings",
  "/settings/account":       "Settings - Account",
  "/settings/general":       "Settings - General",
  "/settings/orders":        "Settings - Orders",
  "/settings/support":       "Settings - Support",
};

function resolveScreenName(route) {
  if (!route) return "Spaila Desktop";
  if (ROUTE_SCREEN_MAP[route]) return ROUTE_SCREEN_MAP[route];
  if (route.startsWith("/settings/")) return `Settings - ${route.split("/")[2] || ""}`;
  return route;
}

function fieldStyle(extra = {}) {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: "9px 11px",
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    fontSize: 13,
    color: "#1e293b",
    background: "#fff",
    outline: "none",
    fontFamily: "inherit",
    ...extra,
  };
}

const labelStyle = {
  display: "block",
  fontSize: 12,
  fontWeight: 700,
  color: "#475569",
  marginBottom: 5,
};

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

export default function SupportModal({ route = "", initialType = "bug_report", onClose }) {
  const [type, setType] = React.useState(initialType || "bug_report");
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [steps, setSteps] = React.useState("");
  const [screenshots, setScreenshots] = React.useState([]);
  const [severity, setSeverity] = React.useState("normal");
  const [includeDiagnostics, setIncludeDiagnostics] = React.useState(true);
  const [state, setState] = React.useState({ saving: false, done: false, error: "", reportId: "", notification: null });
  const submitRef = React.useRef(false);

  React.useEffect(() => {
    setType(initialType || "bug_report");
  }, [initialType]);

  const screenName = resolveScreenName(route);

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
      let context = {
        route,
        screen: screenName,
        timestamp: new Date().toISOString(),
        environment: "desktop",
      };

      // Collect app info via IPC
      const appInfoResult = await window.parserApp?.getSupportAppInfo?.();
      if (appInfoResult?.ok && appInfoResult.appInfo) {
        const info = appInfoResult.appInfo;
        context = {
          ...context,
          appVersion: info.version,
          platform: info.platform,
          os: info.release,
          arch: info.arch,
          electron: info.electron,
          chrome: info.chrome,
          node: info.node,
        };
      }

      // Submit via IPC (handler enriches with helperLogs + account session)
      const screenshotPayload = await Promise.all(screenshots.map(fileToScreenshotPayload));
      const result = await window.parserApp?.submitSupportReport?.({
        type,
        severity,
        subject: trimSubject,
        message: trimMessage,
        steps_to_reproduce: steps.trim(),
        route,
        screen: screenName,
        context,
        includeDiagnostics,
        screenshots: screenshotPayload,
      });

      if (result?.ok) {
        setState({ saving: false, done: true, error: "", reportId: result.reportId || "", notification: result.notification || null });
        return;
      }

      // IPC failed — fall back to direct POST
      const res = await fetch(`${API_BASE}/support/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          severity,
          subject: trimSubject,
          message: trimMessage,
          steps_to_reproduce: steps.trim(),
          app_source: "desktop",
          context,
          diagnostics: {},
          screenshots: screenshotPayload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.status === "received") {
        setState({ saving: false, done: true, error: "", reportId: data.ticket_id || data.report_id || "", notification: data.notification || null });
      } else {
        setState({ saving: false, done: false, error: result?.error || "Could not submit report. Please try again.", reportId: "", notification: null });
        submitRef.current = false;
      }
    } catch (err) {
      setState({ saving: false, done: false, error: err?.message || "Could not connect to Spaila. Please try again." });
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
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); addScreenshotFiles(e.dataTransfer?.files || []); }}
      style={{
      position: "fixed",
      inset: 0,
      zIndex: 100000,
      background: "rgba(15, 23, 42, 0.40)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    }}>
      <div style={{
        width: "min(600px, 100%)",
        background: "#fff",
        borderRadius: 16,
        boxShadow: "0 24px 70px rgba(15, 23, 42, 0.30)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        maxHeight: "calc(100vh - 48px)",
      }}>
        {/* Header */}
        <div style={{
          padding: "16px 20px",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
              {isBug ? "Report a Bug" : typeLabel}
            </div>
            <div style={{ marginTop: 3, fontSize: 12, color: "#64748b" }}>
              Spaila desktop{screenName ? ` · ${screenName}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: "#9ca3af", lineHeight: 1, padding: 2, flexShrink: 0 }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "18px 20px 6px", overflowY: "auto", flex: 1 }}>
          {state.done ? (
            <div style={{ padding: "28px 0 20px" }}>
              <div style={{ textAlign: "center", marginBottom: 18 }}>
                <div style={{ fontSize: 36, marginBottom: 10, color: "#166534" }}>✓</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#166534", marginBottom: 6 }}>
                  {isBug ? "Report sent" : "Support request sent"}
                </div>
              </div>
              {state.reportId && (
                <div style={{ fontSize: 12, color: "#475569", marginBottom: 6, textAlign: "center" }}>
                  Ticket ID: <code style={{ background: "#f1f5f9", padding: "1px 6px", borderRadius: 4 }}>{state.reportId}</code>
                </div>
              )}
              {state.notification ? (
                <div style={{
                  fontSize: 12, marginTop: 10, padding: "8px 12px", borderRadius: 8,
                  background: state.notification.email_sent ? "#f0fdf4" : "#fefce8",
                  border: `1px solid ${state.notification.email_sent ? "#bbf7d0" : "#fde68a"}`,
                  color: state.notification.email_sent ? "#166534" : "#92400e",
                  lineHeight: 1.6,
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
              <div style={{ display: "flex", gap: 12, marginBottom: 14 }}>
                <div style={{ flex: 2 }}>
                  <label style={labelStyle}>Request type</label>
                  <select value={type} onChange={(e) => setType(e.target.value)} style={fieldStyle()}>
                    {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Severity</label>
                  <select value={severity} onChange={(e) => setSeverity(e.target.value)} style={fieldStyle()}>
                    {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  Subject <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder={isBug ? "Brief description of what went wrong" : "What do you need help with?"}
                  style={fieldStyle()}
                  maxLength={500}
                />
              </div>

              <div style={{ marginBottom: isBug ? 14 : 16 }}>
                <label style={labelStyle}>
                  Message <span style={{ color: "#ef4444" }}>*</span>
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={isBug
                    ? "Describe what happened and what you expected to happen."
                    : "Describe what you need help with."}
                  rows={5}
                  style={fieldStyle({ resize: "vertical", minHeight: 90 })}
                />
              </div>

              {isBug && (
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle}>
                    Steps to reproduce <span style={{ color: "#94a3b8", fontWeight: 400 }}>(optional)</span>
                  </label>
                  <textarea
                    value={steps}
                    onChange={(e) => setSteps(e.target.value)}
                    placeholder={"1. Go to...\n2. Click...\n3. See error"}
                    rows={3}
                    style={fieldStyle({ resize: "vertical", minHeight: 64 })}
                  />
                </div>
              )}

              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>
                  Screenshots <span style={{ color: "#94a3b8", fontWeight: 400 }}>(optional, up to 5)</span>
                </label>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => addScreenshotFiles(e.target.files || [])}
                  style={fieldStyle({ padding: 8 })}
                />
                {screenshots.length ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: "#64748b" }}>
                    {screenshots.length} screenshot{screenshots.length === 1 ? "" : "s"} selected
                  </div>
                ) : null}
              </div>

              <div style={{
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: "10px 14px",
                marginBottom: 14,
              }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={includeDiagnostics}
                    onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                    style={{ marginTop: 2, width: 14, height: 14, accentColor: "#2563eb", flexShrink: 0 }}
                  />
                  <span style={{ fontSize: 12, color: "#475569", lineHeight: 1.6 }}>
                    <strong style={{ color: "#1e293b" }}>Include diagnostic files</strong>
                    {" — "}
                    Attaches app version, platform info, and recent coordinator activity.
                    Sensitive keys and tokens are automatically removed.
                  </span>
                </label>
              </div>

              {state.error && (
                <div style={{ color: "#b91c1c", fontSize: 12, marginBottom: 10, padding: "8px 10px", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" }}>
                  {state.error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: "14px 20px",
          borderTop: "1px solid #e5e7eb",
          display: "flex",
          justifyContent: "flex-end",
          gap: 10,
          flexShrink: 0,
        }}>
          {state.done ? (
            <button type="button" onClick={onClose} style={{ padding: "9px 18px", border: "none", borderRadius: 8, background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 800 }}>
              Close
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} style={{ padding: "9px 14px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff", color: "#334155", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={state.saving}
                style={{
                  padding: "9px 18px", border: "none", borderRadius: 8,
                  background: state.saving ? "#93c5fd" : "#2563eb",
                  color: "#fff", cursor: state.saving ? "default" : "pointer",
                  fontSize: 13, fontWeight: 800, minWidth: 100,
                }}
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
