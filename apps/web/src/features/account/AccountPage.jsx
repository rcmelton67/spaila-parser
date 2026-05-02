import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { api } from "../../api.js";

function StatusPill({ children, tone = "blue" }) {
  return <span className={`capability-pill capability-pill-${tone}`}>{children}</span>;
}

export default function AccountPage({ account, capabilities, onAccountUpdated }) {
  const [form, setForm] = React.useState(() => ({
    shop_name: account?.shop_name || "",
    owner_name: account?.owner_name || "",
    account_email: account?.account_email || "",
    business_timezone: account?.business_timezone || "",
  }));
  const [state, setState] = React.useState({ saving: false, error: "", message: "" });

  React.useEffect(() => {
    setForm({
      shop_name: account?.shop_name || "",
      owner_name: account?.owner_name || "",
      account_email: account?.account_email || "",
      business_timezone: account?.business_timezone || "",
    });
    setLogoError(false); // re-attempt logo load when account data refreshes
  }, [account]);

  async function saveProfile(event) {
    event.preventDefault();
    setState({ saving: true, error: "", message: "" });
    try {
      const updated = await api.patch(API_ENDPOINTS.account, form);
      onAccountUpdated?.(updated);
      setState({ saving: false, error: "", message: "Profile saved." });
    } catch (error) {
      setState({ saving: false, error: error?.message || "Could not save profile.", message: "" });
    }
  }

  const shopInitial = String(form.shop_name || "S").trim().slice(0, 1).toUpperCase() || "S";
  const planLabel = account?.plan_code || "local";
  const subscriptionLabel = account?.subscription_state || "local_only";
  // Always attempt the logo endpoint; onError falls back to the initial letter.
  const logoUrl = "http://127.0.0.1:8055/account/logo";
  const [logoError, setLogoError] = React.useState(false);
  const showLogo = !logoError;

  return (
    <section className="orders-page">
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">Account</span>
          <h2>Account Management</h2>
        </div>
      </div>

      {/* Identity hero card */}
      <div className="account-hero-card">
        <div className="account-hero-left">
          <p className="account-hero-desc">
            Manage your Spaila profile, subscription, billing, security, data, and support options.
          </p>
          <div className="account-hero-pills">
            <StatusPill tone="blue">{planLabel}</StatusPill>
            <StatusPill tone="amber">{subscriptionLabel}</StatusPill>
          </div>
        </div>
        <div className="account-hero-avatar">
          {showLogo ? (
            <img
              className="account-hero-logo"
              src={logoUrl}
              alt={form.shop_name || "Shop logo"}
              onError={() => setLogoError(true)}
            />
          ) : (
            <span className="account-hero-initial">{shopInitial}</span>
          )}
        </div>
      </div>

      <div className="detail-grid">
        <section className="section-card">
          <div className="section-eyebrow">Profile</div>
          <form className="account-form" onSubmit={saveProfile}>
            <label>
              <span>Shop name</span>
              <input
                value={form.shop_name}
                onChange={(e) => setForm((p) => ({ ...p, shop_name: e.target.value }))}
                placeholder="Your shop name"
              />
            </label>
            <label>
              <span>Owner name</span>
              <input
                value={form.owner_name}
                onChange={(e) => setForm((p) => ({ ...p, owner_name: e.target.value }))}
                placeholder="Your name"
              />
            </label>
            <label>
              <span>Account email</span>
              <input
                value={form.account_email}
                onChange={(e) => setForm((p) => ({ ...p, account_email: e.target.value }))}
                placeholder="owner@example.com"
              />
            </label>
            <label>
              <span>Business timezone</span>
              <input
                value={form.business_timezone}
                onChange={(e) => setForm((p) => ({ ...p, business_timezone: e.target.value }))}
                placeholder="System local (e.g. America/Chicago)"
              />
            </label>
            {state.error ? <div className="error-banner">{state.error}</div> : null}
            {state.message ? <div className="success-banner">{state.message}</div> : null}
            <button className="ghost-button" type="submit" disabled={state.saving}>
              {state.saving ? "Saving..." : "Save profile"}
            </button>
          </form>
        </section>

        <section className="section-card">
          <div className="section-eyebrow">Subscription / Billing</div>
          <dl className="detail-list">
            <div className="detail-field"><dt>Plan</dt><dd>{planLabel}</dd></div>
            <div className="detail-field"><dt>Subscription</dt><dd>{subscriptionLabel}</dd></div>
            <div className="detail-field"><dt>Auth mode</dt><dd>{account?.auth_mode || "local_first"}</dd></div>
            <div className="detail-field"><dt>SaaS readiness</dt><dd>{capabilities?.subscription_ready ? "Billing shell ready" : "Local-only"}</dd></div>
          </dl>
          <p>Billing is intentionally a placeholder. Desktop operations continue locally while account contracts stabilize.</p>
        </section>
      </div>
    </section>
  );
}
