import re
import sys
from typing import List, Optional
from .models import Candidate, Segment

_NUMBER_RE = re.compile(r"\b\d+(?:[.,]\d+)?\b")

_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]+")
_SHIP_BY_SUBJECT_RE = re.compile(
    r"(?:Ship by|Ships by|Dispatch by|Estimated ship(?: date)?)"
    r"[^A-Za-z0-9]{0,10}([A-Za-z]{3,9} \d{1,2})",
    re.IGNORECASE,
)
_ORDER_DATE_SUBJECT_RE = re.compile(
    r"(?:order\s+date|ordered\s+on|order\s+placed|placed\s+on|"
    r"purchase\s+date|purchased\s+on)"
    r"[^A-Za-z0-9]{0,16}("
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?"
    r"|\d{1,2}(?:st|nd|rd|th)?\s+"
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\.?(?:,?\s+\d{4})?"
    r"|\d{4}[-/]\d{1,2}[-/]\d{1,2}"
    r"|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}"
    r")",
    re.IGNORECASE,
)
_SHIP_BY_BODY_RE = re.compile(
    r"(?:Ship by|Ships by|Dispatch by|Estimated ship(?: date)?)"
    r"[^A-Za-z0-9]{0,10}([A-Za-z]{3,9} \d{1,2})",
    re.IGNORECASE,
)
_MONTH_DAY_RE = re.compile(r"\b([A-Za-z]{3,9} \d{1,2})\b")
_SHIP_BY_KEYWORDS = ("ship by", "ships by", "dispatch by", "estimated ship")

_MONTH_NAMES = (
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
)

# Matches: "Apr 9, 2026" | "April 9 2026" | "9 Apr 2026" | "2026-04-09" | "04/09/2026"
_DATE_RE = re.compile(
    r"\b(?:"
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?"
    r"|\d{1,2}(?:st|nd|rd|th)?\s+"
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
    r"\.?(?:,?\s+\d{4})?"
    r"|\d{4}[-/]\d{1,2}[-/]\d{1,2}"
    r"|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}"
    r")\b",
    re.IGNORECASE,
)


def _attach_context(cand: Candidate, seg_text: str, match_start: int, match_end: int) -> None:
    cand.segment_text = seg_text
    cand.left_context = seg_text[max(0, match_start - 10):match_start]
    cand.right_context = seg_text[match_end:match_end + 10]


def extract_numbers(segments: List[Segment]) -> List[Candidate]:
    candidates: List[Candidate] = []
    counter = 1

    for seg in segments:
        for match in _NUMBER_RE.finditer(seg.text):
            raw = match.group()
            abs_start = seg.start + match.start()
            abs_end = seg.start + match.end()

            cand_id = f"cand_{counter:04d}"
            counter += 1

            cand = Candidate(
                id=cand_id,
                field_type="number",
                value=raw,
                raw_text=raw,
                start=abs_start,
                end=abs_end,
                segment_id=seg.id,
                extractor="number_regex",
            )
            _attach_context(cand, seg.text, match.start(), match.end())
            candidates.append(cand)

    return candidates


def extract_emails(segments: List[Segment]) -> List[Candidate]:
    candidates: List[Candidate] = []
    counter = 1

    for seg in segments:
        for match in _EMAIL_RE.finditer(seg.text):
            raw = match.group()
            abs_start = seg.start + match.start()
            abs_end = seg.start + match.end()

            cand_id = f"email_{counter:04d}"
            counter += 1

            cand = Candidate(
                id=cand_id,
                field_type="email",
                value=raw,
                raw_text=raw,
                start=abs_start,
                end=abs_end,
                segment_id=seg.id,
                extractor="email_regex",
            )
            _attach_context(cand, seg.text, match.start(), match.end())
            candidates.append(cand)

    return candidates


def extract_dates(segments: List[Segment]) -> List[Candidate]:
    candidates: List[Candidate] = []
    counter = 1

    for seg in segments:
        # only scan segments that contain a month name (fast pre-filter)
        seg_lower = seg.text.lower()
        if not any(m in seg_lower for m in _MONTH_NAMES):
            continue

        for match in _DATE_RE.finditer(seg.text):
            raw = match.group()
            abs_start = seg.start + match.start()
            abs_end = seg.start + match.end()

            cand_id = f"date_{counter:04d}"
            counter += 1

            cand = Candidate(
                id=cand_id,
                field_type="date",
                value=raw,
                raw_text=raw,
                start=abs_start,
                end=abs_end,
                segment_id=seg.id,
                extractor="date_regex",
            )
            _attach_context(cand, seg.text, match.start(), match.end())
            candidates.append(cand)

    return candidates


def extract_header_date(email_date: str) -> List[Candidate]:
    if not email_date:
        return []

    cand = Candidate(
        id="date_header_0001",
        field_type="date",
        value=email_date,
        raw_text=email_date,
        start=None,
        end=None,
        segment_id="header",
        extractor="date_header",
        source="header",
    )
    cand.segment_text = f"Date: {email_date}"
    cand.left_context = "Date: "
    cand.right_context = ""
    return [cand]


def extract_order_date_from_subject(subject: str) -> List[Candidate]:
    candidates: List[Candidate] = []
    if not subject:
        return candidates

    for counter, match in enumerate(_ORDER_DATE_SUBJECT_RE.finditer(subject), start=1):
        value = match.group(1)
        cand = Candidate(
            id=f"order_date_subject_{counter:04d}",
            field_type="date",
            value=value,
            raw_text=value,
            start=None,
            end=None,
            segment_id="subject",
            extractor="order_date_subject_regex",
            source="subject",
        )
        _attach_context(cand, subject, match.start(1), match.end(1))
        candidates.append(cand)

    return candidates


def extract_ship_by_from_subject(subject: str) -> List[Candidate]:
    candidates: List[Candidate] = []
    if not subject:
        return candidates

    for counter, match in enumerate(_SHIP_BY_SUBJECT_RE.finditer(subject), start=1):
        value = match.group(1)
        cand = Candidate(
            id=f"ship_by_subject_{counter:04d}",
            field_type="ship_by",
            value=value,
            raw_text=value,
            start=None,
            end=None,
            segment_id="subject",
            extractor="ship_by_subject_regex",
            source="subject",
        )
        _attach_context(cand, subject, match.start(1), match.end(1))
        candidates.append(cand)

    return candidates


# Original pattern kept for shipping_address extractor which references it.
_ADDRESS_LABEL_RE = re.compile(r"(?:shipping|billing)\s+address", re.IGNORECASE)

# Expanded label set for buyer_name extraction only.
_BUYER_LABEL_RE = re.compile(
    r"(?:shipping|billing)\s+address"
    r"|ship\s+to"
    r"|deliver\s+to"
    r"|recipient",
    re.IGNORECASE,
)

_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z'\- ]+$")
_NAME_WITH_TRAILING_NUMBER_RE = re.compile(r"^([A-Za-z][A-Za-z'\- ]*?[A-Za-z])\s+\d+$")
_STREET_RE = re.compile(r"^\d[\d\-]*\s+\S")
_PHONE_RE = re.compile(r"^\+?\d[\d\s().-]{6,}\d$")
_CITY_STATE_RE = re.compile(r"^[A-Za-z .'\-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$")
_COUNTRY_RE = re.compile(r"^[A-Za-z .'\-]{3,40}$")
_ADDRESS_STOP_RE = re.compile(
    r"^(?:"
    r"purchase\s+shipping\s+label"
    r"|shipping\s+internationally\??"
    r"|sell\s+with\s+confidence"
    r"|order\s+details"
    r"|payment\s+method"
    r"|order\s+total"
    r"|item\s+total"
    r"|questions"
    r"|shop\s+policies"
    r"|transaction\s+id"
    r"|processing\s+time"
    r"|returns?\s*&\s*exchanges?"
    r"|cancellations?"
    r")(?::|\b)",
    re.IGNORECASE,
)


def _label_source(text: str) -> str:
    return "billing" if "billing" in text.lower() else "shipping"


def _is_valid_name(text: str) -> bool:
    return bool(_NAME_RE.match(text) and " " in text and len(text) >= 4)


def _extract_contact_name_value(text: str) -> tuple[str, int] | None:
    if _is_valid_name(text):
        return text, len(text)
    match = _NAME_WITH_TRAILING_NUMBER_RE.match(text)
    if match:
        value = match.group(1).strip()
        if _is_valid_name(value):
            return value, len(value)
    return None


def _normalize_name(value: str) -> str:
    """Collapse whitespace and apply Title Case."""
    return re.sub(r"\s+", " ", value).strip().title()


def _is_address_stop(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return True
    if _BUYER_LABEL_RE.search(normalized):
        return True
    return bool(_ADDRESS_STOP_RE.match(normalized))


def _is_addressish_line(text: str) -> bool:
    normalized = re.sub(r"\s+", " ", text).strip()
    lower = normalized.lower()
    if not normalized:
        return False
    if _EMAIL_RE.fullmatch(normalized):
        return False
    if _PHONE_RE.fullmatch(normalized):
        return False
    if _STREET_RE.match(normalized):
        return True
    if _CITY_STATE_RE.match(normalized):
        return True
    if lower in {"united states", "usa", "canada", "australia"}:
        return True
    if any(token in lower for token in ("apt", "apartment", "suite", "ste", "unit", "po box", "p.o. box")):
        return True
    if _is_valid_name(normalized):
        return True
    if _COUNTRY_RE.match(normalized) and len(normalized.split()) <= 3:
        return True
    return False


def _collect_address_blocks(segments: List[Segment]) -> List[tuple[str, List[Segment]]]:
    blocks: List[tuple[str, List[Segment]]] = []

    for i, seg in enumerate(segments):
        if not _BUYER_LABEL_RE.search(seg.text):
            continue

        source = _label_source(seg.text)
        block: List[Segment] = []
        started = False

        for j in range(i + 1, len(segments)):
            seg_j = segments[j]
            text = seg_j.text.strip()

            if not text:
                if started:
                    break
                continue

            if _is_address_stop(text):
                if started:
                    break
                continue

            if started and block and not _is_addressish_line(text):
                break

            started = True
            block.append(seg_j)

        if block:
            blocks.append((source, block))

    return blocks


def extract_buyer_name(segments: List[Segment]) -> List[Candidate]:
    """Name candidates from the first line of cleaned address blocks."""
    raw_candidates: List[Candidate] = []
    counter = 1

    for source, block in _collect_address_blocks(segments):
        first_seg = block[0]
        text = first_seg.text
        extracted = _extract_contact_name_value(text)
        if not extracted:
            continue
        value, value_len = extracted
        cand = Candidate(
            id=f"name_{counter:04d}",
            field_type="buyer_name",
            value=value,
            raw_text=value,
            start=first_seg.start,
            end=first_seg.start + value_len,
            segment_id=first_seg.id,
            extractor="address_block_first_line",
            source=source,
        )
        _attach_context(cand, first_seg.text, 0, value_len)
        raw_candidates.append(cand)
        counter += 1

    # ── Normalized variants ───────────────────────────────────────────────────
    # Add a Title-Case copy if the raw value differs (e.g. "JANE SMITH" → "Jane Smith").
    existing_values = {c.value for c in raw_candidates}
    for base in list(raw_candidates):
        norm = _normalize_name(base.value)
        if norm != base.value and norm not in existing_values:
            cand = Candidate(
                id=f"name_{counter:04d}",
                field_type="buyer_name",
                value=norm,
                raw_text=base.raw_text,
                start=None,
                end=None,
                segment_id=base.segment_id,
                extractor="normalized_variant",
                source=base.source,
            )
            _attach_context(cand, norm, 0, len(norm))
            raw_candidates.append(cand)
            existing_values.add(norm)
            counter += 1

    # ── Deduplication by (source, normalised value) ───────────────────────────
    # A billing-block name and a shipping-block name are structurally distinct
    # even when the text is identical, so they must survive as separate
    # candidates so scoring can prefer the shipping-source one.
    seen_norm: dict = {}
    candidates: List[Candidate] = []
    for cand in raw_candidates:
        key = (getattr(cand, "source", ""), _normalize_name(cand.value), cand.extractor)
        if key not in seen_norm:
            seen_norm[key] = cand
            candidates.append(cand)

    # ── Debug log ─────────────────────────────────────────────────────────────
    print(
        f"[BUYER_NAME] BUYER_NAME_CANDIDATES {{"
        f" total_candidates: {len(candidates)},"
        f" values: {[c.value for c in candidates]},"
        f" sources: {[c.extractor for c in candidates]} }}",
        file=sys.stderr,
        flush=True,
    )
    if len(candidates) == 1:
        c = candidates[0]
        print(
            f"[BUYER_NAME] single candidate — value={c.value!r}"
            f" extractor={c.extractor} segment_id={c.segment_id}",
            file=sys.stderr,
            flush=True,
        )

    return candidates


def extract_shipping_address(segments: List[Segment]) -> List[Candidate]:
    """Address block candidates under a shipping/billing label.

    Produces a street-forward candidate for all cleaned blocks. When the first
    line looks like a recipient name and the second line looks like a street,
    also produces a full recipient+address variant so downstream scoring can
    prefer the richer block when appropriate.
    """
    candidates: List[Candidate] = []
    counter = 1

    for source, block in _collect_address_blocks(segments):
        if not block:
            continue
        primary_block = block[1:] if len(block) > 1 and _is_valid_name(block[0].text) else block
        if len(block) >= 2 and _is_valid_name(block[0].text) and _STREET_RE.match(block[1].text):
            value = "\n".join(seg.text for seg in block)
            first_seg = block[0]
            last_seg = block[-1]
            cand = Candidate(
                id=f"addr_{counter:04d}",
                field_type="shipping_address",
                value=value,
                raw_text=value,
                start=first_seg.start,
                end=last_seg.end,
                segment_id=first_seg.id,
                # Source-qualified so billing vs shipping produce distinct
                # learning signatures and role-based replay can distinguish them.
                extractor=f"{source}_address_block_with_recipient",
                source=source,
            )
            _attach_context(cand, first_seg.text, 0, len(first_seg.text))
            candidates.append(cand)
            counter += 1

        if not primary_block:
            continue

        value = "\n".join(seg.text for seg in primary_block)
        first_seg = primary_block[0]
        last_seg = primary_block[-1]
        cand = Candidate(
            id=f"addr_{counter:04d}",
            field_type="shipping_address",
            value=value,
            raw_text=value,
            start=first_seg.start,
            end=last_seg.end,
            segment_id=first_seg.id,
            extractor=f"{source}_address_block_street_forward",
            source=source,
        )
        _attach_context(cand, first_seg.text, 0, len(first_seg.text))
        candidates.append(cand)
        counter += 1

    return candidates


def validate_candidates(candidates: List[Candidate], clean_text: str) -> List[Candidate]:
    """Drop any candidate where clean_text[start:end] != value (contract gate).
    Candidates with start=None or end=None pass through — they carry no highlight position.
    """
    valid: List[Candidate] = []
    for c in candidates:
        if c.start is None or c.end is None:
            valid.append(c)
            continue
        if clean_text[c.start:c.end] == c.value:
            valid.append(c)
    return valid


def extract_ship_by_from_body(segments: List[Segment]) -> List[Candidate]:
    candidates: List[Candidate] = []
    counter = 1

    for i, seg in enumerate(segments):
        seg_lower = seg.text.lower()
        if not any(keyword in seg_lower for keyword in _SHIP_BY_KEYWORDS):
            continue

        direct_matches = list(_SHIP_BY_BODY_RE.finditer(seg.text))
        if direct_matches:
            for match in direct_matches:
                value = match.group(1)
                start = match.start(1)
                end = match.end(1)
                cand = Candidate(
                    id=f"ship_by_body_{counter:04d}",
                    field_type="ship_by",
                    value=value,
                    raw_text=value,
                    start=seg.start + start,
                    end=seg.start + end,
                    segment_id=seg.id,
                    extractor="ship_by_body_regex",
                    source="body",
                )
                _attach_context(cand, seg.text, start, end)
                candidates.append(cand)
                counter += 1
            continue

        for nearby in segments[i + 1:i + 3]:
            month_day = _MONTH_DAY_RE.search(nearby.text)
            if not month_day:
                continue

            value = month_day.group(1)
            start = month_day.start(1)
            end = month_day.end(1)
            cand = Candidate(
                id=f"ship_by_body_{counter:04d}",
                field_type="ship_by",
                value=value,
                raw_text=value,
                start=nearby.start + start,
                end=nearby.start + end,
                segment_id=nearby.id,
                extractor="ship_by_body_nearby_regex",
                source="body",
            )
            _attach_context(cand, nearby.text, start, end)
            candidates.append(cand)
            counter += 1
            break

    return candidates
