import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { api } from "../../api.js";

const SUPPORT_EMAIL = "support@spaila.com";

function formatAccountCode(value, fallback = "") {
  const raw = String(value || "").trim();
  const normalized = raw.toLowerCase();
  if (!raw) return fallback;
  if (normalized === "trial" || normalized === "trialing") return "Free Trial";
  if (normalized === "trial_expired") return "Trial Expired";
  if (normalized === "active" || normalized === "spaila_one") return "Active Subscription";
  if (normalized === "local_only" || normalized === "local_first") return "Local Mode";
  if (normalized === "payment_failed" || normalized === "billing_issue" || normalized === "past_due" || normalized === "unpaid") return "Billing Issue";
  if (normalized === "saas") return "Setup Pending";
  if (normalized === "canceled") return "Trial Expired";
  if (normalized === "not_configured") return "Setup Pending";
  return raw.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCountdown(value) {
  const target = value ? new Date(value) : null;
  if (!target || Number.isNaN(target.getTime())) return "";
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return "Expired";
  const days = Math.ceil(diffMs / 86400000);
  return `${days} day${days === 1 ? "" : "s"} remaining`;
}

function formatBillingDate(value, fallback = "Not set") {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function DetailField({ label, children }) {
  return (
    <div className="account-detail-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AccountHelpPanel() {
  const entries = [
    ["Profile and identity", "Use Profile / Account Identity to keep the owner name, shop name, logo, saved account email, password reset, and sign-out controls in one place."],
    ["Billing and access", "Subscription / Billing shows the current plan, renewal or expiration date, login/trial controls when needed, and billing actions without repeating the same status in multiple fields."],
    ["Local-first access", "Existing orders stay available even if billing needs attention. Subscription status controls active tools such as the order processor, inbox/helper sync, and new manual order creation."],
  ];
  return (
    <aside className="gen-help account-help-panel">
      <div className="gen-help-label">Account Help</div>
      {entries.map(([title, body]) => (
        <div key={title} className="gen-help-entry">
          <strong>{title}</strong>
          <p>{body}</p>
        </div>
      ))}
    </aside>
  );
}

function openSupportEmail(type = "account") {
  const typeLabel = type === "billing"
    ? "Billing help"
    : type === "account"
      ? "Account help"
      : type === "tutorials"
        ? "Tutorials and documentation"
        : "Support request";
  const subject = encodeURIComponent(`Spaila Support - ${typeLabel}`);
  const body = encodeURIComponent(`Support type: ${typeLabel}\n\nDescribe what you need help with:\n`);
  window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}

function openPasswordReset(email = "") {
  const query = email ? `?email=${encodeURIComponent(email)}` : "";
  window.location.hash = `/reset-password${query}`;
}

function validateAuthForm(authForm, mode) {
  const email = String(authForm?.email || "").trim();
  const password = String(authForm?.password || "");
  if (!email || !email.includes("@")) {
    return "Enter a valid email address.";
  }
  if (!password) {
    return mode === "signup"
      ? "Enter a password with at least 8 characters to start your 7-day trial."
      : "Enter your password to log in.";
  }
  if (mode === "signup" && password.length < 8) {
    return "Enter a password with at least 8 characters to start your 7-day trial.";
  }
  return "";
}

export default function AccountPage({ account, capabilities, onAccountUpdated }) {
  const [form, setForm] = React.useState(() => ({
    shop_name: account?.shop_name || "",
    owner_name: account?.owner_name || "",
    account_email: account?.account_email || "",
    business_timezone: account?.business_timezone || "",
  }));
  const [state, setState] = React.useState({ saving: false, error: "", message: "" });
  const [session, setSession] = React.useState(null);
  const [authForm, setAuthForm] = React.useState({
    email: account?.account_email || "",
    password: "",
    name: account?.owner_name || "",
    shop_name: account?.shop_name || "",
  });
  const [authState, setAuthState] = React.useState({ loading: false, error: "", message: "" });
  const [logoState, setLogoState] = React.useState({ saving: false, error: "", message: "" });
  const [logoError, setLogoError] = React.useState(false);
  const logoInputRef = React.useRef(null);

  React.useEffect(() => {
    setForm({
      shop_name: account?.shop_name || "",
      owner_name: account?.owner_name || "",
      account_email: account?.account_email || "",
      business_timezone: account?.business_timezone || "",
    });
    setAuthForm((current) => ({
      ...current,
      email: current.email || account?.account_email || "",
      name: current.name || account?.owner_name || "",
      shop_name: current.shop_name || account?.shop_name || "",
    }));
    setLogoError(false);
  }, [account]);

  React.useEffect(() => {
    let cancelled = false;
    api.get(API_ENDPOINTS.accountSession)
      .then((payload) => {
        if (!cancelled) setSession(payload);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function submitAuth(event, mode = "login") {
    event.preventDefault();
    const validationError = validateAuthForm(authForm, mode);
    if (validationError) {
      setAuthState({ loading: false, error: validationError, message: "" });
      return;
    }
    setAuthState({ loading: true, error: "", message: "" });
    try {
      const endpoint = mode === "signup" ? API_ENDPOINTS.authSignup : API_ENDPOINTS.authLogin;
      const payload = mode === "signup"
        ? {
            ...authForm,
            email: authForm.email.trim(),
            name: form.owner_name || authForm.name,
            shop_name: form.shop_name || authForm.shop_name,
          }
        : { email: authForm.email.trim(), password: authForm.password };
      const result = await api.post(endpoint, payload);
      setSession(result);
      if (result.profile) onAccountUpdated?.(result.profile);
      setAuthState({ loading: false, error: "", message: mode === "signup" ? "Trial started." : "Signed in." });
    } catch (error) {
      setAuthState({ loading: false, error: error?.message || "Could not authenticate.", message: "" });
    }
  }

  async function logout() {
    setAuthState({ loading: true, error: "", message: "" });
    try {
      await api.post(API_ENDPOINTS.authLogout, {});
      const result = await api.get(API_ENDPOINTS.accountSession);
      setSession(result);
      setAuthState({ loading: false, error: "", message: "Signed out." });
    } catch (error) {
      setAuthState({ loading: false, error: error?.message || "Could not sign out.", message: "" });
    }
  }

  async function startCheckout() {
    setAuthState({ loading: true, error: "", message: "Opening Stripe Checkout..." });
    try {
      const result = await api.post(API_ENDPOINTS.billingCheckout, {
        success_url: window.location.href,
        cancel_url: window.location.href,
      });
      if (result.url) {
        window.location.href = result.url;
        return;
      }
      setAuthState({ loading: false, error: "", message: result.message || "Billing setup is pending Stripe configuration." });
    } catch (error) {
      setAuthState({ loading: false, error: error?.message || "Could not start checkout.", message: "" });
    }
  }

  async function openBillingPortal() {
    setAuthState({ loading: true, error: "", message: "Opening Stripe Billing Portal..." });
    try {
      const result = await api.post(API_ENDPOINTS.billingPortal, { return_url: window.location.href });
      if (result.url) {
        window.location.href = result.url;
        return;
      }
      setAuthState({ loading: false, error: "", message: result.message || "Billing portal is pending Stripe configuration." });
    } catch (error) {
      setAuthState({ loading: false, error: error?.message || "Could not open billing.", message: "" });
    }
  }

  async function uploadLogo(file) {
    if (!file) return;
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (file.type && !allowedTypes.has(file.type)) {
      setLogoState({ saving: false, error: "Logo must be a PNG, JPG, JPEG, or WebP image.", message: "" });
      return;
    }
    setLogoState({ saving: true, error: "", message: "" });
    try {
      const contentBase64 = await fileToBase64(file);
      const result = await api.patch(API_ENDPOINTS.accountLogo, {
        name: file.name || "shop-logo",
        mime_type: file.type || "image/png",
        content_base64: contentBase64,
        source_path: "web_upload",
      });
      if (result.profile) onAccountUpdated?.(result.profile);
      setLogoError(false);
      setLogoState({ saving: false, error: "", message: "Logo updated." });
    } catch (error) {
      setLogoState({ saving: false, error: error?.message || "Could not update logo.", message: "" });
    }
  }

  const shopInitial = String(form.shop_name || "S").trim().slice(0, 1).toUpperCase() || "S";
  const entitlements = session?.entitlements || capabilities?.entitlements || {};
  const isLocked = entitlements.locked === true;
  const rawSubscriptionState = entitlements.subscription_state || account?.subscription_state || "local_only";
  const rawPlanCode = entitlements.plan_code || account?.plan_code || "local";
  const accountStatusLabel = entitlements.account_status || formatAccountCode(rawSubscriptionState, "Local Mode");
  const trialCountdown = formatCountdown(entitlements.trial_ends_at);
  const billingStatusLabel = formatAccountCode(entitlements.billing_status, "Setup Pending");
  const hasBillingIssue = billingStatusLabel === "Billing Issue" || entitlements.locked === true && rawSubscriptionState !== "trial";
  const normalizedBillingState = String(accountStatusLabel || "").toLowerCase();
  const isLocalBilling = normalizedBillingState === "local mode" || rawSubscriptionState === "local_only" || !session?.authenticated;
  const isTrialBilling = normalizedBillingState === "free trial";
  const isActiveBilling = normalizedBillingState === "active subscription";
  const isExpiredBilling = normalizedBillingState === "trial expired" || isLocked;
  const billingPeriodValue = isTrialBilling
    ? (trialCountdown || formatBillingDate(entitlements.trial_ends_at, "Trial not started"))
    : isActiveBilling
      ? formatBillingDate(entitlements.subscription_current_period_end, "Renewal date syncing")
      : hasBillingIssue
        ? formatBillingDate(entitlements.subscription_current_period_end || entitlements.trial_ends_at, "Needs attention")
        : isExpiredBilling
          ? "Restricted Mode"
          : "No cloud billing connected";
  const billingPeriodLabel = isTrialBilling
    ? "Expires"
    : isActiveBilling
      ? "Renews"
      : hasBillingIssue
        ? "Access"
        : isExpiredBilling
          ? "Access"
          : "Access";
  const billingNotice = hasBillingIssue
    ? "Billing Issue Detected"
    : isExpiredBilling
      ? "Restricted Mode"
      : isTrialBilling && trialCountdown && trialCountdown !== "Expired"
        ? `Trial ends in ${trialCountdown.toLowerCase()}`
        : "";
  const showUpgradeAction = !isActiveBilling || isTrialBilling || isExpiredBilling || hasBillingIssue;
  const showBillingActions = !isLocalBilling && (isActiveBilling || isTrialBilling);
  const logoVersion = encodeURIComponent(account?.updated_at || account?.shop_logo_path || "");
  const logoUrl = `http://127.0.0.1:8055/account/logo${logoVersion ? `?v=${logoVersion}` : ""}`;
  const showLogo = !logoError && !!String(account?.shop_logo_path || "").trim();
  const createdLabel = account?.created_at
    ? new Date(account.created_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })
    : "Available after account sign-in";

  return (
    <section className="account-page">
      <div className="account-layout">
        <div className="account-main">
          <div className="account-hero-card account-parity-hero">
            <div className="account-hero-left">
              <div className="section-eyebrow">Account</div>
              <h2>Account Management</h2>
              <p className="account-hero-desc">
                Manage your Spaila profile, sign-in access, subscription, billing, and support options.
              </p>
              <div className="account-action-row account-hero-support-actions">
                <button type="button" className="primary-button" onClick={() => openSupportEmail("account")}>Contact Support</button>
                <button type="button" className="ghost-button" onClick={() => openSupportEmail("tutorials")}>Tutorials &amp; Documentation</button>
              </div>
            </div>
            <div className="account-logo-panel">
              <button
                type="button"
                className={`account-hero-avatar account-logo-upload ${showLogo ? "has-logo" : ""}`}
                title={showLogo ? "Change shop logo" : "Upload shop logo"}
                onClick={() => logoInputRef.current?.click()}
                disabled={logoState.saving}
              >
                {showLogo ? (
                  <img
                    className="account-hero-logo"
                    src={logoUrl}
                    alt={form.shop_name || "Shop logo"}
                    onError={() => setLogoError(true)}
                  />
                ) : (
                  <span className="account-logo-empty">
                    <span className="account-hero-initial">{shopInitial}</span>
                    <span>Upload logo</span>
                  </span>
                )}
              </button>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) uploadLogo(file);
                }}
              />
              <div className="account-logo-actions">
                <button type="button" className="ghost-button" onClick={() => logoInputRef.current?.click()} disabled={logoState.saving}>
                  {showLogo ? "Change logo" : "Upload logo"}
                </button>
              </div>
              {logoState.error ? <div className="error-banner">{logoState.error}</div> : null}
              {logoState.message ? <div className="success-banner">{logoState.message}</div> : null}
            </div>
          </div>

          <div className="account-card-grid">
            <section className="section-card account-card account-profile-card">
              <div className="account-card-header">
                <div>
                  <h3>Profile / Account Identity</h3>
                  <p>Keep business identity separate from billing and future sign-in details.</p>
                </div>
              </div>
              <form className="account-form account-profile-form" onSubmit={saveProfile}>
                <label>
                  <span>User name</span>
                  <input
                    value={form.owner_name}
                    onChange={(e) => setForm((p) => ({ ...p, owner_name: e.target.value }))}
                    placeholder="Account owner name"
                  />
                </label>
                <label>
                  <span>Business / shop name</span>
                  <input
                    value={form.shop_name}
                    onChange={(e) => setForm((p) => ({ ...p, shop_name: e.target.value }))}
                    placeholder="Your shop name"
                  />
                </label>
                {session?.authenticated ? (
                  <label>
                    <span>Account email</span>
                    <input
                      value={form.account_email}
                      onChange={(e) => setForm((p) => ({ ...p, account_email: e.target.value }))}
                      placeholder="owner@example.com"
                    />
                  </label>
                ) : null}
                <dl className="account-detail-list compact">
                  <DetailField label="Created date">{createdLabel}</DetailField>
                </dl>
                {state.error ? <div className="error-banner">{state.error}</div> : null}
                {state.message ? <div className="success-banner">{state.message}</div> : null}
                <div className="account-save-row">
                  <button className="primary-button" type="submit" disabled={state.saving}>
                    {state.saving ? "Saving..." : "Save profile"}
                  </button>
                  <span>Updates sync to the shared account profile used by desktop and web.</span>
                </div>
              </form>
            </section>

            <section className="section-card account-card">
              <div className="account-card-header">
                <div>
                  <h3>Subscription / Billing</h3>
                  <p>Plan, renewal, and access status without repeated billing labels.</p>
                </div>
              </div>
              <dl className="account-detail-list compact">
                <DetailField label="Plan">{accountStatusLabel}</DetailField>
                <DetailField label={billingPeriodLabel}>{billingPeriodValue}</DetailField>
              </dl>
              {!session?.authenticated ? (
                <div className="account-auth-panel">
                  <form className="account-form account-auth-form" onSubmit={(event) => submitAuth(event, "login")}>
                    <div className="account-field-row">
                      <label>
                        <span>Email</span>
                        <input value={authForm.email} onChange={(e) => setAuthForm((p) => ({ ...p, email: e.target.value }))} placeholder="owner@example.com" />
                      </label>
                      <label>
                        <span>Password</span>
                        <input type="password" value={authForm.password} onChange={(e) => setAuthForm((p) => ({ ...p, password: e.target.value }))} placeholder="At least 8 characters" />
                      </label>
                    </div>
                    {authState.error ? <div className="error-banner">{authState.error}</div> : null}
                    <div className="account-action-row">
                      <button className="primary-button" type="submit" disabled={authState.loading}>
                        {authState.loading ? "Working..." : "Login"}
                      </button>
                      <button className="ghost-button" type="button" onClick={(event) => submitAuth(event, "signup")} disabled={authState.loading}>
                        Start 7-Day Trial
                      </button>
                    </div>
                    <button type="button" className="account-link-button" onClick={() => openPasswordReset(authForm.email)}>
                      Forgot password?
                    </button>
                  </form>
                </div>
              ) : null}
              {billingNotice ? (
                <div className="account-license-box">
                  <strong>Status</strong>
                  <span>{billingNotice}</span>
                </div>
              ) : null}
              {hasBillingIssue ? (
                <div className="error-banner">
                  Billing needs attention. Order processor, inbox/helper, and new manual order creation are restricted until billing is resolved.
                </div>
              ) : null}
              {isLocked ? (
                <div className="error-banner">
                  Trial access has ended. Order processor, inbox, helper sync, and manual order creation are locked; order and archive viewing remain available.
                </div>
              ) : null}
              {session?.authenticated && !isLocalBilling && authState.error ? <div className="error-banner">{authState.error}</div> : null}
              {session?.authenticated && !isLocalBilling && authState.message ? <div className="success-banner">{authState.message}</div> : null}
              <div className="account-action-row">
                {!isLocalBilling ? (
                  <>
                    {showUpgradeAction ? (
                      <button type="button" className="primary-button" onClick={startCheckout} disabled={authState.loading}>
                        {isExpiredBilling || hasBillingIssue ? "Upgrade now" : "Upgrade"}
                      </button>
                    ) : null}
                    {showBillingActions ? (
                      <>
                        <button type="button" className="ghost-button" onClick={openBillingPortal} disabled={authState.loading}>
                          Manage subscription
                        </button>
                        <button type="button" className="ghost-button" onClick={openBillingPortal} disabled={authState.loading}>
                          Billing history
                        </button>
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
              {session?.authenticated ? (
                <div className="account-auth-panel">
                  <div className="account-action-row">
                    <button type="button" className="ghost-button" onClick={logout} disabled={authState.loading}>
                      Sign out
                    </button>
                    <button type="button" className="account-link-button" onClick={() => openPasswordReset(session.user?.email || authForm.email)}>
                      Reset password
                    </button>
                  </div>
                </div>
              ) : null}
            </section>

          </div>
        </div>

        <AccountHelpPanel />
      </div>
    </section>
  );
}
