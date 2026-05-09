import hashlib
import hmac
import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient

from backend import orders
from backend.main import app
from backend.api.routes import account
from backend.db import init_db


def setup_db(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SPAILA_ALLOW_DEV_SUBSCRIPTION_PATCH", "1")
    init_db()


def test_signup_starts_seven_day_trial_and_login_creates_session(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)

    signup = account.signup(account.SignupRequest(
        email="owner@example.com",
        password="correct horse battery",
        name="Owner",
        shop_name="Spaila Shop",
    ), Response())

    assert signup["authenticated"] is True
    assert signup["profile"]["subscription_state"] == "trial"
    assert signup["entitlements"]["locked"] is False
    trial_end = datetime.fromisoformat(signup["profile"]["trial_ends_at"])
    assert trial_end > datetime.now(timezone.utc) + timedelta(days=6)

    login = account.login(account.LoginRequest(
        email="OWNER@example.com",
        password="correct horse battery",
    ), Response())

    assert login["authenticated"] is True
    assert login["user"]["email"] == "owner@example.com"


def test_bearer_session_persists_until_logout_or_revocation(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    client = TestClient(app)

    signup = client.post("/account/auth/signup", json={
        "email": "persist@example.com",
        "password": "correct horse battery",
        "name": "Owner",
        "shop_name": "Persistent Shop",
    })
    assert signup.status_code == 200
    token = signup.json()["session_token"]
    assert token

    fresh_client = TestClient(app)
    session = fresh_client.get("/account/session", headers={"Authorization": f"Bearer {token}"})
    assert session.status_code == 200
    assert session.json()["authenticated"] is True
    assert session.json()["user"]["email"] == "persist@example.com"

    logout = fresh_client.post("/account/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert logout.status_code == 200
    after_logout = fresh_client.get("/account/session", headers={"Authorization": f"Bearer {token}"})
    assert after_logout.status_code == 200
    assert after_logout.json()["authenticated"] is False


def test_new_email_signup_does_not_extend_existing_trial(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    expired_trial_end = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()

    first = account.signup(account.SignupRequest(
        email="first@example.com",
        password="correct horse battery",
        name="Owner",
        shop_name="Trial Shop",
    ), Response())
    assert first["entitlements"]["locked"] is False

    account.update_subscription_for_dev(account.DevSubscriptionUpdate(
        subscription_state="trial",
        plan_code="spaila_one",
        trial_ends_at=expired_trial_end,
    ))

    second = account.signup(account.SignupRequest(
        email="second@example.com",
        password="correct horse battery",
        name="Second Owner",
        shop_name="Trial Shop",
    ), Response())

    assert second["authenticated"] is True
    assert second["profile"]["trial_ends_at"] == expired_trial_end
    assert second["entitlements"]["trial_expired"] is True
    assert second["entitlements"]["locked"] is True
    assert second["entitlements"]["can_parse"] is False


def test_same_install_id_cannot_claim_second_fresh_trial(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    install_id = "same-device-install"

    first = account.signup(account.SignupRequest(
        email="device-one@example.com",
        password="correct horse battery",
        confirm_password="correct horse battery",
        name="Owner",
        shop_name="Trial Shop",
        install_id=install_id,
    ), Response())
    first_end = first["profile"]["trial_ends_at"]

    expired_trial_end = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    account.update_subscription_for_dev(account.DevSubscriptionUpdate(
        subscription_state="trial",
        plan_code="spaila_one",
        trial_ends_at=expired_trial_end,
    ))

    second = account.signup(account.SignupRequest(
        email="device-two@example.com",
        password="correct horse battery",
        confirm_password="correct horse battery",
        name="Second Owner",
        shop_name="Trial Shop",
        install_id=install_id,
    ), Response())

    assert second["profile"]["trial_ends_at"] == expired_trial_end
    assert second["profile"]["trial_ends_at"] != first_end or second["entitlements"]["trial_expired"] is True
    assert second["entitlements"]["locked"] is True
    assert second["entitlements"]["can_parse"] is False


def test_clock_rollback_does_not_extend_trial_access(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    future_server_time = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    account._save_commercial_profile_fields({
        "subscription_state": "trial",
        "plan_code": "spaila_one",
        "trial_started_at": (datetime.now(timezone.utc) - timedelta(days=10)).isoformat(),
        "trial_ends_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
        "billing_status": "trialing",
        "entitlement_last_server_time": future_server_time,
    })

    entitlements = account.get_entitlements()

    assert entitlements["clock_tamper_detected"] is True
    assert entitlements["locked"] is True
    assert entitlements["can_parse"] is False


def test_expired_trial_blocks_gated_operations_but_keeps_existing_viewing(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    account.update_subscription_for_dev(account.DevSubscriptionUpdate(
        subscription_state="trial",
        plan_code="spaila_one",
        trial_ends_at=(datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
    ))

    with pytest.raises(HTTPException) as exc:
        orders.create_manual_order({
            "order_number": "3001",
            "buyer_name": "Locked Buyer",
            "ship_by": "2026-05-10",
        })

    assert exc.value.status_code == 402
    assert exc.value.detail["feature"] == "manual_order_creation"

    entitlements = account.get_entitlements()
    assert entitlements["locked"] is True
    assert "order_viewing" in entitlements["preserved_features"]
    assert entitlements["can_create_manual_orders"] is False
    assert entitlements["can_parse"] is False
    assert entitlements["can_receive_email"] is False
    assert entitlements["can_use_helper"] is False
    assert entitlements["can_view_existing_orders"] is True
    assert entitlements["can_search_archive"] is True


def test_password_reset_token_is_one_time_and_expires(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    account.signup(account.SignupRequest(
        email="reset@example.com",
        password="old password",
        name="Owner",
        shop_name="Reset Shop",
    ), Response())

    requested = account.request_password_reset(account.PasswordResetRequest(email="reset@example.com"))
    token = requested["reset_token"]
    assert requested["ok"] is True

    confirmed = account.confirm_password_reset(account.PasswordResetConfirm(
        token=token,
        password="new password",
    ))
    assert confirmed["ok"] is True

    login = account.login(account.LoginRequest(email="reset@example.com", password="new password"), Response())
    assert login["authenticated"] is True

    with pytest.raises(HTTPException):
        account.confirm_password_reset(account.PasswordResetConfirm(
            token=token,
            password="another password",
        ))


def test_billing_checkout_reports_configuration_requirements(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("STRIPE_PRICE_ID", raising=False)

    result = account.create_checkout_session(account.CheckoutRequest(
        success_url="http://127.0.0.1:5173/",
        cancel_url="http://127.0.0.1:5173/",
    ))

    assert result["status"] == "configuration_required"
    assert result["entitlements"]["locked"] is True
    assert result["entitlements"]["can_parse"] is False


def _stripe_signature(secret: str, payload: dict) -> tuple[str, str]:
    raw = json.dumps(payload, separators=(",", ":"))
    timestamp = str(int(time.time()))
    digest = hmac.new(secret.encode("utf-8"), f"{timestamp}.{raw}".encode("utf-8"), hashlib.sha256).hexdigest()
    return raw, f"t={timestamp},v1={digest}"


def test_stripe_webhook_payment_failure_locks_gated_capabilities(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    account.update_subscription_for_dev(account.DevSubscriptionUpdate(
        subscription_state="active",
        plan_code="spaila_one",
    ))
    payload = {
        "id": "evt_payment_failed",
        "type": "invoice.payment_failed",
        "data": {
            "object": {
                "customer": "cus_test",
                "subscription": "sub_test",
            },
        },
    }
    raw, signature = _stripe_signature("whsec_test", payload)

    result = TestClient(app).post(
        "/account/billing/webhook",
        content=raw,
        headers={"Stripe-Signature": signature, "Content-Type": "application/json"},
    )

    assert result.status_code == 200
    entitlements = account.get_entitlements()
    assert entitlements["account_status"] == "Billing Issue"
    assert entitlements["can_parse"] is False
    assert entitlements["can_view_existing_orders"] is True


def test_stripe_webhook_rejects_invalid_signature(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test")
    result = TestClient(app).post(
        "/account/billing/webhook",
        content=json.dumps({"id": "evt_bad", "type": "invoice.paid"}),
        headers={"Stripe-Signature": "t=123,v1=bad", "Content-Type": "application/json"},
    )

    assert result.status_code == 400
