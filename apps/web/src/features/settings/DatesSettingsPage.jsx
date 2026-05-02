import React from "react";
import { settingsApi } from "../../api.js";
import { DATE_FORMAT_OPTIONS, formatDate } from "../../shared/dateConfig.js";

function HelpPanel() {
  return (
    <aside className="dates-help-card">
      <div className="gen-help-label">Dates Help</div>
      <div className="gen-help-entry">
        <strong>Date display</strong>
        <p>Date settings control how order dates and ship-by dates appear in the Orders sheet and related views.</p>
      </div>
      <div className="gen-help-entry">
        <strong>Choose a format</strong>
        <p>Short is easiest to read, Numeric is compact, and ISO is best when you want sortable year-month-day style dates.</p>
      </div>
      <div className="gen-help-entry">
        <strong>Shared with desktop</strong>
        <p>Saving here updates the same shared setting used by the desktop app.</p>
      </div>
    </aside>
  );
}

export default function DatesSettingsPage({ onSettingsSaved }) {
  const [form, setForm] = React.useState(null);
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", message: "" });
  const previewDates = ["2026-04-13", "2025-12-05"];

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setState({ loading: true, saving: false, error: "", message: "" });
      try {
        const config = await settingsApi.getDateConfig();
        if (!cancelled) {
          setForm(config);
          setState({ loading: false, saving: false, error: "", message: "" });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ loading: false, saving: false, error: error?.message || "Could not load date settings.", message: "" });
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function update(key, value) {
    setForm((current) => ({ ...(current || {}), [key]: value }));
    setState((current) => ({ ...current, error: "", message: "" }));
  }

  async function save(event) {
    event.preventDefault();
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const saved = await settingsApi.updateDateConfig(form || {});
      setForm(saved);
      setState({ loading: false, saving: false, error: "", message: "Date settings saved and shared with desktop." });
      onSettingsSaved?.();
    } catch (error) {
      setState((current) => ({ ...current, saving: false, error: error?.message || "Could not save date settings.", message: "" }));
    }
  }

  if (state.loading) {
    return (
      <div className="dates-settings-layout">
        <div className="dates-settings-main">
          <div className="table-state"><div className="spinner" /><span>Loading date settings...</span></div>
        </div>
        <HelpPanel />
      </div>
    );
  }

  const config = form || {};

  return (
    <div className="dates-settings-layout">
      <main className="dates-settings-main">
        <form className="dates-card" onSubmit={save}>
          <div className="dates-section">
            <h3>Date Display Format</h3>
            <p>Control how order_date and ship_by appear in the orders table.</p>
            <div className="dates-radio-list">
              {DATE_FORMAT_OPTIONS.map((option) => (
                <label key={option.value} className={config.format === option.value ? "active" : ""}>
                  <input
                    type="radio"
                    name="dateFormat"
                    value={option.value}
                    checked={config.format === option.value}
                    onChange={() => update("format", option.value)}
                  />
                  <span>{option.label}</span>
                  <small>{option.example}</small>
                </label>
              ))}
            </div>
          </div>

          <div className="dates-section">
            <h3>Options</h3>
            {config.format !== "iso" ? (
              <label className="dates-check-row">
                <input type="checkbox" checked={config.showYear !== false} onChange={(event) => update("showYear", event.target.checked)} />
                <span>
                  <strong>Always show year</strong>
                  <small>When off, year is omitted from Short and Numeric formats.</small>
                </span>
              </label>
            ) : null}
            <label className="dates-check-row">
              <input type="checkbox" checked={config.flexibleSearch !== false} onChange={(event) => update("flexibleSearch", event.target.checked)} />
              <span>
                <strong>Match multiple date formats in search</strong>
                <small>Typing "apr 13" matches stored dates regardless of display format.</small>
              </span>
            </label>
          </div>

          <div className="dates-section">
            <h3>Preview</h3>
            <div className="dates-preview-list">
              {previewDates.map((date) => (
                <span key={date}>
                  <small>{date}</small>
                  {formatDate(date, config)}
                </span>
              ))}
            </div>
          </div>

          {state.error ? <div className="error-banner">{state.error}</div> : null}
          {state.message ? <div className="success-banner">{state.message}</div> : null}
          <button className="gen-save-btn" type="submit" disabled={state.saving}>
            {state.saving ? "Saving..." : "Save"}
          </button>
        </form>
      </main>
      <HelpPanel />
    </div>
  );
}
