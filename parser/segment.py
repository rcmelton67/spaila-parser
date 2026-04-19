from typing import List
from .models import Segment


def segment(clean_text: str) -> List[Segment]:
    segments: List[Segment] = []
    offset = 0

    for line_index, line in enumerate(clean_text.splitlines()):
        seg_id = f"seg_{len(segments) + 1:04d}"
        start = offset
        end = offset + len(line)
        segments.append(Segment(
            id=seg_id,
            text=line,
            start=start,
            end=end,
            line_index=line_index,
        ))
        offset = end + 1  # +1 for the newline character

    return segments
