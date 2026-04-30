import os
import json
import pytest
from parser import pipeline
from parser.learning import confidence_store
from parser.learning import store as learning_store
from parser.pipeline import parse_eml
from parser.ui_bridge import _serialize_result


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
    result = parse_eml(sample_eml, update_confidence=False)
    assert isinstance(result["decisions"], list)


def test_pipeline_decision_has_correct_field(sample_eml):
    result = parse_eml(sample_eml, update_confidence=False)
    decisions = result["decisions"]
    assert len(decisions) > 0
    assert decisions[0].field == "quantity"


def test_pipeline_confidence_valid(sample_eml):
    result = parse_eml(sample_eml, update_confidence=False)
    decisions = result["decisions"]
    assert len(decisions) > 0
    assert 0.0 <= decisions[0].confidence <= 1.0


def test_pipeline_provenance_keys(sample_eml):
    result = parse_eml(sample_eml, update_confidence=False)
    decisions = result["decisions"]
    assert len(decisions) > 0
    prov = decisions[0].provenance
    assert "segment_id" in prov
    assert "snippet" in prov
    assert "signals" in prov


def test_parser_trust_report_schema_and_artifact(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "TRUST_REPORT_DIR", tmp_path / "trust_reports")
    monkeypatch.setattr(learning_store, "STORE_PATH", str(tmp_path / "learning_store.json"))
    monkeypatch.setattr(confidence_store, "CONFIDENCE_STORE_PATH", str(tmp_path / "confidence_store.json"))
    eml_path = tmp_path / "trust-report.eml"
    eml_path.write_text(
        "From: sender@example.com\n"
        "To: buyer@example.com\n"
        "Subject: Your order\n"
        "MIME-Version: 1.0\n"
        "Content-Type: text/plain\n\n"
        "Order #12345\n"
        "Quantity: 2\n"
        "Order date: Apr 10, 2026\n"
        "Ship by: Apr 17\n"
        "Customer email: buyer@example.com\n"
        "Ship to:\nJane Buyer\n123 Main St\nAustin, TX 78701\n"
        "Price: $99.99\n",
        encoding="utf-8",
    )

    result = parse_eml(str(eml_path), update_confidence=False)
    report = result["trust_report"]
    fields = report["fields"]
    decisions = {decision.field: decision for decision in result["decisions"]}

    assert report["schema_version"] == 1
    assert report["parse_run_id"]
    assert report["learning_confidence_updated"] is False
    assert set(fields) == {
        "order_number",
        "item_price",
        "shipping_address",
        "buyer_name",
        "quantity",
        "ship_by",
        "buyer_email",
        "order_date",
    }
    assert fields["order_number"]["final_value"] == decisions["order_number"].value
    assert fields["item_price"]["final_value"] == decisions["price"].value
    assert fields["order_number"]["field_version"] == "parser_trust_field_v1"
    assert fields["order_number"]["family_trust_scope"]["scope"] == "template_family"
    assert fields["order_number"]["unlearn_status"]["status"] in {"active", "rejected"}
    assert isinstance(fields["order_number"]["competing_candidates"], list)
    assert fields["order_number"]["learning"]["confidence_updated"] is False
    assert fields["buyer_name"]["decision"] in {"assigned", "suggested", "missing"}

    artifact_path = report["artifact_path"]
    assert artifact_path
    with open(artifact_path, encoding="utf-8") as file:
        artifact = json.load(file)
    assert artifact["parse_run_id"] == report["parse_run_id"]
    assert artifact["artifact_path"] == artifact_path


def test_parser_trust_report_update_flag_and_bridge_serialization(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "TRUST_REPORT_DIR", tmp_path / "trust_reports")
    monkeypatch.setattr(learning_store, "STORE_PATH", str(tmp_path / "learning_store.json"))
    monkeypatch.setattr(confidence_store, "CONFIDENCE_STORE_PATH", str(tmp_path / "confidence_store.json"))
    eml_path = tmp_path / "trust-report-update.eml"
    eml_path.write_text(
        "From: sender@example.com\n"
        "To: buyer@example.com\n"
        "Subject: Your order\n"
        "MIME-Version: 1.0\n"
        "Content-Type: text/plain\n\n"
        "Order #98765\n"
        "Quantity: 1\n"
        "Order date: Apr 11, 2026\n"
        "Price: $25.00\n",
        encoding="utf-8",
    )

    result = parse_eml(str(eml_path), update_confidence=True)
    report = result["trust_report"]
    serialized = _serialize_result(result)

    assert report["learning_confidence_updated"] is True
    assert report["fields"]["order_date"]["learning"]["confidence_updated"] is True
    assert serialized["trust_report"]["parse_run_id"] == report["parse_run_id"]
    assert serialized["trust_report"]["fields"]["order_date"]["final_value"] == report["fields"]["order_date"]["final_value"]


def test_parser_trust_report_artifact_failure_does_not_break_parse(tmp_path, monkeypatch):
    blocked_path = tmp_path / "not-a-directory"
    blocked_path.write_text("blocks mkdir", encoding="utf-8")
    monkeypatch.setattr(pipeline, "TRUST_REPORT_DIR", blocked_path)
    monkeypatch.setattr(learning_store, "STORE_PATH", str(tmp_path / "learning_store.json"))
    monkeypatch.setattr(confidence_store, "CONFIDENCE_STORE_PATH", str(tmp_path / "confidence_store.json"))
    eml_path = tmp_path / "trust-report-artifact-failure.eml"
    eml_path.write_text(
        "From: sender@example.com\n"
        "To: buyer@example.com\n"
        "Subject: Your order\n"
        "MIME-Version: 1.0\n"
        "Content-Type: text/plain\n\n"
        "Order #11111\n"
        "Quantity: 1\n"
        "Price: $25.00\n",
        encoding="utf-8",
    )

    result = parse_eml(str(eml_path), update_confidence=False)

    assert result["trust_report"]["parse_run_id"]
    assert result["trust_report"]["artifact_path"] == ""


def test_parser_trust_report_builder_failure_does_not_break_parse(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, "TRUST_REPORT_DIR", tmp_path / "trust_reports")
    monkeypatch.setattr(learning_store, "STORE_PATH", str(tmp_path / "learning_store.json"))
    monkeypatch.setattr(confidence_store, "CONFIDENCE_STORE_PATH", str(tmp_path / "confidence_store.json"))
    monkeypatch.setattr(
        pipeline,
        "_build_field_trust_report",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("forced report failure")),
    )
    eml_path = tmp_path / "trust-report-builder-failure.eml"
    eml_path.write_text(
        "From: sender@example.com\n"
        "To: buyer@example.com\n"
        "Subject: Your order\n"
        "MIME-Version: 1.0\n"
        "Content-Type: text/plain\n\n"
        "Order #22222\n"
        "Quantity: 1\n"
        "Price: $25.00\n",
        encoding="utf-8",
    )

    result = parse_eml(str(eml_path), update_confidence=False)

    assert result["decisions"]
    assert result["trust_report"]["parse_run_id"]
    assert result["trust_report"]["error"] == "forced report failure"
