import React from "react";

const API_BASE = "http://127.0.0.1:8055";

const SUPPORT_DOC_SECTIONS = [
  {
    title: "Getting Started",
    body: "Set your shop name, logo, order views, and document paths first. Then connect email and run a small batch of orders to confirm the workflow.",
  },
  {
    title: "Orders",
    body: "Use the Orders sheet to search, sort, color-code, print, and track active or completed work. Customize visible columns from Settings → Orders.",
  },
  {
    title: "Workspace Email",
    body: "Workspace is where Spaila receives customer messages, links emails to orders, opens attachments, and keeps the daily inbox moving.",
  },
  {
    title: "Order Processor and Learning",
    body: "Order Processing controls what Spaila shows while parsing. Learning lets Spaila improve field decisions from accepted assignments and rejected values.",
  },
  {
    title: "Printing and Docs",
    body: "Printing controls order sheet and order card output. Docs stores thank-you letters, gift-message letterhead, and print placement settings.",
  },
  {
    title: "Settings and Data",
    body: "Settings/Data controls archive behavior, backup save location, restore tools, and folder counts for stored archive and backup files.",
  },
];

const SUPPORT_TROUBLESHOOTING = [
  {
    title: "Email will not connect",
    body: "Check the IMAP and SMTP host, port, SSL setting, username, and app password. Use the receiving and sending connection tests before saving.",
  },
  {
    title: "Documents or logo are missing",
    body: "Re-select the file from Settings. Spaila copies PDFs and logos into your workspace Docs folder and uses that copied file path.",
  },
  {
    title: "Parsed order details look wrong",
    body: "Review the original email, correct the field assignment, and save the order. Use Learning settings if you need to reset a field's learned values.",
  },
  {
    title: "Printing does not fit",
    body: "Reduce selected print fields, enable wrapping for long columns, or switch order cards to one order per page when cards overflow.",
  },
  {
    title: "Backup or restore needs attention",
    body: "Confirm the backup folder exists and use Refresh Counts in Settings/Data. Restore only when you intend to replace current data with a backup.",
  },
];

export function openSupportReport(type = "bug_report") {
  window.dispatchEvent(new CustomEvent("spaila:open-support-report", {
    detail: { type },
  }));
}

// ── Severity badge ────────────────────────────────────────────────────────────

function SeverityBadge({ value }) {
  const colors = {
    blocking: { bg: "#fee2e2", color: "#b91c1c" },
    high:     { bg: "#fef3c7", color: "#92400e" },
    normal:   { bg: "#dbeafe", color: "#1d4ed8" },
    low:      { bg: "#f0fdf4", color: "#166534" },
  };
  const c = colors[value] || colors.normal;
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700, background: c.bg, color: c.color }}>
      {String(value || "normal").toUpperCase()}
    </span>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ value }) {
  const open = value === "open" || !value;
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 700,
      background: open ? "#fef9c3" : "#f0fdf4",
      color: open ? "#92400e" : "#166534",
    }}>
      {open ? "OPEN" : String(value || "").toUpperCase()}
    </span>
  );
}

// ── Email indicator ───────────────────────────────────────────────────────────

function EmailIndicator({ emailSent }) {
  if (emailSent === null || emailSent === undefined) {
    return <span style={{ fontSize: 11, color: "#94a3b8" }}>—</span>;
  }
  return (
    <span style={{ fontSize: 13 }}>
      {emailSent ? "✓" : "✗"}
    </span>
  );
}

// ── Report detail modal ───────────────────────────────────────────────────────

function ReportDetailModal({ filepath, reportId, onClose }) {
  const [json, setJson] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    async function load() {
      if (window.parserApp?.readSupportReport) {
        const result = await window.parserApp.readSupportReport(filepath);
        if (result?.ok) {
          setJson(result.json);
        } else {
          setError(result?.error || "Could not read report.");
        }
      } else {
        setError("Report reader not available.");
      }
      setLoading(false);
    }
    load();
  }, [filepath]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100010,
      background: "rgba(15,23,42,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div style={{
        width: "min(840px,100%)", background: "#fff", borderRadius: 14,
        boxShadow: "0 24px 70px rgba(0,0,0,0.3)", overflow: "hidden",
        display: "flex", flexDirection: "column", maxHeight: "calc(100vh - 48px)",
      }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #e5e7eb", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>Report Detail</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>ID: {reportId || "—"}</div>
          </div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: "#9ca3af" }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px" }}>
          {loading ? (
            <div style={{ color: "#64748b", fontSize: 13 }}>Loading…</div>
          ) : error ? (
            <div style={{ color: "#b91c1c", fontSize: 13 }}>{error}</div>
          ) : (
            <pre style={{ fontSize: 12, lineHeight: 1.6, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", background: "#f8fafc", padding: 14, borderRadius: 8, border: "1px solid #e2e8f0" }}>
              {json}
            </pre>
          )}
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid #e5e7eb", display: "flex", justifyContent: "flex-end", flexShrink: 0 }}>
          <button type="button" onClick={onClose} style={{ padding: "8px 16px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff", color: "#334155", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Email config tester ───────────────────────────────────────────────────────

function EmailTester() {
  const [state, setState] = React.useState({ loading: false, result: null });

  async function runTest() {
    setState({ loading: true, result: null });
    try {
      const res = await fetch(`${API_BASE}/support/test-email`);
      const data = await res.json();
      setState({ loading: false, result: data });
    } catch (err) {
      setState({ loading: false, result: { ok: false, message: err?.message || "Request failed." } });
    }
  }

  return (
    <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: "#111827", marginBottom: 6 }}>Email Notification Test</div>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10, lineHeight: 1.6 }}>
        Sends a test message to verify SMTP is working. If email notifications aren&apos;t arriving,
        configure SMTP_HOST, SMTP_USERNAME, and SMTP_PASSWORD in <code>backend/.env</code>, then restart the backend.
      </div>
      <button
        type="button"
        onClick={runTest}
        disabled={state.loading}
        style={{
          padding: "8px 14px", border: "none", borderRadius: 8,
          background: state.loading ? "#93c5fd" : "#2563eb",
          color: "#fff", cursor: state.loading ? "default" : "pointer",
          fontSize: 12, fontWeight: 700,
        }}
      >
        {state.loading ? "Sending…" : "Send Test Email"}
      </button>
      {state.result && (
        <div style={{
          marginTop: 10, padding: "10px 12px", borderRadius: 8, fontSize: 12, lineHeight: 1.6,
          background: state.result.ok ? "#f0fdf4" : "#fef2f2",
          border: `1px solid ${state.result.ok ? "#bbf7d0" : "#fecaca"}`,
          color: state.result.ok ? "#166534" : "#b91c1c",
        }}>
          <strong>{state.result.ok ? "✓ Success" : "✗ Failed"}</strong> — {state.result.message}
          {!state.result.ok && (
            <div style={{ marginTop: 6, color: "#64748b" }}>
              SMTP configured: host={String(state.result.smtp_host_configured)},
              user={String(state.result.smtp_username_configured)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Reports viewer ────────────────────────────────────────────────────────────

function ReportsViewer() {
  const [reports, setReports] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [detail, setDetail] = React.useState(null); // { filepath, reportId }

  async function loadReports() {
    setLoading(true);
    setError("");
    try {
      if (window.parserApp?.listSupportReports) {
        const result = await window.parserApp.listSupportReports();
        if (result?.ok) {
          setReports(result.reports || []);
        } else {
          setError(result?.error || "Could not load reports.");
        }
      } else {
        // Fallback to backend API
        const res = await fetch(`${API_BASE}/support/reports`);
        const data = await res.json();
        setReports(data.reports || []);
      }
    } catch (err) {
      setError(err?.message || "Failed to load reports.");
    }
    setLoading(false);
  }

  async function openFolder() {
    if (window.parserApp?.openSupportReportsFolder) {
      await window.parserApp.openSupportReportsFolder();
    }
  }

  React.useEffect(() => { loadReports(); }, []);

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#111827" }}>
          Support Reports ({reports.length})
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={loadReports}
            disabled={loading}
            style={{ padding: "6px 12px", border: "1px solid #cbd5e1", borderRadius: 7, background: "#fff", color: "#334155", cursor: "pointer", fontSize: 11, fontWeight: 700 }}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={openFolder}
            style={{ padding: "6px 12px", border: "1px solid #cbd5e1", borderRadius: 7, background: "#fff", color: "#334155", cursor: "pointer", fontSize: 11, fontWeight: 700 }}
          >
            Open Folder
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 7, fontSize: 12, color: "#b91c1c", marginBottom: 10 }}>
          {error}
        </div>
      )}

      {reports.length === 0 && !loading ? (
        <div style={{ fontSize: 12, color: "#94a3b8", padding: "16px 0" }}>No support reports saved yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
                {["Received", "Type", "Sev", "Subject", "Source", "User Email", "Screen", "Status", "Email"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: "#475569", fontWeight: 700, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reports.map((r, i) => (
                <tr
                  key={r.report_id || i}
                  onClick={() => setDetail({ filepath: r.filepath, reportId: r.report_id })}
                  style={{
                    borderBottom: "1px solid #f1f5f9",
                    cursor: "pointer",
                    background: i % 2 === 0 ? "#fff" : "#f9fafb",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "#eff6ff"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = i % 2 === 0 ? "#fff" : "#f9fafb"; }}
                >
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: "#64748b" }}>{formatDate(r.received_at)}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{r.type?.replace(/_/g, " ") || "—"}</td>
                  <td style={{ padding: "6px 8px" }}><SeverityBadge value={r.severity} /></td>
                  <td style={{ padding: "6px 8px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.subject}>{r.subject || "—"}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{r.app_source || "—"}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: r.user_email ? "#334155" : "#94a3b8" }}>{r.user_email || "—"}</td>
                  <td style={{ padding: "6px 8px", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.screen}>{r.screen || "—"}</td>
                  <td style={{ padding: "6px 8px" }}><StatusBadge value={r.status} /></td>
                  <td style={{ padding: "6px 8px", textAlign: "center" }}><EmailIndicator emailSent={r.email_sent} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <ReportDetailModal
          filepath={detail.filepath}
          reportId={detail.reportId}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

// ── Main SupportPage ──────────────────────────────────────────────────────────

export default function SupportPage({ activeSupportSubtab = "documentation", setActiveSupportSubtab = () => {} }) {
  const tabs = [
    { id: "documentation", label: "Documentation" },
    { id: "contact",       label: "Contact Support" },
    { id: "reports",       label: "Reports" },
  ];

  return (
    <div>
      <div style={{ fontSize: "15px", fontWeight: 700, color: "#111", marginBottom: "8px" }}>
        Support
      </div>
      <div style={{ fontSize: "12px", color: "#6b7280", marginBottom: "16px", lineHeight: 1.6, maxWidth: "700px" }}>
        Find quick guidance, troubleshooting steps, and ways to contact Spaila support.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveSupportSubtab(tab.id)}
            style={{
              padding: "7px 14px",
              border: `1px solid ${activeSupportSubtab === tab.id ? "#93c5fd" : "#d1d5db"}`,
              borderRadius: 999,
              background: activeSupportSubtab === tab.id ? "#eff6ff" : "#fff",
              color: "#111827",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: activeSupportSubtab === tab.id ? 700 : 600,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeSupportSubtab === "documentation" ? (
        <div style={{ display: "grid", gap: 14, maxWidth: 820 }}>
          {SUPPORT_DOC_SECTIONS.map((section) => (
            <div key={section.title} style={{ border: "1px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "15px 18px" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 5 }}>{section.title}</div>
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>{section.body}</div>
            </div>
          ))}
          <div style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 12, padding: "15px 18px" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#111827", marginBottom: 10 }}>Troubleshooting</div>
            <div style={{ display: "grid", gap: 12 }}>
              {SUPPORT_TROUBLESHOOTING.map((item) => (
                <div key={item.title}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 3 }}>{item.title}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.55 }}>{item.body}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : activeSupportSubtab === "contact" ? (
        <div style={{ display: "grid", gap: 14, maxWidth: 760 }}>
          <div style={{ border: "1px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "16px 18px" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#111827", marginBottom: 8 }}>Contact Spaila</div>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "#64748b", lineHeight: 1.65 }}>
              Use the buttons below or the bottom-left <strong>Report a bug</strong> shortcut.
              Reports are submitted directly to Spaila — no email app required.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button type="button" onClick={() => openSupportReport("bug_report")} style={{ padding: "8px 14px", border: "none", borderRadius: 999, background: "#2563eb", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Report a Bug</button>
              <button type="button" onClick={() => openSupportReport("support_request")} style={{ padding: "8px 14px", border: "1px solid #cbd5e1", borderRadius: 999, background: "#fff", color: "#334155", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Contact Support</button>
              <button type="button" onClick={() => openSupportReport("feature_request")} style={{ padding: "8px 14px", border: "1px solid #cbd5e1", borderRadius: 999, background: "#fff", color: "#334155", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>Request Feature</button>
            </div>
          </div>
          <EmailTester />
        </div>
      ) : (
        <div style={{ maxWidth: 900 }}>
          <ReportsViewer />
        </div>
      )}
    </div>
  );
}
