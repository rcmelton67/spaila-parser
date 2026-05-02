import React from "react";
import { formatAttachmentSize, normalizeAttachmentMetadata } from "../../../../../shared/models/attachment.mjs";
import { api } from "../../api.js";

function absoluteApiUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `${api.baseUrl}${path}`;
}

export default function AttachmentCard({ attachment }) {
  const item = normalizeAttachmentMetadata(attachment);
  const previewUrl = absoluteApiUrl(item.preview_url);
  const downloadUrl = absoluteApiUrl(item.download_url);
  const [previewFailed, setPreviewFailed] = React.useState(false);

  return (
    <article className="attachment-card">
      <a
        className="attachment-preview"
        href={downloadUrl || undefined}
        target="_blank"
        rel="noreferrer"
        aria-disabled={!downloadUrl}
        onClick={(event) => {
          if (!downloadUrl) event.preventDefault();
        }}
      >
        {previewUrl && !previewFailed ? (
          <img src={previewUrl} alt="" loading="lazy" onError={() => setPreviewFailed(true)} />
        ) : (
          <span>{item.kind === "pdf" ? "PDF" : item.kind === "image" ? "IMG" : "FILE"}</span>
        )}
      </a>
      <div className="attachment-card-body">
        <strong title={item.name}>{item.name}</strong>
        <span>{[item.mime_type, formatAttachmentSize(item.size)].filter(Boolean).join(" · ") || "Attachment"}</span>
        {downloadUrl ? (
          <a href={downloadUrl} target="_blank" rel="noreferrer">Download</a>
        ) : (
          <em>Desktop-only source</em>
        )}
      </div>
    </article>
  );
}
