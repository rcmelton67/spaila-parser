import React from "react";
import AppHeader from "../../shared/components/AppHeader.jsx";

const panelStyle = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
};

function formatTimestamp(value) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function WorkspacePage({
  onOpenFile,
  onImport,
  onWorkspace,
  onSettings,
  onOrders,
  activeCount = 0,
  completedCount = 0,
}) {
  const [bucket, setBucket] = React.useState("Inbox");
  const [relativePath, setRelativePath] = React.useState("");
  const [workspaceState, setWorkspaceState] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [dropMessage, setDropMessage] = React.useState("");
  const [isDropActive, setIsDropActive] = React.useState(false);

  const loadWorkspace = React.useCallback(async (nextBucket = bucket, nextRelativePath = relativePath) => {
    setLoading(true);
    try {
      const nextState = await window.parserApp?.getWorkspaceState?.({
        bucket: nextBucket,
        relativePath: nextRelativePath,
      });
      setWorkspaceState(nextState || null);
      setError("");
    } catch (nextError) {
      setError(nextError.message || "Could not load workspace.");
    } finally {
      setLoading(false);
    }
  }, [bucket, relativePath]);

  React.useEffect(() => {
    loadWorkspace(bucket, relativePath);
  }, [bucket, relativePath, loadWorkspace]);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      loadWorkspace(bucket, relativePath);
    }, 4000);
    function handleFocus() {
      loadWorkspace(bucket, relativePath);
    }
    window.addEventListener("focus", handleFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, [bucket, relativePath, loadWorkspace]);

  React.useEffect(() => {
    if (!dropMessage) return undefined;
    const timer = window.setTimeout(() => setDropMessage(""), 2800);
    return () => window.clearTimeout(timer);
  }, [dropMessage]);

  const inboxItems = workspaceState?.inboxItems || [];
  const buckets = workspaceState?.buckets || [];
  const currentEntries = workspaceState?.entries || [];

  async function handleDrop(event) {
    event.preventDefault();
    setIsDropActive(false);
    const filePaths = Array.from(event.dataTransfer?.files || [])
      .map((file) => file.path)
      .filter(Boolean);
    if (!filePaths.length) {
      setDropMessage("No files detected.");
      return;
    }
    try {
      const result = await window.parserApp?.addFilesToInbox?.({ filePaths });
      const addedCount = result?.added?.length || 0;
      const skippedCount = result?.skipped?.length || 0;
      if (addedCount > 0 && skippedCount === 0) {
        setDropMessage(`${addedCount} file${addedCount === 1 ? "" : "s"} added to Inbox`);
      } else if (addedCount > 0) {
        setDropMessage(`${addedCount} added, ${skippedCount} skipped`);
      } else {
        setDropMessage("No files were added.");
      }
      await loadWorkspace(bucket, relativePath);
    } catch (nextError) {
      setDropMessage(nextError.message || "Could not add files to Inbox.");
    }
  }

  function openInboxItem(item) {
    onOpenFile?.(item.path);
  }

  function openBucket(nextBucket) {
    setBucket(nextBucket);
    setRelativePath("");
  }

  function openEntry(entry) {
    if (entry.kind !== "directory") return;
    setRelativePath(entry.relativePath || "");
  }

  const breadcrumbParts = (workspaceState?.currentRelativePath || "").split("/").filter(Boolean);

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#f5f7fb", fontFamily: "'Segoe UI', sans-serif" }}>
      <AppHeader
        onSettings={onSettings}
        onImport={onImport}
        onWorkspace={onWorkspace}
        onSelectTab={onOrders}
        activeCount={activeCount}
        completedCount={completedCount}
        selectedNav="workspace"
        rightContent={
          <div style={{ fontSize: 12, color: "#64748b" }}>
            Workspace reflects Helper-controlled folders.
          </div>
        }
      />

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "380px 1fr", gap: 18, padding: 18, minHeight: 0 }}>
        <section style={{ ...panelStyle, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>Inbox</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
              Click an email to open it in the parser. Items may disappear as Helper processes them.
            </div>
          </div>

          <div
            onDragOver={(event) => { event.preventDefault(); setIsDropActive(true); }}
            onDragLeave={() => setIsDropActive(false)}
            onDrop={handleDrop}
            style={{
              margin: 16,
              border: `1.5px dashed ${isDropActive ? "#2563eb" : "#cbd5e1"}`,
              background: isDropActive ? "#eff6ff" : "#f8fafc",
              color: "#475569",
              borderRadius: 12,
              padding: "14px 16px",
              fontSize: 12,
            }}
          >
            Drop files here to copy them into `Inbox`. No parsing starts automatically.
          </div>

          {dropMessage && (
            <div style={{ margin: "0 16px 10px", fontSize: 12, color: "#1d4ed8" }}>{dropMessage}</div>
          )}
          {error && (
            <div style={{ margin: "0 16px 10px", fontSize: 12, color: "#b91c1c" }}>{error}</div>
          )}

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 16px 16px" }}>
            {loading && !workspaceState ? (
              <div style={{ fontSize: 13, color: "#64748b" }}>Loading workspace…</div>
            ) : inboxItems.length === 0 ? (
              <div style={{ fontSize: 13, color: "#64748b" }}>Inbox is empty.</div>
            ) : inboxItems.map((item) => (
              <button
                key={item.relativePath || item.path}
                onClick={() => openInboxItem(item)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  border: "1px solid #e5e7eb",
                  background: "#fff",
                  borderRadius: 12,
                  padding: 14,
                  marginBottom: 10,
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>{item.subject || item.name}</div>
                <div style={{ marginTop: 6, fontSize: 12, color: "#64748b" }}>{item.preview || item.name}</div>
                <div style={{ marginTop: 8, fontSize: 11, color: "#94a3b8" }}>{formatTimestamp(item.timestamp)}</div>
              </button>
            ))}
          </div>
        </section>

        <section style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 18, minHeight: 0 }}>
          <div style={{ ...panelStyle, padding: 16 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a" }}>System</div>
            <div style={{ marginTop: 4, fontSize: 12, color: "#64748b" }}>
              Read-only workspace folders. Helper controls movement; Spaila only reflects state.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
              {buckets.map((item) => (
                <button
                  key={item.key}
                  onClick={() => openBucket(item.key)}
                  style={{
                    textAlign: "left",
                    border: `1px solid ${bucket === item.key ? "#93c5fd" : "#e5e7eb"}`,
                    background: bucket === item.key ? "#eff6ff" : "#fff",
                    borderRadius: 12,
                    padding: 12,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 12, color: "#64748b" }}>{item.key}</div>
                  <div style={{ marginTop: 6, fontSize: 20, fontWeight: 700, color: "#0f172a" }}>{item.count}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={{ ...panelStyle, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: 16, borderBottom: "1px solid #e5e7eb" }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>{bucket}</div>
              <div style={{ marginTop: 8, fontSize: 12, color: "#64748b", display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setRelativePath("")}
                  style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer", padding: 0 }}
                >
                  root
                </button>
                {breadcrumbParts.map((part, index) => {
                  const nextPath = breadcrumbParts.slice(0, index + 1).join("/");
                  return (
                    <button
                      key={nextPath}
                      onClick={() => setRelativePath(nextPath)}
                      style={{ border: "none", background: "none", color: "#2563eb", cursor: "pointer", padding: 0 }}
                    >
                      / {part}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 16 }}>
              {loading && workspaceState ? <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>Refreshing…</div> : null}
              {workspaceState?.currentKind === "file" ? (
                <div style={{ fontSize: 13, color: "#64748b" }}>File view is read-only.</div>
              ) : currentEntries.length === 0 ? (
                <div style={{ fontSize: 13, color: "#64748b" }}>This folder is empty.</div>
              ) : currentEntries.map((entry) => (
                <div
                  key={entry.relativePath || entry.path}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 10,
                    alignItems: "center",
                    padding: "12px 14px",
                    border: "1px solid #e5e7eb",
                    borderRadius: 12,
                    marginBottom: 10,
                    background: "#fff",
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{entry.name}</div>
                    <div style={{ marginTop: 4, fontSize: 11, color: "#94a3b8" }}>{entry.relativePath || entry.path}</div>
                  </div>
                  {entry.kind === "directory" ? (
                    <button
                      onClick={() => openEntry(entry)}
                      style={{ border: "1px solid #cbd5e1", background: "#fff", borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}
                    >
                      Open
                    </button>
                  ) : (
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>Read-only</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
