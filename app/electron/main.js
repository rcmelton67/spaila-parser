const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } = require("electron");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const nodemailer = require("nodemailer");
const { ImapFlow } = require("imapflow");
const { pathToFileURL } = require("url");
const { ensureWorkspaceLayout } = require("./workspacePaths");
const {
  buildEmailPreview,
  cleanPreviewText,
  logPreviewTextIntegrity,
} = require("./previewText");

// ── Helper process (sync_folders.py) ────────────────────────────────────────
const ROOT = path.join(__dirname, "..", "..");
const APP_ICON = path.join(ROOT, "spaila-logo.blue.ico");
const DEFAULT_APP_NAME = "Parser Viewer";
const DOCS_FOLDER = "C:\\Spaila\\Docs";
const DEFAULT_HELPER_SETTINGS = {
  runInBackground: true,
  runOnStartup: true,
  autoRestart: true,
  duplicateHandling: "quarantine",
  unmatchedHandling: "leave",
  unmatchedStoragePath: "",
};
let currentBrandName = DEFAULT_APP_NAME;
let helperProcess = null;
let helperRestarting = false;
let helperStopRequested = false;
let helperStatus = "stopped";
let helperLastActivityAt = "";
let helperLastError = "";
const helperLogs = [];
let cachedWorkspaceDirs = null;
let backupInProgress = false;
let restoreInProgress = false;

function getWorkspaceDirs() {
  if (!cachedWorkspaceDirs) {
    cachedWorkspaceDirs = ensureWorkspaceLayout((message) => console.log(message));
  }
  return cachedWorkspaceDirs;
}

function getBrandName() {
  const name = String(currentBrandName || "").trim();
  return name || DEFAULT_APP_NAME;
}

function withBrandTitle(title, fallback = "") {
  const detail = String(title || fallback || "").trim();
  return detail ? `${getBrandName()} - ${detail}` : getBrandName();
}

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getAllWindows()[0] || null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function injectBrandingIntoHtml(html, title) {
  const brandedTitle = escapeHtml(withBrandTitle(title));
  const faviconTag = `<link rel="icon" type="image/x-icon" href="${pathToFileURL(APP_ICON).href}" />`;
  let page = String(html || "");

  if (!/<html[\s>]/i.test(page)) {
    page = `<!doctype html><html><head></head><body>${page}</body></html>`;
  }

  if (/<title>.*?<\/title>/i.test(page)) {
    page = page.replace(/<title>.*?<\/title>/i, `<title>${brandedTitle}</title>`);
  } else if (/<head[^>]*>/i.test(page)) {
    page = page.replace(/<head([^>]*)>/i, `<head$1>\n    <title>${brandedTitle}</title>`);
  }

  if (!/rel=["']icon["']/i.test(page) && /<\/head>/i.test(page)) {
    page = page.replace(/<\/head>/i, `    ${faviconTag}\n  </head>`);
  }

  return page;
}

function sanitizeFilenamePart(value, fallback = "document") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function relativeWorkspacePath(targetPath) {
  if (!targetPath) {
    return "";
  }
  const { root } = getWorkspaceDirs();
  try {
    const rel = path.relative(root, targetPath);
    if (!rel || rel.startsWith("..")) {
      return "";
    }
    return rel.split(path.sep).join("/");
  } catch (_error) {
    return "";
  }
}

function isWithinWorkspace(targetPath) {
  if (!targetPath) {
    return false;
  }
  const { root } = getWorkspaceDirs();
  try {
    const rel = path.relative(root, targetPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch (_error) {
    return false;
  }
}

function safeStat(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch (_error) {
    return null;
  }
}

function getHelperSettingsPath() {
  return path.join(getWorkspaceDirs().root, "helper_settings.json");
}

function loadHelperSettings() {
  try {
    const raw = fs.readFileSync(getHelperSettingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeHelperSettings(parsed);
  } catch (_error) {
    return { ...DEFAULT_HELPER_SETTINGS };
  }
}

function normalizeHelperSettings(settings = {}) {
  const duplicateHandling = ["quarantine", "ignore", "delete"].includes(settings.duplicateHandling)
    ? settings.duplicateHandling
    : DEFAULT_HELPER_SETTINGS.duplicateHandling;
  const unmatchedHandling = ["move", "prompt", "review"].includes(settings.unmatchedHandling)
    ? "leave"
    : ["leave", "ignore"].includes(settings.unmatchedHandling)
      ? settings.unmatchedHandling
      : DEFAULT_HELPER_SETTINGS.unmatchedHandling;
  return {
    ...DEFAULT_HELPER_SETTINGS,
    ...settings,
    runInBackground: settings.runInBackground !== false,
    runOnStartup: settings.runOnStartup !== false,
    autoRestart: settings.autoRestart !== false,
    duplicateHandling,
    unmatchedHandling,
    unmatchedStoragePath: typeof settings.unmatchedStoragePath === "string" ? settings.unmatchedStoragePath : "",
  };
}

function saveHelperSettings(settings = {}) {
  const next = normalizeHelperSettings(settings);
  fs.mkdirSync(getWorkspaceDirs().root, { recursive: true });
  fs.writeFileSync(getHelperSettingsPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function appendHelperLog(level, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message: String(message || ""),
  };
  helperLogs.push(entry);
  while (helperLogs.length > 200) helperLogs.shift();
  helperLastActivityAt = entry.timestamp;
  if (level === "error") {
    helperLastError = entry.message;
  }
}

function getHelperFolderSummary() {
  const dirs = getWorkspaceDirs();
  const settings = loadHelperSettings();
  const unmatchedPath = settings.unmatchedStoragePath && path.isAbsolute(settings.unmatchedStoragePath)
    ? settings.unmatchedStoragePath
    : dirs.Unmatched;
  return {
    workspaceRoot: dirs.root,
    inbox: dirs.Inbox,
    duplicates: dirs.Duplicates,
    unmatched: unmatchedPath,
  };
}

function countFolderFiles(folderPath) {
  try {
    return fs.readdirSync(folderPath, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch (_error) {
    return 0;
  }
}

function getHelperState() {
  const folders = getHelperFolderSummary();
  const visibilityDiagnostics = getInboxVisibilityDiagnostics();
  return {
    ok: true,
    status: helperStatus,
    running: !!helperProcess,
    pid: helperProcess?.pid || null,
    lastActivityAt: helperLastActivityAt,
    lastError: helperLastError,
    settings: loadHelperSettings(),
    folders,
    review: {
      duplicateCount: countFolderFiles(folders.duplicates),
      unmatchedCount: countFolderFiles(folders.unmatched),
    },
    logs: [...helperLogs].slice(-80),
    diagnostics: {
      logCount: helperLogs.length,
      pythonProcess: helperProcess ? "active" : "not running",
      activitySummary: "Spaila monitors inbox folders and processes new order emails automatically.",
      ...visibilityDiagnostics,
    },
  };
}

function focusExplorerWindowSoon(delayMs = 250) {
  if (process.platform !== "win32") {
    return;
  }
  const script = `
Start-Sleep -Milliseconds ${Math.max(0, Number(delayMs) || 0)}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$window = Get-Process explorer -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1
if ($window -and $window.MainWindowHandle -ne 0) {
  [void][Win32]::ShowWindowAsync($window.MainWindowHandle, 9)
  [void][Win32]::SetForegroundWindow($window.MainWindowHandle)
}
`;
  try {
    spawn("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy", "Bypass",
      "-Command", script,
    ], {
      cwd: ROOT,
      windowsHide: true,
      detached: false,
      stdio: "ignore",
    });
  } catch (error) {
    console.error("[shell:focus-folder] could not foreground Explorer:", error);
  }
}

async function openFolderVisible(targetPath, logPrefix = "shell:open-folder") {
  console.log(`[${logPrefix}] opening:`, targetPath);
  const err = await shell.openPath(targetPath);
  if (err) {
    console.error(`[${logPrefix}] openPath failed:`, targetPath, err);
    return { ok: false, error: err };
  }
  focusExplorerWindowSoon(250);
  return { ok: true, path: targetPath };
}

function getEmailEnvironmentInfo() {
  const osLabel = process.platform === "win32"
    ? "Windows"
    : process.platform === "darwin"
      ? "macOS"
      : process.platform === "linux"
        ? "Linux"
        : "Unknown";

  return {
    os: osLabel,
    emailClient: "Default Email App",
    attachmentCapability: "Manual",
  };
}

function normalizeEmailLink(value) {
  let raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }
  raw = raw
    .replace(/[\r\n\t]+/g, "")
    .replace(/\s+/g, "")
    .replace(/^[<({"'\[]+/, "")
    .replace(/[>)}"'\],.;:!?]+$/, "");
  if (!raw) {
    return "";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  if (/^(www\.)/i.test(raw)) {
    return `https://${raw}`;
  }
  return raw;
}

function convertPlainTextEmailToHtml(text) {
  const normalizedText = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalizedText.split(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi);
  const html = parts.map((part) => {
    if (!part) {
      return "";
    }
    if (/^(https?:\/\/|www\.)/i.test(part)) {
      const href = normalizeEmailLink(part);
      const safeHref = escapeHtml(href);
      return `<a href="${safeHref}">${safeHref}</a>`;
    }
    return escapeHtml(part).replace(/\n/g, "<br />");
  }).join("");
  return `<!doctype html><html><body>${html}</body></html>`;
}

function normalizeSmtpConfig(config = {}) {
  const username = String(config.username || "").trim();
  const emailAddress = String(config.emailAddress || "").trim() || username;
  return {
    senderName: String(config.senderName || config.sender_name || "").trim(),
    emailAddress,
    host: String(config.host || "").trim(),
    port: Number.parseInt(String(config.port || "").trim(), 10) || 587,
    username,
    password: String(config.password || ""),
  };
}

function normalizeImapConfig(config = {}) {
  const username = String(config.username || config.imapUsername || config.imap_user || "").trim();
  return {
    host: String(config.host || config.imapHost || config.imap_host || "").trim(),
    port: Number.parseInt(String(config.port || config.imapPort || config.imap_port || "").trim(), 10) || 993,
    username,
    password: String(config.password || config.imapPassword || config.imap_pass || ""),
    useSsl: config.useSsl ?? config.imapUseSsl ?? config.imap_ssl ?? true,
  };
}

function validateImapAppendConfig(config) {
  const imap = normalizeImapConfig(config);
  if (!imap.host || !imap.username || !imap.password) {
    return { ok: false, imap, error: "IMAP Sent folder append is not configured." };
  }
  return { ok: true, imap };
}

function validateImapConnectionConfig(config) {
  const imap = normalizeImapConfig(config);
  if (!imap.host) return { ok: false, error: "IMAP Host is required." };
  if (!imap.port || !Number.isFinite(imap.port)) return { ok: false, error: "IMAP Port is required." };
  if (!imap.username) return { ok: false, error: "IMAP Username is required." };
  if (!imap.password) return { ok: false, error: "IMAP Password is required." };
  return { ok: true, imap };
}

function validateSmtpConfig(config) {
  const smtp = normalizeSmtpConfig(config);
  if (!smtp.emailAddress) return { ok: false, error: "Email Address is required." };
  if (!smtp.host) return { ok: false, error: "SMTP Host is required." };
  if (!smtp.port || !Number.isFinite(smtp.port)) return { ok: false, error: "SMTP Port is required." };
  if (!smtp.username) return { ok: false, error: "SMTP Username is required." };
  if (!smtp.password) return { ok: false, error: "SMTP Password is required." };
  return { ok: true, smtp };
}

function createSmtpTransport(config) {
  const smtp = normalizeSmtpConfig(config);
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: {
      user: smtp.username,
      pass: smtp.password,
    },
  });
}

function formatFromHeader(smtp) {
  const emailAddress = String(smtp?.emailAddress || "").trim();
  const senderName = String(smtp?.senderName || "").trim();
  if (!senderName) {
    return emailAddress;
  }
  const safeName = senderName.replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ").trim();
  return `"${safeName}" <${emailAddress}>`;
}

function parseEnvelopeRecipients(to) {
  return String(to || "")
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

async function buildMimeMessage({ smtp, to, subject, body, html, attachmentPaths, sentAt, messageId }) {
  const builder = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });
  const info = await builder.sendMail({
    from: formatFromHeader(smtp),
    to,
    subject,
    text: body,
    html,
    date: sentAt,
    messageId,
    attachments: attachmentPaths.map((filePath) => ({
      filename: path.basename(filePath),
      path: filePath,
    })),
  });
  return info.message;
}

function decodeModifiedUtf7(value) {
  return String(value || "").replace(/&([^-]*)-/g, (match, encoded) => {
    if (encoded === "") {
      return "&";
    }
    try {
      const base64 = encoded.replace(/,/g, "/");
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
      const bytes = Buffer.from(padded, "base64");
      const characters = [];
      for (let index = 0; index + 1 < bytes.length; index += 2) {
        characters.push(String.fromCharCode((bytes[index] << 8) + bytes[index + 1]));
      }
      return characters.join("");
    } catch (_error) {
      return match;
    }
  });
}

function normalizeMailboxName(value) {
  return decodeModifiedUtf7(String(value || "").trim().replace(/^"|"$/g, ""));
}

function normalizeMailboxFlags(mailbox) {
  const specialUseFlags = Array.isArray(mailbox?.specialUse)
    ? mailbox.specialUse
    : mailbox?.specialUse instanceof Set
      ? [...mailbox.specialUse]
      : [mailbox?.specialUse];
  const mailboxFlags = Array.isArray(mailbox?.flags)
    ? mailbox.flags
    : mailbox?.flags instanceof Set
      ? [...mailbox.flags]
      : [mailbox?.flags];
  const rawFlags = [...specialUseFlags, ...mailboxFlags];
  return [...new Set(rawFlags
    .map((flag) => String(flag || "").trim())
    .filter(Boolean))];
}

function getMailboxAppendName(mailbox) {
  return String(mailbox?.path || mailbox?.name || "").trim();
}

function parseListedMailboxes(listed) {
  return (Array.isArray(listed) ? listed : [])
    .map((mailbox) => ({
      raw: mailbox,
      name: normalizeMailboxName(getMailboxAppendName(mailbox)),
      appendName: getMailboxAppendName(mailbox),
      flags: normalizeMailboxFlags(mailbox),
    }))
    .filter((mailbox) => mailbox.appendName);
}

function hasSentSpecialUseFlag(mailbox) {
  return mailbox.flags.some((flag) => String(flag || "").toLowerCase() === "\\sent");
}

function selectSentMailbox(mailboxes) {
  const sentBySpecialUse = mailboxes.find(hasSentSpecialUseFlag);
  if (sentBySpecialUse) {
    return { mailbox: sentBySpecialUse, fallback: false };
  }

  const fallbackNames = ["Sent Items", "Sent", "[Gmail]/Sent Mail"];
  for (const fallbackName of fallbackNames) {
    const fallback = mailboxes.find((mailbox) => mailbox.name === fallbackName || mailbox.appendName === fallbackName);
    if (fallback) {
      console.warn("[IMAP_SENT_FALLBACK_USED]", JSON.stringify({ folder_name: fallback.appendName }));
      return { mailbox: fallback, fallback: true };
    }
  }

  return { mailbox: null, fallback: false };
}

async function appendMimeToSentFolder(imapConfig, rawMessage, sentAt) {
  const validation = validateImapAppendConfig(imapConfig);
  if (!validation.ok) {
    console.warn("[APPEND_SENT_FAILED]", JSON.stringify({
      provider: "",
      folder_attempted: "",
      error: validation.error,
    }));
    return { ok: false, skipped: true, error: validation.error };
  }

  const imap = validation.imap;
  const provider = imap.host;
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.useSsl !== false,
    auth: {
      user: imap.username,
      pass: imap.password,
    },
    logger: false,
  });

  let attemptedFolder = "";
  try {
    await client.connect();
    const listed = await client.list().catch(() => []);
    const mailboxes = parseListedMailboxes(listed);
    const selected = selectSentMailbox(mailboxes);
    if (!selected.mailbox) {
      throw new Error("No IMAP Sent folder was advertised.");
    }

    attemptedFolder = selected.mailbox.appendName;
    console.log("[IMAP_SENT_FOLDER_SELECTED]", JSON.stringify({
      folder: attemptedFolder,
      flags: selected.mailbox.flags,
    }));
    await client.append(attemptedFolder, rawMessage, ["\\Seen"], sentAt);
    return { ok: true, folder: attemptedFolder, fallback: selected.fallback };
  } catch (error) {
    console.warn("[APPEND_SENT_FAILED]", JSON.stringify({
      provider,
      folder_attempted: attemptedFolder,
      error: error?.message || String(error),
    }));
    return { ok: false, provider, folder: attemptedFolder, error: error?.message || "Could not save to Sent folder." };
  } finally {
    try {
      await client.logout();
    } catch (_) {}
  }
}

function getSentEmailFolder(orderFolderPath = "") {
  const { root } = getWorkspaceDirs();
  const now = new Date();
  const year = String(now.getFullYear());
  const month = now.toLocaleString("en-US", { month: "long" }).toLowerCase();
  const orderFolderName = sanitizeFilenamePart(path.basename(String(orderFolderPath || "").trim()) || "email");
  return path.join(root, "sent", year, month, orderFolderName);
}

function getSentMessagesIndexPath() {
  return path.join(getWorkspaceDirs().root, "sent_messages.json");
}

function getManagedSentRoot() {
  return path.join(getWorkspaceDirs().root, "sent");
}

function getSentMailRetentionDays() {
  try {
    const settings = loadWorkspaceEmailSettings();
    const days = Number.parseInt(String(settings.sentMailRetentionDays || ""), 10);
    return Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30;
  } catch (_error) {
    return 30;
  }
}

function isWithinManagedSentRoot(targetPath) {
  const sentRoot = path.resolve(getManagedSentRoot());
  const resolvedTarget = path.resolve(String(targetPath || ""));
  const rel = path.relative(sentRoot, resolvedTarget);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function normalizeSentMessageRecord(record = {}) {
  const messageId = String(record.message_id || record.messageId || record.id || "").trim();
  const timestamp = String(record.timestamp || "").trim();
  const id = String(record.id || messageId || `outbound:${timestamp}:${record.subject || ""}`).trim();
  return {
    id,
    message_id: messageId,
    direction: "outbound",
    order_number: String(record.order_number || "").trim(),
    buyer_name: String(record.buyer_name || "").trim(),
    buyer_email: String(record.buyer_email || "").trim(),
    subject: String(record.subject || "").trim() || "(No subject)",
    from: String(record.from || "").trim(),
    sender: String(record.from || "").trim(),
    to: String(record.to || "").trim(),
    timestamp,
    received_at: timestamp,
    body: String(record.body || ""),
    preview_text: String(record.preview_text || record.body || ""),
    preview: String(record.preview || buildEmailPreview(record.preview_text || record.body || "")),
    preview_html: String(record.preview_html || ""),
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
    sent_folder: String(record.sent_folder || "").trim(),
  };
}

function loadSentMessages() {
  try {
    const indexPath = getSentMessagesIndexPath();
    if (!fs.existsSync(indexPath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const records = Array.isArray(parsed?.messages) ? parsed.messages : parsed;
    const messages = (Array.isArray(records) ? records : [])
      .map(normalizeSentMessageRecord)
      .filter((message) => message.id)
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
    return pruneExpiredSentMessages(messages);
  } catch (_error) {
    return [];
  }
}

function pruneExpiredSentMessages(messages) {
  const retentionDays = getSentMailRetentionDays();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const kept = [];
  const expired = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const sentAtMs = Date.parse(message.timestamp || message.received_at || "");
    if (Number.isFinite(sentAtMs) && sentAtMs < cutoffMs) {
      expired.push(message);
    } else {
      kept.push(message);
    }
  }

  if (!expired.length) {
    return messages;
  }

  const keptFolders = new Set(kept.map((message) => path.resolve(String(message.sent_folder || ""))).filter(Boolean));
  const expiredFolders = new Set(expired.map((message) => path.resolve(String(message.sent_folder || ""))).filter(Boolean));
  for (const folderPath of expiredFolders) {
    if (!folderPath || keptFolders.has(folderPath) || !isWithinManagedSentRoot(folderPath)) {
      continue;
    }
    try {
      fs.rmSync(folderPath, { recursive: true, force: true });
      console.log("[SENT_RETENTION] removed sent folder", folderPath);
    } catch (error) {
      console.warn("[SENT_RETENTION] could not remove sent folder", folderPath, error?.message || error);
    }
  }

  saveSentMessages(kept);
  console.log("[SENT_RETENTION] pruned", expired.length, "sent message record(s)");
  return kept;
}

function saveSentMessages(messages) {
  const indexPath = getSentMessagesIndexPath();
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify({
    messages: messages.map(normalizeSentMessageRecord),
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");
}

function appendSentMessage(record) {
  const nextRecord = normalizeSentMessageRecord(record);
  if (!nextRecord.id) {
    return null;
  }
  const messages = loadSentMessages();
  const existing = messages.find((message) => message.id === nextRecord.id || message.message_id === nextRecord.message_id);
  if (existing) {
    return existing;
  }
  messages.unshift(nextRecord);
  saveSentMessages(messages);
  return nextRecord;
}

function copyFilesIntoFolder(filePaths, destinationFolder) {
  const copied = [];
  for (const filePath of Array.isArray(filePaths) ? filePaths : []) {
    const source = String(filePath || "").trim();
    if (!source || !path.isAbsolute(source) || !fs.existsSync(source)) {
      continue;
    }
    const target = path.join(destinationFolder, path.basename(source));
    fs.copyFileSync(source, target);
    copied.push(target);
  }
  return copied;
}

function inferMimeTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

function normalizeOutboundAttachmentMetadata(filePaths, { copiedPaths = [], sentAt = new Date().toISOString() } = {}) {
  return (Array.isArray(filePaths) ? filePaths : [])
    .map((filePath, index) => {
      const sourcePath = String(filePath || "").trim();
      if (!sourcePath) return null;
      const copiedPath = String(copiedPaths[index] || "").trim();
      let size = 0;
      try {
        size = fs.existsSync(sourcePath) ? fs.statSync(sourcePath).size : 0;
      } catch (_) {
        size = 0;
      }
      const filename = path.basename(sourcePath);
      return {
        file: filename,
        filename,
        name: filename,
        path: sourcePath,
        original_path: sourcePath,
        sent_copy_path: copiedPath,
        mime_type: inferMimeTypeFromPath(sourcePath),
        type: inferMimeTypeFromPath(sourcePath),
        size,
        source: "outbound_send",
        direction: "outbound",
        timestamp: sentAt,
      };
    })
    .filter(Boolean);
}

function decodeHeaderValue(value) {
  return decodeMimeHeader(String(value || "").replace(/\r?\n[\t ]+/g, " ").trim());
}

function decodeBytesWithCharset(buffer, charset = "utf-8") {
  const label = String(charset || "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(buffer);
  } catch (_error) {
    try {
      return new TextDecoder("utf-8").decode(buffer);
    } catch {
      return Buffer.from(buffer).toString("utf8");
    }
  }
}

function decodeMimeHeader(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset, encoding, encoded) => {
    try {
      if (String(encoding).toLowerCase() === "b") {
        return decodeBytesWithCharset(Buffer.from(encoded, "base64"), charset);
      }
      const bytes = [];
      const text = String(encoded || "").replace(/_/g, " ");
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "=" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
          bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(text.charCodeAt(i));
        }
      }
      return decodeBytesWithCharset(Buffer.from(bytes), charset);
    } catch (_error) {
      return "";
    }
  }).trim();
}

function readEmailMetadataRaw(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks = [];
    const buffer = Buffer.alloc(8192);
    let totalLength = 0;
    const maxBytes = 262144;

    while (totalLength < maxBytes) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalLength += bytesRead;
      const text = Buffer.concat(chunks, totalLength).toString("utf8");
      const headerEnd = text.search(/\r?\n\r?\n/);
      if (headerEnd >= 0 && text.length - headerEnd > 65536) {
        break;
      }
    }

    return Buffer.concat(chunks, totalLength).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseEmailHeaders(headers) {
  const parsed = {};
  let currentKey = "";
  for (const line of String(headers || "").split(/\r?\n/)) {
    if (/^[\t ]/.test(line) && currentKey) {
      parsed[currentKey] = `${parsed[currentKey] || ""} ${line.trim()}`.trim();
      continue;
    }
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      currentKey = "";
      continue;
    }
    currentKey = match[1].trim().toLowerCase();
    parsed[currentKey] = match[2].trim();
  }
  return parsed;
}

function getHiddenEmailsPath() {
  return path.join(getWorkspaceDirs().root, "hidden_emails.json");
}

function loadHiddenEmailIds() {
  try {
    const hiddenPath = getHiddenEmailsPath();
    if (!fs.existsSync(hiddenPath)) {
      return new Set();
    }
    const parsed = JSON.parse(fs.readFileSync(hiddenPath, "utf8"));
    const ids = Array.isArray(parsed?.hidden_emails) ? parsed.hidden_emails : parsed;
    return new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || "").trim()).filter(Boolean));
  } catch (_error) {
    return new Set();
  }
}

function saveHiddenEmailIds(hiddenIds) {
  const hiddenPath = getHiddenEmailsPath();
  fs.mkdirSync(path.dirname(hiddenPath), { recursive: true });
  fs.writeFileSync(hiddenPath, JSON.stringify({
    hidden_emails: [...hiddenIds].sort(),
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");
}

function getWorkspaceInboxHiddenPath() {
  return path.join(getWorkspaceDirs().root, "workspace_inbox_hidden.json");
}

function getInboxSourceStatePath() {
  return path.join(getWorkspaceDirs().root, ".spaila_internal", "inbox_source_state.json");
}

function getDedupStorePath() {
  return path.join(getWorkspaceDirs().root, ".spaila_internal", "dedup_store.json");
}

function getProcessedInboxRefsPath() {
  return path.join(getWorkspaceDirs().root, ".processedInboxRefs.json");
}

function getManualImportedInboxRefsPath() {
  return path.join(getWorkspaceDirs().root, ".spaila_internal", "manual_imported_inbox.json");
}

function normalizeInboxRef(value) {
  return String(value || "").trim().toLowerCase();
}

function getInboxItemManualImportRefs(item) {
  return [
    item?.email_id,
    item?.id,
    item?.message_id,
    item?.imap_uid,
    item?.path,
    item?.relativePath,
    item?.name,
  ].map(normalizeInboxRef).filter(Boolean);
}

function loadManualImportedInboxRefs() {
  try {
    const storePath = getManualImportedInboxRefsPath();
    if (!fs.existsSync(storePath)) {
      return new Set();
    }
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const refs = Array.isArray(parsed?.refs) ? parsed.refs : parsed;
    return new Set((Array.isArray(refs) ? refs : []).map(normalizeInboxRef).filter(Boolean));
  } catch (_error) {
    return new Set();
  }
}

function saveManualImportedInboxRefs(refs) {
  const storePath = getManualImportedInboxRefsPath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({
    refs: [...refs].sort(),
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");
}

function addManualImportedInboxItem(item) {
  const refs = loadManualImportedInboxRefs();
  for (const ref of getInboxItemManualImportRefs(item)) {
    refs.add(ref);
  }
  saveManualImportedInboxRefs(refs);
}

function loadSourceDeletedInboxUids() {
  try {
    const sourceStatePath = getInboxSourceStatePath();
    if (!fs.existsSync(sourceStatePath)) {
      return new Set();
    }
    const parsed = JSON.parse(fs.readFileSync(sourceStatePath, "utf8"));
    const uids = parsed?.uids && typeof parsed.uids === "object" ? parsed.uids : {};
    return new Set(Object.entries(uids)
      .filter(([, sourceDeleted]) => sourceDeleted === true)
      .map(([uid]) => String(uid || "").trim())
      .filter(Boolean));
  } catch (_error) {
    return new Set();
  }
}

function getInboxVisibilityDiagnostics() {
  const dirs = getWorkspaceDirs();
  const hiddenCount = loadHiddenEmailIds().size + loadWorkspaceInboxHiddenIds().size;
  const sourceDeletedCount = loadSourceDeletedInboxUids().size;
  let processedRefsCount = 0;
  let dedupHitCount = 0;
  try {
    const processedPath = getProcessedInboxRefsPath();
    if (fs.existsSync(processedPath)) {
      const parsed = JSON.parse(fs.readFileSync(processedPath, "utf8"));
      processedRefsCount = Array.isArray(parsed) ? parsed.length : 0;
    }
  } catch (_error) {
    processedRefsCount = 0;
  }
  try {
    const dedupPath = getDedupStorePath();
    if (fs.existsSync(dedupPath)) {
      const parsed = JSON.parse(fs.readFileSync(dedupPath, "utf8"));
      dedupHitCount = parsed?.messages && typeof parsed.messages === "object"
        ? Object.keys(parsed.messages).length
        : 0;
    }
  } catch (_error) {
    dedupHitCount = 0;
  }
  return {
    inboxEmlCount: countFolderFiles(dirs.InboxModule),
    unmatchedEmlCount: countFolderFiles(dirs.Unmatched),
    hiddenEmailCount: hiddenCount,
    processedRefsCount,
    sourceDeletedRefsCount: sourceDeletedCount,
    dedupHitCount,
  };
}

function loadWorkspaceInboxHiddenIds() {
  try {
    const hiddenPath = getWorkspaceInboxHiddenPath();
    if (!fs.existsSync(hiddenPath)) {
      return new Set();
    }
    const parsed = JSON.parse(fs.readFileSync(hiddenPath, "utf8"));
    const ids = Array.isArray(parsed?.hidden_ids) ? parsed.hidden_ids : [];
    return new Set((Array.isArray(ids) ? ids : []).map((value) => String(value || "").trim()).filter(Boolean));
  } catch (_error) {
    return new Set();
  }
}

function saveWorkspaceInboxHiddenIds(hiddenIds) {
  const hiddenPath = getWorkspaceInboxHiddenPath();
  fs.mkdirSync(path.dirname(hiddenPath), { recursive: true });
  fs.writeFileSync(hiddenPath, JSON.stringify({
    hidden_ids: [...hiddenIds].sort(),
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");
}

function addWorkspaceInboxHiddenIds(emailId, imapUid) {
  const a = String(emailId || "").trim();
  const b = String(imapUid || "").trim();
  if (!a && !b) {
    throw new Error("Email id is required.");
  }
  const hiddenIds = loadWorkspaceInboxHiddenIds();
  if (a) hiddenIds.add(a);
  if (b) hiddenIds.add(b);
  saveWorkspaceInboxHiddenIds(hiddenIds);
}

function hideEmailId(emailId) {
  const normalized = String(emailId || "").trim();
  if (!normalized) {
    throw new Error("Email id is required.");
  }
  const hiddenIds = loadHiddenEmailIds();
  hiddenIds.add(normalized);
  saveHiddenEmailIds(hiddenIds);
}

const ORDER_TOKEN_STOPWORDS = new Set([
  "the", "and", "a", "an", "your", "you", "for", "with", "from", "that",
  "this", "are", "was", "were", "have", "has", "had", "not", "but", "can",
  "our", "out", "all", "new", "one", "two", "to", "of", "in", "on", "at",
  "by", "or", "is", "it", "as", "be", "we", "us", "re", "fw",
]);

function getOrderLearningPath() {
  return path.join(getWorkspaceDirs().root, "order_email_learning.json");
}

function createEmptyOrderLearning() {
  return {
    order_flags: {},
    linked_order_ids: {},
    order_patterns: {
      subject_tokens: {},
      sender_tokens: {},
      body_tokens: {},
    },
  };
}

function normalizeOrderLearningStore(store) {
  const empty = createEmptyOrderLearning();
  const next = {
    order_flags: { ...(store?.order_flags || {}) },
    linked_order_ids: { ...(store?.linked_order_ids || {}) },
    order_patterns: {
      subject_tokens: { ...(store?.order_patterns?.subject_tokens || {}) },
      sender_tokens: { ...(store?.order_patterns?.sender_tokens || {}) },
      body_tokens: { ...(store?.order_patterns?.body_tokens || {}) },
    },
  };
  return {
    order_flags: next.order_flags || empty.order_flags,
    linked_order_ids: next.linked_order_ids || empty.linked_order_ids,
    order_patterns: next.order_patterns || empty.order_patterns,
  };
}

function loadOrderLearningStore() {
  try {
    const learningPath = getOrderLearningPath();
    if (!fs.existsSync(learningPath)) {
      return createEmptyOrderLearning();
    }
    return normalizeOrderLearningStore(JSON.parse(fs.readFileSync(learningPath, "utf8")));
  } catch (_error) {
    return createEmptyOrderLearning();
  }
}

function saveOrderLearningStore(store) {
  const learningPath = getOrderLearningPath();
  fs.mkdirSync(path.dirname(learningPath), { recursive: true });
  fs.writeFileSync(learningPath, JSON.stringify({
    ...normalizeOrderLearningStore(store),
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");
}

function extractOrderTokens(value) {
  const tokens = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !ORDER_TOKEN_STOPWORDS.has(token));
  return [...new Set(tokens)].slice(0, 40);
}

function incrementOrderPattern(patterns, key, tokens) {
  const bucket = patterns[key] || {};
  for (const token of tokens) {
    bucket[token] = (Number(bucket[token]) || 0) + 1;
  }
  patterns[key] = bucket;
}

function learnOrderPatterns(store, item) {
  const patterns = store.order_patterns;
  incrementOrderPattern(patterns, "subject_tokens", extractOrderTokens(item?.subject || ""));
  incrementOrderPattern(patterns, "sender_tokens", extractOrderTokens(item?.sender || ""));
  incrementOrderPattern(patterns, "body_tokens", extractOrderTokens(item?.preview || ""));
}

function scoreOrderSuggestion(store, item) {
  const patterns = store.order_patterns || {};
  let score = 0;
  for (const token of extractOrderTokens(item?.subject || "")) {
    if (patterns.subject_tokens?.[token]) score += 10;
  }
  for (const token of extractOrderTokens(item?.sender || "")) {
    if (patterns.sender_tokens?.[token]) score += 14;
  }
  for (const token of extractOrderTokens(item?.preview || "")) {
    if (patterns.body_tokens?.[token]) score += 5;
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function markInboxItemAsOrder(item) {
  const emailId = String(item?.email_id || item?.emailId || "").trim();
  if (!emailId) {
    throw new Error("Email id is required.");
  }
  const store = loadOrderLearningStore();
  const alreadyFlagged = store.order_flags[emailId] === true;
  store.order_flags[emailId] = true;
  if (!alreadyFlagged) {
    learnOrderPatterns(store, item || {});
  }
  saveOrderLearningStore(store);
  return { flagged: true, score: 100 };
}

function markInboxItemAsNotOrder(item) {
  const emailId = String(item?.email_id || item?.emailId || "").trim();
  if (!emailId) {
    throw new Error("Email id is required.");
  }
  const store = loadOrderLearningStore();
  store.order_flags[emailId] = false;
  if (store.linked_order_ids) {
    delete store.linked_order_ids[emailId];
  }
  saveOrderLearningStore(store);
  return { flagged: false, not_order: true, score: 0 };
}

function undoInboxOrderMark(item) {
  const emailId = String(item?.email_id || item?.emailId || "").trim();
  if (!emailId) {
    throw new Error("Email id is required.");
  }
  const store = loadOrderLearningStore();
  delete store.order_flags[emailId];
  if (store.linked_order_ids) {
    delete store.linked_order_ids[emailId];
  }
  saveOrderLearningStore(store);
  return { flagged: false, not_order: false, score: scoreOrderSuggestion(store, item || {}) };
}

function setInboxItemLinkedOrderId(item, orderId) {
  const emailId = String(item?.email_id || item?.emailId || "").trim();
  if (!emailId) {
    throw new Error("Email id is required.");
  }
  const oid = String(orderId || "").trim();
  if (!oid) {
    throw new Error("Order id is required.");
  }
  const store = loadOrderLearningStore();
  if (!store.linked_order_ids) {
    store.linked_order_ids = {};
  }
  store.linked_order_ids[emailId] = oid;
  saveOrderLearningStore(store);
  return { linked_order_id: oid };
}

function loadWorkspaceEmailSettings() {
  try {
    const settingsPath = path.join(getWorkspaceDirs().root, "email_settings.json");
    if (!fs.existsSync(settingsPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (_error) {
    return {};
  }
}

function isImapConfigured() {
  const settings = loadWorkspaceEmailSettings();
  return !!(
    String(settings.imapHost || settings.imap_host || "").trim()
    && String(settings.imapUsername || settings.imap_user || "").trim()
    && String(settings.imapPassword || settings.imap_pass || "")
  );
}

function formatHeaderSender(fromHeader) {
  const value = decodeHeaderValue(fromHeader);
  if (!value) {
    return "(Unknown sender)";
  }
  const nameMatch = value.match(/^"?([^"<]+?)"?\s*<[^>]+>/);
  if (nameMatch?.[1]?.trim()) {
    return nameMatch[1].trim();
  }
  const emailMatch = value.match(/<([^>]+)>/);
  return (emailMatch?.[1] || value).trim() || "(Unknown sender)";
}

function extractHeaderEmail(headerValue) {
  const value = decodeHeaderValue(headerValue);
  const bracketMatch = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }
  const emailMatch = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return (emailMatch?.[0] || "").trim();
}

function decodeQuotedPrintable(value, charset = "utf-8") {
  const bytes = [];
  const text = String(value || "").replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "=" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return decodeBytesWithCharset(Buffer.from(bytes), charset);
}

function decodePreviewBody(bodyRaw, transferEncoding, charset = "utf-8") {
  const encoding = String(transferEncoding || "").trim().toLowerCase();
  const raw = String(bodyRaw || "");
  if (encoding.includes("base64")) {
    const base64 = raw
      .split(/\r?\n/)
      .filter((line) => !/^\s*--/.test(line) && !/^\s*content-/i.test(line))
      .join("");
    try {
      return decodeBytesWithCharset(Buffer.from(base64, "base64"), charset);
    } catch (_error) {
      return raw;
    }
  }
  if (encoding.includes("quoted-printable")) {
    return decodeQuotedPrintable(raw, charset);
  }
  return raw;
}

function sanitizeEmailHtml(value) {
  let html = String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<meta[^>]*>/gi, "")
    .replace(/<img[^>]*>/gi, "");

  const allowed = new Set(["p", "br", "b", "strong", "i", "em", "ul", "ol", "li", "a"]);
  html = html.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, tagName, attrs) => {
    const name = String(tagName || "").toLowerCase();
    if (!allowed.has(name)) {
      return "";
    }
    if (tag.startsWith("</")) {
      return name === "br" ? "" : `</${name}>`;
    }
    if (name === "br") {
      return "<br>";
    }
    if (name === "a") {
      const href = String(attrs || "").match(/\bhref\s*=\s*["']?([^"'\s>]+)/i)?.[1] || "";
      if (!/^(https?:\/\/|mailto:)/i.test(href)) {
        return "";
      }
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`;
    }
    return `<${name}>`;
  });

  return html
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

function getHeaderParameter(value, name) {
  const pattern = new RegExp(`${name}\\s*=\\s*"?([^";\\r\\n]+)"?`, "i");
  return String(value || "").match(pattern)?.[1]?.trim() || "";
}

function getDecodedHeaderParameter(value, name) {
  const source = String(value || "");
  const encodedMatch = source.match(new RegExp(`${name}\\*\\s*=\\s*"?([^";\\r\\n]+)"?`, "i"));
  if (encodedMatch?.[1]) {
    const raw = encodedMatch[1].trim();
    const rfc5987 = raw.match(/^([^']*)''(.+)$/);
    try {
      return decodeURIComponent(rfc5987 ? rfc5987[2] : raw);
    } catch (_error) {
      return rfc5987 ? rfc5987[2] : raw;
    }
  }
  return decodeHeaderValue(getHeaderParameter(source, name));
}

function decodeBodyPart(bodyRaw, headers) {
  const contentType = headers["content-type"] || "";
  const charset = getHeaderParameter(contentType, "charset") || "utf-8";
  return decodePreviewBody(bodyRaw, headers["content-transfer-encoding"] || "", charset);
}

function getAttachmentFilename(headers = {}, fallback = "attachment") {
  const disposition = headers["content-disposition"] || "";
  const contentType = headers["content-type"] || "";
  return getDecodedHeaderParameter(disposition, "filename")
    || getDecodedHeaderParameter(contentType, "name")
    || fallback;
}

function getMimeType(headers = {}) {
  return String(headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase() || "application/octet-stream";
}

function splitMimeParts(bodyRaw, boundary) {
  return String(bodyRaw || "")
    .split(`--${boundary}`)
    .map((part) => String(part || "").replace(/--\s*$/, "").trim())
    .filter(Boolean)
    .map((part) => {
      const headerEndMatch = part.match(/\r?\n\r?\n/);
      if (!headerEndMatch) return null;
      const headerEnd = headerEndMatch.index;
      return {
        headers: parseEmailHeaders(part.slice(0, headerEnd)),
        body: part.slice(headerEnd + headerEndMatch[0].length),
      };
    })
    .filter(Boolean);
}

function collectEmailAttachments(bodyRaw, headers, sourcePath, attachments = []) {
  const contentType = headers["content-type"] || "";
  const boundary = getHeaderParameter(contentType, "boundary");
  if (boundary) {
    for (const part of splitMimeParts(bodyRaw, boundary)) {
      collectEmailAttachments(part.body, part.headers, sourcePath, attachments);
    }
    return attachments;
  }

  const disposition = String(headers["content-disposition"] || "").toLowerCase();
  const mimeType = getMimeType(headers);
  const filename = getAttachmentFilename(headers, "");
  const isAttachment = !!filename || disposition.includes("attachment");
  if (!isAttachment) {
    return attachments;
  }

  const name = filename || `attachment-${attachments.length + 1}`;
  attachments.push({
    name,
    type: mimeType,
    path: "",
    sourcePath,
    attachmentIndex: attachments.length,
  });
  return attachments;
}

function decodeAttachmentBody(bodyRaw, headers = {}) {
  const encoding = String(headers["content-transfer-encoding"] || "").trim().toLowerCase();
  const raw = String(bodyRaw || "");
  if (encoding.includes("base64")) {
    return Buffer.from(raw.replace(/\s+/g, ""), "base64");
  }
  if (encoding.includes("quoted-printable")) {
    const bytes = [];
    const text = raw.replace(/=\r?\n/g, "");
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "=" && /^[0-9a-f]{2}$/i.test(text.slice(index + 1, index + 3))) {
        bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        bytes.push(text.charCodeAt(index) & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(raw, "binary");
}

function findEmailAttachmentPart(bodyRaw, headers, attachmentIndex, cursor = { index: 0 }) {
  const contentType = headers["content-type"] || "";
  const boundary = getHeaderParameter(contentType, "boundary");
  if (boundary) {
    for (const part of splitMimeParts(bodyRaw, boundary)) {
      const found = findEmailAttachmentPart(part.body, part.headers, attachmentIndex, cursor);
      if (found) return found;
    }
    return null;
  }

  const disposition = String(headers["content-disposition"] || "").toLowerCase();
  const filename = getAttachmentFilename(headers, "");
  const isAttachment = !!filename || disposition.includes("attachment");
  if (!isAttachment) {
    return null;
  }

  const currentIndex = cursor.index;
  cursor.index += 1;
  if (currentIndex !== Number(attachmentIndex)) {
    return null;
  }
  return {
    headers,
    body: bodyRaw,
    name: filename || `attachment-${currentIndex + 1}`,
  };
}

function extractEmailAttachmentToFile(sourcePath, attachmentIndex, requestedName = "") {
  if (!sourcePath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath)) {
    throw new Error("Source email file was not found.");
  }
  const raw = fs.readFileSync(sourcePath, "utf8");
  const headerEndMatch = raw.match(/\r?\n\r?\n/);
  if (!headerEndMatch) {
    throw new Error("Could not read email attachments.");
  }
  const headerEnd = headerEndMatch.index;
  const headers = parseEmailHeaders(raw.slice(0, headerEnd));
  const bodyRaw = raw.slice(headerEnd + headerEndMatch[0].length);
  const part = findEmailAttachmentPart(bodyRaw, headers, attachmentIndex);
  if (!part) {
    throw new Error("Attachment was not found.");
  }

  const folderKey = crypto.createHash("sha1").update(sourcePath).digest("hex").slice(0, 12);
  const outputDir = path.join(getWorkspaceDirs().root, ".spaila_internal", "attachments", folderKey);
  fs.mkdirSync(outputDir, { recursive: true });
  const filename = sanitizeFilenamePart(requestedName || part.name || `attachment-${Number(attachmentIndex) + 1}`, "attachment");
  const outputPath = path.join(outputDir, `${Number(attachmentIndex) + 1}-${filename}`);
  fs.writeFileSync(outputPath, decodeAttachmentBody(part.body, part.headers));
  return outputPath;
}

function extractEmailAttachmentsFromRaw(raw, sourcePath) {
  const headerEndMatch = String(raw || "").match(/\r?\n\r?\n/);
  if (!headerEndMatch) {
    return [];
  }
  const headerEnd = headerEndMatch.index;
  const headers = parseEmailHeaders(String(raw).slice(0, headerEnd));
  const bodyRaw = String(raw).slice(headerEnd + headerEndMatch[0].length);
  return collectEmailAttachments(bodyRaw, headers, sourcePath);
}

function extractDisplayBody(bodyRaw, headers) {
  const contentType = headers["content-type"] || "";
  const boundary = getHeaderParameter(contentType, "boundary");
  if (!boundary) {
    return decodeBodyPart(bodyRaw, headers);
  }

  const parts = String(bodyRaw || "").split(`--${boundary}`);
  const candidates = [];
  for (const part of parts) {
    const trimmed = String(part || "").replace(/--\s*$/, "").trim();
    if (!trimmed) continue;
    const headerEndMatch = trimmed.match(/\r?\n\r?\n/);
    if (!headerEndMatch) continue;
    const headerEnd = headerEndMatch.index;
    const partHeaders = parseEmailHeaders(trimmed.slice(0, headerEnd));
    const partBody = trimmed.slice(headerEnd + headerEndMatch[0].length);
    const partType = String(partHeaders["content-type"] || "").toLowerCase();
    if (/multipart\//i.test(partType)) {
      candidates.push({ type: partType, text: extractDisplayBody(partBody, partHeaders) });
      continue;
    }
    if (partType.includes("text/plain") || partType.includes("text/html")) {
      candidates.push({ type: partType, text: decodeBodyPart(partBody, partHeaders) });
    }
  }

  const cleanedPlain = candidates
    .filter((candidate) => candidate.type.includes("text/plain"))
    .map((candidate) => cleanPreviewText(candidate.text))
    .find((text) => text.length > 20);
  if (cleanedPlain) {
    return cleanedPlain;
  }
  const html = candidates.find((candidate) => candidate.type.includes("text/html"))?.text;
  return html || candidates[0]?.text || decodeBodyPart(bodyRaw, headers);
}

function extractDisplayHtml(bodyRaw, headers) {
  const contentType = String(headers["content-type"] || "").toLowerCase();
  const boundary = getHeaderParameter(headers["content-type"] || "", "boundary");
  if (!boundary) {
    return contentType.includes("text/html") ? decodeBodyPart(bodyRaw, headers) : "";
  }

  const parts = String(bodyRaw || "").split(`--${boundary}`);
  for (const part of parts) {
    const trimmed = String(part || "").replace(/--\s*$/, "").trim();
    if (!trimmed) continue;
    const headerEndMatch = trimmed.match(/\r?\n\r?\n/);
    if (!headerEndMatch) continue;
    const headerEnd = headerEndMatch.index;
    const partHeaders = parseEmailHeaders(trimmed.slice(0, headerEnd));
    const partBody = trimmed.slice(headerEnd + headerEndMatch[0].length);
    const partType = String(partHeaders["content-type"] || "").toLowerCase();
    if (/multipart\//i.test(partType)) {
      const nested = extractDisplayHtml(partBody, partHeaders);
      if (nested) return nested;
    }
    if (partType.includes("text/html")) {
      return decodeBodyPart(partBody, partHeaders);
    }
  }
  return "";
}

function inferInboxEmailId(filePath, headers) {
  const filename = path.basename(filePath);
  const messageId = decodeHeaderValue(headers?.["message-id"] || "").replace(/^<|>$/g, "").trim();
  if (messageId) {
    return messageId;
  }
  const savedIdMatch = filename.match(/^\d+_([A-Za-z0-9]+)\.eml$/i);
  if (savedIdMatch?.[1]) {
    return savedIdMatch[1];
  }
  return `local:${filename}`;
}

function inferSavedInboxUid(filePath) {
  const filename = path.basename(filePath);
  const savedIdMatch = filename.match(/^\d+_([A-Za-z0-9]+)\.eml$/i);
  return savedIdMatch?.[1] || "";
}

function extractEmailMetadata(filePath) {
  let subject = "";
  let sender = "";
  let replyTo = "";
  let timestamp = "";
  let preview = "(No preview available)";
  let previewText = "(No preview available)";
  let previewHtml = "";
  let attachments = [];
  let emailId = `local:${path.basename(filePath)}`;
  try {
    const raw = readEmailMetadataRaw(filePath);
    const headerEndMatch = raw.match(/\r?\n\r?\n/);
    const headerEnd = headerEndMatch ? headerEndMatch.index : -1;
    const headersText = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
    const bodyRaw = headerEnd >= 0 ? raw.slice(headerEnd + headerEndMatch[0].length) : "";
    const headers = parseEmailHeaders(headersText);
    subject = decodeHeaderValue(headers.subject || "");
    sender = formatHeaderSender(headers.from || "");
    replyTo = extractHeaderEmail(headers["reply-to"] || "") || extractHeaderEmail(headers.from || "");
    emailId = inferInboxEmailId(filePath, headers);
    const parsedDate = Date.parse(decodeHeaderValue(headers.date || ""));
    if (Number.isFinite(parsedDate)) {
      timestamp = new Date(parsedDate).toISOString();
    }
    const displayBody = extractDisplayBody(bodyRaw, headers);
    previewText = cleanPreviewText(displayBody) || "(No preview available)";
    preview = buildEmailPreview(previewText);
    logPreviewTextIntegrity(displayBody, previewText);
    previewHtml = sanitizeEmailHtml(extractDisplayHtml(bodyRaw, headers));
    attachments = extractEmailAttachmentsFromRaw(fs.readFileSync(filePath, "utf8"), filePath);
  } catch (_error) {
    // Fall back to header-free defaults below.
  }

  return {
    name: path.basename(filePath),
    id: emailId,
    email_id: emailId,
    imap_uid: inferSavedInboxUid(filePath),
    subject: subject || "(No subject)",
    sender: sender || "(Unknown sender)",
    reply_to: replyTo,
    received_at: timestamp,
    timestamp,
    preview,
    preview_text: previewText,
    preview_html: previewHtml,
    attachments,
  };
}

function countFolderEntries(targetPath) {
  const stat = safeStat(targetPath);
  if (!stat) {
    return 0;
  }
  if (stat.isFile()) {
    return 1;
  }
  let total = 0;
  const stack = [targetPath];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      total += 1;
      if (entry.isDirectory()) {
        stack.push(path.join(current, entry.name));
      }
    }
  }
  return total;
}

function isValidOrderFolderName(name) {
  return /.+[–-]\s*\d+$/.test(String(name || "").trim());
}

function countOrderFolders(targetPath) {
  const stat = safeStat(targetPath);
  if (!stat?.isDirectory()) {
    return 0;
  }

  let total = 0;
  const stack = [targetPath];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    const childDirectories = entries.filter((entry) => entry.isDirectory());
    if (childDirectories.length === 0) {
      if (isValidOrderFolderName(path.basename(current))) {
        total += 1;
      }
      continue;
    }

    for (const entry of childDirectories) {
      stack.push(path.join(current, entry.name));
    }
  }

  return total;
}

function listFolderEntries(targetPath) {
  const stat = safeStat(targetPath);
  if (!stat) {
    return [];
  }
  if (stat.isFile()) {
    return [{
      name: path.basename(targetPath),
      path: targetPath,
      relativePath: relativeWorkspacePath(targetPath),
      kind: "file",
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
    }];
  }

  let entries = [];
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  return entries
    .map((entry) => {
      const fullPath = path.join(targetPath, entry.name);
      const entryStat = safeStat(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        relativePath: relativeWorkspacePath(fullPath),
        kind: entry.isDirectory() ? "directory" : "file",
        modifiedAt: entryStat ? new Date(entryStat.mtimeMs).toISOString() : "",
      };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

function listInboxItems(inboxPath) {
  let entries = [];
  try {
    entries = fs.readdirSync(inboxPath, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  const hiddenIds = loadHiddenEmailIds();
  const workspaceHiddenIds = loadWorkspaceInboxHiddenIds();
  const sourceDeletedUids = loadSourceDeletedInboxUids();
  const manualImportedRefs = loadManualImportedInboxRefs();
  const orderLearning = loadOrderLearningStore();
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".eml"))
    .map((entry) => {
      const fullPath = path.join(inboxPath, entry.name);
      const item = {
        path: fullPath,
        relativePath: relativeWorkspacePath(fullPath),
        ...extractEmailMetadata(fullPath),
      };
      const itemId = String(item.email_id || "").trim();
      const savedUid = String(item.imap_uid || "").trim();
      const orderFlag = orderLearning.order_flags[itemId] ?? orderLearning.order_flags[savedUid];
      const flagged = orderFlag === true;
      const notOrder = orderFlag === false;
      const linkedMap = orderLearning.linked_order_ids || {};
      const linkedOrderId = String(linkedMap[itemId] || linkedMap[savedUid] || "").trim();
      const manualImported = getInboxItemManualImportRefs(item).some((ref) => manualImportedRefs.has(ref));
      return {
        ...item,
        manual_imported: manualImported,
        order_flagged: flagged,
        order_not_order: notOrder,
        order_score: flagged ? 100 : notOrder ? 0 : scoreOrderSuggestion(orderLearning, item),
        source_deleted: savedUid ? sourceDeletedUids.has(savedUid) : false,
        ...(linkedOrderId ? { linked_order_id: linkedOrderId } : {}),
      };
    })
    .filter((item) => {
      const itemId = String(item.email_id || "").trim();
      const savedUid = String(item.imap_uid || "").trim();
      const globallyHidden = hiddenIds.has(itemId) || hiddenIds.has(savedUid);
      const workspaceOnlyHidden = workspaceHiddenIds.has(itemId) || workspaceHiddenIds.has(savedUid);
      return !globallyHidden && !workspaceOnlyHidden;
    })
    .sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || "")));
}

function getWorkspaceBucketPath(dirs, bucket) {
  if (bucket === "Inbox") {
    return dirs.InboxModule;
  }
  return dirs[bucket];
}

function makeUniqueFilePath(targetPath) {
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  const dir = path.dirname(targetPath);
  let candidate = targetPath;
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

function getSupportAppInfo() {
  return {
    appName: getBrandName(),
    version: app.getVersion(),
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  };
}

function moveInboxItemToCurrent(filePath) {
  const dirs = getWorkspaceDirs();
  const sourcePath = String(filePath || "").trim();
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error("Inbox file path is required.");
  }
  const normalizedInboxDir = path.normalize(dirs.InboxModule);
  const normalizedSource = path.normalize(sourcePath);
  if (!normalizedSource.startsWith(normalizedInboxDir)) {
    throw new Error("Inbox file is outside the managed inbox.");
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error("Inbox file no longer exists.");
  }
  return sourcePath;
}

function filterAttachmentFiles(files, mode, extensions) {
  let filtered = Array.isArray(files) ? [...files] : [];
  if (mode === "images") {
    filtered = filtered.filter((filePath) => /\.(jpe?g|png|gif|bmp|webp)$/i.test(filePath));
  } else if (mode === "extension" && extensions?.length) {
    const exts = extensions.map((value) => String(value).toLowerCase().replace(/^\./, ""));
    filtered = filtered.filter((filePath) => exts.includes(path.extname(filePath).toLowerCase().replace(".", "")));
  }
  return filtered;
}

function listAttachmentFilesFromPath(targetPath, mode, extensions) {
  if (!targetPath || mode === "none") {
    return [];
  }
  const stat = safeStat(targetPath);
  if (!stat) {
    return [];
  }
  if (stat.isDirectory()) {
    try {
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(targetPath, entry.name));
      return filterAttachmentFiles(files, mode, extensions);
    } catch (_error) {
      return [];
    }
  }
  return filterAttachmentFiles([targetPath], mode, extensions);
}

function resolveAttachmentPayload({ orderFolderPath, sourceEmlPath, mode, extensions }) {
  const warnings = [];
  if (mode === "none") {
    return { files: [], source: "none", sourcePath: "", warnings };
  }

  const fromOrderFolder = listAttachmentFilesFromPath(orderFolderPath, mode, extensions);
  if (fromOrderFolder.length) {
    if (fromOrderFolder.length > 1) {
      warnings.push(`Multiple attachments found (${fromOrderFolder.length} files)`);
    }
    return {
      files: fromOrderFolder,
      source: "order_folder_path",
      sourcePath: orderFolderPath,
      warnings,
    };
  }

  const fromSourcePath = listAttachmentFilesFromPath(sourceEmlPath, mode, extensions);
  if (fromSourcePath.length) {
    if (fromSourcePath.length > 1) {
      warnings.push(`Multiple attachments found (${fromSourcePath.length} files)`);
    }
    return {
      files: fromSourcePath,
      source: "source_eml_path",
      sourcePath: sourceEmlPath,
      warnings,
    };
  }

  warnings.push("Attachments not ready yet");
  return {
    files: [],
    source: "not_ready",
    sourcePath: "",
    warnings,
  };
}

function startHelper() {
  if (helperProcess) return;
  const settings = loadHelperSettings();
  if (settings.runInBackground === false) {
    helperStatus = "stopped";
    appendHelperLog("info", "Helper start skipped because background helper is disabled.");
    return;
  }

  // Spawn tray_app.py — it owns the tray icon and starts sync_folders.py internally
  helperProcess = spawn("py", [path.join(ROOT, "helper", "tray_app.py")], {
    cwd: ROOT,
    detached: false,
    windowsHide: false,   // must be false so the tray icon can attach to the shell
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      SPALIA_HELPER_SETTINGS_PATH: getHelperSettingsPath(),
      SPALIA_DUPLICATE_HANDLING: settings.duplicateHandling,
      SPALIA_UNMATCHED_HANDLING: settings.unmatchedHandling,
      SPAILA_HELPER_SETTINGS_PATH: getHelperSettingsPath(),
      SPAILA_DUPLICATE_HANDLING: settings.duplicateHandling,
      SPAILA_UNMATCHED_HANDLING: settings.unmatchedHandling,
    },
  });
  helperStatus = "running";
  helperLastError = "";

  helperProcess.stdout.on("data", (data) => {
    const text = data.toString().trimEnd();
    console.log("[HELPER]", text);
    appendHelperLog("info", text);
  });

  helperProcess.stderr.on("data", (data) => {
    const text = data.toString().trimEnd();
    console.error("[HELPER ERR]", text);
    appendHelperLog("error", text);
  });

  helperProcess.on("error", (err) => {
    helperStatus = "error";
    appendHelperLog("error", err.message);
    console.error("[HELPER SPAWN ERROR]", err.message);
    helperProcess = null;
  });

  helperProcess.on("close", (code) => {
    helperProcess = null;
    helperStatus = code === 0 ? "stopped" : "error";
    appendHelperLog(code === 0 ? "info" : "error", `Helper exited with code ${code}.`);
    if (helperRestarting) return;     // Electron is quitting — don't restart
    if (helperStopRequested) {
      helperStopRequested = false;
      return;
    }
    if (code === 0) return;           // User clicked "Exit" in tray — respect that
    if (loadHelperSettings().autoRestart === false) return;
    helperStatus = "restarting";
    appendHelperLog("info", "Helper restarting in 3 seconds.");
    console.log(`[HELPER EXITED] code=${code} — restarting in 3s…`);
    setTimeout(startHelper, 3000);
  });

  appendHelperLog("info", `Helper started pid ${helperProcess.pid}.`);
  console.log("[HELPER] started pid", helperProcess.pid);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: getBrandName(),
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[WINDOW render-process-gone]", details);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error("[WINDOW did-fail-load]", { errorCode, errorDescription, validatedURL, isMainFrame });
  });
  window.on("unresponsive", () => {
    console.error("[WINDOW unresponsive]");
  });
  window.on("close", (event) => {
    if (!backupInProgress && !restoreInProgress) return;
    const isRestore = restoreInProgress;
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      buttons: [isRestore ? "Keep Restore Running" : "Keep Backup Running", "Close Anyway"],
      defaultId: 0,
      cancelId: 0,
      title: withBrandTitle(isRestore ? "Restore in Progress" : "Backup in Progress"),
      message: isRestore
        ? "Restore in progress. Closing now may leave your workspace partially restored. Are you sure?"
        : "Backup in progress. Closing now may corrupt your backup. Are you sure?",
      detail: isRestore
        ? "Spaila is restoring a full workspace backup. It is safest to wait until restore completes."
        : "Spaila is creating or validating a full workspace backup. It is safest to wait until the backup completes.",
      noLink: true,
    });
    if (choice !== 1) {
      event.preventDefault();
    }
  });
  window.on("closed", () => {
    console.log("[WINDOW closed]");
  });

  window.removeMenu();
  window.maximize();
  window.show();
  window.loadFile(path.join(__dirname, "..", "ui", "index.html"));
  if (process.env.SPALIA_OPEN_DEVTOOLS === "1" || process.env.NODE_ENV === "development") {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed() && !window.webContents.isDevToolsOpened()) {
        window.webContents.openDevTools({ mode: "detach" });
      }
    });
  }
}

function runBridge(argsObj) {
  return new Promise((resolve, reject) => {
    const child = spawn("py", ["-3", "-m", "parser.ui_bridge", JSON.stringify(argsObj)], {
      cwd: path.join(__dirname, "..", ".."),
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try { child.kill(); } catch (_error) {}
      reject(new Error("Parser timed out while opening the email."));
    }, 15000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text); // forward parser debug logs to terminal in real-time
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `Parser exited with code ${code}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse parser output: ${error.message}`));
      }
    });
  });
}

function findWorkspaceFileByName(filePath) {
  const targetName = path.basename(String(filePath || "").trim()).toLowerCase();
  if (!targetName) {
    return null;
  }
  const dirs = getWorkspaceDirs();
  const roots = [dirs.Orders, dirs.Archive, dirs.Backup].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    const stack = [root];
    while (stack.length) {
      const current = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_error) {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.name.toLowerCase() === targetName) {
          return fullPath;
        }
      }
    }
  }
  return null;
}

async function fetchOrderPathCandidates(orderNumber) {
  if (!orderNumber) {
    return [];
  }

  // Hard 3-second timeout so a restarting/crashed backend never hangs IPC
  // calls and leaves the UI frozen with loading=true.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch("http://127.0.0.1:8055/orders", {
      signal: controller.signal,
    });
    if (!response.ok) {
      return [];
    }

    const orders = await response.json();
    return orders
      .filter((order) => String(order.order_number || "") === String(orderNumber))
      .flatMap((order) => [order.eml_path, order.source_eml_path])
      .filter(Boolean);
  } catch (_error) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function findOriginalEmlInOrders(orderNumber) {
  if (!orderNumber) {
    return null;
  }

  const ordersRoot = getWorkspaceDirs().Orders;
  if (!fs.existsSync(ordersRoot)) {
    return null;
  }

  const stack = [ordersRoot];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.includes(String(orderNumber))) {
          const original = path.join(fullPath, "original.eml");
          if (fs.existsSync(original)) {
            return original;
          }
        }
        stack.push(fullPath);
      }
    }
  }

  return null;
}

async function resolveParserPath(payload) {
  const originalPath = payload.filePath;
  const orderNumber = payload.orderNumber || payload.decision?.order_number || payload.orderNumberValue;
  const candidates = Array.from(new Set([
    originalPath,
    ...(await fetchOrderPathCandidates(orderNumber)),
    findOriginalEmlInOrders(orderNumber),
    findWorkspaceFileByName(originalPath),
  ].filter(Boolean)));

  const resolvedPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolvedPath) {
    throw new Error("Email file not found. It may have been moved.");
  }

  return resolvedPath;
}

ipcMain.handle("parser:parse-file", async (_event, { filePath, businessTimezone }) => {
  if (!filePath) throw new Error("No file path provided.");
  const resolvedPath = await resolveParserPath({ filePath });
  const parsed = await runBridge({ action: "parse", path: resolvedPath, businessTimezone: String(businessTimezone || "").trim() });
  if (parsed.error) throw new Error(parsed.error);
  return { filePath: resolvedPath, ...parsed };
});


ipcMain.handle("parser:teach", async (_event, payload) => {
  const parsed = await runBridge({
    action: payload.action,
    path: payload.filePath,
    decision: payload.decision,
    businessTimezone: String(payload.businessTimezone || "").trim(),
  });
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return {
    filePath: payload.filePath,
    ...parsed,
  };
});

ipcMain.handle("parser:save-assignment", async (_event, payload) => {
  const resolvedPath = await resolveParserPath(payload);
  const parsed = await runBridge({
    action: "save_assignment",
    path: resolvedPath,
    decision: payload.decision,
    businessTimezone: String(payload.businessTimezone || "").trim(),
  });
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return {
    filePath: resolvedPath,
    ...parsed,
  };
});

ipcMain.handle("parser:save-rejection", async (_event, payload) => {
  const resolvedPath = await resolveParserPath(payload);
  const parsed = await runBridge({
    action: "save_rejection",
    path: resolvedPath,
    decision: payload.decision,
    businessTimezone: String(payload.businessTimezone || "").trim(),
  });
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return {
    filePath: resolvedPath,
    ...parsed,
  };
});

ipcMain.handle("parser:learning-summary", async () => {
  const summary = await runBridge({ action: "learning_summary" });
  if (summary.error) {
    throw new Error(summary.error);
  }
  return summary;
});

ipcMain.handle("parser:reset-field-learning", async (_event, payload = {}) => {
  const field = String(payload.field || "").trim();
  if (!field) {
    throw new Error("No learning field provided.");
  }
  const result = await runBridge({ action: "reset_field_learning", field });
  if (result.error) {
    throw new Error(result.error);
  }
  return result;
});

ipcMain.handle("parser:resolve-path", async (_event, payload) => {
  const resolvedPath = await resolveParserPath(payload);
  return { path: resolvedPath };
});

ipcMain.handle("shell:open-folder", async (_event, folderPath) => {
  const rawPath = String(folderPath || "").trim();
  if (!rawPath) {
    console.error("[shell:open-folder] missing path");
    return { ok: false, error: "No folder path provided" };
  }
  if (!path.isAbsolute(rawPath)) {
    console.error("[shell:open-folder] path is not absolute:", rawPath);
    return { ok: false, error: "Folder path must be absolute" };
  }

  const stat = safeStat(rawPath);
  if (!stat) {
    console.error("[shell:open-folder] path does not exist:", rawPath);
    return { ok: false, error: "Folder path does not exist" };
  }

  const targetPath = stat.isDirectory() ? rawPath : path.dirname(rawPath);

  try {
    return await openFolderVisible(targetPath, "shell:open-folder");
  } catch (error) {
    console.error("[shell:open-folder] unexpected error:", targetPath, error);
    return { ok: false, error: error?.message || "Could not open folder" };
  }
});

ipcMain.handle("app:set-title", (_event, title) => {
  const nextTitle = String(title || "").trim() || DEFAULT_APP_NAME;
  currentBrandName = nextTitle;
  try { app.setName(nextTitle); } catch (_) {}
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.setTitle(nextTitle);
  return { ok: true, title: nextTitle };
});

ipcMain.handle("helper:get-state", async () => getHelperState());

ipcMain.handle("helper:save-settings", async (_event, payload = {}) => {
  const previous = loadHelperSettings();
  const next = saveHelperSettings(payload.settings || payload);
  appendHelperLog("info", "Helper settings saved.");
  if (previous.runInBackground !== next.runInBackground) {
    if (next.runInBackground) {
      startHelper();
    } else {
      killHelper({ intentional: true });
    }
  }
  return getHelperState();
});

ipcMain.handle("helper:restart", async () => {
  appendHelperLog("info", "Helper restart requested.");
  helperStatus = "restarting";
  killHelper({ intentional: true });
  setTimeout(startHelper, 500);
  return getHelperState();
});

ipcMain.handle("helper:open-logs", async () => {
  const supportFolder = path.join(app.getPath("userData"), "support");
  fs.mkdirSync(supportFolder, { recursive: true });
  const logPath = path.join(supportFolder, "helper-log.json");
  fs.writeFileSync(logPath, JSON.stringify(helperLogs, null, 2), "utf8");
  await openFolderVisible(supportFolder, "helper:open-logs");
  return { ok: true, path: logPath, folderPath: supportFolder };
});

ipcMain.handle("helper:open-folder", async (_event, payload = {}) => {
  const folders = getHelperFolderSummary();
  const key = String(payload.folder || payload.key || "").trim();
  const targetPath = key === "duplicates" ? folders.duplicates : key === "unmatched" ? folders.unmatched : "";
  if (!targetPath) {
    return { ok: false, error: "Unknown helper folder." };
  }
  fs.mkdirSync(targetPath, { recursive: true });
  return openFolderVisible(targetPath, "helper:open-folder");
});

ipcMain.handle("helper:clear-folder", async (_event, payload = {}) => {
  const folders = getHelperFolderSummary();
  const key = String(payload.folder || payload.key || "").trim();
  const targetPath = key === "duplicates" ? folders.duplicates : key === "unmatched" ? folders.unmatched : "";
  if (!targetPath) {
    return { ok: false, error: "Unknown helper folder." };
  }
  fs.mkdirSync(targetPath, { recursive: true });
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  let removed = 0;
  entries.forEach((entry) => {
    if (!entry.isFile()) return;
    fs.rmSync(path.join(targetPath, entry.name), { force: true });
    removed += 1;
  });
  appendHelperLog("info", `Cleared ${removed} file(s) from helper ${key} storage.`);
  return { ok: true, removed, ...getHelperState() };
});

ipcMain.handle("helper:pick-unmatched-folder", async (event) => {
  const window = getSenderWindow(event);
  const result = await dialog.showOpenDialog(window || undefined, {
    title: withBrandTitle("Choose Needs Review storage folder"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { ok: false, canceled: true };
  }
  const settings = saveHelperSettings({ ...loadHelperSettings(), unmatchedStoragePath: result.filePaths[0] });
  appendHelperLog("info", "Updated Needs Review storage folder.");
  return { ok: true, settings, ...getHelperState() };
});

ipcMain.handle("support:get-app-info", async () => {
  return { ok: true, appInfo: getSupportAppInfo() };
});

ipcMain.handle("support:create-diagnostics", async (_event, payload = {}) => {
  try {
    const supportFolder = path.join(app.getPath("userData"), "support");
    fs.mkdirSync(supportFolder, { recursive: true });
    const createdAt = new Date();
    const reportType = sanitizeFilenamePart(payload.type || "support", "support").toLowerCase().replace(/\s+/g, "-");
    const targetPath = makeUniqueFilePath(path.join(supportFolder, `${reportType}-${createdAt.toISOString().replace(/[:.]/g, "-")}.json`));
    const report = {
      createdAt: createdAt.toISOString(),
      appInfo: getSupportAppInfo(),
      context: {
        type: String(payload.type || "bug"),
        route: String(payload.route || ""),
        description: String(payload.description || ""),
        screenshotPath: String(payload.screenshotPath || ""),
      },
    };
    fs.writeFileSync(targetPath, JSON.stringify(report, null, 2), "utf8");
    return { ok: true, path: targetPath, folderPath: supportFolder, report };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not create support diagnostics." };
  }
});

ipcMain.handle("open-external", async (_event, url) => {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) {
    return { ok: false, error: "No URL provided." };
  }
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_error) {
    return { ok: false, error: "Invalid URL." };
  }
  if (!["https:", "http:", "mailto:"].includes(parsed.protocol)) {
    return { ok: false, error: "Unsupported external link type." };
  }
  await shell.openExternal(targetUrl);
  return { ok: true };
});

ipcMain.handle("orders:open-print-preview", async (event, payload = {}) => {
  const html = String(payload.html || "");
  if (!html.trim()) {
    return { ok: false, error: "No print content provided." };
  }

  const title = String(payload.title || "").trim() || "Print Preview";
  const parent = getSenderWindow(event) || undefined;
  const preview = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    show: false,
    parent,
    title: withBrandTitle(title),
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  preview.removeMenu();
  preview.once("ready-to-show", () => preview.show());
  await preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(injectBrandingIntoHtml(html, title))}`);
  return { ok: true };
});

ipcMain.handle("orders:export-print-pdf", async (_event, payload = {}) => {
  const html = String(payload.html || "");
  if (!html.trim()) {
    return { ok: false, error: "No print content provided." };
  }

  const title = String(payload.title || "").trim() || "Print";
  const isLandscape = payload.orientation === "landscape";
  const printWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    title: withBrandTitle(title),
    icon: APP_ICON,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    printWindow.removeMenu();
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(injectBrandingIntoHtml(html, title))}`);
    const pdfBuffer = await printWindow.webContents.printToPDF({
      landscape: isLandscape,
      printBackground: true,
      preferCSSPageSize: true,
    });

    const brand = sanitizeFilenamePart(getBrandName(), "Shop");
    const label = sanitizeFilenamePart(title, "Print");
    const outputPath = path.join(os.tmpdir(), `${brand} ${label}.pdf`);
    fs.writeFileSync(outputPath, pdfBuffer);

    const openError = await shell.openPath(outputPath);
    if (openError) {
      return { ok: false, error: openError };
    }

    return { ok: true, path: outputPath };
  } catch (error) {
    return { ok: false, error: error.message || "Failed to export print PDF." };
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.close();
    }
  }
});

// ── Gift message → letterhead PDF overlay ────────────────────────────────
ipcMain.handle("documents:generate-gift-letter", async (_event, {
  letterheadPath,
  giftMessage,
  textX        = 72,
  textY        = 500,
  textMaxWidth = 450,
  textFontSize = 12,
  textColor    = "#000000",
}) => {
  try {
    const { PDFDocument, rgb, StandardFonts, PageSizes } = require("pdf-lib");

    // Load letterhead if provided, otherwise create a blank letter-size page
    let pdfDoc;
    if (letterheadPath && fs.existsSync(letterheadPath)) {
      const pdfBytes = fs.readFileSync(letterheadPath);
      pdfDoc = await PDFDocument.load(pdfBytes);
    } else {
      pdfDoc = await PDFDocument.create();
      pdfDoc.addPage(PageSizes.Letter); // 612 × 792 pt
    }
    const pages    = pdfDoc.getPages();
    if (!pages.length) throw new Error("Letterhead PDF has no pages.");
    const page = pages[0];

    // Embed a standard font
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Parse hex color → pdf-lib rgb (0–1 range)
    function hexToRgb(hex) {
      const h = hex.replace("#", "");
      return rgb(
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255
      );
    }
    const color = hexToRgb(textColor || "#000000");

    // Word-wrap the gift message to honour maxWidth
    const words   = giftMessage.split(" ");
    const lines   = [];
    let   current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(test, textFontSize) > textMaxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);

    // Also honour literal newlines in the message
    const finalLines = lines.flatMap((l) => l.split(/\r?\n/));

    // Draw each line top-to-bottom (Y decreases per line)
    const lineHeight = textFontSize * 1.4;
    finalLines.forEach((line, idx) => {
      page.drawText(line, {
        x:    textX,
        y:    textY - idx * lineHeight,
        size: textFontSize,
        font,
        color,
      });
    });

    // Save to a temp file and open it
    const outBytes  = await pdfDoc.save();
    const tmpPath   = path.join(os.tmpdir(), `spaila_gift_letter_${Date.now()}.pdf`);
    fs.writeFileSync(tmpPath, outBytes);
    await shell.openPath(tmpPath);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Full backup / restore ─────────────────────────────────────────────────

const DB_PATH = path.join(ROOT, "spaila.db");
const BACKUP_VERSION = 2;
const BACKUP_KIND = "spaila-full-workspace-backup";
const QUICK_BACKUP_KIND = "spaila-incremental-workspace-backup";
const SUPPORTED_BACKUP_VERSIONS = new Set([2]);
const MAX_INCREMENTAL_CHAIN = 20;
const MAX_INCREMENTAL_CHANGE_RATIO = 0.35;

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function copyDirectoryRecursive(sourceDir, targetDir, options = {}) {
  const shouldExclude = typeof options.exclude === "function" ? options.exclude : () => false;
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(sourceDir, sourcePath);
    if (shouldExclude(sourcePath, relativePath, entry)) continue;
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, targetPath, {
        exclude: (childPath, childRelative, childEntry) => {
          const nestedRelative = path.join(entry.name, childRelative);
          return shouldExclude(childPath, nestedRelative, childEntry);
        },
      });
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

async function copyDirectoryRecursiveAsync(sourceDir, targetDir, options = {}) {
  const shouldExclude = typeof options.exclude === "function" ? options.exclude : () => false;
  if (!fs.existsSync(sourceDir)) return;
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(sourceDir, sourcePath);
    if (shouldExclude(sourcePath, relativePath, entry)) continue;
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursiveAsync(sourcePath, targetPath, {
        exclude: (childPath, childRelative, childEntry) => {
          const nestedRelative = path.join(entry.name, childRelative);
          return shouldExclude(childPath, nestedRelative, childEntry);
        },
      });
    } else if (entry.isFile()) {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

function clearDirectoryContents(targetDir, options = {}) {
  if (!fs.existsSync(targetDir)) return;
  const shouldKeep = typeof options.keep === "function" ? options.keep : () => false;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    const targetPath = path.join(targetDir, entry.name);
    if (shouldKeep(targetPath, entry)) continue;
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function emailLifecycleIndexPath() {
  return path.join(getWorkspaceDirs().Internal, "email_retention_index.json");
}

function loadEmailLifecycleIndex() {
  try {
    const indexPath = emailLifecycleIndexPath();
    if (!fs.existsSync(indexPath)) return { version: 1, records: {} };
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    return {
      version: 1,
      migration_version: parsed?.migration_version || "email_archive_v1",
      updated_at: parsed?.updated_at || "",
      records: parsed?.records && typeof parsed.records === "object" ? parsed.records : {},
    };
  } catch (_error) {
    return { version: 1, records: {} };
  }
}

function saveEmailLifecycleIndex(index) {
  const indexPath = emailLifecycleIndexPath();
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify({
    version: 1,
    migration_version: "email_archive_v1",
    updated_at: new Date().toISOString(),
    records: index?.records && typeof index.records === "object" ? index.records : {},
  }, null, 2), "utf8");
}

function safeLifecycleToken(value, fallback = "unknown") {
  const token = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "").slice(0, 80);
  return token || fallback;
}

function uniqueLifecyclePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const stem = path.basename(targetPath, ext);
  let suffix = 1;
  while (true) {
    const candidate = path.join(dir, `${stem}__${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    suffix += 1;
  }
}

function findInboxFileForLifecycle(emailId, imapUid) {
  const dirs = getWorkspaceDirs();
  let entries = [];
  try {
    entries = fs.readdirSync(dirs.InboxModule, { withFileTypes: true });
  } catch (_error) {
    return "";
  }
  const wanted = new Set([String(emailId || "").trim(), String(imapUid || "").trim()].filter(Boolean));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".eml")) continue;
    const fullPath = path.join(dirs.InboxModule, entry.name);
    const metadata = extractEmailMetadata(fullPath);
    if (wanted.has(String(metadata.email_id || "").trim()) || wanted.has(String(metadata.imap_uid || "").trim())) {
      return fullPath;
    }
  }
  return "";
}

function archiveAndDeactivateInboxFile(filePath, reason = "handled") {
  const dirs = getWorkspaceDirs();
  const sourcePath = String(filePath || "").trim();
  if (!sourcePath || !path.isAbsolute(sourcePath) || !fs.existsSync(sourcePath)) {
    return { ok: false, reason: "source_missing" };
  }
  const inboxRoot = path.resolve(dirs.InboxModule).toLowerCase();
  const resolvedSource = path.resolve(sourcePath);
  if (!resolvedSource.toLowerCase().startsWith(inboxRoot)) {
    return { ok: false, reason: "outside_inbox", path: sourcePath };
  }

  const metadata = extractEmailMetadata(resolvedSource);
  const checksum = sha256File(resolvedSource);
  const received = Number.isFinite(Date.parse(metadata.received_at || "")) ? new Date(metadata.received_at) : new Date();
  const archiveDir = path.join(
    dirs.Internal,
    "email_archive",
    String(received.getUTCFullYear()),
    String(received.getUTCMonth() + 1).padStart(2, "0"),
  );
  fs.mkdirSync(archiveDir, { recursive: true });
  const archiveName = `${received.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}_${safeLifecycleToken(metadata.imap_uid || metadata.email_id)}_${checksum.slice(0, 12)}.eml`;
  const archivePath = uniqueLifecyclePath(path.join(archiveDir, archiveName));
  const tmpPath = `${archivePath}.tmp`;
  fs.copyFileSync(resolvedSource, tmpPath);
  if (sha256File(tmpPath) !== checksum) {
    fs.rmSync(tmpPath, { force: true });
    return { ok: false, reason: "archive_checksum_failed", path: resolvedSource };
  }
  fs.renameSync(tmpPath, archivePath);
  if (sha256File(archivePath) !== checksum) {
    return { ok: false, reason: "archive_verify_failed", path: resolvedSource };
  }

  const inactiveDir = path.join(dirs.Internal, "inbox_inactive", new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  fs.mkdirSync(inactiveDir, { recursive: true });
  const inactivePath = uniqueLifecyclePath(path.join(inactiveDir, path.basename(resolvedSource)));
  fs.renameSync(resolvedSource, inactivePath);

  const messageId = String(metadata.email_id || "").trim();
  const uid = String(metadata.imap_uid || "").trim();
  const key = messageId.includes("@") ? `message:${messageId.toLowerCase().replace(/^<|>$/g, "")}` : uid ? `uid:${uid.toLowerCase()}` : `sha256:${checksum}`;
  const index = loadEmailLifecycleIndex();
  index.records[key] = {
    ...(index.records[key] || {}),
    email_id: messageId,
    message_id: messageId.includes("@") ? messageId.toLowerCase().replace(/^<|>$/g, "") : "",
    uid,
    checksum,
    original_inbox_path: resolvedSource,
    archive_path: archivePath,
    inactive_path: inactivePath,
    inactive_reason: reason,
    status: "inactive_archived",
    archived_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    migration_version: "email_archive_v1",
    verified: true,
  };
  saveEmailLifecycleIndex(index);
  console.log("[INBOX_LIFECYCLE_MOVE]", {
    source: resolvedSource,
    inactive_path: inactivePath,
    archive_path: archivePath,
    reason,
  });
  return { ok: true, archive_path: archivePath, inactive_path: inactivePath, reason };
}

function sha256FileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function readAppPackageVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return String(packageJson.version || app.getVersion() || "");
  } catch (_error) {
    return String(app.getVersion() || "");
  }
}

function readParserVersion() {
  try {
    const regressionAuditPath = path.join(ROOT, "parser", "regression_audit.py");
    const raw = fs.readFileSync(regressionAuditPath, "utf8");
    const match = raw.match(/return\s+["']([^"']+)["']\s*$/m);
    return match?.[1] || "0.1.0";
  } catch (_error) {
    return "0.1.0";
  }
}

function buildFileManifest(rootDir) {
  const files = [];
  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(filePath);
      files.push({
        path: path.relative(rootDir, filePath).split(path.sep).join("/"),
        size: stat.size,
        sha256: sha256File(filePath),
      });
    }
  }
  walk(rootDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function buildFileManifestAsync(rootDir) {
  const filePaths = [];
  async function walk(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      filePaths.push(filePath);
    }
  }
  await walk(rootDir);
  const files = [];
  let cursor = 0;
  const workerCount = Math.min(4, Math.max(1, filePaths.length));
  async function worker() {
    while (cursor < filePaths.length) {
      const filePath = filePaths[cursor];
      cursor += 1;
      const stat = await fsp.stat(filePath);
      files.push({
        path: path.relative(rootDir, filePath).split(path.sep).join("/"),
        size: stat.size,
        sha256: await sha256FileAsync(filePath),
      });
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function checksumManifestFiles(files) {
  const hash = crypto.createHash("sha256");
  files.forEach((file) => {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\n");
  });
  return hash.digest("hex");
}

function normalizeBackupRelativePath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function getBackupIndexPath(dirs = getWorkspaceDirs()) {
  return path.join(dirs.Internal, "backup_index.json");
}

function loadBackupIndex(dirs = getWorkspaceDirs()) {
  try {
    const indexPath = getBackupIndexPath(dirs);
    if (!fs.existsSync(indexPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (!parsed || parsed.version !== 1 || !parsed.baseline?.filename) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

async function saveBackupIndex(dirs, index) {
  await fsp.mkdir(dirs.Internal, { recursive: true });
  await fsp.writeFile(getBackupIndexPath(dirs), JSON.stringify(index, null, 2), "utf8");
}

function backupIndexBaselineExists(index, targetFolder) {
  if (!index?.baseline?.filename) return false;
  return fs.existsSync(path.join(targetFolder, index.baseline.filename));
}

async function scanWorkspaceFiles(dirs, indexFiles = {}) {
  const records = [];
  async function walk(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(currentDir, entry.name);
      if (path.resolve(filePath).toLowerCase().startsWith(path.resolve(dirs.Backup).toLowerCase())) continue;
      const relativePath = normalizeBackupRelativePath(path.relative(dirs.root, filePath));
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fsp.stat(filePath);
      const previous = indexFiles[relativePath];
      const sameSignature = previous
        && Number(previous.size) === stat.size
        && Number(previous.mtimeMs) === Math.round(stat.mtimeMs);
      records.push({
        path: relativePath,
        sourcePath: filePath,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        sha256: sameSignature ? previous.sha256 : "",
        changed: !sameSignature,
      });
    }
  }
  await walk(dirs.root);
  records.sort((a, b) => a.path.localeCompare(b.path));
  return records;
}

async function hashChangedRecords(records) {
  const changed = records.filter((record) => record.changed || !record.sha256);
  let cursor = 0;
  const workerCount = Math.min(4, Math.max(1, changed.length));
  async function worker() {
    while (cursor < changed.length) {
      const record = changed[cursor];
      cursor += 1;
      record.sha256 = await sha256FileAsync(record.sourcePath);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return records;
}

function recordsToIndexMap(records) {
  return Object.fromEntries(records.map((record) => [record.path, {
    size: record.size,
    mtimeMs: record.mtimeMs,
    sha256: record.sha256,
  }]));
}

function recordsToManifestFiles(records, prefix = "workspace/") {
  return records.map((record) => ({
    path: `${prefix}${record.path}`,
    size: record.size,
    sha256: record.sha256,
  })).sort((a, b) => a.path.localeCompare(b.path));
}

function shouldCreateFullBaseline(index, targetFolder, changedBytes, totalBytes) {
  if (!backupIndexBaselineExists(index, targetFolder)) return { full: true, reason: "missing-baseline" };
  const incrementalCount = Array.isArray(index.incrementals) ? index.incrementals.length : 0;
  if (incrementalCount >= MAX_INCREMENTAL_CHAIN) return { full: true, reason: "refresh-chain-length" };
  if (totalBytes > 0 && changedBytes / totalBytes > MAX_INCREMENTAL_CHANGE_RATIO) {
    return { full: true, reason: "refresh-change-ratio" };
  }
  return { full: false, reason: "quick" };
}

function runPowerShell(script, fallbackError) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || fallbackError));
      }
    });
  });
}

function listBackupInventory(backupDir) {
  try {
    return fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(zip|spailabackup)$/i.test(entry.name))
      .map((entry) => {
        const filePath = path.join(backupDir, entry.name);
        const stat = fs.statSync(filePath);
        return {
          name: entry.name,
          size: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
        };
      })
      .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  } catch (_error) {
    return [];
  }
}

async function createZipArchive(sourceDir, zipPath) {
  if (process.platform !== "win32") {
    throw new Error("Compressed workspace backups are currently supported on Windows.");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `if (Test-Path -LiteralPath '${zipPath.replaceAll("'", "''")}') { Remove-Item -LiteralPath '${zipPath.replaceAll("'", "''")}' -Force }`,
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${sourceDir.replaceAll("'", "''")}', '${zipPath.replaceAll("'", "''")}', [System.IO.Compression.CompressionLevel]::Fastest, $false)`,
  ].join("\n");
  await runPowerShell(script, "Could not create backup archive.");
}

async function expandZipArchive(zipPath, targetDir) {
  if (process.platform !== "win32") {
    throw new Error("Compressed workspace restore is currently supported on Windows.");
  }
  fs.mkdirSync(targetDir, { recursive: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Expand-Archive -Path '${zipPath.replaceAll("'", "''")}' -DestinationPath '${targetDir.replaceAll("'", "''")}' -Force`,
  ].join("\n");
  await runPowerShell(script, "Could not expand backup archive.");
}

function resolveBackupPackageRoot(expandedRoot) {
  const nestedPackageRoot = path.join(expandedRoot, "spaila_backup");
  if (fs.existsSync(path.join(nestedPackageRoot, "backup-manifest.json"))) {
    return nestedPackageRoot;
  }
  if (fs.existsSync(path.join(expandedRoot, "backup-manifest.json"))) {
    return expandedRoot;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(expandedRoot).slice(0, 12);
  } catch (_error) {}
  throw new Error(`Backup manifest was not found after extraction. Checked ${nestedPackageRoot} and ${expandedRoot}. Extracted entries: ${entries.join(", ") || "none"}.`);
}

async function validateBackupManifest(packageRoot) {
  const manifestPath = path.join(packageRoot, "backup-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Backup manifest was not found.");
  }
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (![BACKUP_KIND, QUICK_BACKUP_KIND].includes(manifest.kind)) {
    throw new Error("Unsupported backup package.");
  }
  if (!SUPPORTED_BACKUP_VERSIONS.has(Number(manifest.backupVersion))) {
    throw new Error(`Unsupported backup version: ${manifest.backupVersion || "unknown"}.`);
  }
  if (!manifest.sections?.workspace) {
    throw new Error("Backup is missing the workspace section.");
  }
  if (!fs.existsSync(path.join(packageRoot, "workspace"))) {
    throw new Error("Backup workspace payload was not found.");
  }
  const files = (await buildFileManifestAsync(packageRoot))
    .filter((file) => !["backup-manifest.json", "backup-metadata.json"].includes(file.path));
  const checksum = checksumManifestFiles(files);
  if (checksum !== manifest.checksum) {
    throw new Error("Backup checksum validation failed.");
  }
  return manifest;
}

async function validateZipArchive(zipPath) {
  if (process.platform !== "win32") {
    throw new Error("Compressed workspace backup validation is currently supported on Windows.");
  }
  const safeZipPath = zipPath.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [System.IO.Compression.ZipFile]::OpenRead('${safeZipPath}')`,
    "try {",
    "  $entries = @($zip.Entries | Where-Object { $_.FullName -and -not $_.FullName.EndsWith('/') })",
    "  $manifestEntry = $entries | Where-Object { $_.FullName -eq 'backup-manifest.json' -or $_.FullName -eq 'spaila_backup/backup-manifest.json' -or $_.FullName -eq 'spaila_backup\\backup-manifest.json' } | Select-Object -First 1",
    "  if (-not $manifestEntry) { throw 'Backup manifest was not found in archive.' }",
    "  $reader = [System.IO.StreamReader]::new($manifestEntry.Open())",
    "  try { $manifestRaw = $reader.ReadToEnd() } finally { $reader.Dispose() }",
    "  $names = @($entries | ForEach-Object { $_.FullName })",
    "  [pscustomobject]@{",
    "    manifestRaw = $manifestRaw",
    "    entryCount = $entries.Count",
    "    hasWorkspace = [bool]($names | Where-Object { $_ -like 'workspace/*' -or $_ -like 'workspace\\*' -or $_ -like 'spaila_backup/workspace/*' -or $_ -like 'spaila_backup\\workspace\\*' } | Select-Object -First 1)",
    "    hasLocalStorage = [bool]($names | Where-Object { $_ -eq 'localStorage.json' -or $_ -eq 'spaila_backup/localStorage.json' -or $_ -eq 'spaila_backup\\localStorage.json' } | Select-Object -First 1)",
    "  } | ConvertTo-Json -Compress",
    "} finally {",
    "  $zip.Dispose()",
    "}",
  ].join("\n");
  const result = await runPowerShell(script, "Could not validate backup archive.");
  const validation = JSON.parse(String(result.stdout || "").trim());
  const manifest = JSON.parse(validation.manifestRaw);
  if (![BACKUP_KIND, QUICK_BACKUP_KIND].includes(manifest.kind)) {
    throw new Error("Unsupported backup package.");
  }
  if (!SUPPORTED_BACKUP_VERSIONS.has(Number(manifest.backupVersion))) {
    throw new Error(`Unsupported backup version: ${manifest.backupVersion || "unknown"}.`);
  }
  if (!manifest.sections?.workspace || !validation.hasWorkspace) {
    throw new Error("Backup archive is missing the workspace section.");
  }
  if (!validation.hasLocalStorage) {
    throw new Error("Backup archive is missing settings data.");
  }
  const payloadEntryCount = Number(validation.entryCount || 0) - 2;
  if (Number.isFinite(Number(manifest.fileCount)) && payloadEntryCount < Number(manifest.fileCount)) {
    throw new Error("Backup archive file count is lower than the manifest file count.");
  }
  return manifest;
}

function emitBackupProgress(event, stage, message, details = {}) {
  try {
    event?.sender?.send("backup:progress", {
      stage,
      message,
      timestamp: new Date().toISOString(),
      ...details,
    });
  } catch (_) {}
}

function emitRestoreProgress(event, stage, message, details = {}) {
  try {
    event?.sender?.send("restore:progress", {
      stage,
      message,
      timestamp: new Date().toISOString(),
      ...details,
    });
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryFsOperation(operation, description, { attempts = 5, delayMs = 450 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const code = error?.code || "";
      const retryable = ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code);
      if (!retryable || attempt === attempts) break;
      await sleep(delayMs * attempt);
    }
  }
  const code = lastError?.code ? ` (${lastError.code})` : "";
  throw new Error(`${description} failed${code}: ${lastError?.message || "unknown filesystem lock"}`);
}

function describeFsError(error) {
  const code = error?.code ? ` (${error.code})` : "";
  return `${error?.message || "unknown filesystem lock"}${code}`;
}

async function movePathWithPowerShell(sourcePath, targetPath) {
  if (process.platform !== "win32") {
    throw new Error("PowerShell move fallback is only available on Windows.");
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Move-Item -LiteralPath '${sourcePath.replaceAll("'", "''")}' -Destination '${targetPath.replaceAll("'", "''")}' -Force`,
  ].join("\n");
  await runPowerShell(script, `Could not move ${sourcePath}`);
}

async function stopBackgroundOperationsForRestore(onProgress = () => {}) {
  onProgress("suspend", "Stopping helper and file watchers.");
  killHelper({ intentional: true, silent: true });
  if (process.platform === "win32") {
    const helperRoot = ROOT.replaceAll("'", "''");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$root = '${helperRoot}'`,
      "$procs = Get-CimInstance Win32_Process | Where-Object {",
      "  $_.CommandLine -and (",
      "    $_.CommandLine -match 'helper[\\\\/]sync_folders\\.py' -or",
      "    $_.CommandLine -match 'helper[\\\\/]tray_app\\.py'",
      "  ) -and $_.CommandLine -like \"*$root*\"",
      "}",
      "$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ].join("\n");
    await runPowerShell(script, "Could not stop helper processes.");
  }
  await sleep(700);
}

async function moveWorkspaceAsideForRestore(dirs, onProgress = () => {}) {
  const timestamp = timestampForFilename();
  const restoreSafetyRoot = path.join(dirs.Backup, `pre_restore_workspace_${timestamp}`);
  await fsp.mkdir(restoreSafetyRoot, { recursive: true });
  const entries = await fsp.readdir(dirs.root, { withFileTypes: true });
  const moved = [];
  const copiedFallback = [];
  const diagnostics = [];
  for (const entry of entries) {
    if (entry.name.toLowerCase() === "backup") continue;
    const sourcePath = path.join(dirs.root, entry.name);
    const targetPath = path.join(restoreSafetyRoot, entry.name);
    onProgress("renaming", `Moving current ${entry.name} aside before restore.`);
    try {
      await retryFsOperation(
        async () => fsp.rename(sourcePath, targetPath),
        `Move current workspace item aside: ${sourcePath}`,
      );
      moved.push({ from: sourcePath, to: targetPath, method: "rename" });
      continue;
    } catch (renameError) {
      diagnostics.push(`Node rename failed for ${sourcePath}: ${describeFsError(renameError)}`);
    }
    try {
      await retryFsOperation(
        async () => movePathWithPowerShell(sourcePath, targetPath),
        `PowerShell move current workspace item aside: ${sourcePath}`,
        { attempts: 3, delayMs: 650 },
      );
      moved.push({ from: sourcePath, to: targetPath, method: "powershell-move" });
      continue;
    } catch (moveError) {
      diagnostics.push(`PowerShell move failed for ${sourcePath}: ${describeFsError(moveError)}`);
    }
    onProgress("renaming", `${entry.name} is locked. Preserving a safety copy and restoring over the active folder.`);
    await retryFsOperation(
      async () => copyDirectoryRecursiveAsync(sourcePath, targetPath),
      `Copy locked workspace item to safety location: ${sourcePath}`,
      { attempts: 3, delayMs: 650 },
    );
    copiedFallback.push({ from: sourcePath, to: targetPath, method: "copy-locked-fallback" });
    diagnostics.push(`Locked item preserved by copy fallback: ${sourcePath} -> ${targetPath}. Restore will merge over the active folder because it could not be renamed.`);
  }
  return { path: restoreSafetyRoot, moved, copiedFallback, diagnostics };
}

async function restoreAppDatabase(appDbPath, onProgress = () => {}) {
  if (!fs.existsSync(appDbPath)) return { restored: false };
  onProgress("database", "Restoring application database.");
  const dbSafetyPath = `${DB_PATH}.pre_restore_${timestampForFilename()}`;
  if (fs.existsSync(DB_PATH)) {
    await retryFsOperation(
      async () => fsp.rename(DB_PATH, dbSafetyPath),
      `Move existing database aside: ${DB_PATH}`,
    );
  }
  await retryFsOperation(
    async () => fsp.copyFile(appDbPath, DB_PATH),
    `Restore application database: ${DB_PATH}`,
  );
  return { restored: true, previousPath: fs.existsSync(dbSafetyPath) ? dbSafetyPath : "" };
}

async function deleteWorkspaceRelativePaths(root, deletedPaths = []) {
  for (const relativePath of deletedPaths) {
    const targetPath = path.join(root, ...String(relativePath || "").split("/"));
    if (!isWithinWorkspace(targetPath) || !fs.existsSync(targetPath)) continue;
    await retryFsOperation(
      async () => fsp.rm(targetPath, { recursive: true, force: true }),
      `Remove deleted path during incremental restore: ${targetPath}`,
      { attempts: 3, delayMs: 450 },
    );
  }
}

async function applyWorkspacePackage(packageRoot, dirs, manifest) {
  const workspaceSource = path.join(packageRoot, "workspace");
  if (!fs.existsSync(workspaceSource)) {
    throw new Error("Backup workspace payload was not found.");
  }
  if (manifest.kind === QUICK_BACKUP_KIND) {
    await deleteWorkspaceRelativePaths(dirs.root, manifest.deletedPaths || []);
  }
  await copyDirectoryRecursiveAsync(workspaceSource, dirs.root, {
    exclude: (_sourcePath, relativePath) => (
      /^Backup(?:[\\/]|$)/i.test(relativePath)
      || relativePath === "_incremental_marker.json"
    ),
  });
}

function resolveBackupChainPaths(selectedBackupPath, manifest, targetFolder) {
  if (manifest.kind !== QUICK_BACKUP_KIND) {
    return [selectedBackupPath];
  }
  const baselinePath = path.join(targetFolder, manifest.baselineFilename || "");
  if (!manifest.baselineFilename || !fs.existsSync(baselinePath)) {
    throw new Error(`Quick backup restore requires baseline backup: ${manifest.baselineFilename || "missing"}`);
  }
  const previous = Array.isArray(manifest.previousIncrementals) ? manifest.previousIncrementals : [];
  const previousPaths = previous.map((filename) => {
    const candidate = path.join(targetFolder, filename);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Quick backup restore chain is missing incremental backup: ${filename}`);
    }
    return candidate;
  });
  return [baselinePath, ...previousPaths, selectedBackupPath];
}

function pruneBackups(targetFolder, maxBackups = 30, keepFilenames = []) {
  try {
    const keep = new Set((keepFilenames || []).map((name) => String(name || "").toLowerCase()).filter(Boolean));
    const allFiles = fs.readdirSync(targetFolder)
      .filter((file) => /\.(zip|spailabackup)$/i.test(file))
      .map((name) => ({ name, mtime: fs.statSync(path.join(targetFolder, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    const excess = allFiles.length - maxBackups;
    for (let i = 0; i < excess; i += 1) {
      if (keep.has(allFiles[i].name.toLowerCase())) continue;
      try { fs.unlinkSync(path.join(targetFolder, allFiles[i].name)); } catch (_) {}
    }
  } catch (_) {}
}

async function buildWorkspaceBackupPackage({
  targetFolder,
  localStorageData,
  reason = "manual",
  onProgress = () => {},
  backupType = "full",
  updateIndex = true,
  pruneKeepFilenames = [],
}) {
  const dirs = ensureWorkspaceLayout((message) => console.log(message));
  const createdAt = new Date();
  const timingStartMs = Date.now();
  let lastTimingMs = timingStartMs;
  const timings = [];
  function markTiming(stage) {
    const now = Date.now();
    timings.push({
      stage,
      elapsedMs: now - timingStartMs,
      deltaMs: now - lastTimingMs,
    });
    lastTimingMs = now;
  }
  const timestamp = timestampForFilename(createdAt);
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spaila-backup-"));
  const packageRoot = path.join(stagingRoot, "spaila_backup");
  const workspaceTarget = path.join(packageRoot, "workspace");
  const appTarget = path.join(packageRoot, "app");
  const filename = `spaila_backup_${timestamp}.zip`;
  const dest = path.join(targetFolder, filename);
  const partialDest = path.join(stagingRoot, `${filename}.partial.zip`);
  try {
    onProgress("start", "Starting full workspace backup.");
    await fsp.mkdir(workspaceTarget, { recursive: true });
    await fsp.mkdir(appTarget, { recursive: true });

    onProgress("scanning", "Scanning workspace and backup inventory.");
    const backupInventory = listBackupInventory(dirs.Backup);
    onProgress("copying", "Backing up orders, inbox files, archives, conversations, and attachments.");
    await copyDirectoryRecursiveAsync(dirs.root, workspaceTarget, {
      exclude: (sourcePath) => path.resolve(sourcePath).toLowerCase().startsWith(path.resolve(dirs.Backup).toLowerCase()),
    });
    markTiming("copying");
    if (fs.existsSync(dirs.Internal)) {
      onProgress("internal", "Backing up internal system recovery data.");
    }
    await fsp.mkdir(path.join(workspaceTarget, "Backup"), { recursive: true });
    await fsp.writeFile(path.join(workspaceTarget, "Backup", "_backup_inventory.json"), JSON.stringify(backupInventory, null, 2), "utf8");
    onProgress("database", "Backing up database and settings.");
    if (fs.existsSync(DB_PATH)) {
      await fsp.copyFile(DB_PATH, path.join(appTarget, "spaila.db"));
    }
    await fsp.writeFile(path.join(packageRoot, "localStorage.json"), JSON.stringify(localStorageData || {}, null, 2), "utf8");
    markTiming("database-and-settings");

    onProgress("manifest", "Generating backup manifest and checksums.");
    const includedFiles = await buildFileManifestAsync(packageRoot);
    markTiming("manifest-hashing");
    const baselineId = crypto.randomUUID();
    const manifest = {
      kind: BACKUP_KIND,
      appVersion: readAppPackageVersion(),
      parserVersion: readParserVersion(),
      backupVersion: BACKUP_VERSION,
      backupType,
      baselineId,
      createdAt: createdAt.toISOString(),
      timestamp,
      reason,
      workspaceRoot: dirs.root,
      sections: {
        workspace: true,
        appDatabase: fs.existsSync(DB_PATH),
        localStorage: true,
        internalRecoveryStorage: fs.existsSync(dirs.Internal),
        emailArchive: fs.existsSync(path.join(dirs.Internal, "email_archive")),
        emailRetentionIndex: fs.existsSync(path.join(dirs.Internal, "email_retention_index.json")),
        backupInventory: true,
        existingBackupArchives: false,
      },
      includedSections: [
        "workspace",
        "app",
        "localStorage",
        "internalRecoveryStorage",
        "emailArchive",
        "emailRetentionIndex",
        "backupInventory",
      ].filter((section) => {
        if (section === "app") return fs.existsSync(DB_PATH);
        if (section === "emailArchive") return fs.existsSync(path.join(dirs.Internal, "email_archive"));
        if (section === "emailRetentionIndex") return fs.existsSync(path.join(dirs.Internal, "email_retention_index.json"));
        return true;
      }),
      fileCount: includedFiles.length,
      payloadBytes: includedFiles.reduce((total, file) => total + file.size, 0),
      includedPaths: {
        workspace: "workspace/",
        appDatabase: fs.existsSync(DB_PATH) ? "app/spaila.db" : "",
        settings: "localStorage.json",
        internalRecoveryStorage: "workspace/.spaila_internal/",
        emailArchive: "workspace/.spaila_internal/email_archive/",
        emailRetentionIndex: "workspace/.spaila_internal/email_retention_index.json",
        backupInventory: "workspace/Backup/_backup_inventory.json",
      },
      checksumAlgorithm: "sha256",
      checksum: checksumManifestFiles(includedFiles),
      storageOptimization: {
        excludesExistingBackupArchives: true,
        reliesOnZipCompressionForDuplicateRecoveryFiles: true,
      },
    };
    await fsp.writeFile(path.join(packageRoot, "backup-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fsp.writeFile(path.join(packageRoot, "backup-metadata.json"), JSON.stringify(manifest, null, 2), "utf8");

    onProgress("compressing", "Compressing backup archive.", { fileCount: manifest.fileCount, payloadBytes: manifest.payloadBytes });
    fs.rmSync(partialDest, { force: true });
    fs.rmSync(dest, { force: true });
    await createZipArchive(packageRoot, partialDest);
    markTiming("compressing");
    onProgress("validating", "Validating archive integrity and manifest.");
    const archiveManifest = await validateZipArchive(partialDest);
    markTiming("validating");
    const archiveChecksum = await sha256FileAsync(partialDest);
    markTiming("archive-checksum");
    await fsp.rename(partialDest, dest);
    onProgress("finalizing", "Finalizing backup archive.", { filename });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    pruneBackups(targetFolder, 30, [filename, ...pruneKeepFilenames]);
    markTiming("finalizing");
    if (updateIndex) {
      const workspaceFiles = includedFiles
        .filter((file) => file.path.startsWith("workspace/") && file.path !== "workspace/Backup/_backup_inventory.json")
        .map((file) => ({
          ...file,
          path: file.path.slice("workspace/".length),
        }));
      const sourceRecords = await scanWorkspaceFiles(dirs, {});
      const workspaceHashByPath = Object.fromEntries(workspaceFiles.map((file) => [file.path, file.sha256]));
      await saveBackupIndex(dirs, {
        version: 1,
        updatedAt: new Date().toISOString(),
        workspaceRoot: dirs.root,
        baseline: {
          id: baselineId,
          filename,
          createdAt: manifest.createdAt,
          payloadBytes: manifest.payloadBytes,
          fileCount: manifest.fileCount,
        },
        incrementals: [],
        files: Object.fromEntries(sourceRecords.map((record) => [record.path, {
          size: record.size,
          sha256: workspaceHashByPath[record.path] || "",
          mtimeMs: record.mtimeMs,
        }])),
      });
    }
    onProgress("complete", "Backup archive validated and saved.", { filename });
    return {
      path: dest,
      filename,
      metadata: {
        ...archiveManifest,
        archiveChecksum,
        archiveBytes: (await fsp.stat(dest)).size,
        finalized: true,
        timings,
        quickBackup: false,
      },
    };
  } catch (error) {
    fs.rmSync(partialDest, { force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    onProgress("failed", error?.message || "Backup failed.");
    throw error;
  }
}

async function buildSafetyWorkspaceBackupPackage({ targetFolder, localStorageData, reason, onProgress, keepFilenames = [] }) {
  return buildWorkspaceBackupPackage({
    targetFolder,
    localStorageData,
    reason,
    onProgress,
    backupType: "safety-full",
    updateIndex: false,
    pruneKeepFilenames: keepFilenames,
  });
}

async function buildQuickWorkspaceBackupPackage({ targetFolder, localStorageData, index, onProgress = () => {} }) {
  const dirs = ensureWorkspaceLayout((message) => console.log(message));
  const createdAt = new Date();
  const timestamp = timestampForFilename(createdAt);
  const timingStartMs = Date.now();
  let lastTimingMs = timingStartMs;
  const timings = [];
  function markTiming(stage) {
    const now = Date.now();
    timings.push({ stage, elapsedMs: now - timingStartMs, deltaMs: now - lastTimingMs });
    lastTimingMs = now;
  }

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spaila-quick-backup-"));
  const packageRoot = path.join(stagingRoot, "spaila_backup");
  const workspaceTarget = path.join(packageRoot, "workspace");
  const appTarget = path.join(packageRoot, "app");
  const filename = `spaila_quick_backup_${timestamp}.zip`;
  const dest = path.join(targetFolder, filename);
  const partialDest = path.join(stagingRoot, `${filename}.partial.zip`);
  try {
    onProgress("start", "Starting quick incremental backup.");
    await fsp.mkdir(workspaceTarget, { recursive: true });
    await fsp.mkdir(appTarget, { recursive: true });

    onProgress("scanning", "Scanning for changed files.");
    const scanned = await scanWorkspaceFiles(dirs, index.files || {});
    const currentPaths = new Set(scanned.map((record) => record.path));
    const deletedPaths = Object.keys(index.files || {}).filter((relativePath) => !currentPaths.has(relativePath));
    const changedRecords = scanned.filter((record) => record.changed || !record.sha256);
    const totalBytes = scanned.reduce((total, record) => total + record.size, 0);
    const changedBytes = changedRecords.reduce((total, record) => total + record.size, 0);
    markTiming("scan");

    const baselineDecision = shouldCreateFullBaseline(index, targetFolder, changedBytes, totalBytes);
    if (baselineDecision.full) {
      onProgress("scanning", `Refreshing full backup baseline (${baselineDecision.reason}).`);
      return buildWorkspaceBackupPackage({
        targetFolder,
        localStorageData,
        reason: baselineDecision.reason,
        onProgress,
        backupType: "full",
      });
    }

    onProgress("manifest", `Hashing ${changedRecords.length} changed file(s).`, {
      fileCount: changedRecords.length,
      payloadBytes: changedBytes,
    });
    await hashChangedRecords(changedRecords);
    markTiming("hash-changed");

    onProgress("copying", "Packaging changed files only.");
    for (const record of changedRecords) {
      const targetPath = path.join(workspaceTarget, ...record.path.split("/"));
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.copyFile(record.sourcePath, targetPath);
    }
    await fsp.writeFile(path.join(workspaceTarget, "_incremental_marker.json"), JSON.stringify({
      createdAt: createdAt.toISOString(),
      changedFileCount: changedRecords.length,
      deletedFileCount: deletedPaths.length,
    }, null, 2), "utf8");
    if (fs.existsSync(DB_PATH)) {
      await fsp.copyFile(DB_PATH, path.join(appTarget, "spaila.db"));
    }
    await fsp.writeFile(path.join(packageRoot, "localStorage.json"), JSON.stringify(localStorageData || {}, null, 2), "utf8");
    markTiming("copy-changed");

    const nextFileRecords = scanned.map((record) => ({
      ...record,
      sha256: record.sha256 || changedRecords.find((changed) => changed.path === record.path)?.sha256 || "",
    }));
    const previousIncrementals = Array.isArray(index.incrementals) ? index.incrementals.map((item) => item.filename) : [];
    const payloadFiles = await buildFileManifestAsync(packageRoot);
    const sequence = previousIncrementals.length + 1;
    const manifest = {
      kind: QUICK_BACKUP_KIND,
      appVersion: readAppPackageVersion(),
      parserVersion: readParserVersion(),
      backupVersion: BACKUP_VERSION,
      backupType: "incremental",
      baselineId: index.baseline.id,
      baselineFilename: index.baseline.filename,
      previousIncrementals,
      sequence,
      createdAt: createdAt.toISOString(),
      timestamp,
      workspaceRoot: dirs.root,
      sections: {
        workspace: true,
        appDatabase: fs.existsSync(DB_PATH),
        localStorage: true,
        internalRecoveryStorage: true,
        emailArchive: fs.existsSync(path.join(dirs.Internal, "email_archive")),
        emailRetentionIndex: fs.existsSync(path.join(dirs.Internal, "email_retention_index.json")),
        existingBackupArchives: false,
      },
      changedFiles: recordsToManifestFiles(changedRecords),
      deletedPaths,
      fileIndex: recordsToManifestFiles(nextFileRecords, ""),
      fileCount: payloadFiles.length,
      payloadBytes: payloadFiles.reduce((total, file) => total + file.size, 0),
      changedBytes,
      checksumAlgorithm: "sha256",
      checksum: checksumManifestFiles(payloadFiles),
      storageOptimization: {
        mode: "incremental",
        reusesUnchangedHashes: true,
        packagesChangedFilesOnly: true,
      },
      timings,
    };
    await fsp.writeFile(path.join(packageRoot, "backup-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await fsp.writeFile(path.join(packageRoot, "backup-metadata.json"), JSON.stringify(manifest, null, 2), "utf8");
    markTiming("manifest");

    onProgress("compressing", "Compressing quick backup archive.", {
      fileCount: changedRecords.length,
      payloadBytes: changedBytes,
    });
    fs.rmSync(partialDest, { force: true });
    fs.rmSync(dest, { force: true });
    await createZipArchive(packageRoot, partialDest);
    markTiming("compressing");
    onProgress("validating", "Validating quick backup archive.");
    const archiveManifest = await validateZipArchive(partialDest);
    markTiming("validating");
    const archiveChecksum = await sha256FileAsync(partialDest);
    await fsp.rename(partialDest, dest);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    const archiveStat = await fsp.stat(dest);
    const nextIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      workspaceRoot: dirs.root,
      baseline: index.baseline,
      incrementals: [
        ...(Array.isArray(index.incrementals) ? index.incrementals : []),
        {
          filename,
          createdAt: manifest.createdAt,
          sequence,
          changedFileCount: changedRecords.length,
          deletedFileCount: deletedPaths.length,
          changedBytes,
        },
      ],
      files: recordsToIndexMap(nextFileRecords),
    };
    await saveBackupIndex(dirs, nextIndex);
    pruneBackups(targetFolder, 30, [
      index.baseline.filename,
      ...(Array.isArray(index.incrementals) ? index.incrementals.map((item) => item.filename) : []),
      filename,
    ]);
    markTiming("finalizing");
    onProgress("complete", "Quick backup validated and saved.", { filename });
    return {
      path: dest,
      filename,
      metadata: {
        ...archiveManifest,
        archiveChecksum,
        archiveBytes: archiveStat.size,
        finalized: true,
        timings,
        quickBackup: true,
      },
    };
  } catch (error) {
    fs.rmSync(partialDest, { force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    onProgress("failed", error?.message || "Quick backup failed.");
    throw error;
  }
}

ipcMain.handle("backup:save", async (event, { folderPath, localStorageData }) => {
  if (backupInProgress) {
    return { ok: false, error: "A backup is already in progress." };
  }
  backupInProgress = true;
  try {
    console.log("[backup:save] requested", { folderPath });
    const targetFolder = String(folderPath || "").trim() || getWorkspaceDirs().Backup;
    if (!path.isAbsolute(targetFolder)) {
      console.error("[backup:save] folder path not absolute", targetFolder);
      return { ok: false, error: "Backup folder path must be absolute." };
    }
    fs.mkdirSync(targetFolder, { recursive: true });

    const progress = (stage, message, details) => emitBackupProgress(event, stage, message, details);
    const index = loadBackupIndex(getWorkspaceDirs());
    const result = index && backupIndexBaselineExists(index, targetFolder)
      ? await buildQuickWorkspaceBackupPackage({
          targetFolder,
          localStorageData,
          index,
          onProgress: progress,
        })
      : await buildWorkspaceBackupPackage({
          targetFolder,
          localStorageData,
          reason: "baseline",
          onProgress: progress,
          backupType: "full",
        });
    console.log("[backup:save] wrote backup", result.path);
    return { ok: true, path: result.path, filename: result.filename, metadata: result.metadata };
  } catch (err) {
    console.error("[backup:save] failed", err);
    return { ok: false, error: err.message };
  } finally {
    backupInProgress = false;
  }
});

ipcMain.handle("backup:restore", async (event, { filePath }) => {
  if (backupInProgress || restoreInProgress) {
    return { ok: false, error: backupInProgress ? "A backup is already in progress." : "A restore is already in progress." };
  }
  restoreInProgress = true;
  const progress = (stage, message, details) => emitRestoreProgress(event, stage, message, details);
  try {
    const backupPath = String(filePath || "").trim();
    if (!backupPath || !fs.existsSync(backupPath)) {
      return { ok: false, error: "Backup file not found." };
    }
    progress("suspend", "Suspending background operations.");
    await stopBackgroundOperationsForRestore(progress);
    if (/\.spailabackup$/i.test(backupPath)) {
      progress("validating", "Validating legacy backup file.");
      const raw = fs.readFileSync(backupPath, "utf8");
      const payload = JSON.parse(raw);
      if (!payload.version || !payload.database) {
        return { ok: false, error: "Invalid backup file." };
      }
      progress("safety", "Creating safety backup before restore.");
      const safety = await buildSafetyWorkspaceBackupPackage({
        targetFolder: getWorkspaceDirs().Backup,
        localStorageData: {},
        reason: "pre-legacy-restore",
        onProgress: (stage, message, details) => progress(`safety:${stage}`, message, details),
      });
      const dbBytes = Buffer.from(payload.database, "base64");
      const dbSafetyPath = `${DB_PATH}.pre_restore_${timestampForFilename()}`;
      if (fs.existsSync(DB_PATH)) {
        await retryFsOperation(async () => fsp.rename(DB_PATH, dbSafetyPath), `Move existing database aside: ${DB_PATH}`);
      }
      await retryFsOperation(async () => fsp.writeFile(DB_PATH, dbBytes), `Restore legacy database: ${DB_PATH}`);
      progress("complete", "Legacy backup restored.", { safetyBackupPath: safety.path, dbSafetyPath });
      return { ok: true, settings: payload.settings || {}, createdAt: payload.createdAt, safetyBackupPath: safety.path, dbSafetyPath };
    }
    if (!/\.zip$/i.test(backupPath)) {
      return { ok: false, error: "Unsupported backup file type." };
    }

    const dirs = getWorkspaceDirs();
    progress("validating", "Validating restore archive and manifest.");
    const selectedManifest = await validateZipArchive(backupPath);
    const backupChain = resolveBackupChainPaths(backupPath, selectedManifest, path.dirname(backupPath));
    if (backupChain.length > 1) {
      progress("validating", `Validated quick backup chain with ${backupChain.length} archives.`);
    }
    progress("safety", "Creating safety backup of current workspace.");
    const safety = await buildSafetyWorkspaceBackupPackage({
      targetFolder: dirs.Backup,
      localStorageData: {},
      reason: "pre-restore",
      onProgress: (stage, message, details) => progress(`safety:${stage}`, message, details),
      keepFilenames: backupChain.map((chainPath) => path.basename(chainPath)),
    });
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spaila-restore-"));
    try {
      const extractedPackages = [];
      for (let i = 0; i < backupChain.length; i += 1) {
        const chainPath = backupChain[i];
        progress("extracting", `Extracting restore archive ${i + 1} of ${backupChain.length}.`);
        const chainManifest = await validateZipArchive(chainPath);
        if (i > 0 && chainManifest.baselineFilename && chainManifest.baselineFilename !== path.basename(backupChain[0])) {
          throw new Error("Quick backup restore chain points to a different baseline.");
        }
        if (i > 0 && Number(chainManifest.sequence || 0) !== i) {
          throw new Error("Quick backup restore chain sequence is invalid.");
        }
        const extractTarget = path.join(stagingRoot, `archive_${i}`);
        await expandZipArchive(chainPath, extractTarget);
        const packageRoot = resolveBackupPackageRoot(extractTarget);
        const manifest = await validateBackupManifest(packageRoot);
        if (i === 0 && manifest.kind !== BACKUP_KIND) {
          throw new Error("Restore chain must start with a full backup baseline.");
        }
        if (i > 0 && manifest.kind !== QUICK_BACKUP_KIND) {
          throw new Error("Restore chain contains a non-incremental archive after the baseline.");
        }
        extractedPackages.push({ packageRoot, manifest, chainPath });
      }
      const manifest = extractedPackages[extractedPackages.length - 1].manifest;
      await fsp.mkdir(dirs.root, { recursive: true });
      progress("renaming", "Moving current workspace aside for recoverability.");
      const restoreSafety = await moveWorkspaceAsideForRestore(dirs, progress);
      for (let i = 0; i < extractedPackages.length; i += 1) {
        const item = extractedPackages[i];
        progress("restoring", `Restoring ${i === 0 ? "full baseline" : `quick backup ${i}`} of ${extractedPackages.length - 1}.`);
        await applyWorkspacePackage(item.packageRoot, dirs, item.manifest);
      }
      const packageRoot = extractedPackages[extractedPackages.length - 1].packageRoot;
      const appDbPath = path.join(packageRoot, "app", "spaila.db");
      const dbRestore = await restoreAppDatabase(appDbPath, progress);
      const localStoragePath = path.join(packageRoot, "localStorage.json");
      const settings = fs.existsSync(localStoragePath)
        ? JSON.parse(fs.readFileSync(localStoragePath, "utf8"))
        : {};
      progress("complete", "Restore completed successfully.", {
        safetyBackupPath: safety.path,
        restoreSafetyPath: restoreSafety.path,
        dbSafetyPath: dbRestore.previousPath || "",
        diagnostics: restoreSafety.diagnostics || [],
      });

      return {
        ok: true,
        settings,
        createdAt: manifest.createdAt,
        metadata: { ...manifest, archiveChecksum: await sha256FileAsync(backupPath), validatedAt: new Date().toISOString() },
        safetyBackupPath: safety.path,
        restoreSafetyPath: restoreSafety.path,
        dbSafetyPath: dbRestore.previousPath || "",
        diagnostics: restoreSafety.diagnostics || [],
        copiedFallback: restoreSafety.copiedFallback || [],
      };
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  } catch (err) {
    progress("failed", err?.message || "Restore failed.");
    return { ok: false, error: err.message };
  } finally {
    restoreInProgress = false;
  }
});

ipcMain.handle("documents:open-file", async (_event, { filePath }) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: "File not found." };
    }
    const err = await shell.openPath(filePath);
    if (err) return { ok: false, error: err };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("documents:copy-to-docs", async (_event, payload = {}) => {
  try {
    const sourcePath = String(payload.filePath || payload.path || "").trim();
    const allowedExtensions = Array.isArray(payload.allowedExtensions) && payload.allowedExtensions.length
      ? payload.allowedExtensions.map((ext) => String(ext || "").replace(/^\./, "").toLowerCase()).filter(Boolean)
      : ["pdf"];
    if (!sourcePath || !path.isAbsolute(sourcePath)) {
      return { ok: false, error: "Document file path is required." };
    }
    if (!fs.existsSync(sourcePath)) {
      return { ok: false, error: "Document file not found." };
    }
    const stat = safeStat(sourcePath);
    if (!stat?.isFile()) {
      return { ok: false, error: "Selected document is not a file." };
    }
    const sourceExt = path.extname(sourcePath).replace(/^\./, "").toLowerCase();
    if (!allowedExtensions.includes(sourceExt)) {
      return { ok: false, error: `Only ${allowedExtensions.map((ext) => `.${ext}`).join(", ")} files are supported.` };
    }

    fs.mkdirSync(DOCS_FOLDER, { recursive: true });
    const filename = sanitizeFilenamePart(path.basename(sourcePath), `document.${allowedExtensions[0] || "pdf"}`);
    const preferredTarget = path.join(DOCS_FOLDER, filename);
    const sameFile = path.resolve(sourcePath).toLowerCase() === path.resolve(preferredTarget).toLowerCase();
    const targetPath = sameFile ? preferredTarget : makeUniqueFilePath(preferredTarget);
    if (!sameFile) {
      fs.copyFileSync(sourcePath, targetPath);
    }

    return { ok: true, path: targetPath, name: path.basename(targetPath), folderPath: DOCS_FOLDER };
  } catch (err) {
    return { ok: false, error: err.message || "Could not copy document." };
  }
});

function getDocumentMimeType(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".txt") return "text/plain";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

ipcMain.handle("documents:sync-thank-you-template", async (_event, payload = {}) => {
  try {
    const filePath = String(payload.filePath || "").trim();
    if (!filePath || !path.isAbsolute(filePath)) {
      return { ok: false, error: "Thank-you template path is required." };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: "Thank-you template file not found." };
    }
    const stat = safeStat(filePath);
    if (!stat?.isFile()) {
      return { ok: false, error: "Thank-you template is not a file." };
    }
    const content = await fsp.readFile(filePath);
    const response = await fetch("http://127.0.0.1:8055/account/thank-you-template", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: String(payload.name || path.basename(filePath)).trim() || path.basename(filePath),
        mime_type: getDocumentMimeType(filePath),
        content_base64: content.toString("base64"),
        source_path: filePath,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { ok: false, error: detail || `Shared template import failed (${response.status}).` };
    }
    const template = await response.json();
    return { ok: true, template };
  } catch (err) {
    return { ok: false, error: err?.message || "Could not sync thank-you template." };
  }
});

ipcMain.handle("file:save-json", async (_event, { folderPath, filename, data }) => {
  try {
    const dest = path.join(folderPath, filename);
    fs.writeFileSync(dest, typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("dialog:pick-file", async (_event, { title, filters }) => {
  const owner = getSenderWindow(_event) || undefined;
  const result = await dialog.showOpenDialog(owner, {
    title: withBrandTitle(title, "Select File"),
    properties: ["openFile"],
    filters: filters || [{ name: "All Files", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0], name: require("path").basename(result.filePaths[0]) };
});

ipcMain.handle("dialog:pick-folder", async () => {
  const owner = BrowserWindow.getAllWindows()[0] || undefined;
  const result = await dialog.showOpenDialog(owner, {
    title: withBrandTitle("Select Archive Folder"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0] };
});

ipcMain.handle("workspace:get-state", async (_event, payload = {}) => {
  const dirs = getWorkspaceDirs();
  const bucket = dirs[payload.bucket] ? payload.bucket : "Inbox";
  const selectedRoot = getWorkspaceBucketPath(dirs, bucket);
  const requestedRelativePath = String(payload.relativePath || "").trim();
  const requestedPath = requestedRelativePath
    ? path.join(dirs.root, requestedRelativePath.split("/").join(path.sep))
    : selectedRoot;
  const currentPath = isWithinWorkspace(requestedPath) && fs.existsSync(requestedPath)
    ? requestedPath
    : selectedRoot;
  const currentStat = safeStat(currentPath);
  const currentKind = currentStat?.isDirectory() ? "directory" : currentStat?.isFile() ? "file" : "missing";

  return {
    root: dirs.root,
    inboxPath: dirs.InboxModule,
    imapConfigured: isImapConfigured(),
    buckets: ["Inbox", "Orders", "Archive", "Backup"]
      .map((key) => {
        const folderPath = getWorkspaceBucketPath(dirs, key);
        return {
        key,
        path: folderPath,
        relativePath: relativeWorkspacePath(folderPath),
        count: key === "Orders" ? countOrderFolders(folderPath) : countFolderEntries(folderPath),
        };
      }),
    inboxItems: listInboxItems(dirs.InboxModule),
    inboxVisibilityDiagnostics: getInboxVisibilityDiagnostics(),
    sentMessages: loadSentMessages(),
    currentBucket: bucket,
    currentPath,
    currentRelativePath: relativeWorkspacePath(currentPath),
    currentKind,
    entries: listFolderEntries(currentPath),
  };
});

ipcMain.handle("workspace:add-to-inbox", async (_event, payload = {}) => {
  const dirs = getWorkspaceDirs();
  const inboxPath = dirs.InboxModule;
  const incomingPaths = Array.isArray(payload.filePaths) ? payload.filePaths : [];
  const added = [];
  const skipped = [];

  for (const sourcePath of incomingPaths) {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      skipped.push({ path: sourcePath, reason: "missing" });
      continue;
    }
    const stat = safeStat(sourcePath);
    if (!stat?.isFile()) {
      skipped.push({ path: sourcePath, reason: "not_a_file" });
      continue;
    }
    if (!/\.eml$/i.test(sourcePath)) {
      skipped.push({ path: sourcePath, reason: "not_eml" });
      continue;
    }

    const ext = path.extname(sourcePath);
    const targetPath = makeUniqueFilePath(path.join(inboxPath, path.basename(sourcePath, ext) + ext));

    try {
      fs.copyFileSync(sourcePath, targetPath);
      const item = {
        path: targetPath,
        relativePath: relativeWorkspacePath(targetPath),
        name: path.basename(targetPath),
        ...extractEmailMetadata(targetPath),
      };
      addManualImportedInboxItem(item);
      added.push({ path: targetPath, relativePath: item.relativePath, manual_imported: true });
    } catch (error) {
      skipped.push({ path: sourcePath, reason: error.message || "copy_failed" });
    }
  }

  return { ok: true, added, skipped };
});

ipcMain.handle("workspace:open-inbox-item", async (_event, payload = {}) => {
  try {
    const pathToOpen = moveInboxItemToCurrent(payload.filePath);
    return { ok: true, path: pathToOpen, relativePath: relativeWorkspacePath(pathToOpen) };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not open inbox email." };
  }
});

function resolveAttachmentFilePathForOpen(attachment = {}) {
  let filePath = String(attachment.path || attachment.filePath || "").trim();
  const originalPath = String(attachment.original_path || attachment.originalPath || "").trim();
  const sentCopyPath = String(attachment.sent_copy_path || attachment.sentCopyPath || "").trim();
  if ((!filePath || !path.isAbsolute(filePath)) && originalPath && path.isAbsolute(originalPath)) {
    filePath = originalPath;
  }
  if ((!filePath || !path.isAbsolute(filePath)) && sentCopyPath && path.isAbsolute(sentCopyPath)) {
    filePath = sentCopyPath;
  }
  return filePath;
}

function isPreviewableImagePath(filePath, attachment = {}) {
  const type = String(attachment.type || attachment.mime_type || attachment.mimeType || attachment.contentType || "").toLowerCase();
  const name = String(attachment.name || attachment.filename || attachment.file || filePath || "").toLowerCase();
  return type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(filePath || ""));
}

async function createAttachmentThumbnailDataUrl(filePath) {
  if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return "";
  try {
    const thumbnail = await nativeImage.createThumbnailFromPath(filePath, { width: 96, height: 96 });
    if (thumbnail && !thumbnail.isEmpty()) {
      return thumbnail.toDataURL();
    }
  } catch (_) {}
  return pathToFileURL(filePath).href;
}

ipcMain.handle("workspace:attachment-info", async (_event, payload = {}) => {
  try {
    const attachment = payload.attachment || payload;
    const url = String(attachment.url || attachment.href || "").trim();
    if (/^https?:\/\//i.test(url)) {
      return { ok: true, exists: true, remote: true, size: Number(attachment.size || attachment.bytes || 0) || 0 };
    }
    let filePath = resolveAttachmentFilePathForOpen(attachment);
    if ((!filePath || !path.isAbsolute(filePath)) && attachment.sourcePath && attachment.attachmentIndex !== undefined && isPreviewableImagePath("", attachment)) {
      filePath = extractEmailAttachmentToFile(
        String(attachment.sourcePath || ""),
        attachment.attachmentIndex,
        attachment.name || attachment.filename || ""
      );
    }
    if (!filePath || !path.isAbsolute(filePath)) {
      return { ok: true, exists: false, missing: true, size: 0 };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: true, exists: false, missing: true, path: filePath, size: 0 };
    }
    const stat = fs.statSync(filePath);
    const thumbnailDataUrl = stat.isFile() && isPreviewableImagePath(filePath, attachment)
      ? await createAttachmentThumbnailDataUrl(filePath)
      : "";
    return {
      ok: true,
      exists: stat.isFile(),
      missing: !stat.isFile(),
      path: filePath,
      size: stat.isFile() ? stat.size : 0,
      thumbnailDataUrl,
      previewSrc: thumbnailDataUrl || (stat.isFile() && isPreviewableImagePath(filePath, attachment) ? pathToFileURL(filePath).href : ""),
    };
  } catch (error) {
    return { ok: false, exists: false, missing: true, error: error?.message || "Could not inspect attachment." };
  }
});

ipcMain.handle("workspace:open-attachment", async (_event, payload = {}) => {
  try {
    const attachment = payload.attachment || payload;
    const url = String(attachment.url || attachment.href || "").trim();
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return { ok: true };
    }

    let filePath = resolveAttachmentFilePathForOpen(attachment);
    if (!filePath && attachment.sourcePath && attachment.attachmentIndex !== undefined) {
      filePath = extractEmailAttachmentToFile(
        String(attachment.sourcePath || ""),
        attachment.attachmentIndex,
        attachment.name || attachment.filename || ""
      );
    }
    if (!filePath || !path.isAbsolute(filePath) || !fs.existsSync(filePath)) {
      return { ok: false, error: "Attachment file was not found." };
    }
    const err = await shell.openPath(filePath);
    if (err) return { ok: false, error: err };
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not open attachment." };
  }
});

ipcMain.handle("workspace:hide-inbox-item", async (_event, payload = {}) => {
  try {
    const emailId = payload.emailId || payload.email_id || "";
    hideEmailId(emailId);
    const sourcePath = String(payload.filePath || payload.path || "").trim()
      || findInboxFileForLifecycle(emailId, payload.imap_uid || payload.imapUid || "");
    const lifecycle = sourcePath
      ? archiveAndDeactivateInboxFile(sourcePath, "global_hidden")
      : { ok: false, reason: "source_not_found" };
    return { ok: true, lifecycle };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not remove inbox email." };
  }
});

ipcMain.handle("workspace:hide-inbox-workspace-only", async (_event, payload = {}) => {
  try {
    const emailId = String(payload.emailId || payload.email_id || "").trim();
    const imapUid = String(payload.imap_uid || payload.imapUid || "").trim();
    addWorkspaceInboxHiddenIds(emailId, imapUid);
    const sourcePath = String(payload.filePath || payload.path || "").trim()
      || findInboxFileForLifecycle(emailId, imapUid);
    const lifecycle = sourcePath
      ? archiveAndDeactivateInboxFile(sourcePath, "workspace_hidden")
      : { ok: false, reason: "source_not_found" };
    return { ok: true, workspace_only: true, lifecycle };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not hide inbox email in workspace." };
  }
});

ipcMain.handle("workspace:mark-inbox-order", async (_event, payload = {}) => {
  try {
    const result = markInboxItemAsOrder(payload.item || payload);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not mark inbox email as order." };
  }
});

ipcMain.handle("workspace:mark-inbox-not-order", async (_event, payload = {}) => {
  try {
    const result = markInboxItemAsNotOrder(payload.item || payload);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not mark inbox email as not order." };
  }
});

ipcMain.handle("workspace:undo-inbox-order-mark", async (_event, payload = {}) => {
  try {
    const result = undoInboxOrderMark(payload.item || payload);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not undo inbox order mark." };
  }
});

ipcMain.handle("workspace:set-inbox-linked-order", async (_event, payload = {}) => {
  try {
    const result = setInboxItemLinkedOrderId(payload.item || payload, payload.order_id || payload.orderId);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not save inbox order link." };
  }
});

// ── Email compose ────────────────────────────────────────────────────────────

ipcMain.handle("email:list-attachments", async (_event, { folderPath, mode, extensions }) => {
  if (!folderPath || mode === "none") return { files: [], warnings: [] };
  try {
    const files = listAttachmentFilesFromPath(folderPath, mode, extensions);
    const warnings = [];
    if (files.length === 0) warnings.push("No attachments found");
    else if (files.length > 1) warnings.push(`Multiple attachments found (${files.length} files)`);
    return { files, warnings };
  } catch (err) {
    return { files: [], warnings: [`Could not read folder: ${err.message}`] };
  }
});

ipcMain.handle("email:resolve-attachments", async (_event, payload = {}) => {
  return resolveAttachmentPayload(payload);
});
ipcMain.handle("email:get-environment", async () => {
  return getEmailEnvironmentInfo();
});
ipcMain.handle("email:test-smtp", async (_event, payload = {}) => {
  const validation = validateSmtpConfig(payload.config || {});
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }
  try {
    const transport = createSmtpTransport(validation.smtp);
    await transport.verify();
    return { ok: true, message: "SMTP connection successful." };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not connect to SMTP server." };
  }
});
ipcMain.handle("email:test-imap", async (_event, payload = {}) => {
  const validation = validateImapConnectionConfig(payload.config || {});
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const imap = validation.imap;
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.useSsl !== false,
    auth: {
      user: imap.username,
      pass: imap.password,
    },
    logger: false,
  });

  let lock = null;
  try {
    await client.connect();
    lock = await client.getMailboxLock("INBOX");
    return { ok: true, message: "IMAP receiving connection successful." };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not connect to IMAP server." };
  } finally {
    try { lock?.release?.(); } catch (_) {}
    try { await client.logout(); } catch (_) {}
  }
});
ipcMain.handle("email:send-smtp", async (_event, payload = {}) => {
  const smtpValidation = validateSmtpConfig(payload.smtp || {});
  if (!smtpValidation.ok) {
    return { ok: false, error: smtpValidation.error };
  }

  const to = String(payload.to || "").trim();
  const subject = String(payload.subject || "").trim();
  const body = String(payload.body || "");
  if (!to) return { ok: false, error: "Recipient is required." };
  if (!subject) return { ok: false, error: "Subject is required." };
  const attachmentPaths = (Array.isArray(payload.attachmentPaths) ? payload.attachmentPaths : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && path.isAbsolute(value) && fs.existsSync(value));
  if (!body.trim() && !attachmentPaths.length) return { ok: false, error: "Body or attachment is required." };

  const html = convertPlainTextEmailToHtml(body);

  try {
    const sentAt = new Date();
    const messageId = `<${crypto.randomUUID()}@spaila.local>`;
    const mimeMessage = await buildMimeMessage({
      smtp: smtpValidation.smtp,
      to,
      subject,
      body,
      html,
      attachmentPaths,
      sentAt,
      messageId,
    });
    const transport = createSmtpTransport(smtpValidation.smtp);
    await transport.sendMail({
      envelope: {
        from: smtpValidation.smtp.emailAddress,
        to: parseEnvelopeRecipients(to),
      },
      raw: mimeMessage,
    });
    const appendResult = await appendMimeToSentFolder(payload.imap || {}, mimeMessage, sentAt);

    const sentFolder = getSentEmailFolder(payload.orderFolderPath || "");
    fs.mkdirSync(sentFolder, { recursive: true });
    fs.writeFileSync(path.join(sentFolder, "email.html"), html, "utf8");
    fs.writeFileSync(path.join(sentFolder, "email.eml"), mimeMessage);
    const copiedAttachmentPaths = copyFilesIntoFolder(attachmentPaths, sentFolder);
    const attachmentMetadata = normalizeOutboundAttachmentMetadata(attachmentPaths, {
      copiedPaths: copiedAttachmentPaths,
      sentAt: sentAt.toISOString(),
    });
    console.log("[ATTACHMENT_SEND]", JSON.stringify({
      count: attachmentMetadata.length,
      filenames: attachmentMetadata.map((item) => item.filename || item.file || item.name),
      to,
      subject,
      message_id: messageId,
    }));
    const sentMessage = appendSentMessage({
      id: `outbound:${messageId.replace(/^<|>$/g, "")}`,
      message_id: messageId.replace(/^<|>$/g, ""),
      order_number: payload.orderNumber || payload.order_number || "",
      buyer_name: payload.buyerName || payload.buyer_name || "",
      buyer_email: payload.buyerEmail || payload.buyer_email || "",
      from: formatFromHeader(smtpValidation.smtp),
      to,
      subject,
      timestamp: sentAt.toISOString(),
      body,
      preview_text: body,
      preview: buildEmailPreview(body),
      preview_html: html,
      attachments: attachmentMetadata,
      sent_folder: sentFolder,
    });
    console.log("[SEND_LOGGED]", JSON.stringify({
      to,
      subject,
      message_id: messageId,
      timestamp: sentAt.toISOString(),
      snippet: body.slice(0, 160),
      attachment_names: attachmentPaths.map((filePath) => path.basename(filePath)),
      sent_status: "sent",
      saved_to_sent: !!appendResult.ok,
      sent_folder: appendResult.folder || "",
    }));

    return {
      ok: true,
      message: "Email sent.",
      messageId,
      timestamp: sentAt.toISOString(),
      sentFolder,
      appendToSent: appendResult,
      sentMessage,
    };
  } catch (error) {
    return { ok: false, error: error?.message || "Could not send email." };
  }
});
ipcMain.handle("email:compose", async (_event, { to, subject, body, attachmentFolderPath }) => {
  const mailto = `mailto:${encodeURIComponent(to || "")}?subject=${encodeURIComponent(subject || "")}&body=${encodeURIComponent(body || "")}`;
  await shell.openExternal(mailto);
  const result = { ok: true, method: "mailto" };

  const targetFolder = String(attachmentFolderPath || "").trim();
  if (targetFolder && path.isAbsolute(targetFolder)) {
    setTimeout(() => {
      const stat = safeStat(targetFolder);
      const folderToOpen = stat?.isDirectory() ? targetFolder : (stat ? path.dirname(targetFolder) : "");
      if (!folderToOpen) {
        console.error("[email:compose] attachment folder path missing:", targetFolder);
        return;
      }
      openFolderVisible(folderToOpen, "email:compose").then((openResult) => {
        if (!openResult?.ok) {
          console.error("[email:compose] could not open attachment folder:", folderToOpen, openResult?.error);
        }
      }).catch((error) => {
        console.error("[email:compose] unexpected folder open error:", folderToOpen, error);
      });
    }, 400);
  }
  return result;
});

// Fetch the shared account profile from the local backend API.
// This lets the desktop pick up any shop identity changes made via the webapp.
ipcMain.handle("account:get-profile", async () => {
  try {
    const response = await fetch("http://127.0.0.1:8055/account/profile");
    if (!response.ok) return { ok: false };
    const profile = await response.json();
    return { ok: true, profile };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("account:update-profile", async (_event, patch) => {
  try {
    const response = await fetch("http://127.0.0.1:8055/account/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch || {}),
    });
    if (!response.ok) return { ok: false };
    const profile = await response.json();
    return { ok: true, profile };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("account:get-order-field-layout", async () => {
  try {
    const response = await fetch("http://127.0.0.1:8055/account/order-field-layout");
    if (!response.ok) return { ok: false };
    const layout = await response.json();
    return { ok: true, layout };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("account:update-order-field-layout", async (_event, layout) => {
  try {
    const response = await fetch("http://127.0.0.1:8055/account/order-field-layout", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(layout || {}),
    });
    if (!response.ok) return { ok: false };
    const saved = await response.json();
    return { ok: true, layout: saved };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("account:get-pricing-rules", async () => {
  try {
    const response = await fetch("http://127.0.0.1:8055/account/pricing-rules");
    if (!response.ok) return { ok: false };
    const pricing = await response.json();
    return { ok: true, pricing };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("account:update-pricing-rules", async (_event, pricing) => {
  try {
    const response = await fetch("http://127.0.0.1:8055/account/pricing-rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pricing || {}),
    });
    if (!response.ok) return { ok: false };
    const saved = await response.json();
    return { ok: true, pricing: saved };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("account:get-print-config", async () => {
  try {
    const response = await fetch("http://127.0.0.1:8055/account/print-config");
    if (!response.ok) return { ok: false };
    const config = await response.json();
    return { ok: true, config };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("account:update-print-config", async (_event, config) => {
  try {
    const response = await fetch("http://127.0.0.1:8055/account/print-config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config || {}),
    });
    if (!response.ok) return { ok: false };
    const saved = await response.json();
    return { ok: true, config: saved };
  } catch {
    return { ok: false };
  }
});

app.whenReady().then(() => {
  getWorkspaceDirs();
  try { app.setName(getBrandName()); } catch (_) {}
  // Set app icon for taskbar, dock, and native dialogs on all platforms
  if (process.platform === "win32") {
    app.setAppUserModelId("spaila-parser-ui");
  }
  try { app.dock?.setIcon(APP_ICON); } catch (_) {} // macOS dock (no-op on Windows)

  createWindow();
  if (loadHelperSettings().runOnStartup !== false) {
    startHelper();
  } else {
    helperStatus = "stopped";
    appendHelperLog("info", "Helper startup disabled by settings.");
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("child-process-gone", (_event, details) => {
  console.error("[app child-process-gone]", details);
});

app.on("render-process-gone", (_event, webContents, details) => {
  console.error("[app render-process-gone]", {
    details,
    url: webContents?.getURL?.(),
  });
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

function killHelper(options = {}) {
  if (options.intentional) {
    helperStopRequested = true;
  } else {
    helperRestarting = true;
  }
  if (helperProcess) {
    try { helperProcess.kill(); } catch (_) {}
    helperProcess = null;
  }
  helperStatus = "stopped";
  if (!options.silent) appendHelperLog("info", "Helper stopped.");
}

app.on("before-quit", killHelper);

// Ensure Ctrl+C in the terminal (SIGINT forwarded by concurrently) also cleans up
process.on("SIGINT",  () => { killHelper(); app.quit(); });
process.on("SIGTERM", () => { killHelper(); app.quit(); });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
