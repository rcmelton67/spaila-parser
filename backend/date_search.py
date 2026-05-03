from __future__ import annotations

import re
from typing import Iterable

MONTHS = [
    ("jan", "january"),
    ("feb", "february"),
    ("mar", "march"),
    ("apr", "april"),
    ("may", "may"),
    ("jun", "june"),
    ("jul", "july"),
    ("aug", "august"),
    ("sep", "september"),
    ("oct", "october"),
    ("nov", "november"),
    ("dec", "december"),
]

MONTH_LOOKUP = {
    name: index + 1
    for index, pair in enumerate(MONTHS)
    for name in pair
}


def normalize_search_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _valid_parts(month: int, day: int, year: int | None = None) -> bool:
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return False
    return year is None or 1000 <= year <= 9999


def parse_date_search_parts(value: object) -> dict[str, int] | None:
    text = normalize_search_text(value).replace(",", "")
    if not text:
        return None

    match = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:t.*)?$", text)
    if match:
        year, month, day = (int(match.group(i)) for i in (1, 2, 3))
        return {"year": year, "month": month, "day": day} if _valid_parts(month, day, year) else None

    match = re.match(r"^(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?$", text)
    if match:
        month = int(match.group(1))
        day = int(match.group(2))
        year = int(match.group(3)) if match.group(3) else None
        if year is not None and year < 100:
            year += 2000
        return {"year": year, "month": month, "day": day} if _valid_parts(month, day, year) else None

    match = re.match(r"^([a-z]+)\.?\s+(\d{1,2})(?:\s+(\d{2,4}))?$", text)
    if match:
        raw_month = match.group(1)
        month = MONTH_LOOKUP.get(raw_month[:3]) or MONTH_LOOKUP.get(raw_month)
        day = int(match.group(2))
        year = int(match.group(3)) if match.group(3) else None
        if year is not None and year < 100:
            year += 2000
        return {"year": year, "month": month, "day": day} if month and _valid_parts(month, day, year) else None

    return None


def build_date_search_aliases(value: object) -> list[str]:
    parts = value if isinstance(value, dict) else parse_date_search_parts(value)
    if not parts:
        return []

    month = int(parts["month"])
    day = int(parts["day"])
    year = parts.get("year")
    mm = f"{month:02d}"
    dd = f"{day:02d}"
    short_name, full_name = MONTHS[month - 1]
    aliases = {
        f"{month}/{day}",
        f"{mm}/{dd}",
        f"{month}/{dd}",
        f"{mm}/{day}",
        f"{short_name} {day}",
        f"{short_name} {dd}",
        f"{full_name} {day}",
        f"{full_name} {dd}",
    }

    if year:
        aliases.update({
            f"{year}-{mm}-{dd}",
            f"{month}/{day}/{year}",
            f"{mm}/{dd}/{year}",
            f"{short_name} {day} {year}",
            f"{full_name} {day} {year}",
        })

    return [normalize_search_text(alias) for alias in aliases]


def expand_search_value_aliases(value: object) -> list[str]:
    normalized = normalize_search_text(value)
    aliases = {normalized} if normalized else set()
    aliases.update(build_date_search_aliases(value))
    return [alias for alias in aliases if alias]


def normalized_search_matches(query: object, values: Iterable[object], mode: str = "smart") -> bool:
    needle = normalize_search_text(query)
    if not needle:
        return True

    expanded_values = [
        alias
        for value in values
        for alias in expand_search_value_aliases(value)
    ]
    if not expanded_values:
        return False

    query_date_aliases = build_date_search_aliases(needle)
    if query_date_aliases:
        return any(alias in expanded_values for alias in query_date_aliases)

    if mode == "exact":
        return any(value == needle for value in expanded_values)

    haystack = " ".join(expanded_values)
    return all(term in haystack for term in needle.split() if term)

