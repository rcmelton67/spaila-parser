import re
import sys
from typing import List, Optional
from .models import Candidate, Segment

_NUMBER_RE = re.compile(r"\b\d+(?:[.,]\d+)?\b")

_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]+")
_SHIP_BY_SUBJECT_RE = re.compile(r"Ship by ([A-Za-z]{3,9} \d{1,2})", re.IGNORECASE)
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
_STREET_RE = re.compile(r"^\d[\d\-]*\s+\S")


def _label_source(text: str) -> str:
    return "billing" if "billing" in text.lower() else "shipping"


def _is_valid_name(text: str) -> bool:
    return bool(_NAME_RE.match(text) and " " in text and len(text) >= 4)


def _normalize_name(value: str) -> str:
    """Collapse whitespace and apply Title Case."""
    return re.sub(r"\s+", " ", value).strip().title()


def extract_buyer_name(segments: List[Segment]) -> List[Candidate]:
    """Name candidates from all shipping/address label variants.

    Sources (in order of priority):
      1. address_label_name   — first valid name line after the label
      2. address_label_next   — fallback next line when the immediate first
                                line is empty or not a valid name
      3. normalized_variant   — Title-Case normalised copy of a raw candidate
                                when it differs from the original

    Candidates are deduplicated by normalised value before return;
    the first occurrence (highest positional priority) wins.
    """
    seen_seg_ids: set = set()
    raw_candidates: List[Candidate] = []
    counter = 1

    for i, seg in enumerate(segments):
        if not _BUYER_LABEL_RE.search(seg.text):
            continue
        source = _label_source(seg.text)

        first_name_found = False
        for j in range(i + 1, min(i + 6, len(segments))):
            seg_j = segments[j]
            text = seg_j.text

            if not text:
                continue
            if seg_j.id in seen_seg_ids:
                continue

            # Skip obvious street / address lines — they are not names.
            if _STREET_RE.match(text):
                break

            if _is_valid_name(text):
                extractor = "address_label_name" if not first_name_found else "address_label_next"
                cand = Candidate(
                    id=f"name_{counter:04d}",
                    field_type="buyer_name",
                    value=text,
                    raw_text=text,
                    start=seg_j.start,
                    end=seg_j.end,
                    segment_id=seg_j.id,
                    extractor=extractor,
                    source=source,
                )
                _attach_context(cand, seg_j.text, 0, len(text))
                raw_candidates.append(cand)
                seen_seg_ids.add(seg_j.id)
                counter += 1

                if not first_name_found:
                    first_name_found = True
                    # Only look one extra line for "address_label_next" variant;
                    # stop after two name candidates per label block.
                else:
                    break
            elif first_name_found:
                # Hit a non-name line after the first name → stop this block.
                break

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
                start=base.start,
                end=base.end,
                segment_id=base.segment_id,
                extractor="normalized_variant",
                source=base.source,
            )
            _attach_context(cand, norm, 0, len(norm))
            raw_candidates.append(cand)
            existing_values.add(norm)
            counter += 1

    # ── Deduplication by normalised value ─────────────────────────────────────
    seen_norm: dict = {}
    candidates: List[Candidate] = []
    for cand in raw_candidates:
        key = _normalize_name(cand.value)
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
    """Full address block (all lines after buyer name) under a 'Shipping address' label.

    Collects every consecutive non-empty line after the name line until the first
    blank line.  The value is the multi-line block joined with '\\n', and the
    offsets span from the first collected segment to the last — satisfying
    clean_text[start:end] == value because adjacent segments are separated by
    exactly one newline character.
    """
    candidates: List[Candidate] = []
    counter = 1

    for i, seg in enumerate(segments):
        if "shipping address" not in seg.text.lower():
            continue

        # Find the buyer-name line (first non-empty segment after the label)
        name_idx = None
        for j in range(i + 1, min(i + 5, len(segments))):
            if segments[j].text:
                name_idx = j
                break
        if name_idx is None:
            continue

        # Collect address lines (everything after the name until a blank line)
        addr_segs: List[Segment] = []
        for k in range(name_idx + 1, len(segments)):
            if not segments[k].text:
                break
            addr_segs.append(segments[k])

        if not addr_segs:
            continue

        # Build value from the exact text of each segment joined with a newline.
        # Because offset = end + 1 in the segmenter, clean_text[first.start:last.end]
        # equals '\n'.join(s.text for s in addr_segs) — guaranteed by construction.
        value = "\n".join(s.text for s in addr_segs)
        first_seg = addr_segs[0]
        last_seg = addr_segs[-1]

        cand = Candidate(
            id=f"addr_{counter:04d}",
            field_type="shipping_address",
            value=value,
            raw_text=value,
            start=first_seg.start,
            end=last_seg.end,
            segment_id=first_seg.id,
            extractor="address_label_block",
            source="shipping",
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
