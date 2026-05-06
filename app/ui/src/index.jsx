import React from "react";
import { createRoot } from "react-dom/client";
import ParserApp from "./features/parser/ParserApp.jsx";
import OrdersPage from "./features/orders/OrdersPage.jsx";
import WorkspacePage from "./features/workspace/WorkspacePage.jsx";
import SettingsPage from "./settings/SettingsModal.jsx";
import SupportModal from "./features/support/SupportModal.jsx";
import {
  loadColumnOrder,
  loadFieldConfig,
  loadShopConfig,
  loadStatusConfig,
  saveColumnOrder,
  saveFieldConfig,
  saveShopConfig,
  savePriceList,
  savePrintConfig,
  saveStatusConfig,
} from "./shared/utils/fieldConfig.js";
import "./features/parser/styles.css";


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

function applySharedPrintConfig(config) {
  if (config?.updated_at) {
    savePrintConfig(config);
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
  const [workspaceOpenKey, setWorkspaceOpenKey] = React.useState(0);

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

    window.parserApp?.getPrintConfig?.().then((result) => {
      if (result?.ok && result.config) {
        applySharedPrintConfig(result.config);
      }
    }).catch(() => {});

    return () => window.removeEventListener("spaila:shopconfig", syncBranding);
  }, []);

  React.useEffect(() => {
    function handleSupportReport(event) {
      const raw = event?.detail?.type || "bug_report";
      // Map legacy type names to new format
      const typeMap = { bug: "bug_report", feature: "feature_request", billing: "billing_help" };
      const type = typeMap[raw] || raw;
      setSupportReportRequest({ key: Date.now(), type });
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
    setWorkspaceOpenKey((key) => key + 1);
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
          openKey={workspaceOpenKey}
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
        onClick={() => setSupportReportRequest({ key: Date.now(), type: "bug_report" })}
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
        <SupportModal
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
