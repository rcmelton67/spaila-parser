import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { api } from "../../api.js";

function hashParam(name) {
  const hash = String(window.location.hash || "");
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  return new URLSearchParams(query).get(name) || "";
}

export default function PasswordResetPage({ onBack }) {
  const [email, setEmail] = React.useState(() => hashParam("email"));
  const [token, setToken] = React.useState(() => hashParam("token"));
  const [password, setPassword] = React.useState("");
  const [state, setState] = React.useState({ loading: false, error: "", message: "" });

  async function requestReset(event) {
    event.preventDefault();
    setState({ loading: true, error: "", message: "" });
    try {
      const result = await api.post(API_ENDPOINTS.passwordResetRequest, { email });
      setToken(result.reset_token || "");
      setState({
        loading: false,
        error: "",
        message: result.reset_token
          ? "Reset code created. Use the one-time code below within 30 minutes."
          : "If that account exists, a reset code was created.",
      });
    } catch (error) {
      setState({ loading: false, error: error?.message || "Could not request password reset.", message: "" });
    }
  }

  async function confirmReset(event) {
    event.preventDefault();
    setState({ loading: true, error: "", message: "" });
    try {
      await api.post(API_ENDPOINTS.passwordResetConfirm, { token, password });
      setPassword("");
      setState({ loading: false, error: "", message: "Password reset. You can now login with the new password." });
    } catch (error) {
      setState({ loading: false, error: error?.message || "Could not reset password.", message: "" });
    }
  }

  return (
    <section className="account-page">
      <div className="section-card account-card account-reset-card">
        <div className="account-card-header">
          <div>
            <h3>Reset Password</h3>
            <p>Request a secure one-time reset code, then set a new password.</p>
          </div>
        </div>
        <form className="account-form account-auth-form" onSubmit={requestReset}>
          <label>
            <span>Account email</span>
            <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="owner@example.com" />
          </label>
          <button className="primary-button" type="submit" disabled={state.loading}>
            Request reset code
          </button>
        </form>
        <form className="account-form account-auth-form" onSubmit={confirmReset}>
          <label>
            <span>Reset code</span>
            <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="One-time reset code" />
          </label>
          <label>
            <span>New password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" />
          </label>
          {state.error ? <div className="error-banner">{state.error}</div> : null}
          {state.message ? <div className="success-banner">{state.message}</div> : null}
          <div className="account-action-row">
            <button className="primary-button" type="submit" disabled={state.loading}>
              Reset password
            </button>
            <button className="ghost-button" type="button" onClick={onBack}>
              Back to account
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
