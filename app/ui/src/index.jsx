import React from "react";
import { createRoot } from "react-dom/client";
import ParserApp from "./features/parser/ParserApp.jsx";
import OrdersPage from "./features/orders/OrdersPage.jsx";
import WorkspacePage from "./features/workspace/WorkspacePage.jsx";
import SettingsPage from "./settings/SettingsModal.jsx";
import {
  loadColumnOrder,
  loadFieldConfig,
  loadShopConfig,
  loadStatusConfig,
  saveColumnOrder,
  saveFieldConfig,
  saveShopConfig,
  savePriceList,
  saveStatusConfig,
} from "./shared/utils/fieldConfig.js";
import "./features/parser/styles.css";

const SUPPORT_EMAIL = "support@spaila.com";

function applySharedWidthProfile(layout) {
  const profiles = layout?.column_width_profiles && typeof layout.column_width_profiles === "object"
    ? Object.values(layout.column_width_profiles).filter((item) => item && typeof item === "object")
    : [];
  const profile = profiles.sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""))[0];
  const columns = profile?.columns && typeof profile.columns === "object" ? profile.columns : null;
  if (!columns) return;
  const order = Array.isArray(layout.order) && layout.order.length ? layout.order : loadColumnOrder();
  const currentFields = Object.fromEntries(loadFieldConfig().map((field) => [field.key, field]));
  const currentWidths = (() => {
    try {
      return JSON.parse(localStorage.getItem("spaila_col_widths") || "{}") || {};
    } catch (_) {
      return {};
    }
  })();
  const totalWidth = order.reduce((sum, key) => {
    if (key === "status") return sum + Number(currentWidths.status || 100);
    if (key === "order_info") return sum + Number(currentWidths.order_info || 160);
    return sum + Number(currentWidths[key] || currentFields[key]?.defaultWidth || 120);
  }, 0);
  if (!totalWidth) return;
  const nextWidths = { ...currentWidths };
  for (const key of order) {
    const percent = Number(columns[key]?.percent);
    if (!Number.isFinite(percent) || percent <= 0) continue;
    nextWidths[key] = Math.max(40, Math.round(totalWidth * percent));
  }
  localStorage.setItem("spaila_col_widths", JSON.stringify(nextWidths));
}

function applySharedOrderFieldLayout(layout) {
  if (!layout || typeof layout !== "object") return;
  if (Array.isArray(layout.fields) && layout.fields.length) {
    const byKey = new Map(layout.fields.map((field) => [field.key, field]));
    const mergedFields = loadFieldConfig().map((field) => {
      const incoming = byKey.get(field.key);
      if (!incoming) return field;
      return {
        ...field,
        label: incoming.label || field.label,
        visibleInOrders: incoming.visibleInOrders !== false,
        paletteEnabled: incoming.paletteEnabled !== false,
        highlight: {
          ...field.highlight,
          ...(incoming.highlight && typeof incoming.highlight === "object" ? incoming.highlight : {}),
        },
      };
    });
    saveFieldConfig(mergedFields);
  }
  if (Array.isArray(layout.order) && layout.order.length) {
    saveColumnOrder(layout.order);
    window.dispatchEvent(new CustomEvent("spaila:columnorder"));
  }
  if (layout.status && typeof layout.status === "object") {
    saveStatusConfig({
      ...loadStatusConfig(),
      enabled: layout.status.enabled !== false,
      columnLabel: layout.status.columnLabel || "Status",
    });
  }
  applySharedWidthProfile(layout);
}

function applySharedPricingRules(pricing) {
  if (Array.isArray(pricing?.rules) && (pricing.updated_at || pricing.rules.length > 0)) {
    savePriceList(pricing.rules);
  }
}

function getCurrentRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "/" || hash === "/parser" || hash === "/workspace") {
    return hash;
  }
  if (hash === "/settings" || hash.startsWith("/settings/")) {
    return hash === "/settings" ? "/settings/account" : hash;
  }
  return "/workspace";
}

function getSupportTypeLabel(type) {
  if (type === "feature") return "Feature request";
  if (type === "billing") return "Billing help";
  return "Bug report";
}

function getSupportRouteLabel(route) {
  if (route === "/") return "Orders";
  if (route === "/parser") return "Order Processing";
  if (route === "/settings" || route.startsWith("/settings/")) return "Settings";
  if (route === "/workspace") return "Workspace";
  return route || "Unknown";
}

function SupportReportModal({ route, initialType = "bug", onClose }) {
  const [type, setType] = React.useState(initialType || "bug");
  const [description, setDescription] = React.useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = React.useState(true);
  const [screenshotPath, setScreenshotPath] = React.useState("");
  const [screenshotName, setScreenshotName] = React.useState("");
  const [status, setStatus] = React.useState({ sending: false, message: "", error: "" });

  React.useEffect(() => {
    setType(initialType || "bug");
  }, [initialType]);

  async function pickScreenshot() {
    const result = await window.parserApp?.pickFile?.({
      title: "Select Screenshot",
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (!result || result.canceled) return;
    setScreenshotPath(result.path || "");
    setScreenshotName(result.name || result.path || "");
  }

  async function submitReport() {
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      setStatus({ sending: false, message: "", error: "Please describe what you need help with." });
      return;
    }

    setStatus({ sending: true, message: "", error: "" });
    const appInfoResult = await window.parserApp?.getSupportAppInfo?.();
    const appInfo = appInfoResult?.ok ? appInfoResult.appInfo : {};
    let diagnostics = null;
    if (includeDiagnostics) {
      const diagnosticsResult = await window.parserApp?.createSupportDiagnostics?.({
        type,
        description: trimmedDescription,
        route,
        screenshotPath,
      });
      if (diagnosticsResult?.ok) {
        diagnostics = diagnosticsResult;
      }
    }

    const version = appInfo.version || "unknown";
    const typeLabel = getSupportTypeLabel(type);
    const subject = `Spaila Support - ${typeLabel} - v${version}`;
    const bodyLines = [
      `Support type: ${typeLabel}`,
      `Spaila version: ${version}`,
      `Screen: ${getSupportRouteLabel(route)}`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
      "Description:",
      trimmedDescription,
      "",
      "System info:",
      `Platform: ${appInfo.platform || "unknown"} ${appInfo.release || ""}`,
      `Architecture: ${appInfo.arch || "unknown"}`,
      `Electron: ${appInfo.electron || "unknown"}`,
      `Chrome: ${appInfo.chrome || "unknown"}`,
      `Node: ${appInfo.node || "unknown"}`,
      "",
      "Attachments / diagnostics:",
      screenshotPath ? `Screenshot selected: ${screenshotPath}` : "Screenshot selected: No",
      diagnostics?.path ? `Diagnostic report: ${diagnostics.path}` : "Diagnostic report: Not generated",
      "",
      "Please attach the screenshot and diagnostic report paths listed above if your email app did not attach them automatically.",
    ];

    try {
      const composeResult = await window.parserApp?.composeEmail?.({
        to: SUPPORT_EMAIL,
        subject,
        body: bodyLines.join("\n"),
        attachmentFolderPath: diagnostics?.folderPath || screenshotPath || "",
      });
      if (!composeResult?.ok) {
        setStatus({ sending: false, message: "", error: composeResult?.error || "Could not open your email app." });
        return;
      }
      setStatus({ sending: false, message: "Your email app opened with a prepared support message.", error: "" });
    } catch (error) {
      setStatus({ sending: false, message: "", error: error?.message || "Could not open your email app." });
    }
  }

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      zIndex: 100000,
      background: "rgba(15, 23, 42, 0.38)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    }}>
      <div style={{ width: "min(620px, 100%)", background: "#fff", borderRadius: 16, boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)", overflow: "hidden" }}>
        <div style={{ padding: "18px 22px", borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#111827" }}>Contact Spaila Support</div>
            <div style={{ marginTop: 3, fontSize: 12, color: "#64748b" }}>Opens your default email app so you can review before sending.</div>
          </div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: "#64748b", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "18px 22px 22px" }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>Support type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            style={{ width: "100%", padding: "9px 11px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13, marginBottom: 14 }}
          >
            <option value="bug">Report a bug</option>
            <option value="feature">Feature request</option>
            <option value="billing">Billing help</option>
          </select>

          <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#475569", marginBottom: 6 }}>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe what happened, what you expected, and any steps support should try."
            rows={7}
            style={{ width: "100%", boxSizing: "border-box", padding: "10px 11px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13, resize: "vertical", marginBottom: 12 }}
          />

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <button type="button" onClick={pickScreenshot} style={{ padding: "8px 12px", border: "1px solid #cbd5e1", borderRadius: 999, background: "#fff", color: "#334155", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
              Choose Screenshot
            </button>
            <span style={{ fontSize: 12, color: screenshotName ? "#475569" : "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 }}>
              {screenshotName || "No screenshot selected"}
            </span>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#475569", cursor: "pointer", marginBottom: 14 }}>
            <input
              type="checkbox"
              checked={includeDiagnostics}
              onChange={(e) => setIncludeDiagnostics(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: "#2563eb" }}
            />
            Include system info and a lightweight diagnostic report
          </label>

          {status.error ? <div style={{ color: "#b91c1c", fontSize: 12, marginBottom: 10 }}>{status.error}</div> : null}
          {status.message ? <div style={{ color: "#166534", fontSize: 12, marginBottom: 10 }}>{status.message}</div> : null}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" onClick={onClose} style={{ padding: "9px 13px", border: "1px solid #cbd5e1", borderRadius: 8, background: "#fff", color: "#334155", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
              Close
            </button>
            <button type="button" onClick={submitReport} disabled={status.sending} style={{ padding: "9px 14px", border: "none", borderRadius: 8, background: status.sending ? "#93c5fd" : "#2563eb", color: "#fff", cursor: status.sending ? "default" : "pointer", fontSize: 13, fontWeight: 800 }}>
              {status.sending ? "Preparing..." : "Open Email"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const [route, setRoute] = React.useState(() => getCurrentRoute());
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [columnOrder, setColumnOrder] = React.useState(() => loadColumnOrder());
  const [parserFileRequest, setParserFileRequest] = React.useState({ key: 0, filePath: "" });
  const [ordersTab, setOrdersTab] = React.useState("active");
  const [returnRoute, setReturnRoute] = React.useState("/");
  const [orderFocusRequest, setOrderFocusRequest] = React.useState({ key: 0, orderNumber: "" });
  const [orderCounts, setOrderCounts] = React.useState({ active: 0, completed: 0 });
  const [settingsTab, setSettingsTab] = React.useState("account");
  const [supportReportRequest, setSupportReportRequest] = React.useState(null);

  React.useEffect(() => {
    function handleHashChange() {
      setRoute(getCurrentRoute());
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  React.useEffect(() => {
    function syncBranding() {
      const name = loadShopConfig().shopName?.trim() || "Parser Viewer";
      document.title = name;
      window.parserApp?.setTitle?.(name);
    }

    syncBranding();
    window.addEventListener("spaila:shopconfig", syncBranding);

    // Pull the latest shop_name from the shared account profile (may have been
    // updated by the webapp). If it differs from localStorage, persist and
    // fire spaila:shopconfig so the titlebar and workspace panel update immediately.
    window.parserApp?.getAccountProfile?.().then((result) => {
      if (!result?.ok || !result.profile?.shop_name) return;
      const incoming = result.profile.shop_name;
      const stored = loadShopConfig();
      if ((stored.shopName || "") === incoming) return;
      saveShopConfig({ ...stored, shopName: incoming });
    }).catch(() => {});

    window.parserApp?.getOrderFieldLayout?.().then((result) => {
      if (result?.ok && result.layout) {
        applySharedOrderFieldLayout(result.layout);
        setColumnOrder(loadColumnOrder());
      }
    }).catch(() => {});

    window.parserApp?.getPricingRules?.().then((result) => {
      if (result?.ok && result.pricing) {
        applySharedPricingRules(result.pricing);
      }
    }).catch(() => {});

    return () => window.removeEventListener("spaila:shopconfig", syncBranding);
  }, []);

  React.useEffect(() => {
    function handleSupportReport(event) {
      setSupportReportRequest({
        key: Date.now(),
        type: event?.detail?.type || "bug",
      });
    }

    window.addEventListener("spaila:open-support-report", handleSupportReport);
    return () => window.removeEventListener("spaila:open-support-report", handleSupportReport);
  }, []);

  function navigate(nextRoute) {
    const nextHash = nextRoute === "/" ? "#/" : `#${nextRoute}`;
    if (nextRoute !== "/parser") {
      setParserFileRequest((current) => (
        current.filePath ? { ...current, filePath: "" } : current
      ));
    }
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
      return;
    }
    setRoute(nextRoute);
  }

  // Capture the current page so closing parser/settings returns here.
  function captureReturn() {
    if (route !== "/parser" && route !== "/settings" && !route.startsWith("/settings/")) {
      setReturnRoute(route);
    }
  }

  function openParserFile(filePath) {
    captureReturn();
    setParserFileRequest((current) => ({ key: current.key + 1, filePath: filePath || "" }));
    navigate("/parser");
  }

  function goToOrders(nextTab) {
    if (nextTab) {
      setOrdersTab(nextTab);
    }
    navigate("/");
  }

  function openOrder(order) {
    captureReturn();
    const orderNumber = String(order?.order_number || "").trim();
    const orderId = String(order?.order_id || order?.id || "").trim();
    if (!orderNumber && !orderId) return;
    const orderStatus = String(order?.status || "").toLowerCase();
    const lineStatus = String(order?.item_status || order?.status || "").toLowerCase();
    if (orderStatus === "archived") {
      setOrdersTab("active");
    } else {
      setOrdersTab(lineStatus === "completed" || lineStatus === "done" ? "completed" : "active");
    }
    setOrderFocusRequest((current) => ({
      key: current.key + 1,
      orderNumber,
      orderId,
      directOpen: true,
      orderData: order,
    }));
    navigate("/");
  }

  function goToSettings(nextTab = "account") {
    captureReturn();
    const tab = typeof nextTab === "string" && nextTab.trim() ? nextTab.trim() : "account";
    setSettingsTab(tab);
    navigate(`/settings/${tab}`);
  }

  function goToWorkspace() {
    navigate("/workspace");
  }

  function handleCreated() {
    setRefreshKey((k) => k + 1);
    navigate("/");
  }

  function handleOrderCreated() {
    setRefreshKey((k) => k + 1);
  }

  function handleColumnOrderChange(next) {
    setColumnOrder(next);
    saveColumnOrder(next);
  }

  return (
    <>
      {/* Orders page is always mounted so its state is preserved */}
      <div style={{ display: route === "/" ? "flex" : "none", flexDirection: "column", height: "100vh" }}>
        <OrdersPage
          onWorkspace={goToWorkspace}
          onSettings={goToSettings}
          refreshKey={refreshKey}
          onCountsChange={setOrderCounts}
          activeTab={ordersTab}
          onActiveTabChange={setOrdersTab}
          focusOrderRequest={orderFocusRequest}
          isActive={route === "/"}
          columnOrder={columnOrder}
          onColumnOrderChange={handleColumnOrderChange}
          onDirectOrderModalClose={() => navigate(returnRoute)}
        />
      </div>

      {/* Parser page — full screen, rendered only when navigated to */}
      {route === "/parser" && (
        <div className="parser-page">
          <ParserApp
            onCreated={handleCreated}
            onOrderCreated={handleOrderCreated}
            onBack={() => navigate(returnRoute)}
            onWorkspace={goToWorkspace}
            onSettings={goToSettings}
            ordersTab={ordersTab}
            onOrdersTabChange={setOrdersTab}
            selectedFilePath={parserFileRequest.filePath}
            selectedFileRequestKey={parserFileRequest.key}
          />
        </div>
      )}

      {route === "/workspace" && (
        <WorkspacePage
          onOpenFile={openParserFile}
          onOpenOrder={openOrder}
          onWorkspace={goToWorkspace}
          onSettings={goToSettings}
          onOrders={goToOrders}
          activeCount={orderCounts.active}
          completedCount={orderCounts.completed}
        />
      )}

      {(route === "/settings" || route.startsWith("/settings/")) && (
        <SettingsPage
          onOrders={(nextTab) => nextTab ? goToOrders(nextTab) : navigate(returnRoute)}
          onWorkspace={goToWorkspace}
          onSettings={goToSettings}
          initialTab={route.startsWith("/settings/") ? route.split("/")[2] || "account" : settingsTab}
          ordersTab={ordersTab}
          onOrdersTabChange={setOrdersTab}
          columnOrder={columnOrder}
          onColumnOrderChange={handleColumnOrderChange}
        />
      )}

      <button
        type="button"
        onClick={() => setSupportReportRequest({ key: Date.now(), type: "bug" })}
        style={{
          position: "fixed",
          left: 18,
          bottom: 18,
          zIndex: 800,
          border: "1px solid #bfdbfe",
          borderRadius: 999,
          background: "#eff6ff",
          color: "#1d4ed8",
          padding: "7px 12px",
          boxShadow: "0 8px 18px rgba(15, 23, 42, 0.12)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 800,
        }}
      >
        Report a bug
      </button>

      {supportReportRequest ? (
        <SupportReportModal
          key={supportReportRequest.key}
          route={route}
          initialType={supportReportRequest.type}
          onClose={() => setSupportReportRequest(null)}
        />
      ) : null}
    </>
  );
}

createRoot(document.getElementById("root")).render(<Shell />);
