const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const nodemailer = require("nodemailer");
const { pathToFileURL } = require("url");
const { ensureWorkspaceLayout } = require("./workspacePaths");

// ── Helper process (sync_folders.py) ────────────────────────────────────────
const ROOT = path.join(__dirname, "..", "..");
const APP_ICON = path.join(ROOT, "spaila-logo.blue.ico");
const DEFAULT_APP_NAME = "Parser Viewer";
let currentBrandName = DEFAULT_APP_NAME;
let helperProcess = null;
let helperRestarting = false;
let cachedWorkspaceDirs = null;

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

function getSentEmailFolder(orderFolderPath = "") {
  const { root } = getWorkspaceDirs();
  const now = new Date();
  const year = String(now.getFullYear());
  const month = now.toLocaleString("en-US", { month: "long" }).toLowerCase();
  const orderFolderName = sanitizeFilenamePart(path.basename(String(orderFolderPath || "").trim()) || "email");
  return path.join(root, "sent", year, month, orderFolderName);
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

function decodeHeaderValue(value) {
  return String(value || "").replace(/\r?\n[\t ]+/g, " ").trim();
}

function readEmailHeadersOnly(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const chunks = [];
    const buffer = Buffer.alloc(4096);
    let totalLength = 0;
    let headerEnd = -1;

    while (headerEnd < 0 && totalLength < 65536) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalLength += bytesRead;
      const text = Buffer.concat(chunks, totalLength).toString("utf8");
      headerEnd = text.search(/\r?\n\r?\n/);
      if (headerEnd >= 0) {
        return text.slice(0, headerEnd);
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

function extractEmailMetadata(filePath) {
  const stat = safeStat(filePath);
  let subject = "";
  let sender = "";
  let timestamp = stat ? new Date(stat.mtimeMs).toISOString() : "";
  try {
    const headers = parseEmailHeaders(readEmailHeadersOnly(filePath));
    subject = decodeHeaderValue(headers.subject || "");
    sender = formatHeaderSender(headers.from || "");
    const parsedDate = Date.parse(decodeHeaderValue(headers.date || ""));
    if (Number.isFinite(parsedDate)) {
      timestamp = new Date(parsedDate).toISOString();
    }
  } catch (_error) {
    // Fall back to header-free defaults below.
  }

  return {
    name: path.basename(filePath),
    subject: subject || "(No subject)",
    sender: sender || "(Unknown sender)",
    timestamp,
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
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".eml"))
    .map((entry) => {
      const fullPath = path.join(inboxPath, entry.name);
      return {
        path: fullPath,
        relativePath: relativeWorkspacePath(fullPath),
        ...extractEmailMetadata(fullPath),
      };
    })
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
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

  // Spawn tray_app.py — it owns the tray icon and starts sync_folders.py internally
  helperProcess = spawn("py", [path.join(ROOT, "helper", "tray_app.py")], {
    cwd: ROOT,
    detached: false,
    windowsHide: false,   // must be false so the tray icon can attach to the shell
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
  });

  helperProcess.stdout.on("data", (data) => {
    console.log("[HELPER]", data.toString().trimEnd());
  });

  helperProcess.stderr.on("data", (data) => {
    console.error("[HELPER ERR]", data.toString().trimEnd());
  });

  helperProcess.on("error", (err) => {
    console.error("[HELPER SPAWN ERROR]", err.message);
    helperProcess = null;
  });

  helperProcess.on("close", (code) => {
    helperProcess = null;
    if (helperRestarting) return;     // Electron is quitting — don't restart
    if (code === 0) return;           // User clicked "Exit" in tray — respect that
    console.log(`[HELPER EXITED] code=${code} — restarting in 3s…`);
    setTimeout(startHelper, 3000);
  });

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
  window.on("closed", () => {
    console.log("[WINDOW closed]");
  });

  window.removeMenu();
  window.maximize();
  window.show();
  window.loadFile(path.join(__dirname, "..", "ui", "index.html"));
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
  const roots = [dirs.Orders, dirs.Duplicates, dirs.Archive, dirs.Backup].filter(Boolean);
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

ipcMain.handle("parser:parse-file", async (_event, { filePath }) => {
  if (!filePath) throw new Error("No file path provided.");
  const resolvedPath = await resolveParserPath({ filePath });
  const parsed = await runBridge({ action: "parse", path: resolvedPath });
  if (parsed.error) throw new Error(parsed.error);
  return { filePath: resolvedPath, ...parsed };
});


ipcMain.handle("parser:teach", async (_event, payload) => {
  const parsed = await runBridge({
    action: payload.action,
    path: payload.filePath,
    decision: payload.decision,
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
  });
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return {
    filePath: resolvedPath,
    ...parsed,
  };
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
const BACKUP_VERSION = 1;

ipcMain.handle("backup:save", async (_event, { folderPath, localStorageData }) => {
  try {
    console.log("[backup:save] requested", { folderPath });
    if (!fs.existsSync(DB_PATH)) {
      console.error("[backup:save] database file missing", DB_PATH);
      return { ok: false, error: "Database file not found." };
    }
    const targetFolder = String(folderPath || "").trim() || getWorkspaceDirs().Backup;
    if (!path.isAbsolute(targetFolder)) {
      console.error("[backup:save] folder path not absolute", targetFolder);
      return { ok: false, error: "Backup folder path must be absolute." };
    }
    fs.mkdirSync(targetFolder, { recursive: true });

    const dbBytes  = fs.readFileSync(DB_PATH);
    const dbBase64 = dbBytes.toString("base64");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename  = `spaila-backup-${timestamp}.spailabackup`;
    const dest      = path.join(targetFolder, filename);

    const payload = JSON.stringify({
      version:    BACKUP_VERSION,
      createdAt:  new Date().toISOString(),
      database:   dbBase64,
      settings:   localStorageData,   // all localStorage key→value pairs
    });

    fs.writeFileSync(dest, payload, "utf8");
    console.log("[backup:save] wrote backup", dest);

    // Keep only the 10 most recent .spailabackup files in the folder
    try {
      const MAX_BACKUPS = 10;
      const allFiles = fs.readdirSync(targetFolder)
        .filter((f) => f.endsWith(".spailabackup"))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(targetFolder, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime); // oldest first

      const excess = allFiles.length - MAX_BACKUPS;
      for (let i = 0; i < excess; i++) {
        try { fs.unlinkSync(path.join(targetFolder, allFiles[i].name)); } catch (_) {}
      }
    } catch (_) {}

    return { ok: true, path: dest, filename };
  } catch (err) {
    console.error("[backup:save] failed", err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("backup:restore", async (_event, { filePath }) => {
  try {
    const raw     = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw);

    if (!payload.version || !payload.database) {
      return { ok: false, error: "Invalid backup file." };
    }

    // Write database (overwrite existing)
    const dbBytes = Buffer.from(payload.database, "base64");
    fs.writeFileSync(DB_PATH, dbBytes);

    return { ok: true, settings: payload.settings || {}, createdAt: payload.createdAt };
  } catch (err) {
    return { ok: false, error: err.message };
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
    buckets: ["Inbox", "Orders", "Duplicates", "Archive", "Backup"]
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
      added.push({ path: targetPath, relativePath: relativeWorkspacePath(targetPath) });
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
  if (!body.trim()) return { ok: false, error: "Body is required." };

  const html = convertPlainTextEmailToHtml(body);
  const attachmentPaths = (Array.isArray(payload.attachmentPaths) ? payload.attachmentPaths : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && path.isAbsolute(value) && fs.existsSync(value));

  try {
    const transport = createSmtpTransport(smtpValidation.smtp);
    await transport.sendMail({
      from: formatFromHeader(smtpValidation.smtp),
      to,
      subject,
      text: body,
      html,
      attachments: attachmentPaths.map((filePath) => ({
        filename: path.basename(filePath),
        path: filePath,
      })),
    });

    const sentFolder = getSentEmailFolder(payload.orderFolderPath || "");
    fs.mkdirSync(sentFolder, { recursive: true });
    fs.writeFileSync(path.join(sentFolder, "email.html"), html, "utf8");
    copyFilesIntoFolder(attachmentPaths, sentFolder);

    return {
      ok: true,
      message: "Email sent.",
      sentFolder,
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

app.whenReady().then(() => {
  getWorkspaceDirs();
  try { app.setName(getBrandName()); } catch (_) {}
  // Set app icon for taskbar, dock, and native dialogs on all platforms
  if (process.platform === "win32") {
    app.setAppUserModelId("spaila-parser-ui");
  }
  try { app.dock?.setIcon(APP_ICON); } catch (_) {} // macOS dock (no-op on Windows)

  createWindow();
  startHelper();

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

function killHelper() {
  helperRestarting = true;
  if (helperProcess) {
    try { helperProcess.kill(); } catch (_) {}
    helperProcess = null;
  }
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
