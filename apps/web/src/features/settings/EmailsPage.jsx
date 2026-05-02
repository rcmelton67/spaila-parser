import React from "react";
import { settingsApi } from "../../api.js";

const HELP_ENTRIES = [
  {
    title: "Emails & Attachments",
    body: "Control how email attachments are displayed in the web app. Full email sending, SMTP, and IMAP configuration is managed in the Spaila desktop app.",
  },
  {
    title: "Attachment previews",
    body: "When enabled, image thumbnails and file cards appear on the order detail page for web-safe attachments. Disable to show a plain file list instead.",
  },
];

const DESKTOP_ITEMS = [
  { label: "SMTP sending", hint: "Outgoing email server credentials and sender name." },
  { label: "IMAP inbox", hint: "Incoming email connection for Spaila's inbox monitoring." },
  { label: "Email templates", hint: "Thank-you, shipping, and custom message templates." },
];

export default function EmailsPage({ onSettingsSaved }) {
  const [settings, setSettings] = React.useState(null);
  const [form, setForm] = React.useState(null);
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", message: "" });

  React.useEffect(() => {
    let cancelled = false;
    settingsApi.getWebSettings().then((result) => {
      if (!cancelled) {
        setSettings(result);
        setForm(result);
        setState({ loading: false, saving: false, error: "", message: "" });
      }
    }).catch((err) => {
      if (!cancelled) setState({ loading: false, saving: false, error: err?.message || "Could not load settings.", message: "" });
    });
    return () => { cancelled = true; };
  }, []);

  async function save(event) {
    event.preventDefault();
    setState((s) => ({ ...s, saving: true, error: "", message: "" }));
    try {
      const result = await settingsApi.updateWebSettings({ show_attachment_previews: form?.show_attachment_previews });
      setSettings(result);
      setForm(result);
      setState({ loading: false, saving: false, error: "", message: "Email settings saved." });
      onSettingsSaved?.();
    } catch (err) {
      setState((s) => ({ ...s, saving: false, error: err?.message || "Could not save settings.", message: "" }));
    }
  }

  const ws = form || settings || {};

  return (
    <div className="gen-layout">
      <div className="gen-main">

        {/* Web-capable: Attachment display */}
        <section className="gen-section">
          <h3 className="gen-section-title">Attachments</h3>
          <p className="gen-section-desc">Control how attachments are displayed in the web app.</p>
          {state.loading ? (
            <div className="table-state"><div className="spinner" /><span>Loading…</span></div>
          ) : (
            <form onSubmit={save}>
              <div className="gen-checks">
                <label className="gen-check-row">
                  <input
                    type="checkbox"
                    checked={ws.show_attachment_previews !== false}
                    onChange={(e) => setForm((p) => ({ ...p, show_attachment_previews: e.target.checked }))}
                  />
                  <div>
                    <span className="gen-check-label">Show attachment previews</span>
                    <div className="gen-check-hint">Display image thumbnails and file cards for web-safe attachments on the order detail page.</div>
                  </div>
                </label>
              </div>
              {state.error ? <div className="error-banner" style={{ marginTop: 8 }}>{state.error}</div> : null}
              {state.message ? <div className="success-banner">{state.message}</div> : null}
              <div style={{ marginTop: 16 }}>
                <button className="gen-save-btn" type="submit" disabled={state.saving}>
                  {state.saving ? "Saving…" : "Save email settings"}
                </button>
              </div>
            </form>
          )}
        </section>

        {/* Desktop-only: SMTP / IMAP / Templates */}
        <section className="gen-section">
          <h3 className="gen-section-title">Desktop email settings</h3>
          <p className="gen-section-desc">These options are managed in the Spaila desktop app under Settings → Emails.</p>
          <div className="gen-checks">
            {DESKTOP_ITEMS.map((item) => (
              <label key={item.label} className="gen-check-row gen-check-disabled">
                <input type="checkbox" disabled checked={false} onChange={() => {}} />
                <div>
                  <span className="gen-check-label">{item.label}</span>
                  <div className="gen-check-hint">{item.hint}</div>
                  <div className="gen-check-hint gen-desktop-only">Managed in the Spaila desktop app.</div>
                </div>
              </label>
            ))}
          </div>
        </section>

      </div>

      <aside className="gen-help">
        <div className="gen-help-label">Emails Help</div>
        {HELP_ENTRIES.map((entry) => (
          <div key={entry.title} className="gen-help-entry">
            <strong>{entry.title}</strong>
            <p>{entry.body}</p>
          </div>
        ))}
      </aside>
    </div>
  );
}
