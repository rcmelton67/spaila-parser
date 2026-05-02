import email
from email import policy
from email.header import decode_header
from email.utils import parsedate_to_datetime
import json
import sys
from datetime import datetime
from typing import Dict, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _system_local_timezone():
    return datetime.now().astimezone().tzinfo


def _resolve_business_timezone(business_timezone: Optional[str]):
    requested = (business_timezone or "").strip()
    if requested:
        try:
            return ZoneInfo(requested), requested, "configured_business_timezone"
        except (ZoneInfoNotFoundError, ValueError):
            local_tz = _system_local_timezone()
            return local_tz, str(local_tz), "invalid_configured_timezone_fell_back_to_system_local"
    local_tz = _system_local_timezone()
    return local_tz, str(local_tz), "system_local_timezone"


def format_header_date_for_business_timezone(raw_date: str, business_timezone: Optional[str] = None) -> tuple[str, Dict[str, str]]:
    provenance: Dict[str, str] = {
        "raw_header_date": raw_date or "",
        "parsed_header_datetime": "",
        "source_timezone": "",
        "business_timezone_used": "",
        "final_calendar_date": "",
        "timezone_adjustment_reason": "",
    }
    if not raw_date:
        return "", provenance

    parsed_date = parsedate_to_datetime(raw_date)
    if parsed_date.tzinfo is None:
        parsed_date = parsed_date.replace(tzinfo=_system_local_timezone())
        source_timezone = str(parsed_date.tzinfo)
        naive_reason = "naive_header_assumed_system_local"
    else:
        source_timezone = str(parsed_date.tzinfo)
        naive_reason = ""

    target_tz, target_tz_name, reason = _resolve_business_timezone(business_timezone)
    business_datetime = parsed_date.astimezone(target_tz)
    email_date = f"{business_datetime.strftime('%B')} {business_datetime.day}, {business_datetime.year}"
    adjustment_reason = reason
    if naive_reason:
        adjustment_reason = f"{adjustment_reason};{naive_reason}"
    if business_datetime.date() != parsed_date.date():
        adjustment_reason = f"{adjustment_reason};calendar_date_shifted_from_header_timezone"
    else:
        adjustment_reason = f"{adjustment_reason};calendar_date_preserved"

    provenance.update({
        "parsed_header_datetime": parsed_date.isoformat(),
        "source_timezone": source_timezone,
        "business_timezone_used": target_tz_name,
        "final_calendar_date": email_date,
        "timezone_adjustment_reason": adjustment_reason,
    })
    return email_date, provenance


def load_eml(path: str, business_timezone: Optional[str] = None) -> Dict[str, Optional[str]]:
    with open(path, "rb") as raw_file:
        raw_bytes = raw_file.read()

    with open(path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=policy.default)

    raw_subject = msg.get("Subject", "")
    decoded_parts = decode_header(raw_subject)
    subject = ""
    for part, encoding in decoded_parts:
        if isinstance(part, bytes):
            subject += part.decode(encoding or "utf-8", errors="ignore")
        else:
            subject += part

    raw_date = msg.get("Date", "")
    email_date = ""
    header_date_provenance: Dict[str, str] = {}
    if raw_date:
        try:
            email_date, header_date_provenance = format_header_date_for_business_timezone(raw_date, business_timezone)
        except (TypeError, ValueError, IndexError):
            email_date = ""
            header_date_provenance = {
                "raw_header_date": raw_date,
                "parsed_header_datetime": "",
                "source_timezone": "",
                "business_timezone_used": "",
                "final_calendar_date": "",
                "timezone_adjustment_reason": "header_date_parse_failed",
            }

    plain: Optional[str] = None
    html: Optional[str] = None

    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            if content_type == "text/plain" and plain is None:
                plain = part.get_content()
            elif content_type == "text/html" and html is None:
                html = part.get_content()
    else:
        content_type = msg.get_content_type()
        if content_type == "text/plain":
            plain = msg.get_content()
        elif content_type == "text/html":
            html = msg.get_content()

    boundary = msg.get_boundary() or ""
    boundary_count = raw_bytes.count(boundary.encode("utf-8", errors="ignore")) if boundary else 0
    charsets = []
    transfer_encodings = []
    text_part_types = []
    for part in msg.walk():
        content_type = part.get_content_type()
        if content_type.startswith("text/"):
            text_part_types.append(content_type)
        charset = part.get_content_charset()
        if charset:
            charsets.append(charset)
        transfer_encoding = part.get("Content-Transfer-Encoding", "")
        if transfer_encoding:
            transfer_encodings.append(str(transfer_encoding).strip().lower())

    diag = {
        "file_path": path,
        "file_size": len(raw_bytes),
        "first_500_chars": raw_bytes[:500].decode("latin-1", errors="ignore"),
        "content_type_header": msg.get("Content-Type", ""),
        "mime_boundary_count": boundary_count,
        "has_text_plain_part": plain is not None,
        "has_text_html_part": html is not None,
        "detected_charsets": sorted(set(charsets)),
        "transfer_encodings": sorted(set(transfer_encodings)),
        "text_part_types": text_part_types,
    }
    print(f"[EML_SOURCE_DIAG] {json.dumps(diag, ensure_ascii=False)}", file=sys.stderr, flush=True)

    return {
        "subject": subject,
        "email_date": email_date,
        "raw_header_date": raw_date,
        "header_date_provenance": header_date_provenance,
        "plain": plain,
        "html": html,
        "_diag": diag,
        "_raw_size": len(raw_bytes),
        "_path": path,
    }
