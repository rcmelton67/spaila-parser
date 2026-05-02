import React from "react";

const SUPPORT_DOC_SECTIONS = [
  {
    title: "Getting Started",
    body: "Set your shop name, logo, order views, and document paths first. Then connect email and run a small batch of orders to confirm the workflow.",
  },
  {
    title: "Orders",
    body: "Use the Orders sheet to search, sort, color-code, print, and track active or completed work. Customize visible columns from Settings -> Orders.",
  },
  {
    title: "Workspace Email",
    body: "Workspace is where Spaila receives customer messages, links emails to orders, opens attachments, and keeps the daily inbox moving.",
  },
  {
    title: "Parser and Learning",
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
    body: "Re-select the file from Settings. Spaila copies PDFs and logos into C:\\Spaila\\Docs and uses that copied file path.",
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

const SUPPORT_CONTACT_OPTIONS = [
  {
    type: "bug",
    title: "Report a bug",
    body: "Tell support what went wrong, what screen you were on, and what you expected to happen.",
    button: "Report Bug",
  },
  {
    type: "feature",
    title: "Feature request",
    body: "Share the workflow or improvement you want Spaila to support next.",
    button: "Request Feature",
  },
  {
    type: "billing",
    title: "Billing help",
    body: "Ask for help with account, subscription, billing, or license questions.",
    button: "Get Billing Help",
  },
];

export function openSupportReport(type = "bug") {
  window.dispatchEvent(new CustomEvent("spaila:open-support-report", {
    detail: { type },
  }));
}

export default function SupportPage({ activeSupportSubtab = "documentation", setActiveSupportSubtab = () => {} }) {
  const tabs = [
    { id: "documentation", label: "Documentation" },
    { id: "contact", label: "Contact Support" },
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
              <div style={{ marginTop: 9, fontSize: 12, color: "#2563eb", fontWeight: 700 }}>Video: Coming soon</div>
            </div>
          ))}

          <div style={{ border: "1px solid #e5e7eb", background: "#fff", borderRadius: 12, padding: "15px 18px" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#111827", marginBottom: 10 }}>Troubleshooting</div>
            <div style={{ display: "grid", gap: 12 }}>
              {SUPPORT_TROUBLESHOOTING.map((item) => (
                <div key={item.title}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 3 }}>{item.title}</div>
                  <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.55 }}>{item.body}</div>
                  <div style={{ marginTop: 5, fontSize: 12, color: "#2563eb", fontWeight: 700 }}>Video: Coming soon</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14, maxWidth: 760 }}>
          {SUPPORT_CONTACT_OPTIONS.map((option) => (
            <div key={option.type} style={{ border: "1px solid #e5e7eb", background: "#f9fafb", borderRadius: 12, padding: "16px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", marginBottom: 5 }}>{option.title}</div>
                <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.6 }}>{option.body}</div>
              </div>
              <button
                type="button"
                onClick={() => openSupportReport(option.type)}
                style={{
                  padding: "8px 13px",
                  border: "none",
                  borderRadius: 999,
                  background: "#2563eb",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                {option.button}
              </button>
            </div>
          ))}
          <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.55 }}>
            Support emails open in your default email app so you can review and edit before sending.
          </div>
        </div>
      )}
    </div>
  );
}
