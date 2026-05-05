import base64

import pytest
from fastapi import HTTPException

from backend.api.routes import account
from backend.db import init_db


PDF_BYTES = b"%PDF-1.4\n% test pdf\n"


def setup_db(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    init_db()


def test_documents_config_defaults_and_patch(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)

    defaults = account.get_documents_config()
    assert defaults["show_gift_print_icon"] is True
    assert defaults["gift_text_x"] == 72

    saved = account.update_documents_config(account.DocumentsConfigUpdate(
        show_gift_print_icon=False,
        gift_text_x=120,
        gift_text_y=640,
        gift_text_max_width=320,
        font_size=14,
        text_color="#123",
        layout_version=1,
    ))

    assert saved["show_gift_print_icon"] is False
    assert saved["gift_text_x"] == 120
    assert saved["gift_text_y"] == 640
    assert saved["gift_text_max_width"] == 320
    assert saved["font_size"] == 14
    assert saved["text_color"] == "#112233"


def test_document_asset_upload_metadata_and_file(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)

    metadata = account.update_document_asset("gift_template", account.BusinessAssetUpdate(
        name="gift.pdf",
        mime_type="application/pdf",
        content_base64=base64.b64encode(PDF_BYTES).decode("ascii"),
        source_path="test",
    ))

    assert metadata["asset_key"] == "gift_template"
    assert metadata["name"] == "gift.pdf"
    assert metadata["size"] == len(PDF_BYTES)

    response = account.get_document_asset_file("gift_template")
    assert response.media_type == "application/pdf"
    assert response.body == PDF_BYTES


def test_document_asset_rejects_non_pdf(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)

    with pytest.raises(HTTPException) as exc:
        account.update_document_asset("gift_template", account.BusinessAssetUpdate(
            name="gift.txt",
            mime_type="text/plain",
            content_base64=base64.b64encode(b"not pdf").decode("ascii"),
        ))

    assert exc.value.status_code == 400


def test_legacy_thank_you_endpoint_uses_pdf_validation(tmp_path, monkeypatch):
    setup_db(tmp_path, monkeypatch)

    metadata = account.update_thank_you_template(account.BusinessAssetUpdate(
        name="thanks.pdf",
        mime_type="application/pdf",
        content_base64=base64.b64encode(PDF_BYTES).decode("ascii"),
    ))

    assert metadata["asset_key"] == "thank_you_template"
    assert metadata["name"] == "thanks.pdf"
