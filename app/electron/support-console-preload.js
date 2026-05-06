"use strict";
/**
 * Preload for the Spaila Support Console BrowserWindow.
 * Exposes only the support-console IPC surface — nothing from the customer app.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("supportConsole", {
  // Report listing / reading
  listReports:   ()          => ipcRenderer.invoke("support:list-reports"),
  readReport:    (fp)        => ipcRenderer.invoke("support:read-report", fp),

  // Status management
  updateStatus:  (fp, status) => ipcRenderer.invoke("support:update-status", fp, status),

  // File system
  openFile:      (fp)        => ipcRenderer.invoke("support:open-file", fp),
  openFolder:    ()          => ipcRenderer.invoke("support:open-reports-folder"),

  // Live watch — backend pushes "support:new-report" events to this window
  startWatch:    ()          => ipcRenderer.invoke("support:watch-start"),
  onNewReport:   (cb)        => ipcRenderer.on("support:new-report", (_e, fp) => cb(fp)),
  offNewReport:  (cb)        => ipcRenderer.removeListener("support:new-report", cb),
});
