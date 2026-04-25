import React from "react";
import { createRoot } from "react-dom/client";
import ParserApp from "./features/parser/ParserApp.jsx";
import OrdersPage from "./features/orders/OrdersPage.jsx";
import WorkspacePage from "./features/workspace/WorkspacePage.jsx";
import SettingsPage from "./settings/SettingsModal.jsx";
import { loadColumnOrder, loadShopConfig, saveColumnOrder } from "./shared/utils/fieldConfig.js";
import "./features/parser/styles.css";

function getCurrentRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash === "/" || hash === "/parser" || hash === "/settings" || hash === "/workspace") {
    return hash;
  }
  return "/workspace";
}

function Shell() {
  const [route, setRoute] = React.useState(() => getCurrentRoute());
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [columnOrder, setColumnOrder] = React.useState(() => loadColumnOrder());
  const [parserFileRequest, setParserFileRequest] = React.useState({ key: 0, filePath: "" });
  const [ordersTab, setOrdersTab] = React.useState("active");
  const [orderCounts, setOrderCounts] = React.useState({ active: 0, completed: 0 });

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
    return () => window.removeEventListener("spaila:shopconfig", syncBranding);
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

  function openParserFile(filePath) {
    setParserFileRequest((current) => ({ key: current.key + 1, filePath: filePath || "" }));
    navigate("/parser");
  }

  function goToOrders(nextTab) {
    if (nextTab) {
      setOrdersTab(nextTab);
    }
    navigate("/");
  }

  function goToSettings() {
    navigate("/settings");
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
          isActive={route === "/"}
          columnOrder={columnOrder}
          onColumnOrderChange={handleColumnOrderChange}
        />
      </div>

      {/* Parser page — full screen, rendered only when navigated to */}
      {route === "/parser" && (
        <div className="parser-page">
          <ParserApp
            onCreated={handleCreated}
            onOrderCreated={handleOrderCreated}
            onBack={goToOrders}
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
          onWorkspace={goToWorkspace}
          onSettings={goToSettings}
          onOrders={goToOrders}
          activeCount={orderCounts.active}
          completedCount={orderCounts.completed}
          ordersTab={ordersTab}
          onOrdersTabChange={setOrdersTab}
        />
      )}

      {route === "/settings" && (
        <SettingsPage
          onOrders={goToOrders}
          onWorkspace={goToWorkspace}
          onSettings={goToSettings}
          ordersTab={ordersTab}
          onOrdersTabChange={setOrdersTab}
          columnOrder={columnOrder}
          onColumnOrderChange={handleColumnOrderChange}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")).render(<Shell />);
