from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_electron_parser_ipc_uses_standalone_ui_bridge_only():
    main_js = ROOT / "app" / "electron" / "main.js"
    preload_js = ROOT / "app" / "electron" / "preload.js"

    main_source = main_js.read_text(encoding="utf-8")
    preload_source = preload_js.read_text(encoding="utf-8")

    assert '"parser.ui_bridge"' in main_source
    assert 'ipcMain.handle("parser:parse-file"' in main_source
    assert 'runBridge({ action: "parse"' in main_source
    assert 'parseFile:  (payload) => ipcRenderer.invoke("parser:parse-file", payload)' in preload_source
    assert "parse_eml" not in main_source
    assert "parse_eml" not in preload_source


def test_legacy_pre_src_parser_ui_tree_removed():
    assert not (ROOT / "app" / "ui" / "index.jsx").exists()
    assert not (ROOT / "app" / "ui" / "features").exists()
