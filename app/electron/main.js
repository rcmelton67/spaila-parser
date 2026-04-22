const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

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

ipcMain.handle("app:set-title", (_event, title) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.setTitle(title || "Parser Viewer");
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
    if (!fs.existsSync(DB_PATH)) {
      return { ok: false, error: "Database file not found." };
    }
    const dbBytes  = fs.readFileSync(DB_PATH);
    const dbBase64 = dbBytes.toString("base64");

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename  = `spaila-backup-${timestamp}.spailabackup`;
    const dest      = path.join(folderPath, filename);

    const payload = JSON.stringify({
      version:    BACKUP_VERSION,
      createdAt:  new Date().toISOString(),
      database:   dbBase64,
      settings:   localStorageData,   // all localStorage key→value pairs
    });

    fs.writeFileSync(dest, payload, "utf8");
    return { ok: true, path: dest, filename };
  } catch (err) {
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
  const result = await dialog.showOpenDialog({
    title: title || "Select File",
    properties: ["openFile"],
    filters: filters || [{ name: "All Files", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0], name: require("path").basename(result.filePaths[0]) };
});

ipcMain.handle("dialog:pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select Archive Folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { path: result.filePaths[0] };
});

// ── Email compose ────────────────────────────────────────────────────────────

ipcMain.handle("email:list-attachments", async (_event, { folderPath, mode, extensions }) => {
  if (!folderPath || mode === "none") return { files: [], warnings: [] };
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    let files = entries
      .filter((e) => e.isFile())
      .map((e) => path.join(folderPath, e.name));

    if (mode === "images") {
      files = files.filter((f) => /\.(jpe?g|png|gif|bmp|webp)$/i.test(f));
    } else if (mode === "extension" && extensions?.length) {
      const exts = extensions.map((e) => e.toLowerCase().replace(/^\./, ""));
      files = files.filter((f) => {
        const ext = path.extname(f).toLowerCase().replace(".", "");
        return exts.includes(ext);
      });
    }

    const warnings = [];
    if (files.length === 0) warnings.push("No attachments found");
    else if (files.length > 1) warnings.push(`Multiple attachments found (${files.length} files)`);

    return { files, warnings };
  } catch (err) {
    return { files: [], warnings: [`Could not read folder: ${err.message}`] };
  }
});

/**
 * Convert a plain-text email body to HTML in JavaScript so URLs become
 * clickable <a> tags. Done here (not in PowerShell) for reliability.
 */
function _plainTextToHtml(text) {
  // 1. Escape HTML special characters
  let html = (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  // 2. Wrap bare URLs in anchor tags
  html = html.replace(/(https?:\/\/[^\s<>"]+)/gi, '<a href="$1">$1</a>');

  // 3. Convert newlines to <br>
  html = html.replace(/\r?\n/g, "<br>\n");

  return (
    '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.8;color:#222">' +
    html +
    "</div>"
  );
}

function _buildOutlookScript(to, subject, body, attachments) {
  // Convert body to HTML before encoding — PowerShell just decodes and sets HTMLBody.
  const htmlBody = _plainTextToHtml(body);

  // Base64 encode a string for PowerShell UTF-8 decoding
  const enc = (s) => Buffer.from(s || "", "utf8").toString("base64");
  const decodeExpr = (b64) =>
    `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`;

  // Base64 encode a string for PowerShell -EncodedCommand (requires UTF-16LE)
  const encCmd = (s) => Buffer.from(s || "", "utf16le").toString("base64");

  const attachLines = (attachments || [])
    .map((p) => `  $mail.Attachments.Add('${p.replace(/'/g, "''")}') | Out-Null`)
    .join("\n");

  // The activation script runs as a grandchild process (spawned via Start-Process
  // from inside the .ps1). Because it is NOT a direct child of Electron it is
  // allowed to steal foreground focus on Windows.
  const activatePs = [
    "Start-Sleep -Milliseconds 900",
    "try {",
    "  $ol  = New-Object -ComObject Outlook.Application",
    "  $ins = $ol.ActiveInspector()",
    "  if ($ins) { $ins.WindowState = 1; $ins.Activate() }",
    "} catch {}",
    "try { (New-Object -ComObject WScript.Shell).AppActivate((Get-Process outlook -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowTitle) | Out-Null } catch {}",
  ].join("\n");
  const encodedActivate = encCmd(activatePs);

  return `
try {
  $outlook = New-Object -ComObject Outlook.Application
  $mail = $outlook.CreateItem(0)
  $mail.To       = ${decodeExpr(enc(to))}
  $mail.Subject  = ${decodeExpr(enc(subject))}
  $mail.HTMLBody = ${decodeExpr(enc(htmlBody))}
${attachLines}
  $mail.Display($false)

  # Spawn an independent grandchild to bring Outlook to the foreground.
  # Start-Process creates a process outside Electron's parent chain, so
  # Windows permits it to call SetForegroundWindow.
  Start-Process powershell -ArgumentList @("-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", "${encodedActivate}") -WindowStyle Hidden

} catch {
  exit 1
}
`.trim();
}

ipcMain.handle("email:compose", async (_event, { to, subject, body, attachmentPaths }) => {
  const hasAttachments = Array.isArray(attachmentPaths) && attachmentPaths.length > 0;

  // ── Always try Outlook COM via PowerShell first (HTML body + attachments) ─
  // mailto: is plain-text only and cannot render hyperlinks.
  // The focus-stealing trick is handled INSIDE the .ps1 script itself by
  // spawning a grandchild process (Start-Process) that is not a child of
  // Electron and therefore can call SetForegroundWindow freely.
  {
    const script = _buildOutlookScript(to, subject, body, attachmentPaths);
    const tmpFile = path.join(os.tmpdir(), `spaila_email_${Date.now()}.ps1`);
    try {
      fs.writeFileSync(tmpFile, script, "utf8");
      await new Promise((resolve, reject) => {
        execFile(
          "powershell",
          ["-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile],
          { windowsHide: true },
          (err) => {
            try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
            if (err) reject(err);
            else resolve();
          }
        );
      });
      return { ok: true, method: "outlook" };
    } catch (_) {
      try { fs.unlinkSync(tmpFile); } catch (_2) { /* ignore */ }
      // Outlook not available — fall through to mailto
    }
  }

  // ── mailto fallback ───────────────────────────────────────────────────────
  const mailto = `mailto:${encodeURIComponent(to || "")}?subject=${encodeURIComponent(subject || "")}&body=${encodeURIComponent(body || "")}`;
  await shell.openExternal(mailto);
  return {
    ok: true,
    method: "mailto",
    attachmentsFallback: hasAttachments,
  };
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
