function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, num) => String.fromCodePoint(parseInt(num, 10)));
}

function htmlToDisplayText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<meta[^>]*>/gi, " ")
    .replace(/<\/?(table|tbody|thead|tfoot|tr|td|th)[^>]*>/gi, "\n")
    .replace(/<(br|p|div|section|article|li|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function cleanPreviewText(bodyText, { singleLine = false } = {}) {
  let text = String(bodyText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");

  if (/<html[\s>]/i.test(text) || /<\/?[a-z][\s\S]*>/i.test(text)) {
    text = htmlToDisplayText(text);
  }

  text = decodeHtmlEntities(text)
    .replace(/[�]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return singleLine ? text.replace(/\s+/g, " ").trim() : text;
}

function normalizePreviewIntegritySample(value) {
  return cleanPreviewText(value, { singleLine: true }).slice(0, 80);
}

function logPreviewTextIntegrity(rawText, previewText) {
  const rawSample = normalizePreviewIntegritySample(rawText);
  const previewSample = normalizePreviewIntegritySample(previewText);
  const tag = rawSample === previewSample ? "[PREVIEW_TEXT_CHECK]" : "[PREVIEW_TEXT_MISMATCH]";
  console.log(`${tag} raw_sample=${JSON.stringify(rawSample)} preview_sample=${JSON.stringify(previewSample)}`);
}

function buildEmailPreview(bodyText, maxLength = 160) {
  const cleaned = cleanPreviewText(bodyText, { singleLine: true });
  if (!cleaned) {
    return "(No preview available)";
  }
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const slice = cleaned.slice(0, maxLength + 1);
  const boundary = slice.search(/\s+\S*$/);
  const preview = (boundary > 80 ? slice.slice(0, boundary) : cleaned.slice(0, maxLength)).trim();
  return `${preview}...`;
}

module.exports = {
  buildEmailPreview,
  cleanPreviewText,
  decodeHtmlEntities,
  logPreviewTextIntegrity,
};
