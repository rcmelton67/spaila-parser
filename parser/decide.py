from typing import List, Optional
from .models import Candidate, DecisionRow

ANCHOR_FORCE_THRESHOLD = 0.85
ANCHOR_BOOST_THRESHOLD = 0.5
ANCHOR_BOOST_VALUE = 5.0
ORDER_DATE_PRIMARY_THRESHOLD = 0.8


def _apply_anchor_boost(candidates: List[Candidate]) -> None:
    for c in candidates:
        match = getattr(c, "anchor_match", 0.0)
        if match >= ANCHOR_FORCE_THRESHOLD:
            c.score = 999
            c.signals.append("anchor_override(+∞)")
        elif match >= ANCHOR_BOOST_THRESHOLD:
            c.score += ANCHOR_BOOST_VALUE


def _decision_label(candidate: Candidate) -> str:
    # "assigned" only when the decision is span-authoritative (learning store
    # injection) or the structural anchor match is overwhelmingly strong.
    # Value repetition boost (assigned_value signal) assists scoring but is
    # NOT sufficient alone to declare an assignment — that would be greedy.
    if (
        getattr(candidate, "source", "") in {
            "learned",
            "structural_trust_replay",
            "price_structural_trust_replay",
            "shipping_address_structural_trust_replay",
            "buyer_name_structural_trust_replay",
            "quantity_structural_trust_replay",
            "ship_by_structural_trust_replay",
            "order_date_structural_trust_replay",
            "buyer_email_structural_trust_replay",
        }
        or getattr(candidate, "anchor_match", 0.0) >= ANCHOR_FORCE_THRESHOLD
    ):
        return "assigned"
    return "suggested"


def _pick_best(candidates: List[Candidate], field: str, scale: float) -> Optional[DecisionRow]:
    valid = [c for c in candidates if c.score > 0]
    if not valid:
        return None
    best = sorted(valid, key=lambda c: (-c.score, c.start if c.start is not None else 0))[0]
    provenance = {
        "segment_id": best.segment_id,
        "snippet": best.raw_text,
        "signals": best.signals + best.penalties,
    }
    provenance.update(getattr(best, "provenance_extra", {}) or {})
    return DecisionRow(
        field=field,
        value=best.value,
        decision=_decision_label(best),
        decision_source=best.source if best.source in {
            "structural_trust_replay",
            "price_structural_trust_replay",
            "shipping_address_structural_trust_replay",
            "buyer_name_structural_trust_replay",
            "quantity_structural_trust_replay",
            "ship_by_structural_trust_replay",
            "order_date_structural_trust_replay",
            "buyer_email_structural_trust_replay",
        } else "score",
        candidate_id=best.id,
        start=best.start,
        end=best.end,
        confidence=min(1.0, best.score / scale),
        provenance=provenance,
    )


def decide_quantity(candidates: List[Candidate]) -> Optional[DecisionRow]:
    _apply_anchor_boost(candidates)
    return _pick_best(candidates, field="quantity", scale=5.0)


def decide_price(candidates: List[Candidate]) -> Optional[DecisionRow]:
    _apply_anchor_boost(candidates)
    return _pick_best(candidates, field="price", scale=8.0)


def decide_order_number(candidates: List[Candidate]) -> Optional[DecisionRow]:
    _apply_anchor_boost(candidates)
    return _pick_best(candidates, field="order_number", scale=10.0)


def decide_order_date(candidates: List[Candidate]) -> Optional[DecisionRow]:
    _apply_anchor_boost(candidates)
    replay_sources = {"order_date_structural_trust_replay", "structural_trust_replay"}
    non_header = [c for c in candidates if c.score > 0 and getattr(c, "source", "") != "header"]
    if non_header:
        best_primary = sorted(non_header, key=lambda c: (-c.score, c.start if c.start is not None else 0))[0]
        confidence = min(1.0, best_primary.score / 10.0)
        if confidence >= ORDER_DATE_PRIMARY_THRESHOLD:
            provenance = {
                "segment_id": best_primary.segment_id,
                "snippet": best_primary.raw_text,
                "signals": best_primary.signals + best_primary.penalties,
            }
            provenance.update(getattr(best_primary, "provenance_extra", {}) or {})
            return DecisionRow(
                field="order_date",
                value=best_primary.value,
                decision=_decision_label(best_primary),
                decision_source=best_primary.source if best_primary.source in replay_sources else "score",
                candidate_id=best_primary.id,
                start=best_primary.start,
                end=best_primary.end,
                confidence=confidence,
                provenance=provenance,
            )

    header_candidates = [c for c in candidates if c.score > 0 and getattr(c, "source", "") == "header"]
    if header_candidates:
        header_best = sorted(header_candidates, key=lambda c: (-c.score, c.start if c.start is not None else 0))[0]
        fallback_signals = header_best.signals + ["header_fallback(+2.0)"]
        provenance = {
            "segment_id": header_best.segment_id,
            "snippet": header_best.raw_text,
            "signals": fallback_signals + header_best.penalties,
        }
        provenance.update(getattr(header_best, "provenance_extra", {}) or {})
        return DecisionRow(
            field="order_date",
            value=header_best.value,
            decision=_decision_label(header_best),
            decision_source=header_best.source if header_best.source in replay_sources else "score",
            candidate_id=header_best.id,
            start=header_best.start,
            end=header_best.end,
            confidence=min(1.0, header_best.score / 10.0),
            provenance=provenance,
        )

    return _pick_best(candidates, field="order_date", scale=10.0)


def decide_buyer_email(candidates: List[Candidate]) -> Optional[DecisionRow]:
    _apply_anchor_boost(candidates)
    return _pick_best(candidates, field="buyer_email", scale=6.5)


def decide_ship_by(candidates: List[Candidate]) -> Optional[DecisionRow]:
    _apply_anchor_boost(candidates)
    return _pick_best(candidates, field="ship_by", scale=8.0)


def decide_buyer_name(candidates: List[Candidate]) -> Optional[DecisionRow]:
    _apply_anchor_boost(candidates)
    return _pick_best(candidates, field="buyer_name", scale=8.0)


def decide_shipping_address(candidates: List[Candidate]) -> Optional[DecisionRow]:
    _apply_anchor_boost(candidates)
    return _pick_best(candidates, field="shipping_address", scale=7.0)
