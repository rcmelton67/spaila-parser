import React from "react";

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp)$/i;

function isAbsoluteLocalPath(value) {
  const raw = String(value || "").trim();
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\");
}

function localFileSrc(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw || !isAbsoluteLocalPath(raw)) return "";
  return `file:///${encodeURI(raw.replace(/\\/g, "/").replace(/^\/+/, ""))}`;
}

export function getAttachmentDisplayName(attachment) {
  if (typeof attachment === "string") {
    return attachment.split(/[/\\]/).pop() || "Attachment";
  }
  return String(
    attachment?.name
    || attachment?.filename
    || attachment?.fileName
    || attachment?.file
    || attachment?.path
    || attachment?.url
    || "Attachment"
  ).split(/[/\\]/).pop() || "Attachment";
}

export function getAttachmentOpenPath(attachment) {
  if (typeof attachment === "string") return attachment;
  const direct = String(attachment?.path || attachment?.filePath || "").trim();
  if (isAbsoluteLocalPath(direct)) return direct;
  const original = String(attachment?.original_path || attachment?.originalPath || "").trim();
  if (isAbsoluteLocalPath(original)) return original;
  const sentCopy = String(attachment?.sent_copy_path || attachment?.sentCopyPath || "").trim();
  if (isAbsoluteLocalPath(sentCopy)) return sentCopy;
  return direct || original || sentCopy || String(attachment?.url || attachment?.href || "").trim();
}

function getAttachmentMimeType(attachment) {
  if (typeof attachment === "string") return "";
  return String(attachment?.type || attachment?.mime_type || attachment?.mimeType || attachment?.contentType || "").toLowerCase();
}

function extensionFromName(name) {
  const match = String(name || "").match(/\.([^.]+)$/);
  return match ? match[1].toUpperCase() : "FILE";
}

function getAttachmentKind(attachment) {
  const name = getAttachmentDisplayName(attachment);
  const type = getAttachmentMimeType(attachment);
  if (type.includes("image") || IMAGE_EXTENSIONS.test(name)) return "image";
  if (type.includes("pdf") || /\.pdf$/i.test(name)) return "pdf";
  if (type.includes("spreadsheet") || /\.(csv|xlsx?)$/i.test(name)) return "sheet";
  if (type.includes("word") || /\.(docx?|rtf)$/i.test(name)) return "doc";
  if (type.includes("zip") || /\.(zip|rar|7z)$/i.test(name)) return "zip";
  if (/^https?:\/\//i.test(getAttachmentOpenPath(attachment))) return "web";
  return "file";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function typeLabel(kind, name) {
  if (kind === "image") return extensionFromName(name);
  if (kind === "pdf") return "PDF";
  if (kind === "sheet") return extensionFromName(name) || "SHEET";
  if (kind === "doc") return extensionFromName(name) || "DOC";
  if (kind === "zip") return "ZIP";
  if (kind === "web") return "LINK";
  return extensionFromName(name);
}

function iconPalette(kind, missing) {
  if (missing) return { bg: "#fef2f2", border: "#fecaca", color: "#991b1b" };
  if (kind === "pdf") return { bg: "#fff1f2", border: "#fecdd3", color: "#be123c" };
  if (kind === "image") return { bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" };
  if (kind === "sheet") return { bg: "#ecfdf5", border: "#bbf7d0", color: "#047857" };
  if (kind === "doc") return { bg: "#eef2ff", border: "#c7d2fe", color: "#4338ca" };
  if (kind === "zip") return { bg: "#fffbeb", border: "#fde68a", color: "#92400e" };
  return { bg: "#f8fafc", border: "#e2e8f0", color: "#475569" };
}

export default function AttachmentPreviewCard({
  attachment,
  onOpen,
  onRemove,
  removable = false,
  compact = false,
  maxWidth = 340,
}) {
  const name = getAttachmentDisplayName(attachment);
  const openPath = getAttachmentOpenPath(attachment);
  const kind = getAttachmentKind(attachment);
  const [imageFailed, setImageFailed] = React.useState(false);
  const [info, setInfo] = React.useState(() => ({
    checked: false,
    missing: false,
    size: Number(attachment?.size || attachment?.bytes || 0) || 0,
    path: "",
    thumbnailSrc: "",
  }));

  React.useEffect(() => {
    let cancelled = false;
    setImageFailed(false);
    const initialSize = Number(attachment?.size || attachment?.bytes || 0) || 0;
    setInfo({ checked: false, missing: false, size: initialSize, path: "", thumbnailSrc: "" });
    if (!window.parserApp?.getAttachmentInfo) {
      return () => { cancelled = true; };
    }
    window.parserApp.getAttachmentInfo({ attachment })
      .then((result) => {
        if (cancelled || !result?.ok) return;
        setInfo({
          checked: true,
          missing: Boolean(result.missing || result.exists === false),
          size: Number(result.size || initialSize || 0) || 0,
          path: String(result.path || ""),
          thumbnailSrc: String(result.thumbnailDataUrl || result.previewSrc || ""),
        });
      })
      .catch(() => {
        if (!cancelled) setInfo((current) => ({ ...current, checked: true }));
      });
    return () => { cancelled = true; };
  }, [attachment, openPath]);

  const missing = info.missing || Boolean(attachment?.missing || attachment?.notFound);
  const resolvedPath = info.path || openPath;
  const previewSrc = kind === "image" && !missing && !imageFailed
    ? (info.thumbnailSrc || (isAbsoluteLocalPath(resolvedPath) ? localFileSrc(resolvedPath) : ""))
    : "";
  const palette = iconPalette(kind, missing);
  const label = missing ? "Missing" : typeLabel(kind, name);
  const sizeLabel = formatBytes(info.size);

  const open = () => {
    if (!missing) onOpen?.(attachment);
  };

  return (
    <div
      className="attachment-preview-card"
      title={openPath || name}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 8 : 10,
        width: "auto",
        maxWidth,
        minWidth: compact ? 180 : 220,
        border: `1px solid ${missing ? "#fecaca" : "#e2e8f0"}`,
        background: missing ? "#fff7f7" : "#fff",
        color: "#0f172a",
        borderRadius: 12,
        padding: compact ? 7 : 9,
        boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
      }}
    >
      <button
        type="button"
        onClick={open}
        disabled={missing}
        aria-label={missing ? `${name} file not found` : `Open ${name}`}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          margin: 0,
          cursor: missing ? "not-allowed" : "pointer",
          flexShrink: 0,
          opacity: missing ? 0.78 : 1,
        }}
      >
        {previewSrc ? (
          <img
            src={previewSrc}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
            style={{
              width: compact ? 42 : 50,
              height: compact ? 42 : 50,
              borderRadius: 9,
              objectFit: "contain",
              border: "1px solid #e5e7eb",
              background: "#f8fafc",
              display: "block",
            }}
          />
        ) : (
          <span
            aria-hidden="true"
            style={{
              width: compact ? 42 : 50,
              height: compact ? 42 : 50,
              borderRadius: 9,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: palette.bg,
              border: `1px solid ${palette.border}`,
              color: palette.color,
              fontSize: compact ? 11 : 12,
              fontWeight: 900,
              letterSpacing: "0.04em",
            }}
          >
            {label}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={open}
        disabled={missing}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          margin: 0,
          minWidth: 0,
          flex: "1 1 auto",
          textAlign: "left",
          cursor: missing ? "not-allowed" : "pointer",
          color: missing ? "#991b1b" : "#0f172a",
        }}
      >
        <span style={{
          display: "block",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: compact ? 12 : 13,
          fontWeight: 800,
        }}>
          {name}
        </span>
        <span style={{
          display: "block",
          marginTop: 3,
          color: missing ? "#b91c1c" : "#64748b",
          fontSize: 11,
          fontWeight: 700,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          {missing ? "File not found" : [typeLabel(kind, name), sizeLabel].filter(Boolean).join(" · ")}
        </span>
      </button>

      {removable ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          style={{
            border: "none",
            background: "#f1f5f9",
            color: "#64748b",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: 900,
            lineHeight: 1,
            padding: 0,
            width: 22,
            height: 22,
            borderRadius: 999,
            flexShrink: 0,
          }}
        >
          x
        </button>
      ) : null}
    </div>
  );
}
