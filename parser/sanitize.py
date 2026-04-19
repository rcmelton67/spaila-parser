import re
from html.parser import HTMLParser
from typing import Optional, Dict


class _StripHTMLParser(HTMLParser):
    SKIP_TAGS = {"script", "style"}

    def __init__(self) -> None:
        super().__init__()
        self._parts: list[str] = []
        self._skip = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self.SKIP_TAGS:
            self._skip = True
            return
        if tag == "a" and not self._skip:
            attrs_dict = dict(attrs)
            href = attrs_dict.get("href", "")
            if href.lower().startswith("mailto:"):
                email = href[len("mailto:"):]
                if email:
                    self._parts.append(f" {email} ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP_TAGS:
            self._skip = False

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self._parts.append(data)

    def get_text(self) -> str:
        return "".join(self._parts)


def _strip_html(raw_html: str) -> str:
    parser = _StripHTMLParser()
    parser.feed(raw_html)
    return parser.get_text()


def _normalize(text: str) -> str:
    lines = text.splitlines()
    normalized = []
    for line in lines:
        line = re.sub(r"[ \t]+", " ", line).strip()
        normalized.append(line)
    text = "\n".join(normalized)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def sanitize(ingested: Dict) -> str:
    html: Optional[str] = ingested.get("html")
    plain: Optional[str] = ingested.get("plain")

    if html:
        text = _strip_html(html)
    elif plain:
        text = plain
    else:
        text = ""

    return _normalize(text)
