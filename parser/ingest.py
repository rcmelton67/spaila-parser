import email
from email import policy
from email.header import decode_header
from email.utils import parsedate_to_datetime
import json
import sys
from typing import Dict, Optional


def load_eml(path: str) -> Dict[str, Optional[str]]:
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
    if raw_date:
        try:
            parsed_date = parsedate_to_datetime(raw_date)
            email_date = f"{parsed_date.strftime('%B')} {parsed_date.day}, {parsed_date.year}"
        except (TypeError, ValueError, IndexError):
            email_date = ""

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
        "plain": plain,
        "html": html,
        "_diag": diag,
        "_raw_size": len(raw_bytes),
        "_path": path,
    }
