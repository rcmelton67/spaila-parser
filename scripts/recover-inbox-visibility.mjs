import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const stopHelper = args.has("--stop-helper");

function workspaceRoot() {
  return process.platform === "win32" ? "C:\\Spaila" : path.join(os.homedir(), "Spaila");
}

const root = workspaceRoot();
const inboxDir = path.join(root, "inbox");
const internalDir = path.join(root, ".spaila_internal");
const unmatchedDir = path.join(internalDir, "unmatched");
const legacyUnmatchedDir = path.join(root, "Unmatched");
const helperSettingsPath = path.join(root, "helper_settings.json");
const manualImportsPath = path.join(internalDir, "manual_imported_inbox.json");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function countEmlFiles(folderPath) {
  try {
    return fs.readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".eml"))
      .length;
  } catch {
    return 0;
  }
}

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let suffix = 1;
  while (true) {
    const candidate = path.join(dir, `${base}__restored${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    suffix += 1;
  }
}

function extractHeader(raw, name) {
  const headerBlock = String(raw || "").split(/\r?\n\r?\n/, 1)[0] || "";
  const lines = headerBlock.split(/\r?\n/);
  const headers = {};
  let current = "";
  for (const line of lines) {
    if (/^\s/.test(line) && current) {
      headers[current] = `${headers[current] || ""} ${line.trim()}`.trim();
      continue;
    }
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      current = "";
      continue;
    }
    current = match[1].trim().toLowerCase();
    headers[current] = match[2].trim();
  }
  return String(headers[String(name).toLowerCase()] || "").replace(/^<|>$/g, "").trim();
}

function inboxRefsForFile(filePath) {
  const refs = new Set([
    filePath,
    path.basename(filePath),
    path.relative(root, filePath).split(path.sep).join("/"),
  ].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const messageId = extractHeader(raw, "message-id");
    if (messageId) refs.add(messageId.toLowerCase());
  } catch {
    // Path and filename refs are enough to preserve manual-import visibility.
  }
  const uidMatch = path.basename(filePath).match(/^\d+_([A-Za-z0-9]+)\.eml$/i);
  if (uidMatch?.[1]) refs.add(uidMatch[1].toLowerCase());
  return refs;
}

function loadManualImportRefs() {
  const parsed = readJson(manualImportsPath, { refs: [] });
  const refs = Array.isArray(parsed?.refs) ? parsed.refs : parsed;
  return new Set((Array.isArray(refs) ? refs : []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
}

function saveManualImportRefs(refs) {
  writeJson(manualImportsPath, {
    refs: [...refs].sort(),
    updated_at: new Date().toISOString(),
  });
}

function visibilityDiagnostics() {
  const hidden = readJson(path.join(root, "hidden_emails.json"), { hidden_emails: [] });
  const workspaceHidden = readJson(path.join(root, "workspace_inbox_hidden.json"), { hidden_ids: [] });
  const processed = readJson(path.join(root, ".processedInboxRefs.json"), []);
  const sourceDeleted = readJson(path.join(internalDir, "inbox_source_state.json"), { uids: {} });
  const dedup = readJson(path.join(internalDir, "dedup_store.json"), { messages: {} });
  const sourceDeletedRefs = sourceDeleted?.uids && typeof sourceDeleted.uids === "object"
    ? Object.values(sourceDeleted.uids).filter((value) => value === true).length
    : 0;
  return {
    inboxEmlCount: countEmlFiles(inboxDir),
    unmatchedEmlCount: countEmlFiles(unmatchedDir) + countEmlFiles(legacyUnmatchedDir),
    hiddenEmailCount: (Array.isArray(hidden?.hidden_emails) ? hidden.hidden_emails.length : 0)
      + (Array.isArray(workspaceHidden?.hidden_ids) ? workspaceHidden.hidden_ids.length : 0),
    processedRefsCount: Array.isArray(processed) ? processed.length : 0,
    sourceDeletedRefsCount: sourceDeletedRefs,
    dedupHitCount: dedup?.messages && typeof dedup.messages === "object" ? Object.keys(dedup.messages).length : 0,
  };
}

function ensureHelperLeavesUnmatched() {
  const current = readJson(helperSettingsPath, {});
  writeJson(helperSettingsPath, {
    ...current,
    unmatchedHandling: "leave",
  });
}

function stopHelperProcesses() {
  if (process.platform !== "win32") return;
  const ps = [
    "$procs = Get-CimInstance Win32_Process | Where-Object {",
    "  $_.CommandLine -match 'helper[\\\\/]tray_app\\.py' -or $_.CommandLine -match 'helper[\\\\/]sync_folders\\.py'",
    "}",
    "$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "$procs | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
  ].join("\n");
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
    if (output) console.log("[recover] stopped helper processes:", output);
  } catch (error) {
    console.warn("[recover] could not stop helper processes:", error?.message || error);
  }
}

function recoverUnmatchedToInbox() {
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(unmatchedDir, { recursive: true });
  const refs = loadManualImportRefs();
  const sources = [unmatchedDir, legacyUnmatchedDir].filter((folder, index, list) => fs.existsSync(folder) && list.indexOf(folder) === index);
  const entries = sources.flatMap((folder) => fs.readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".eml"))
    .map((entry) => ({ entry, folder })));
  let copied = 0;
  let skippedExisting = 0;
  const restored = [];
  for (const { entry, folder } of entries) {
    const sourcePath = path.join(folder, entry.name);
    const preferredTargetPath = path.join(inboxDir, entry.name);
    if (fs.existsSync(preferredTargetPath)) {
      for (const ref of inboxRefsForFile(preferredTargetPath)) refs.add(ref);
      skippedExisting += 1;
      continue;
    }
    const targetPath = uniquePath(preferredTargetPath);
    fs.copyFileSync(sourcePath, targetPath);
    for (const ref of inboxRefsForFile(targetPath)) refs.add(ref);
    copied += 1;
    restored.push({ sourcePath, targetPath });
  }
  saveManualImportRefs(refs);
  return { copied, skippedExisting, restored };
}

console.log("[recover] before", visibilityDiagnostics());
console.log("[recover] mode", execute ? "execute" : "dry-run");

if (!execute) {
  console.log("[recover] no changes made. Run with --execute --stop-helper to restore.");
  process.exit(0);
}

ensureHelperLeavesUnmatched();
if (stopHelper) stopHelperProcesses();
const result = recoverUnmatchedToInbox();
console.log("[recover] copied", result.copied);
console.log("[recover] skipped_existing", result.skippedExisting);
console.log("[recover] after", visibilityDiagnostics());
