const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// ── Helper process (sync_folders.py) ────────────────────────────────────────
const ROOT = path.join(__dirname, "..", "..");
let helperProcess = null;
let helperRestarting = false;

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text); // forward parser debug logs to terminal in real-time
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
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

  const ordersRoot = path.join(ROOT, "..", "Spaila", "orders");
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
  const candidates = [
    ...(await fetchOrderPathCandidates(orderNumber)),
    originalPath,
    findOriginalEmlInOrders(orderNumber),
  ].filter(Boolean);

  const resolvedPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolvedPath) {
    throw new Error("Email file not found. It may have been moved.");
  }

  return resolvedPath;
}

ipcMain.handle("parser:import-eml", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "EML Files", extensions: ["eml"] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const parsed = await runBridge({ action: "parse", path: filePath });
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  return {
    filePath,
    ...parsed,
  };
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
  if (!folderPath) return { error: "No folder path provided" };
  const err = await shell.openPath(folderPath);
  return err ? { error: err } : { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  startHelper();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
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
