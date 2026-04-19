import os
import pytest
from parser.pipeline import parse_eml


SAMPLE_EML = os.path.join(os.path.dirname(__file__), "samples", "basic.eml")


@pytest.fixture(scope="module")
def sample_eml(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("samples")
    eml_path = tmp / "basic.eml"
    eml_path.write_text(
        "From: sender@example.com\n"
        "To: buyer@example.com\n"
        "Subject: Your order\n"
        "MIME-Version: 1.0\n"
        "Content-Type: text/plain\n\n"
        "Quantity: 5\n"
        "Order total: $99.99\n",
        encoding="utf-8",
    )
    return str(eml_path)


def test_pipeline_returns_list(sample_eml):
    result = parse_eml(sample_eml)
    assert isinstance(result["decisions"], list)


def test_pipeline_decision_has_correct_field(sample_eml):
    result = parse_eml(sample_eml)
    decisions = result["decisions"]
    assert len(decisions) > 0
    assert decisions[0].field == "quantity"


def test_pipeline_confidence_valid(sample_eml):
    result = parse_eml(sample_eml)
    decisions = result["decisions"]
    assert len(decisions) > 0
    assert 0.0 <= decisions[0].confidence <= 1.0


def test_pipeline_provenance_keys(sample_eml):
    result = parse_eml(sample_eml)
    decisions = result["decisions"]
    assert len(decisions) > 0
    prov = decisions[0].provenance
    assert "segment_id" in prov
    assert "snippet" in prov
    assert "signals" in prov
