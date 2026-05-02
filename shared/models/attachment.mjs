export const ATTACHMENT_KINDS = Object.freeze({
  image: "image",
  pdf: "pdf",
  file: "file",
});

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp)$/i;

export function inferAttachmentKind(attachment = {}) {
  const name = String(attachment.name || attachment.filename || attachment.file || "").toLowerCase();
  const mime = String(attachment.mime_type || attachment.type || "").toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.test(name)) return ATTACHMENT_KINDS.image;
  if (mime === "application/pdf" || name.endsWith(".pdf")) return ATTACHMENT_KINDS.pdf;
  return ATTACHMENT_KINDS.file;
}

export function normalizeAttachmentMetadata(attachment = {}) {
  const kind = inferAttachmentKind(attachment);
  return {
    id: String(attachment.id || "").trim(),
    name: String(attachment.name || attachment.filename || attachment.file || "Attachment").trim(),
    mime_type: String(attachment.mime_type || attachment.type || "").trim(),
    size: Number(attachment.size || 0) || 0,
    kind,
    downloadable: attachment.downloadable !== false,
    previewable: attachment.previewable === true || kind === ATTACHMENT_KINDS.image,
    download_url: String(attachment.download_url || "").trim(),
    preview_url: String(attachment.preview_url || "").trim(),
  };
}

export function formatAttachmentSize(bytes = 0) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
