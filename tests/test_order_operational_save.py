import pytest
import asyncio
from fastapi import HTTPException

from backend import orders
from backend.db import init_db


def setup_db(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    init_db()


def test_parser_create_order_persists_shared_order_fields(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)

    result = asyncio.run(orders.create_order({
        "order": {
            "order_number": "2001",
            "buyer_name": "Parser Buyer",
            "shipping_name": "Ship Recipient",
            "buyer_email": "buyer@example.com",
            "shipping_address": "1 Parser Way",
            "phone_number": "555-0200",
            "order_date": "2026-05-03",
            "ship_by": "2026-05-08",
            "pet_name": "Scout",
            "gift_message": "Gift from parser",
            "is_gift": True,
            "gift_wrap": False,
        },
        "items": [{
            "item_index": 0,
            "quantity": 1,
            "price": "35.00",
            "custom_fields": {
                "custom_1": "Scout",
                "custom_2": "Dog",
                "custom_3": "Forever loved",
                "custom_4": "2014-2026",
                "custom_5": "Black",
                "custom_6": "Granite",
            },
        }],
        "meta": {"platform": "etsy"},
    }))

    loaded = orders.get_order(result["id"])

    assert result["status"] == "created"
    assert loaded["shipping_name"] == "Ship Recipient"
    assert loaded["phone_number"] == "555-0200"
    assert loaded["pet_name"] == "Scout"
    assert loaded["platform"] == "etsy"
    assert loaded["is_gift"] is True
    assert loaded["items"][0]["gift_message"] == "Gift from parser"


def test_web_reply_appends_shared_order_thread_message(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    created = orders.create_manual_order({
        "order_number": "1000",
        "buyer_name": "Thread Buyer",
        "buyer_email": "buyer@example.com",
        "ship_by": "2026-05-05",
    })

    result = orders.append_order_message(created["order_id"], {
        "message": {
            "id": "web-test-message",
            "direction": "outbound",
            "type": "outbound",
            "source": "web",
            "delivery_status": "draft_saved",
            "to": "buyer@example.com",
            "body": "Thanks for your order.",
            "attachments": [],
        },
    })

    loaded = orders.get_order(created["order_id"])
    assert result["status"] == "ok"
    assert loaded["messages"][-1]["id"] == "web-test-message"
    assert loaded["messages"][-1]["source"] == "web"
    assert loaded["messages"][-1]["body"] == "Thanks for your order."


def test_update_full_persists_operational_order_fields(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    created = orders.create_manual_order({
        "order_number": "1001",
        "buyer_name": "Original Buyer",
        "ship_by": "2026-05-05",
    })
    loaded = orders.get_order(created["order_id"])

    result = orders.update_full({
        "order_id": created["order_id"],
        "id": created["id"],
        "base_updated_at": loaded["updated_at"],
        "order_number": "1001",
        "buyer_name": "New Buyer",
        "shipping_name": "Ship Person",
        "buyer_email": "buyer@example.com",
        "shipping_address": "1 Main St",
        "phone_number": "555-0100",
        "order_date": "2026-05-01",
        "ship_by": "2026-05-07",
        "pet_name": "Buddy",
        "status": "active",
        "quantity": 2,
        "price": "42.00",
        "custom_1": "Dog",
        "custom_2": "Forever loved",
        "custom_3": "2010-2026",
        "custom_4": "Black",
        "custom_5": "Granite",
        "custom_6": "Premium",
        "order_notes": "Internal note",
        "gift_message": "Gift note",
        "item_status": "in_progress",
        "is_gift": True,
        "gift_wrap": True,
    })

    assert result == {"status": "ok"}
    saved = orders.get_order(created["order_id"])
    item = saved["items"][0]
    assert saved["buyer_name"] == "New Buyer"
    assert saved["shipping_name"] == "Ship Person"
    assert saved["phone_number"] == "555-0100"
    assert saved["pet_name"] == "Buddy"
    assert saved["is_gift"] is True
    assert item["quantity"] == 2
    assert item["custom_1"] == "Dog"
    assert item["custom_5"] == "Granite"
    assert item["order_notes"] == "Internal note"
    assert item["gift_message"] == "Gift note"
    assert item["item_status"] == "in_progress"


def test_update_full_rejects_stale_base_updated_at(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    created = orders.create_manual_order({
        "order_number": "1002",
        "buyer_name": "Buyer",
        "ship_by": "2026-05-05",
    })
    loaded = orders.get_order(created["order_id"])

    orders.update_full({
        "order_id": created["order_id"],
        "id": created["id"],
        "base_updated_at": loaded["updated_at"],
        "order_number": "1002",
        "buyer_name": "First Save",
        "status": "active",
    })

    with pytest.raises(HTTPException) as exc:
        orders.update_full({
            "order_id": created["order_id"],
            "id": created["id"],
            "base_updated_at": loaded["updated_at"],
            "order_number": "1002",
            "buyer_name": "Stale Save",
            "status": "active",
        })

    assert exc.value.status_code == 409


def test_order_detail_derives_pet_name_from_custom_1_for_desktop_parity(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)
    created = orders.create_manual_order({
        "order_number": "1003",
        "buyer_name": "Buyer",
        "ship_by": "2026-05-05",
        "custom_1": "Fluffy",
        "custom_2": "Cat",
    })

    loaded = orders.get_order(created["order_id"])

    assert loaded["pet_name"] == "Fluffy"
    assert loaded["items"][0]["custom_1"] == "Fluffy"
    assert loaded["items"][0]["custom_2"] == "Cat"
