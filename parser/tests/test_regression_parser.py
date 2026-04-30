import json
import os

from parser.pipeline import parse_eml


def load_expected(path):
    with open(path, "r") as f:
        data = json.load(f)
    return {item["field"]: item["value"] for item in data}


def run_case(eml_path, expected_path):
    decisions = parse_eml(eml_path, update_confidence=False)["decisions"]

    result = {d.field: d.value for d in decisions}
    expected = load_expected(expected_path)

    assert result == expected, f"""
Mismatch for {eml_path}

Expected:
{expected}

Got:
{result}
"""


def test_woo_2353():
    run_case(
        "tests/samples/2353.eml",
        "tests/samples/2353.expected.json"
    )


def test_etsy_4024391570():
    run_case(
        "tests/samples/4024391570.eml",
        "tests/samples/4024391570.expected.json"
    )
