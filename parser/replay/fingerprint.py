import re
import hashlib


# ── Structural anchors — never replaced by [VAR_BLOCK] ──────────────────────
# These are labels/headings that define the *shape* of an email template.
_STRUCTURAL = frozenset({
    # Order fields
    "quantity", "price", "order number", "order summary", "order details",
    "order total", "item total", "subtotal", "tax", "total", "sales tax",
    # Sections
    "shipping address", "billing address", "payment method",
    "customer note", "notes", "message from buyer",
    # Logistics
    "shipping", "shipping label", "purchase shipping label", "tracking",
    "delivery", "processing time",
    # Item metadata
    "product", "item", "size", "shop",
    # Payment
    "credit card", "debit card", "etsy payments", "payment account",
    # Policy
    "returns & exchanges", "cancellations", "contact page",
    "personalized item", "no returns or exchanges accepted",
    # Misc
    "transaction id", "order placed", "order confirmed",
    # Note: "etsy seller protection" intentionally excluded — it is optional
    # boilerplate that appears in some Etsy emails but not others, so it is
    # handled by _OPTIONAL_BOILERPLATE_RE instead.
})

# ── High-variance line detectors ─────────────────────────────────────────────

# Street address: any line containing a street-type suffix word
_STREET_RE = re.compile(
    r'\b(st|ave|rd|blvd|dr|ln|ct|pl|way|hwy|pkwy|terr?|cir)\b\.?',
    re.IGNORECASE,
)

_FULL_STREET_LINE_RE = re.compile(
    r'^\s*\d+\s+[\w.\-#\s]+?\b('
    r'avenue|road|street|drive|boulevard|lane|court|place'
    r')\b\.?\s*$',
    re.IGNORECASE,
)

# "Cedar City, UT" / "PLANO, TX" / "Cedar City, UT 84720"
# Requires "word+, 2-uppercase-letters" pattern
_CITY_STATE_RE = re.compile(
    r'^[A-Za-z][\w\s]+,\s*[A-Z]{2}(\s+\d{5}(-\d{4})?)?$'
)

# Country name on its own line
_COUNTRY_RE = re.compile(
    r'^(united states|canada|united kingdom|australia|mexico|ireland'
    r'|france|germany|italy|spain|netherlands|belgium|sweden|norway'
    r'|denmark|finland|poland|switzerland|austria)$',
    re.IGNORECASE,
)

# Buyer name: 2–4 words each starting with a capital letter
# e.g. "Alexandra Esfeld", "Jenna Lowry", "Mary Jane Watson"
_NAME_RE = re.compile(r'^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$')

_NAME_WITH_INITIAL_RE = re.compile(
    r'^[A-Z](?:\s+[A-Z][a-z]+){1,3}$|^[A-Z][a-z]+(?:\s+[A-Z])?(?:\s+[A-Z][a-z]+){1,2}$'
)

# Personalization / custom attribute line (label + colon + variable value)
# e.g. "Personalization: Aria", "Pet Name: Shasta", "Heading: Forever Loved"
_CUSTOM_LABEL_RE = re.compile(
    r'^(personalization|personalize|pet name|heading|enter type'
    r'|engraving|inscription|note from buyer|custom note)[:\s]',
    re.IGNORECASE,
)

_BUYER_CONTACT_RE = re.compile(
    r'please contact the buyer directly',
    re.IGNORECASE,
)

_USERNAME_LINE_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{4,}$', re.IGNORECASE)

_BOX_RE = re.compile(r'^\s*(?:po\s+box|box)\s+\d+[a-z0-9-]*\s*$', re.IGNORECASE)
_NUMBER_WORD_LINE_RE = re.compile(
    r'^\s*\d+[a-z]{0,2}\s+[\w#.\-]+(?:\s+[\w#.\-]+){0,6}\s*$',
    re.IGNORECASE,
)

_ITEM_DETAIL_LABEL_RE = re.compile(
    r'^(size|personalization|heading|shop|transaction id|processing time)[:\s]',
    re.IGNORECASE,
)

_ITEM_SECTION_KEEPERS = frozenset({
    "quantity", "price", "personalized item", "processing time",
    "no returns or exchanges accepted", "item total", "order total",
    "shipping", "sales tax", "discount", "subtotal",
})

_TITLEISH_WORDS = frozenset({
    "heart", "rock", "custom", "engraved", "granite", "stone", "memorial",
    "headstone", "gift", "paw", "print", "dog", "cat", "river", "bone",
    "shop", "loss", "pet",
})

# ── Optional boilerplate — present in some emails of the same template, absent
# in others.  These lines must be REMOVED (not replaced) so that emails with
# and without them hash to the same template_id.
_OPTIONAL_BOILERPLATE_RE = re.compile(
    r'paid via etsy payments'
    r'|payments\s+(?:were\s+)?made via etsy payments'
    r'|can be viewed in your payment account'
    r'|payment account'
    r'|etsy gift card balance applied'
    r'|usps\u00ae?\s+verified this address'
    r'|usps\u00ae?\s+could not confirm this address'
    r'|^learn more\.?$'
    r'|^learn$'
    r'|sell with confidence'
    r'|etsy seller protection'
    r'|purchase protection program'
    r'|choose a ddp shipping option'
    r'|double[\s-]check any customs requirements',
    re.IGNORECASE,
)

_EXTRA_IGNORABLE_RE = re.compile(
    r'^questions$'
    r'|^learn about$'
    r'|^send$'
    r'|^send them an email$'
    r'|^\S+\s+send them an email$'
    r'|^them a convo'
    r'|^them an email'
    r'|^if you have any questions about this order'
    r'|^reply to this email if you have any problems with your order'
    r'|^shop policies for this order'
    r'|^terms showing to your buyers'
    r'|^returns & exchanges$'
    r'|^if you were not involved in this transaction'
    r'|^if you live in north america or south america'
    r'|^if you live elsewhere'
    r'|^you are receiving this email because'
    r'|^copyright'
    r'|^\(guest\)$'
    r'|^customs and import taxes$'
    r'|^buyers are responsible for any customs and import taxes'
    r'|^contact the seller if you have any problems with your order'
    r'|^cancellations$'
    r'|^cancellations: accepted'
    r'|^the buyer applied these discounts'
    r'|^for qualifying orders up to'
    r'|^request a cancellation',
    re.IGNORECASE,
)

_TOTAL_BREAKDOWN_RE = re.compile(
    r'^(item total|discount|subtotal|shipping|sales tax|order total):?$'
    r'|^\$[\d.,]+$'
    r'|^-\s*\$[\d.,]+$',
    re.IGNORECASE,
)


def _is_high_variance(line: str) -> bool:
    """Return True if this line contains per-order variable content."""
    stripped = line.strip()
    if not stripped or len(stripped) < 3:
        return False
    lower = stripped.lower()

    # Always keep known structural labels/headings
    if lower in _STRUCTURAL or lower.rstrip(':') in _STRUCTURAL:
        return False

    # Number-leading address fragments (e.g. "219 Claire De Lune", "2333 34th AveS")
    if _NUMBER_WORD_LINE_RE.match(stripped):
        return True

    # Street address line (e.g. "4208 McAlice Dr", "121 N Main")
    if _STREET_RE.search(stripped):
        return True

    # Street address line with full-word suffix (e.g. "40 Lincoln Avenue")
    if _FULL_STREET_LINE_RE.match(stripped):
        return True

    if _BOX_RE.match(stripped):
        return True

    # City/state line (e.g. "PLANO, TX", "Cedar City, UT 84720")
    if _CITY_STATE_RE.match(stripped):
        return True

    # Country on its own line
    if _COUNTRY_RE.match(stripped):
        return True

    # Buyer name: 2–4 title-cased words with no punctuation
    if _NAME_RE.match(stripped):
        return True

    if _NAME_WITH_INITIAL_RE.match(stripped):
        return True

    # Personalization / custom field label + value
    if _CUSTOM_LABEL_RE.match(stripped):
        return True

    # Buyer-contact helper line includes per-order usernames/handles.
    if _BUYER_CONTACT_RE.search(stripped):
        return True

    # Generic buyer handle / username fallback.
    if _USERNAME_LINE_RE.match(stripped) and lower not in _STRUCTURAL and not stripped.isdigit():
        return True

    return False


def _is_ignorable_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    return bool(
        _OPTIONAL_BOILERPLATE_RE.search(stripped)
        or _EXTRA_IGNORABLE_RE.search(stripped)
        or _TOTAL_BREAKDOWN_RE.search(stripped)
    )


def _is_item_detail_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    lower = stripped.lower().rstrip(':')
    if lower in _ITEM_SECTION_KEEPERS:
        return False
    if _ITEM_DETAIL_LABEL_RE.match(stripped):
        return True
    if '|' in stripped:
        return True
    tokens = {token.strip('":,.-').lower() for token in stripped.split()}
    if len(tokens & _TITLEISH_WORDS) >= 2:
        return True
    return False


def normalize_for_template(text: str) -> str:
    # ── Phase 1: Line-level replacement ──────────────────────────────────────
    # Replace per-order variable lines with a fixed placeholder so that
    # two orders from the same source produce the same normalized text.
    # Optional boilerplate lines are removed entirely so their presence or
    # absence does not change the template hash.
    raw_lines = text.splitlines()
    out_lines: list[str] = []
    for idx, line in enumerate(raw_lines):
        stripped = line.strip()
        next_stripped = raw_lines[idx + 1].strip() if idx + 1 < len(raw_lines) else ""

        # Optional boilerplate: remove completely (not even a placeholder)
        if _is_ignorable_line(stripped):
            continue
        if _is_high_variance(line):
            out_lines.append("[VAR_BLOCK]")
        elif _is_item_detail_line(stripped):
            out_lines.append("[ITEM_BLOCK]")
        elif stripped.lower() in _TITLEISH_WORDS and _is_item_detail_line(next_stripped):
            out_lines.append("[ITEM_BLOCK]")
        elif (
            stripped
            and not (_NAME_RE.match(stripped) or _NAME_WITH_INITIAL_RE.match(stripped))
            and len(stripped) >= 20
            and (_is_item_detail_line(next_stripped) or next_stripped.lower().startswith("quantity:"))
        ):
            out_lines.append("[ITEM_BLOCK]")
        else:
            out_lines.append(stripped.lower())

    joined = " ".join(out_lines)

    # ── Phase 2: Token-level cleanup ─────────────────────────────────────────
    # Remove email addresses
    joined = re.sub(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+", "", joined)

    # Remove dates (e.g. "Apr 9, 2026")
    joined = re.sub(
        r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b.*?\d{4}",
        "",
        joined,
    )

    # Remove all remaining digit sequences (order #, price, zip, etc.)
    joined = re.sub(r"\d+", "", joined)

    # Collapse consecutive [var_block] placeholders into one
    joined = re.sub(r"(\[VAR_BLOCK\]\s*)+", "[VAR_BLOCK] ", joined)
    joined = re.sub(r"(\[ITEM_BLOCK\]\s*)+", "[ITEM_BLOCK] ", joined)

    # Address artifacts can leave separator tokens between placeholders.
    joined = re.sub(r"\[VAR_BLOCK\]\s*-\s*\[VAR_BLOCK\]", "[VAR_BLOCK]", joined)
    joined = re.sub(r"\[VAR_BLOCK\]\s*[|/]\s*\[VAR_BLOCK\]", "[VAR_BLOCK]", joined)
    joined = re.sub(r"\[ITEM_BLOCK\]\s*[|/]\s*\[ITEM_BLOCK\]", "[ITEM_BLOCK]", joined)
    joined = re.sub(r"\[VAR_BLOCK\]\s+\[ITEM_BLOCK\]", "[VAR_BLOCK] [ITEM_BLOCK]", joined)
    joined = re.sub(r"\[VAR_BLOCK\]\s+\[ITEM_BLOCK\]", "[ITEM_BLOCK]", joined)

    # Collapse again after artifact cleanup.
    joined = re.sub(r"(\[VAR_BLOCK\]\s*)+", "[VAR_BLOCK] ", joined)
    joined = re.sub(r"(\[ITEM_BLOCK\]\s*)+", "[ITEM_BLOCK] ", joined)

    # Normalize singular/plural item wording in Etsy sale headers.
    joined = re.sub(r"\bitems?\b", "item", joined)
    joined = re.sub(r"\(guest\)", "", joined, flags=re.IGNORECASE)

    # Collapse repeated Etsy item rows so 1-item and 2-item emails share one structural skeleton.
    joined = re.sub(
        r"\[ITEM_BLOCK\](?:\s+\[VAR_BLOCK\]|\s+\[ITEM_BLOCK\]|\s+personalized item|\s+no returns or exchanges accepted)*"
        r"\s+quantity:\s+price:\s+\$\.(?:\s+personalized item|\s+\[ITEM_BLOCK\]|\s+no returns or exchanges accepted)*",
        "[ITEM_BLOCK] quantity: price: $.",
        joined,
    )
    joined = re.sub(
        r"\[ITEM_BLOCK\]\s+quantity:\s+price:\s+\$\.(?:\s+\[VAR_BLOCK\])?",
        "[ITEM_BLOCK] quantity: price: $.",
        joined,
    )
    joined = re.sub(
        r"(?:\s*\[ITEM_BLOCK\]\s+quantity:\s+price:\s+\$\.)+",
        " [ITEM_BLOCK] quantity: price: $.",
        joined,
    )
    joined = re.sub(
        r"quantity:\s+price:\s+\$\.(?:\s+personalized item|\s+\[ITEM_BLOCK\]|\s+no returns or exchanges accepted|\s+\[VAR_BLOCK\])+",
        "quantity: price: $.",
        joined,
    )
    joined = re.sub(
        r"(?:quantity:\s+price:\s+\$\.\s*)+",
        "quantity: price: $. ",
        joined,
    )

    # Normalize whitespace
    joined = re.sub(r"\s+", " ", joined).strip()

    return joined


def compute_template_id(clean_text: str) -> str:
    normalized = normalize_for_template(clean_text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ── Template-family normalization ─────────────────────────────────────────────
# The family ID is intentionally coarser than the strict template ID.
#
# Strategy: for each recognised platform, extract ONLY the stable structural
# section-header labels that appear in every email from that platform,
# regardless of product, item count, personalization, or template version.
# This is far more robust than phrase-matching because it doesn't depend on
# any particular greeting or boilerplate wording.

# ── Etsy structural skeleton ──────────────────────────────────────────────────
# Only include labels that are UNIVERSALLY present in every Etsy order
# confirmation email.  Optional labels (sales_tax, item_total, shipping_label,
# processing_time, personalized_item, etc.) MUST NOT be included here because
# their presence/absence varies per order and causes family ID fragmentation.
#
# The two labels below are the minimum universal set:
#   • "order details" / "order summary" — always present (order section header)
#   • "shipping address"               — always present (delivery section)
#
# This is deliberately narrow.  Woo / other platforms are isolated by the
# _is_etsy() gate that routes them through the non-Etsy block-collapsing path.
_ETSY_SKELETON: list = [
    (re.compile(r'order\s+(?:details|summary)', re.IGNORECASE), 'order_details'),
    (re.compile(r'shipping\s+address',          re.IGNORECASE), 'shipping_address'),
]

# Etsy identifiers — if ANY of these appear in the normalized text, treat the
# email as an Etsy email.  Using multiple signals avoids missing newer templates
# that drop some phrases.
_ETSY_SIGNALS: list = [
    re.compile(r'\betsy\b',                                    re.IGNORECASE),
    re.compile(r'etsy\.com',                                   re.IGNORECASE),
    re.compile(r'etsy\s+(?:sale|order|payment|seller)',        re.IGNORECASE),
]


def _is_etsy(normalized_text: str) -> bool:
    """Return True if *normalized_text* looks like an Etsy email."""
    return any(sig.search(normalized_text) for sig in _ETSY_SIGNALS)


def _build_skeleton(text: str, skeleton: list) -> str:
    """Collect structural labels present in *text*, sorted by position."""
    hits: list = []
    for pattern, label in skeleton:
        m = pattern.search(text)
        if m:
            hits.append((m.start(), label))
    hits.sort(key=lambda h: h[0])
    return " ".join(label for _, label in hits)


def normalize_for_family(clean_text: str) -> str:
    """Aggressively normalise *clean_text* for platform-family grouping.

    For Etsy emails the output is a compact structural skeleton, e.g.:
        "etsy order_details payment_method shipping_address shipping_label ..."

    This is stable across ALL Etsy template variants (any greeting, any product,
    any item count, any personalization section) because it depends only on the
    presence and order of section headers, not on any specific phrasing.

    For non-Etsy platforms the normalization collapses item / var blocks into
    uniform placeholders and strips price / digit artifacts.
    """
    text = normalize_for_template(clean_text)

    # ── Etsy: structural-skeleton extraction ─────────────────────────────────
    if _is_etsy(text):
        skeleton = _build_skeleton(text, _ETSY_SKELETON)
        # Guarantee a stable prefix even when no skeleton label is found.
        return f"etsy {skeleton}" if skeleton else "etsy order_details"

    # ── Non-Etsy: block collapsing ────────────────────────────────────────────

    # Phase A: collapse [ITEM_BLOCK] sequences and surrounding labels.
    for _ in range(4):
        prev = text
        text = re.sub(
            r'\[ITEM_BLOCK\]'
            r'(?:\s+(?:\[ITEM_BLOCK\]|\[VAR_BLOCK\]|quantity:|price:|\$\.'
            r'|personalized item|no returns or exchanges accepted))*',
            '[ITEM_ROW]',
            text,
            flags=re.IGNORECASE,
        )
        text = re.sub(r'(\[ITEM_ROW\]\s*)+', '[ITEM_ROW] ', text)
        if text == prev:
            break

    # Phase B: collapse remaining [VAR_BLOCK] groups.
    text = re.sub(r'(\[VAR_BLOCK\]\s*)+', '[VAR_ROW] ', text)

    # Phase C: strip residual price / digit artifacts.
    text = re.sub(r'\$[.,\d]*\.?', '', text)
    text = re.sub(r'\b\d+\b', '', text)

    # Phase D: final whitespace normalisation.
    text = re.sub(r'\s+', ' ', text).strip()

    return text


def compute_template_family_id(clean_text: str) -> str:
    """Return an SHA-256 hex digest of the family-normalised form of *clean_text*.

    Use this key for learning, confidence, and replay storage.
    Use compute_template_id for strict per-variant matching only.
    """
    normalized = normalize_for_family(clean_text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
