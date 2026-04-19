from parser.sanitize import sanitize


def test_sanitize_plain_returns_string():
    result = sanitize({"plain": "Hello world", "html": None})
    assert isinstance(result, str)
    assert "Hello world" in result


def test_sanitize_html_strips_tags():
    result = sanitize({"plain": None, "html": "<p>Hello <b>world</b></p>"})
    assert isinstance(result, str)
    assert "<p>" not in result
    assert "Hello" in result


def test_sanitize_removes_script():
    result = sanitize({"plain": None, "html": "<script>alert(1)</script><p>Keep this</p>"})
    assert "alert" not in result
    assert "Keep this" in result


def test_sanitize_collapses_spaces():
    result = sanitize({"plain": "Hello    world", "html": None})
    assert "  " not in result


def test_sanitize_empty_returns_string():
    result = sanitize({"plain": None, "html": None})
    assert isinstance(result, str)
    assert result == ""
