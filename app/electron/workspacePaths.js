const os = require("os");
const path = require("path");
const fs = require("fs");

function getWorkspaceRoot() {
  if (process.platform === "win32") {
    return "C:\\Spaila";
  }
  return path.join(os.homedir(), "Spaila");
}

function getWorkspacePaths() {
  const root = getWorkspaceRoot();
  return {
    root,
    Inbox: path.join(root, "Inbox"),
    Orders: path.join(root, "Orders"),
    Duplicates: path.join(root, "Duplicates"),
    Archive: path.join(root, "Archive"),
    Backup: path.join(root, "Backup"),
  };
}

function ensureWorkspaceLayout(log = () => {}) {
  const paths = getWorkspacePaths();
  fs.mkdirSync(paths.root, { recursive: true });

  const legacyPairs = {
    inbox: "Inbox",
    orders: "Orders",
    duplicates: "Duplicates",
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

  ["Processed", "processed", "unmatched", "Unmatched"].forEach((legacyName) => {
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
