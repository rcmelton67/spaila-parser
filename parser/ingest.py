import email
from email import policy
from email.header import decode_header
from email.utils import parsedate_to_datetime
from typing import Dict, Optional


def load_eml(path: str) -> Dict[str, Optional[str]]:
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

    return {"subject": subject, "email_date": email_date, "plain": plain, "html": html}
