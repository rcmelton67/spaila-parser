import React from "react";
import SupportModal from "./SupportModal.jsx";

export default function SupportPage() {
  const [modal, setModal] = React.useState(null);

  return (
    <section className="orders-page">
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">Support</span>
          <h2>Spaila Support</h2>
          <p>Report a bug, request a feature, or contact Spaila directly — no email app required.</p>
        </div>
      </div>

      <div className="detail-grid">
        <section className="section-card">
          <div className="section-eyebrow">Contact Spaila</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
            <p style={{ margin: 0, fontSize: 13, color: "#475569", lineHeight: 1.65 }}>
              Use the buttons below to reach the Spaila team. Reports are submitted directly — no email app is required.
              Diagnostic information (app version, current page, recent errors) can be attached automatically to help us troubleshoot faster.
              Sensitive keys and tokens are always removed before sending.
            </p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
              <button
                type="button"
                className="primary-button"
                onClick={() => setModal({ type: "bug_report" })}
              >
                Report a Bug
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setModal({ type: "support_request" })}
              >
                Contact Support
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setModal({ type: "feature_request" })}
              >
                Request a Feature
              </button>
            </div>
          </div>
        </section>

        <section className="section-card">
          <div className="section-eyebrow">Support Scope</div>
          <div className="feature-list">
            <div>
              <strong>Web support covers</strong>
              <span>Order operations, archive search, attachments, account, and settings.</span>
            </div>
            <div>
              <strong>Desktop-side only</strong>
              <span>Order processor, inbox ingestion, helper, backup, restore, and local filesystem troubleshooting.</span>
            </div>
          </div>
        </section>
      </div>

      {modal && (
        <SupportModal
          key={modal.type}
          initialType={modal.type}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}
