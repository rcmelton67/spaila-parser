from dataclasses import dataclass, field
from typing import List, Dict, Optional


@dataclass
class Segment:
    id: str
    text: str
    start: int
    end: int
    line_index: int


@dataclass
class Candidate:
    id: str
    field_type: str
    value: str
    raw_text: str
    start: Optional[int]
    end: Optional[int]
    segment_id: str
    extractor: str
    base_confidence: float = 0.0
    signals: List[str] = field(default_factory=list)
    penalties: List[str] = field(default_factory=list)
    score: float = 0.0
    segment_text: str = ""
    left_context: str = ""
    right_context: str = ""
    anchor_match: float = 0.0
    source: str = ""


@dataclass
class DecisionRow:
    field: str
    value: str
    decision: str
    decision_source: str
    candidate_id: str
    start: Optional[int]
    end: Optional[int]
    confidence: float
    provenance: Dict
