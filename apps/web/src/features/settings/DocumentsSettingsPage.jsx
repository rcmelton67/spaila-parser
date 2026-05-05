import React from "react";
import { API_ENDPOINTS } from "../../../../../shared/api/endpoints.mjs";
import { DOCUMENT_ASSET_KEYS, normalizeDocumentsConfig } from "../../../../../shared/models/documentsConfig.mjs";
import { api } from "../../api.js";

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

function AssetPicker({ label, description, asset, onUpload, onRemove, disabled }) {
  const inputRef = React.useRef(null);
  return (
    <section className="documents-option-section">
      <span className="documents-section-label">{label}</span>
      <p>{description}</p>
      <div className="documents-file-row">
        <span className={asset?.name ? "selected" : ""}>{asset?.name || "No file selected"}</span>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled}>Browse...</button>
        {asset?.name ? <button className="link-button" type="button" onClick={onRemove} disabled={disabled}>Remove</button> : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onUpload(file);
        }}
      />
      {asset?.updated_at ? <div className="documents-file-meta">Updated {new Date(asset.updated_at).toLocaleString()}</div> : null}
    </section>
  );
}

export default function DocumentsSettingsPage({ onSettingsSaved }) {
  const [config, setConfig] = React.useState(() => normalizeDocumentsConfig());
  const [state, setState] = React.useState({ loading: true, saving: false, error: "", message: "" });

  React.useEffect(() => {
    let cancelled = false;
    api.get(API_ENDPOINTS.documentsConfig).then((payload) => {
      if (!cancelled) {
        setConfig(normalizeDocumentsConfig(payload));
        setState({ loading: false, saving: false, error: "", message: "" });
      }
    }).catch((error) => {
      if (!cancelled) setState({ loading: false, saving: false, error: error?.message || "Could not load Docs settings.", message: "" });
    });
    return () => { cancelled = true; };
  }, []);

  async function uploadAsset(assetKey, file) {
    if (file.type && file.type !== "application/pdf") {
      setState((current) => ({ ...current, error: "Only PDF files are supported.", message: "" }));
      return;
    }
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const contentBase64 = await fileToBase64(file);
      const metadata = await api.patch(API_ENDPOINTS.documentAsset(assetKey), {
        name: file.name || `${assetKey}.pdf`,
        mime_type: "application/pdf",
        content_base64: contentBase64,
        source_path: "web_upload",
      });
      const next = normalizeDocumentsConfig({
        ...config,
        [assetKey === DOCUMENT_ASSET_KEYS.giftTemplate ? "gift_template" : "thank_you_template"]: metadata,
      });
      setConfig(next);
      setState({ loading: false, saving: false, error: "", message: "PDF uploaded. Click Save to keep these Docs settings." });
    } catch (error) {
      setState({ loading: false, saving: false, error: error?.message || "Could not upload PDF.", message: "" });
    }
  }

  async function removeAsset(assetKey) {
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      await api.delete(API_ENDPOINTS.documentAsset(assetKey));
      const key = assetKey === DOCUMENT_ASSET_KEYS.giftTemplate ? "gift_template" : "thank_you_template";
      setConfig((current) => normalizeDocumentsConfig({ ...current, [key]: null }));
      setState({ loading: false, saving: false, error: "", message: "PDF removed. Click Save to keep these Docs settings." });
    } catch (error) {
      setState({ loading: false, saving: false, error: error?.message || "Could not remove PDF.", message: "" });
    }
  }

  async function saveDocuments() {
    setState((current) => ({ ...current, saving: true, error: "", message: "" }));
    try {
      const saved = await api.patch(API_ENDPOINTS.documentsConfig, {
        ...config,
        layout_version: 1,
      });
      setConfig(normalizeDocumentsConfig(saved));
      setState({ loading: false, saving: false, error: "", message: "Docs settings saved and shared with desktop." });
      onSettingsSaved?.();
    } catch (error) {
      setState({ loading: false, saving: false, error: error?.message || "Could not save Docs settings.", message: "" });
    }
  }

  const disabled = state.loading || state.saving;

  return (
    <div className="documents-settings-layout">
      <div className="documents-settings-main">
        <div className="orders-settings-heading">
          <div>
            <h3>Docs</h3>
            <p>Manage shared PDFs and gift-message placement used by Spaila document workflows.</p>
          </div>
        </div>

        {state.loading ? <div className="table-state"><div className="spinner" /><span>Loading Docs settings...</span></div> : null}

        <AssetPicker
          label="Gift Message PDF Template"
          description="Upload the letterhead PDF used when printing gift messages."
          asset={config.gift_template}
          disabled={disabled}
          onUpload={(file) => uploadAsset(DOCUMENT_ASSET_KEYS.giftTemplate, file)}
          onRemove={() => removeAsset(DOCUMENT_ASSET_KEYS.giftTemplate)}
        />

        <section className="documents-option-section">
          <label className="documents-toggle-row">
            <input
              type="checkbox"
              checked={config.show_gift_print_icon !== false}
              onChange={(event) => setConfig((current) => normalizeDocumentsConfig({ ...current, show_gift_print_icon: event.target.checked }))}
            />
            <span>Show print icon on gift message cells</span>
          </label>
        </section>

        <AssetPicker
          label="Thank You Letter"
          description="Upload your standard thank-you letter template for packing inserts."
          asset={config.thank_you_template}
          disabled={disabled}
          onUpload={(file) => uploadAsset(DOCUMENT_ASSET_KEYS.thankYouTemplate, file)}
          onRemove={() => removeAsset(DOCUMENT_ASSET_KEYS.thankYouTemplate)}
        />

        <section className="documents-option-section">
          <span className="documents-section-label">Gift Message Text Position</span>
          <p>Coordinates are in points (1 inch = 72 pt) measured from the bottom-left corner of the PDF page.</p>
          <div className="documents-position-grid">
            {[
              ["gift_text_x", "X (left offset, pt)", 0, 800],
              ["gift_text_y", "Y (from bottom, pt)", 0, 1200],
              ["gift_text_max_width", "Max width (pt)", 50, 800],
              ["font_size", "Font size (pt)", 6, 72],
            ].map(([key, label, min, max]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  type="number"
                  min={min}
                  max={max}
                  value={config[key] ?? ""}
                  onChange={(event) => setConfig((current) => normalizeDocumentsConfig({ ...current, [key]: Number(event.target.value) }))}
                />
              </label>
            ))}
            <label className="documents-color-row">
              <span>Text color</span>
              <div>
                <input
                  type="color"
                  value={config.text_color || "#000000"}
                  onChange={(event) => setConfig((current) => normalizeDocumentsConfig({ ...current, text_color: event.target.value }))}
                />
                <code>{config.text_color || "#000000"}</code>
              </div>
            </label>
          </div>
        </section>

        {state.error ? <div className="error-banner">{state.error}</div> : null}
        {state.message ? <div className="success-banner">{state.message}</div> : null}
        <div className="orders-settings-actions">
          <button className="gen-save-btn" type="button" onClick={saveDocuments} disabled={disabled}>
            {state.saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <aside className="orders-help-card">
        <div className="gen-help-label">Docs Help</div>
        <div className="gen-help-entry">
          <strong>Shared document templates</strong>
          <p>PDFs uploaded here are stored as shared business assets, so web and desktop can show the same document settings without relying on local file paths.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Gift messages</strong>
          <p>The gift message template and X/Y controls match the desktop Docs settings. Desktop still uses its local copy when printing from the Electron app.</p>
        </div>
        <div className="gen-help-entry">
          <strong>Safe replacement</strong>
          <p>Upload failures do not remove the previous working template. Click Save after replacing or removing a PDF to publish the settings.</p>
        </div>
      </aside>
    </div>
  );
}
