import React from "react";
import { settingsApi } from "../../api.js";

// ── Help panel entries ────────────────────────────────────────────────────
const HELP_ENTRIES = [
  {
    title: "General app settings",
    body: "General settings control operational preferences and app visibility. Business identity is managed in Account.",
  },
  {
    title: "App visibility",
    body: "Control which order views and features appear during normal web use.",
  },
];

function HelpPanel() {
  return (
    <aside className="gen-help">
      <div className="gen-help-label">General Help</div>
      {HELP_ENTRIES.map((entry) => (
        <div key={entry.title} className="gen-help-entry">
          <strong>{entry.title}</strong>
          <p>{entry.body}</p>
        </div>
      ))}
    </aside>
  );
}

function CheckSetting({ checked, onChange, label, hint, disabled }) {
  return (
    <label className={`gen-check-row${disabled ? " gen-check-disabled" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <div>
        <span className="gen-check-label">{label}</span>
        {hint ? <div className="gen-check-hint">{hint}</div> : null}
        {disabled ? <div className="gen-check-hint gen-desktop-only">Managed in the Spaila desktop app.</div> : null}
      </div>
    </label>
  );
}

export default function SettingsPage({ onSettingsSaved }) {
  // Web display preferences
  const [webSettings, setWebSettings] = React.useState(null);
  const [webForm, setWebForm] = React.useState(null);
  const [webState, setWebState] = React.useState({ loading: true, saving: false, error: "", message: "" });

  // Load web settings on mount
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setWebState({ loading: true, saving: false, error: "", message: "" });
      try {
        const settingsResult = await settingsApi.getWebSettings();
        if (!cancelled) {
          setWebSettings(settingsResult);
          setWebForm(settingsResult);
          setWebState({ loading: false, saving: false, error: "", message: "" });
        }
      } catch (error) {
        if (!cancelled) {
          setWebState({ loading: false, saving: false, error: error?.message || "Could not load settings.", message: "" });
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function saveWebSettings(event) {
    event.preventDefault();
    setWebState((s) => ({ ...s, saving: true, error: "", message: "" }));
    try {
      const result = await settingsApi.updateWebSettings(webForm || {});
      setWebSettings(result);
      setWebForm(result);
      setWebState({ loading: false, saving: false, error: "", message: "Display settings saved." });
      onSettingsSaved?.();
    } catch (error) {
      setWebState((s) => ({ ...s, saving: false, error: error?.message || "Could not save display settings.", message: "" }));
    }
  }

  const ws = webForm || webSettings || {};

  if (webState.loading) {
    return (
      <div className="gen-layout">
        <div className="gen-main">
          <div className="table-state"><div className="spinner" /><span>Loading settings…</span></div>
        </div>
        <HelpPanel />
      </div>
    );
  }

  return (
    <div className="gen-layout">
      {/* ── Main content ───────────────────────────────────────────────── */}
      <div className="gen-main">

        {/* App Visibility */}
        <section className="gen-section">
          <h3 className="gen-section-title">App Visibility</h3>
          <p className="gen-section-desc">Control which order views appear during normal daily use.</p>
          <form onSubmit={saveWebSettings}>
            <div className="gen-checks">
              <CheckSetting
                checked={ws.show_completed_tab !== false}
                onChange={(e) => setWebForm((p) => ({ ...p, show_completed_tab: e.target.checked }))}
                label="Show completed orders"
                hint="Show the Completed tab in the main navigation."
              />
              <CheckSetting
                checked={ws.show_inventory_tab === true}
                onChange={(e) => setWebForm((p) => ({ ...p, show_inventory_tab: e.target.checked }))}
                label='Show "Inventory Needed" tab'
                hint="Show a separate tab for orders missing personalization or production details."
              />
              <CheckSetting
                checked={ws.show_thank_you_shortcut !== false}
                onChange={(e) => setWebForm((p) => ({ ...p, show_thank_you_shortcut: e.target.checked }))}
                label="Show thank-you letter shortcut"
                hint="Show the Thank-You Letter button in the main navigation header."
              />
            </div>

            {webState.error ? <div className="error-banner" style={{ marginTop: 8 }}>{webState.error}</div> : null}
            {webState.message ? <div className="success-banner">{webState.message}</div> : null}
            <div style={{ marginTop: 16 }}>
              <button className="gen-save-btn" type="submit" disabled={webState.saving}>
                {webState.saving ? "Saving…" : "Save visibility settings"}
              </button>
            </div>
          </form>
        </section>

      </div>

      {/* ── Help panel ─────────────────────────────────────────────────── */}
      <HelpPanel />
    </div>
  );
}
