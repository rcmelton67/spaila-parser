from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


MANIFEST_VERSION = "1"
SUPPORTED_TIERS = {"smoke", "core", "mutation", "drift", "load", "cert"}


@dataclass(frozen=True)
class CertificationCase:
    case_id: str
    category: str
    tier: str
    seed: int
    input: dict[str, Any]
    expected: dict[str, str] = field(default_factory=dict)
    forbidden: dict[str, list[str]] = field(default_factory=dict)
    repetitions: int = 1
    update_confidence: bool = False
    trust_expectations: dict[str, Any] = field(default_factory=dict)
    notes: str = ""


@dataclass(frozen=True)
class CertificationManifest:
    manifest_id: str
    manifest_version: str
    cases: list[CertificationCase]
    source_path: Path | None = None


def _require_string(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _require_dict(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def parse_manifest(data: dict[str, Any], source_path: Path | None = None) -> CertificationManifest:
    manifest_id = _require_string(data.get("manifest_id"), "manifest_id")
    manifest_version = _require_string(data.get("manifest_version", MANIFEST_VERSION), "manifest_version")
    if manifest_version != MANIFEST_VERSION:
        raise ValueError(
            f"Unsupported manifest_version={manifest_version!r}; expected {MANIFEST_VERSION!r}"
        )
    raw_cases = data.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        raise ValueError("cases must be a non-empty array")

    cases: list[CertificationCase] = []
    seen: set[str] = set()
    for index, raw_case in enumerate(raw_cases):
        raw_case = _require_dict(raw_case, f"cases[{index}]")
        case_id = _require_string(raw_case.get("case_id"), f"cases[{index}].case_id")
        if case_id in seen:
            raise ValueError(f"duplicate case_id={case_id!r}")
        seen.add(case_id)

        tier = _require_string(raw_case.get("tier", "smoke"), f"{case_id}.tier")
        if tier not in SUPPORTED_TIERS:
            raise ValueError(f"{case_id}.tier must be one of {sorted(SUPPORTED_TIERS)}")

        repetitions = int(raw_case.get("repetitions", 1))
        if repetitions < 1:
            raise ValueError(f"{case_id}.repetitions must be >= 1")

        cases.append(
            CertificationCase(
                case_id=case_id,
                category=_require_string(raw_case.get("category"), f"{case_id}.category"),
                tier=tier,
                seed=int(raw_case.get("seed", index + 1)),
                input=_require_dict(raw_case.get("input", {}), f"{case_id}.input"),
                expected={str(k): str(v) for k, v in raw_case.get("expected", {}).items()},
                forbidden={
                    str(k): [str(item) for item in values]
                    for k, values in raw_case.get("forbidden", {}).items()
                },
                repetitions=repetitions,
                update_confidence=bool(raw_case.get("update_confidence", False)),
                trust_expectations=_require_dict(
                    raw_case.get("trust_expectations", {}), f"{case_id}.trust_expectations"
                ),
                notes=str(raw_case.get("notes", "")),
            )
        )

    return CertificationManifest(
        manifest_id=manifest_id,
        manifest_version=manifest_version,
        cases=cases,
        source_path=source_path,
    )


def load_manifest(path: str | Path) -> CertificationManifest:
    manifest_path = Path(path)
    with manifest_path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return parse_manifest(data, manifest_path)

