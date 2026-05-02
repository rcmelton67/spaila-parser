import React from "react";

const SUPPORT_EMAIL = "support@spaila.com";

export default function SupportPage() {
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState("bug");

  function openEmail(event) {
    event.preventDefault();
    const typeLabel = type === "feature" ? "Feature request" : type === "billing" ? "Billing help" : "Bug report";
    const subject = encodeURIComponent(`Spaila Support - ${typeLabel}`);
    const body = encodeURIComponent(
      [
        `Support type: ${typeLabel}`,
        `Timestamp: ${new Date().toISOString()}`,
        "",
        "Description:",
        description.trim() || "(no description provided)",
      ].join("\n"),
    );
    window.open(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`, "_blank");
  }

  return (
    <section className="orders-page">
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">Support</span>
          <h2>Spaila Support</h2>
          <p>Contact support, report issues, or request features. Opens your default email app.</p>
        </div>
      </div>

      <div className="detail-grid">
        <section className="section-card">
          <div className="section-eyebrow">Contact Support</div>
          <form className="account-form" onSubmit={openEmail}>
            <label>
              <span>Support type</span>
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="bug">Report a bug</option>
                <option value="feature">Feature request</option>
                <option value="billing">Billing help</option>
              </select>
            </label>
            <label>
              <span>Description</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe what happened, what you expected, and any steps to reproduce."
                rows={6}
                style={{ border: "1px solid #cbd5e1", borderRadius: 14, background: "#f8fafc", padding: "11px 12px", fontSize: 14, resize: "vertical", width: "100%", color: "#0f172a", fontFamily: "inherit" }}
              />
            </label>
            <button className="ghost-button" type="submit">
              Open email app
            </button>
          </form>
        </section>

        <section className="section-card">
          <div className="section-eyebrow">Safety Boundary</div>
          <div className="feature-list">
            <div>
              <strong>Web support covers</strong>
              <span>Order operations, archive search, attachments, account, and settings.</span>
            </div>
            <div>
              <strong>Desktop-side only</strong>
              <span>Parser, inbox ingestion, helper, backup, restore, and local filesystem troubleshooting.</span>
            </div>
            <div>
              <strong>Direct contact</strong>
              <span>
                Email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} style={{ color: "#2563eb", fontWeight: 800 }}>
                  {SUPPORT_EMAIL}
                </a>{" "}
                at any time.
              </span>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
