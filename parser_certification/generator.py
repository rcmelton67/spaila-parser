from __future__ import annotations

import random
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from .manifest import CertificationCase


DEFAULT_DATE = "Fri, 10 Apr 2026 12:00:00 -0500"


def render_body(input_spec: dict[str, Any], seed: int) -> str:
    """Render a deterministic commerce body from a manifest input spec."""
    if "body" in input_spec:
        return str(input_spec["body"]).strip() + "\n"

    rng = random.Random(seed)
    order_label = input_spec.get("order_label") or rng.choice(
        ["New order", "Purchase", "Invoice", "Order"]
    )
    order_number = input_spec.get("order_number", "1935")
    order_date = input_spec.get("order_date", "April 10, 2026")
    ship_by = input_spec.get("ship_by", "Apr 16")
    buyer_name = input_spec.get("buyer_name", "Alex Rivers")
    buyer_email = input_spec.get("buyer_email", "alex@example.net")
    quantity = input_spec.get("quantity", "2")
    item_price = input_spec.get("item_price", "24.50")
    street = input_spec.get("street", "120 Market St")
    city_state_zip = input_spec.get("city_state_zip", "Rochester, MN 55906")
    footer = input_spec.get("footer", "Need help? Contact support@example.invalid")

    return "\n".join(
        [
            f"{order_label}: #{order_number}",
            f"Order date: {order_date}",
            f"Ship by: {ship_by}",
            f"Customer email: {buyer_email}",
            f"Quantity: {quantity}",
            f"Item price: ${item_price}",
            "Shipping address",
            buyer_name,
            street,
            city_state_zip,
            "",
            footer,
            "",
        ]
    )


def write_eml(case: CertificationCase, output_dir: Path, repetition: int = 1) -> Path:
    """Write a deterministic EML fixture for a certification case."""
    output_dir.mkdir(parents=True, exist_ok=True)
    input_spec = dict(case.input)
    subject = input_spec.get("subject")
    if not subject:
        order_number = input_spec.get("order_number", "1935")
        subject = f"New order #{order_number}"

    message = EmailMessage()
    message["From"] = input_spec.get("from", "seller@example.invalid")
    message["To"] = input_spec.get("to", "parser-cert@example.invalid")
    message["Subject"] = str(subject)
    message["Date"] = input_spec.get("date_header", DEFAULT_DATE)
    message.set_content(render_body(input_spec, case.seed + repetition))

    path = output_dir / f"{case.case_id}-{repetition:02d}.eml"
    path.write_bytes(message.as_bytes())
    return path

