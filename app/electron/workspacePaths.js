const os = require("os");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

function getWorkspaceRoot() {
  if (process.platform === "win32") {
    return "C:\\Spaila";
  }
  return path.join(os.homedir(), "Spaila");
}

function getWorkspacePaths() {
  const root = getWorkspaceRoot();
  const internal = path.join(root, ".spaila_internal");
  return {
    root,
    Internal: internal,
    Inbox: path.join(root, "Inbox"),
    InboxModule: path.join(root, "inbox"),
    InboxNew: path.join(root, "inbox"),
    InboxCur: path.join(root, "inbox"),
    Orders: path.join(root, "Orders"),
    Archive: path.join(root, "Archive"),
    Backup: path.join(root, "Backup"),
    Duplicates: path.join(internal, "duplicates"),
    Unmatched: path.join(internal, "unmatched"),
  };
}

function uniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
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
      const sourcePath = path.join(legacyPath, entry.name);
      const targetPath = uniquePath(path.join(internalPath, entry.name));
      fs.renameSync(sourcePath, targetPath);
      migrated += 1;
    }
    if (migrated) {
      log(`[WORKSPACE] migrated ${migrated} file(s) from ${legacyPath} -> ${internalPath}`);
    }
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

function ensureWorkspaceLayout(log = () => {}) {
  const paths = getWorkspacePaths();
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.Internal, { recursive: true });
  if (process.platform === "win32") {
    try { execFileSync("attrib", ["+h", paths.Internal], { windowsHide: true, stdio: "ignore" }); } catch (_) {}
  }

  const legacyPairs = {
    orders: "Orders",
    archive: "Archive",
    backup: "Backup",
  };

  Object.entries(legacyPairs).forEach(([legacyName, canonicalName]) => {
    const legacyPath = path.join(paths.root, legacyName);
    const canonicalPath = paths[canonicalName];
    try {
      if (fs.existsSync(legacyPath) && !fs.existsSync(canonicalPath)) {
        fs.renameSync(legacyPath, canonicalPath);
        log(`[WORKSPACE] renamed ${legacyPath} -> ${canonicalPath}`);
      } else if (fs.existsSync(legacyPath) && fs.existsSync(canonicalPath)) {
        log(`[WORKSPACE] rename skipped for ${legacyPath} because ${canonicalPath} already exists`);
      }
    } catch (error) {
      log(`[WORKSPACE] rename failed for ${legacyPath}: ${error.message || error}`);
    }
  });

  migrateLegacyRecoveryFolder(paths.root, "Duplicates", paths.Duplicates, log);
  migrateLegacyRecoveryFolder(paths.root, "duplicates", paths.Duplicates, log);
  migrateLegacyRecoveryFolder(paths.root, "Unmatched", paths.Unmatched, log);
  migrateLegacyRecoveryFolder(paths.root, "unmatched", paths.Unmatched, log);

  ["Processed", "processed"].forEach((legacyName) => {
    const legacyPath = path.join(paths.root, legacyName);
    if (fs.existsSync(legacyPath)) {
      log(`[WORKSPACE] legacy folder left in place: ${legacyPath}`);
    }
  });

  Object.entries(paths).forEach(([key, folderPath]) => {
    if (key === "root") return;
    fs.mkdirSync(folderPath, { recursive: true });
  });

  return paths;
}

module.exports = {
  getWorkspaceRoot,
  getWorkspacePaths,
  ensureWorkspaceLayout,
};
