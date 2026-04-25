import re
import sys
from html.parser import HTMLParser
from typing import Optional, Dict


class _StructureHTMLParser(HTMLParser):
    SKIP_TAGS = {"script", "style"}
    BLOCK_TAGS = {
        "address", "article", "aside", "blockquote", "div", "dl", "dt", "dd",
        "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
        "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
        "section", "table", "tbody", "tfoot", "thead", "tr", "ul",
    }
    LINEBREAK_TAGS = {"br"}
    LIST_ITEM_TAGS = {"li"}
    CELL_TAGS = {"td", "th"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []
        self._skip_depth = 0

    def _last_char(self) -> str:
        if not self._parts:
            return ""
        return self._parts[-1][-1:] if self._parts[-1] else ""

    def _append(self, value: str) -> None:
        if value:
            self._parts.append(value)

    def _ensure_newline(self, count: int = 1) -> None:
        if self._skip_depth:
            return
        existing = 0
        for part in reversed(self._parts):
            if not part:
                continue
            match = re.search(r"\n+$", part)
            if match:
                existing += len(match.group(0))
                continue
            break
        needed = max(0, count - existing)
        if needed:
            self._parts.append("\n" * needed)

    def _append_text(self, data: str) -> None:
        if self._skip_depth:
            return
        text = data.replace("\xa0", " ").replace("\r", " ").replace("\n", " ")
        if not text.strip():
            return
        if self._parts:
            last = self._last_char()
            first = text[:1]
            if last and last not in {" ", "\n", "\t"} and first and first not in {" ", "\n", "\t"}:
                self._parts.append(" ")
        self._parts.append(text)

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
            return
        if tag in self.LINEBREAK_TAGS:
            self._ensure_newline(1)
        elif tag in self.LIST_ITEM_TAGS:
            self._ensure_newline(1)
        elif tag in self.BLOCK_TAGS:
            self._ensure_newline(1)
        elif tag in self.CELL_TAGS:
            if self._parts and self._last_char() not in {"", " ", "\n", "\t"}:
                self._append(" ")
        if tag == "a" and not self._skip_depth:
            attrs_dict = dict(attrs)
            href = attrs_dict.get("href", "")
            if href.lower().startswith("mailto:"):
                email = href[len("mailto:"):]
                if email:
                    self._append_text(f" {email} ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag in self.LINEBREAK_TAGS | self.LIST_ITEM_TAGS | self.BLOCK_TAGS:
            self._ensure_newline(1)

    def handle_data(self, data: str) -> None:
        self._append_text(data)

    def get_text(self) -> str:
        return "".join(self._parts)


def _strip_html(raw_html: str) -> str:
    parser = _StructureHTMLParser()
    parser.feed(raw_html)
    parser.close()
    return parser.get_text()


def _normalize(text: str) -> str:
    text = text.replace("\xa0", " ").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()
    normalized = []
    for line in lines:
        line = re.sub(r"[ \t]+", " ", line).strip()
        normalized.append(line)
    text = "\n".join(normalized)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def sanitize(ingested: Dict) -> str:
    html: Optional[str] = ingested.get("html")
    plain: Optional[str] = ingested.get("plain")

    if html:
        text = _strip_html(html)
        source = "html"
    elif plain:
        text = plain
        source = "plain"
    else:
        text = ""
        source = "none"

    normalized = _normalize(text)
    print(
        f"[HTML_NORMALIZED_PREVIEW] source={source} preview={normalized[:500]!r}",
        file=sys.stderr,
        flush=True,
    )
    return normalized
