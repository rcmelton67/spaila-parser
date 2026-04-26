import React from "react";

const tabStyle = {
  padding: "6px 14px",
  border: "1px solid #ccc",
  background: "#eee",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "13px",
};

const tabStyleActive = {
  ...tabStyle,
  background: "#fff",
  borderBottom: "2px solid #2563eb",
  fontWeight: "bold",
  color: "#2563eb",
};

export default function AppHeader({
  canSave = false,
  onSave,
  saveTitle = "Nothing to save yet",
  onSettings,
  documentsConfig = {},
  onWorkspace,
  activeTab = "active",
  onSelectTab,
  activeCount = 0,
  completedCount = 0,
  archivedCount = 0,
  tabCounts = null,
  showCounts = true,
  selectedNav = "active",
  rightContent = null,
}) {
  const [saveFeedback, setSaveFeedback] = React.useState(false);
  const saveFeedbackTimerRef = React.useRef(null);
  const hasDoc = !!documentsConfig.thankYouPath;
  const titleText = hasDoc
    ? "Open thank you letter (ready to print)"
    : "No thank you letter configured - go to Settings -> Documents";

  React.useEffect(() => {
    return () => {
      if (saveFeedbackTimerRef.current) {
        window.clearTimeout(saveFeedbackTimerRef.current);
      }
    };
  }, []);

  const triggerSave = () => {
    if (!canSave) {
      return;
    }
    if (saveFeedbackTimerRef.current) {
      window.clearTimeout(saveFeedbackTimerRef.current);
    }
    setSaveFeedback(true);
    onSave?.();
    saveFeedbackTimerRef.current = window.setTimeout(() => {
      setSaveFeedback(false);
    }, 700);
  };

  const navButtonStyle = (key) => (
    selectedNav === key
      ? tabStyleActive
      : {
          ...tabStyle,
          opacity: selectedNav && selectedNav !== key ? 0.68 : 1,
          transition: "opacity 0.15s, background 0.15s, color 0.15s, border-color 0.15s",
        }
  );
  const settingsButtonStyle = selectedNav === "settings"
    ? {
        width: 36,
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fff",
        border: "1px solid #93c5fd",
        borderRadius: "10px",
        cursor: "pointer",
        fontSize: "18px",
        color: "#2563eb",
        boxShadow: "0 1px 3px rgba(37,99,235,0.18)",
        transition: "box-shadow 0.15s, border-color 0.15s, color 0.15s",
        flexShrink: 0,
      }
    : {
        width: 36,
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        cursor: "pointer",
        fontSize: "18px",
        color: "#64748b",
        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        transition: "box-shadow 0.15s, border-color 0.15s, color 0.15s",
        flexShrink: 0,
        opacity: selectedNav && selectedNav !== "settings" ? 0.72 : 1,
      };

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "10px 16px", borderBottom: "1px solid #ddd",
      background: "#f7f7f7", flexShrink: 0,
    }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={triggerSave}
          title={saveFeedback ? "Saved" : saveTitle}
          style={{
            width: 36, height: 36,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: saveFeedback ? "#16a34a" : canSave ? "#dbeafe" : "#e2e8f0",
            border: `1px solid ${saveFeedback ? "#15803d" : canSave ? "#bfdbfe" : "#cbd5e1"}`,
            borderRadius: "10px",
            cursor: canSave ? "pointer" : "default",
            fontSize: "18px",
            color: canSave ? "#1d4ed8" : "#94a3b8",
            boxShadow: saveFeedback
              ? "inset 0 2px 5px rgba(0,0,0,0.22)"
              : canSave ? "0 1px 3px rgba(37,99,235,0.16)" : "none",
            transform: saveFeedback ? "translateY(1px)" : "translateY(0)",
            transition: "background 0.14s, border-color 0.14s, box-shadow 0.14s, transform 0.14s",
            flexShrink: 0,
            opacity: canSave ? 1 : 0.55,
          }}
          onMouseEnter={(e) => {
            if (!canSave || saveFeedback) return;
            e.currentTarget.style.background = "#bfdbfe";
            e.currentTarget.style.boxShadow = "0 2px 8px rgba(37,99,235,0.22)";
          }}
          onMouseLeave={(e) => {
            if (!canSave || saveFeedback) return;
            e.currentTarget.style.background = "#dbeafe";
            e.currentTarget.style.boxShadow = "0 1px 3px rgba(37,99,235,0.16)";
          }}
        >{saveFeedback ? "✓" : "💾"}</button>

        <button
          onClick={onSettings}
          title="Settings"
          style={settingsButtonStyle}
          onMouseEnter={(e) => {
            e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.14)";
            e.currentTarget.style.borderColor = selectedNav === "settings" ? "#60a5fa" : "#cbd5e1";
            e.currentTarget.style.color = selectedNav === "settings" ? "#2563eb" : "#1e293b";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.boxShadow = selectedNav === "settings"
              ? "0 1px 3px rgba(37,99,235,0.18)"
              : "0 1px 3px rgba(0,0,0,0.08)";
            e.currentTarget.style.borderColor = selectedNav === "settings" ? "#93c5fd" : "#e2e8f0";
            e.currentTarget.style.color = selectedNav === "settings" ? "#2563eb" : "#64748b";
          }}
        >⚙</button>

        {documentsConfig.showThankYouHeaderBtn !== false && (
          <button
            onClick={hasDoc ? async () => {
              const result = await window.parserApp?.openFile?.({ filePath: documentsConfig.thankYouPath });
              if (result && !result.ok) alert(`Could not open file: ${result.error}`);
            } : undefined}
            title={titleText}
            style={{
              marginLeft: 12,
              width: 36, height: 36,
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "#fff",
              border: `1px solid ${hasDoc ? "#0369a1" : "#e2e8f0"}`,
              borderRadius: "10px",
              cursor: hasDoc ? "pointer" : "default",
              fontSize: "20px",
              color: hasDoc ? "#0369a1" : "#94a3b8",
              boxShadow: hasDoc ? "0 1px 4px rgba(3,105,161,0.2)" : "none",
              transition: "all 0.15s",
              flexShrink: 0,
              opacity: hasDoc ? 1 : 0.35,
            }}
            onMouseEnter={(e) => {
              if (!hasDoc) return;
              e.currentTarget.style.background = "#f0f9ff";
              e.currentTarget.style.boxShadow = "0 2px 8px rgba(3,105,161,0.3)";
            }}
            onMouseLeave={(e) => {
              if (!hasDoc) return;
              e.currentTarget.style.background = "#fff";
              e.currentTarget.style.boxShadow = "0 1px 4px rgba(3,105,161,0.2)";
            }}
          >📄</button>
        )}

        <div style={{ width: 1, height: 28, background: "#d1d5db", margin: "0 4px", flexShrink: 0 }} />

        <button onClick={onWorkspace} style={navButtonStyle("workspace")}>Workspace</button>
        <button style={navButtonStyle("active")} onClick={() => onSelectTab?.("active")}>
          {showCounts ? `Active (${activeCount})` : "Active"}
          {tabCounts && (
            <span style={{
              marginLeft: 6, background: selectedNav === "active" ? "#2563eb" : "#6b7280",
              color: "#fff", borderRadius: 999, padding: "1px 7px",
              fontSize: 11, fontWeight: 700, lineHeight: "16px",
            }}>{tabCounts.active}</span>
          )}
        </button>
        <button style={navButtonStyle("completed")} onClick={() => onSelectTab?.("completed")}>
          {"Completed"}
          {tabCounts && (
            <span style={{
              marginLeft: 6, background: selectedNav === "completed" ? "#2563eb" : "#6b7280",
              color: "#fff", borderRadius: 999, padding: "1px 7px",
              fontSize: 11, fontWeight: 700, lineHeight: "16px",
            }}>{tabCounts.completed}</span>
          )}
        </button>
        <button style={navButtonStyle("archived")} onClick={() => onSelectTab?.("archived")}>
          Archived
          {tabCounts && (
            <span style={{
              marginLeft: 6, background: selectedNav === "archived" ? "#2563eb" : "#6b7280",
              color: "#fff", borderRadius: 999, padding: "1px 7px",
              fontSize: 11, fontWeight: 700, lineHeight: "16px",
            }}>{tabCounts.archived}</span>
          )}
        </button>
      </div>
      {rightContent ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {rightContent}
        </div>
      ) : <div />}
    </div>
  );
}
