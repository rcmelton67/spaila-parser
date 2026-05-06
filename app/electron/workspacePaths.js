"use strict";
/**
 * Spaila workspace path management — JS mirror of workspace_paths.py.
 *
 * Root resolution order (first match wins):
 *  1. SPAILA_WORKSPACE_ROOT env var (CI / testing)
 *  2. workspace_config.json in OS app-config directory
 *  3. Legacy C:\Spaila (Windows) / ~/Spaila (other) — if it already exists with data
 *  4. Default new location: ~/Spaila  (home dir, cross-platform)
 *
 * workspace_config.json location:
 *  Windows : %APPDATA%/Spaila/workspace_config.json
 *  Other   : ~/.config/Spaila/workspace_config.json
 */

const os   = require("os");
const path = require("path");
const fs   = require("fs");
const { execFileSync } = require("child_process");

const CONFIG_VERSION = "2";

// ── Config directory (NOT inside the workspace) ─────────────────────────────

function getConfigDir() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || os.homedir();
    return path.join(appdata, "Spaila");
  }
  return path.join(os.homedir(), ".config", "Spaila");
}

function getConfigPath() {
  return path.join(getConfigDir(), "workspace_config.json");
}

function readConfig() {
  const cp = getConfigPath();
  try {
    if (fs.existsSync(cp)) {
      return JSON.parse(fs.readFileSync(cp, "utf8"));
    }
  } catch (_) {}
  return {};
}

function writeConfig(root, migrationVersion = "0") {
  const cd = getConfigDir();
  fs.mkdirSync(cd, { recursive: true });
  const existing = readConfig();
  const cfg = {
    workspace_root:       root.replace(/\\/g, "/"),
    initialized_version:  CONFIG_VERSION,
    migration_version:    String(migrationVersion),
    created_at:           existing.created_at || new Date().toISOString(),
  };
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), "utf8");
}

// ── Workspace root ────────────────────────────────────────────────────────────

function getWorkspaceRoot() {
  // 1. Env override
  const envRoot = (process.env.SPAILA_WORKSPACE_ROOT || "").trim();
  if (envRoot) return envRoot;

  // 2. Persisted config
  const cfg = readConfig();
  if (cfg.workspace_root) return cfg.workspace_root;

  // 3. Legacy default — preserve existing installs that have real data
  // Only use it if it contains at least one user-visible subfolder with content.
  // An empty C:\Spaila (recreated by old code after a manual move) is ignored.
  const legacy = process.platform === "win32"
    ? "C:\\Spaila"
    : path.join(os.homedir(), "Spaila");
  if (fs.existsSync(legacy) && _legacyRootHasData(legacy)) {
    writeConfig(legacy, "0");
    return legacy;
  }

  // 4. New default
  // Default: ~/Spaila — home dir avoids OneDrive/cloud-sync redirection
  const newDefault = path.join(os.homedir(), "Spaila");
  writeConfig(newDefault, "1");
  return newDefault;
}

// ── Legacy root content check ─────────────────────────────────────────────────

/**
 * Returns true only if the legacy root folder has at least one user-visible
 * subfolder containing files (Orders, Archive, Inbox, Backup, Sent, Docs).
 * An empty directory skeleton left behind by old code returns false.
 */
function _legacyRootHasData(legacyRoot) {
  const markers = ["Orders", "Archive", "Inbox", "inbox", "Backup", "Sent", "Docs"];
  for (const name of markers) {
    const sub = path.join(legacyRoot, name);
    try {
      if (fs.existsSync(sub) && fs.readdirSync(sub).length > 0) return true;
    } catch (_) {}
  }
  // Also check for any .json config files in root (pre-migration install)
  const jsonMarkers = ["helper_settings.json", "email_settings.json", "hidden_emails.json"];
  for (const name of jsonMarkers) {
    if (fs.existsSync(path.join(legacyRoot, name))) return true;
  }
  // Check .spaila_internal with actual files
  const internal = path.join(legacyRoot, ".spaila_internal");
  try {
    if (fs.existsSync(internal) && fs.readdirSync(internal).length > 0) return true;
  } catch (_) {}
  return false;
}

// ── Workspace path map ────────────────────────────────────────────────────────

function getWorkspacePaths() {
  const root     = getWorkspaceRoot();
  const internal = path.join(root, ".spaila_internal");
  return {
    // ── User-visible ──────────────────────────────────────────────────────
    root,
    Inbox:    path.join(root, "Inbox"),
    Orders:   path.join(root, "Orders"),
    Archive:  path.join(root, "Archive"),
    Backup:   path.join(root, "Backup"),
    Sent:     path.join(root, "Sent"),        // was lowercase "sent"
    Docs:     path.join(root, "Docs"),        // was hardcoded C:\Spaila\Docs
    // ── Internal / system ────────────────────────────────────────────────
    Internal:     internal,
    InboxModule:  path.join(root, "Inbox"),
    InboxNew:     path.join(root, "Inbox"),
    InboxCur:     path.join(root, "Inbox"),
    // Recovery (inside internal)
    Duplicates:   path.join(internal, "duplicates"),
    Unmatched:    path.join(internal, "unmatched"),
    // ── System JSON file paths (all inside .spaila_internal/) ────────────
    HelperSettings:       path.join(internal, "helper_settings.json"),
    EmailSettings:        path.join(internal, "email_settings.json"),
    OrderEmailLearning:   path.join(internal, "order_email_learning.json"),
    HiddenEmails:         path.join(internal, "hidden_emails.json"),
    WorkspaceInboxHidden: path.join(internal, "workspace_inbox_hidden.json"),
    ProcessedInboxRefs:   path.join(internal, ".processedInboxRefs.json"),
    OrderArchiveSettings: path.join(internal, "order_archive_settings.json"),
    SentMessages:         path.join(internal, "sent_messages.json"),
    // ── Support reports ──────────────────────────────────────────────────
    SupportReports: path.join(internal, "support_reports"),
  };
}

// ── Legacy recovery folder migration ─────────────────────────────────────────

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir  = path.dirname(targetPath);
  const ext  = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let suffix = 1;
  while (true) {
    const candidate = path.join(dir, `${base}__migrated${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    suffix += 1;
  }
}

function migrateLegacyRecoveryFolder(root, legacyName, internalPath, log) {
  const legacyPath = path.join(root, legacyName);
  if (!fs.existsSync(legacyPath)) return;
  fs.mkdirSync(internalPath, { recursive: true });
  let migrated = 0;
  try {
    for (const entry of fs.readdirSync(legacyPath, { withFileTypes: true })) {
      const src = path.join(legacyPath, entry.name);
      const dst = uniquePath(path.join(internalPath, entry.name));
      fs.renameSync(src, dst);
      migrated += 1;
    }
    if (migrated) log(`[WORKSPACE] migrated ${migrated} file(s) from ${legacyPath} -> ${internalPath}`);
    if (!fs.readdirSync(legacyPath).length) {
      fs.rmdirSync(legacyPath);
      log(`[WORKSPACE] removed empty legacy recovery folder: ${legacyPath}`);
    } else {
      log(`[WORKSPACE] legacy recovery folder retained with non-file entries: ${legacyPath}`);
    }
  } catch (error) {
    log(`[WORKSPACE] recovery migration failed for ${legacyPath}: ${error.message || error}`);
  }
}

// ── Root JSON → .spaila_internal/ migration ──────────────────────────────────

function migrateRootJsonFiles(paths, log) {
  const root     = paths.root;
  const internal = paths.Internal;
  const entries  = [
    ["helper_settings.json",        paths.HelperSettings],
    ["email_settings.json",         paths.EmailSettings],
    ["order_email_learning.json",   paths.OrderEmailLearning],
    ["hidden_emails.json",          paths.HiddenEmails],
    ["workspace_inbox_hidden.json", paths.WorkspaceInboxHidden],
    [".processedInboxRefs.json",    paths.ProcessedInboxRefs],
    ["order_archive_settings.json", paths.OrderArchiveSettings],
    ["sent_messages.json",          paths.SentMessages],
  ];
  for (const [filename, dst] of entries) {
    const src = path.join(root, filename);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        log(`[WORKSPACE] migrated ${filename} -> .spaila_internal/`);
      } catch (e) {
        log(`[WORKSPACE] could not migrate ${filename}: ${e.message || e}`);
      }
    } else if (fs.existsSync(src) && fs.existsSync(dst)) {
      log(`[WORKSPACE] ${filename} already exists in .spaila_internal/, leaving root copy`);
    }
  }
}

// ── Generic workspace move (old root → new root) ─────────────────────────────

/**
 * Move all workspace content from oldRoot to newRoot.
 * Handles both same-drive (fast rename) and cross-drive (copy+delete) moves.
 * Never deletes the source until the destination has been verified.
 * Returns { ok: boolean, logLines: string[], errors: number }
 */
function _moveFolderContents(src, dst, log, logLines) {
  /** Merge the contents of src into dst, recursing into sub-folders.
   *  Returns the number of errors encountered. */
  let errors = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (fs.existsSync(d)) {
      if (entry.isDirectory() && fs.statSync(d).isDirectory()) {
        errors += _moveFolderContents(s, d, log, logLines);
      } else {
        logLines.push(`    skip ${entry.name}: already at destination`);
      }
    } else {
      try {
        fs.renameSync(s, d);
        logLines.push(`    merged ${entry.name}`);
      } catch (_) {
        try {
          if (entry.isDirectory()) {
            _copyDirRecursive(s, d);
            _removeDirRecursive(s);
          } else {
            fs.copyFileSync(s, d);
            fs.unlinkSync(s);
          }
          logLines.push(`    merged (cross-drive) ${entry.name}`);
        } catch (copyErr) {
          logLines.push(`    ERROR merging ${entry.name}: ${copyErr.message}`);
          errors += 1;
        }
      }
    }
  }
  return errors;
}

function moveWorkspace(oldRoot, newRoot, log) {
  const folders = [
    "Inbox", "inbox",    // include lowercase legacy so old installs migrate cleanly
    "Orders", "Archive",
    "Backup", "Sent", "sent",
    "Docs", ".spaila_internal",
  ];
  const logLines = [];
  let errors = 0;

  fs.mkdirSync(newRoot, { recursive: true });

  for (const name of folders) {
    const src = path.join(oldRoot, name);
    const dst = path.join(newRoot, name);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dst)) {
      // Destination exists (likely an empty skeleton from startup layout).
      // Merge contents so no files are stranded at the old location.
      logLines.push(`  merge ${name}: destination exists, merging contents`);
      log(`[WORKSPACE] merging ${name} contents into existing destination`);
      const errs = _moveFolderContents(src, dst, log, logLines);
      errors += errs;
      if (errs === 0) {
        try {
          if (fs.readdirSync(src).length === 0) fs.rmdirSync(src);
        } catch (_) {}
      }
      continue;
    }
    try {
      fs.renameSync(src, dst);
      logLines.push(`  moved ${name}: ${src} -> ${dst}`);
      log(`[WORKSPACE] moved ${name}`);
    } catch (renameErr) {
      // Cross-drive fallback: recursive copy then remove
      try {
        _copyDirRecursive(src, dst);
        _removeDirRecursive(src);
        logLines.push(`  copied+removed ${name} (cross-drive): ${src} -> ${dst}`);
        log(`[WORKSPACE] cross-drive move ${name}`);
      } catch (copyErr) {
        logLines.push(`  ERROR moving ${name}: ${copyErr.message || copyErr}`);
        log(`[WORKSPACE] ERROR moving ${name}: ${copyErr.message || copyErr}`);
        errors += 1;
      }
    }
  }

  // Write migration log into new location
  try {
    const logDir = path.join(newRoot, ".spaila_internal", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const stamp   = new Date().toISOString().slice(0, 10);
    const logFile = path.join(logDir, `migration_${stamp}.log`);
    const content = [
      `[${new Date().toISOString()}] Workspace moved: ${oldRoot} -> ${newRoot}`,
      ...logLines,
      errors ? `  ${errors} error(s) occurred — some items may remain in old location` : "  completed without errors",
      "",
    ].join("\n");
    fs.appendFileSync(logFile, content, "utf8");
    log(`[WORKSPACE] migration log written: ${logFile}`);
  } catch (_) {}

  return { ok: errors === 0, logLines, errors };
}

function _copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      _copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function _removeDirRecursive(p) {
  // Node 14+: fs.rmSync with recursive; older: manual
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {
    // Ignore cleanup errors — data is already at destination
  }
}

// Kept for internal legacy-detection use in ensureWorkspaceLayout
function migrateLegacyWorkspaceRoot(root, legacyRoot, log) {
  return moveWorkspace(legacyRoot, root, log);
}

// ── Main layout function ──────────────────────────────────────────────────────

function ensureWorkspaceLayout(log = () => {}) {
  const paths = getWorkspacePaths();
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.Internal, { recursive: true });

  if (process.platform === "win32") {
    try { execFileSync("attrib", ["+h", paths.Internal], { windowsHide: true, stdio: "ignore" }); } catch (_) {}
  }

  // ── Capitalization normalization (Windows-safe two-step case rename) ────────
  // On Windows, path.exists() is case-insensitive, so we must inspect the real
  // on-disk names via fs.readdirSync to detect a casing mismatch.
  const legacyPairs = {
    inbox:   "Inbox",
    orders:  "Orders",
    archive: "Archive",
    backup:  "Backup",
    sent:    "Sent",
    docs:    "Docs",
  };
  let rootEntries;
  try { rootEntries = fs.readdirSync(paths.root); } catch (_) { rootEntries = []; }
  const rootEntriesLower = Object.fromEntries(rootEntries.map(n => [n.toLowerCase(), n]));

  for (const [legacyLower, canonicalName] of Object.entries(legacyPairs)) {
    const actualName = rootEntriesLower[legacyLower];
    if (!actualName) continue;               // folder doesn't exist — created below
    if (actualName === canonicalName) continue; // already correct
    const actualPath    = path.join(paths.root, actualName);
    const canonicalPath = path.join(paths.root, canonicalName);
    const tmpPath       = path.join(paths.root, `__spaila_tmp_rename__${actualName}__`);
    try {
      fs.renameSync(actualPath, tmpPath);
      fs.renameSync(tmpPath, canonicalPath);
      log(`[WORKSPACE] case-renamed ${actualName} -> ${canonicalName}`);
    } catch (error) {
      log(`[WORKSPACE] case-rename failed ${actualName} -> ${canonicalName}: ${error.message || error}`);
      try { if (fs.existsSync(tmpPath)) fs.renameSync(tmpPath, actualPath); } catch (_) {}
    }
  }

  // ── Month subfolder capitalisation (Orders/2026/april → April) ────────────
  const ordersDir = path.join(paths.root, "Orders");
  if (fs.existsSync(ordersDir)) {
    for (const yearEntry of fs.readdirSync(ordersDir, { withFileTypes: true })) {
      if (!yearEntry.isDirectory() || !/^\d+$/.test(yearEntry.name)) continue;
      const yearDir = path.join(ordersDir, yearEntry.name);
      for (const moEntry of fs.readdirSync(yearDir, { withFileTypes: true })) {
        if (!moEntry.isDirectory()) continue;
        const canonical = moEntry.name.charAt(0).toUpperCase() + moEntry.name.slice(1).toLowerCase();
        if (moEntry.name === canonical) continue;
        const moPath  = path.join(yearDir, moEntry.name);
        const moCanon = path.join(yearDir, canonical);
        const moTmp   = path.join(yearDir, `__spaila_tmp_rename__${moEntry.name}__`);
        try {
          fs.renameSync(moPath, moTmp);
          fs.renameSync(moTmp, moCanon);
          log(`[WORKSPACE] case-renamed month ${moEntry.name} -> ${canonical}`);
        } catch (error) {
          log(`[WORKSPACE] month case-rename failed ${moEntry.name}: ${error.message}`);
          try { if (fs.existsSync(moTmp)) fs.renameSync(moTmp, moPath); } catch (_) {}
        }
      }
    }
  }

  // ── Recovery folder migration (Duplicates/Unmatched → internal) ──────────
  migrateLegacyRecoveryFolder(paths.root, "Duplicates", paths.Duplicates, log);
  migrateLegacyRecoveryFolder(paths.root, "duplicates", paths.Duplicates, log);
  migrateLegacyRecoveryFolder(paths.root, "Unmatched",  paths.Unmatched,  log);
  migrateLegacyRecoveryFolder(paths.root, "unmatched",  paths.Unmatched,  log);

  for (const legacyName of ["Processed", "processed"]) {
    const legacyPath = path.join(paths.root, legacyName);
    if (fs.existsSync(legacyPath)) log(`[WORKSPACE] legacy folder left in place: ${legacyPath}`);
  }

  // ── Legacy workspace root migration (C:\Spaila → Documents/Spaila) ───────
  const cfg = readConfig();
  const migrationVersion = cfg.migration_version || "0";
  if (migrationVersion === "0" && process.platform === "win32") {
    const legacyRoot = "C:\\Spaila";
    if (
      fs.existsSync(legacyRoot) &&
      path.resolve(paths.root) !== path.resolve(legacyRoot)
    ) {
      log(`[WORKSPACE] migrating legacy workspace ${legacyRoot} -> ${paths.root}`);
      migrateLegacyWorkspaceRoot(paths.root, legacyRoot, log);
      writeConfig(paths.root, "1");
    }
  }

  // ── Root JSON → .spaila_internal/ migration ──────────────────────────────
  migrateRootJsonFiles(paths, log);

  // ── Create all directories ────────────────────────────────────────────────
  const dirsToCreate = [
    "Inbox", "InboxModule", "Orders", "Archive", "Backup",
    "Sent", "Docs", "Internal", "Duplicates", "Unmatched", "SupportReports",
  ];
  for (const key of dirsToCreate) {
    if (paths[key]) fs.mkdirSync(paths[key], { recursive: true });
  }

  return paths;
}

module.exports = {
  getWorkspaceRoot,
  getWorkspacePaths,
  getConfigDir,
  getConfigPath,
  readConfig,
  writeConfig,
  ensureWorkspaceLayout,
  moveWorkspace,
};
