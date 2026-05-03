import React from "react";
import { API_ENDPOINTS } from "../../../shared/api/endpoints.mjs";
import { api, settingsApi } from "./api.js";
import OrdersPage from "./features/orders/OrdersPage.jsx";
import OrderDetail from "./features/order-detail/OrderDetail.jsx";
import ArchivePage from "./features/archive/ArchivePage.jsx";
import AccountPage from "./features/account/AccountPage.jsx";
import SettingsPage from "./features/settings/SettingsPage.jsx";
import OrdersSettingsPage from "./features/settings/OrdersSettingsPage.jsx";
import SearchSortSettingsPage from "./features/settings/SearchSortSettingsPage.jsx";
import StatusSettingsPage from "./features/settings/StatusSettingsPage.jsx";
import DatesSettingsPage from "./features/settings/DatesSettingsPage.jsx";
import PricingSettingsPage from "./features/settings/PricingSettingsPage.jsx";
import PrintingSettingsPage from "./features/settings/PrintingSettingsPage.jsx";
import EmailsPage from "./features/settings/EmailsPage.jsx";
import SupportPage from "./features/support/SupportPage.jsx";

const WEB_ORDER_SHEET_SIZE_KEY = "spaila_web_order_sheet_size";
const DEFAULT_ORDER_SHEET_SIZE = 12;

// Settings sidebar tabs — mirrors desktop settings sidebar exactly.
// desktopOnly: true grays out the row (managed in the desktop app only).
const SETTINGS_TABS = [
  { id: "account",    label: "Account" },
  { id: "general",   label: "General" },
  { kind: "divider" },
  { id: "orders_cfg", label: "Orders" },
  { kind: "divider" },
  { id: "view",      label: "Search / Sort" },
  { id: "dates",     label: "Dates" },
  { id: "status",    label: "Status" },
  { id: "pricing",   label: "Pricing" },
  { kind: "divider" },
  { id: "printing",  label: "Printing" },
  { id: "documents", label: "Docs",              desktopOnly: true },
  { kind: "divider" },
  { id: "support",   label: "Support" },
];

function ThankYouPage() {
  const [state, setState] = React.useState({
    loading: true,
    error: "",
    metadata: null,
    objectUrl: "",
    text: "",
  });

  React.useEffect(() => {
    let cancelled = false;
    let objectUrl = "";

    async function loadTemplate() {
      setState({ loading: true, error: "", metadata: null, objectUrl: "", text: "" });
      try {
        const metadata = await api.get(API_ENDPOINTS.thankYouTemplate);
        const fileResponse = await fetch(`${api.baseUrl}${API_ENDPOINTS.thankYouTemplateFile}`);
        if (!fileResponse.ok) throw new Error("Could not load the thank-you template file.");
        const blob = await fileResponse.blob();
        objectUrl = URL.createObjectURL(blob);
        const text = metadata.mime_type?.startsWith("text/")
          ? await blob.text()
          : "";
        if (!cancelled) {
          setState({ loading: false, error: "", metadata, objectUrl, text });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            loading: false,
            error: error?.message || "No thank-you template is configured yet.",
            metadata: null,
            objectUrl: "",
            text: "",
          });
        }
      }
    }

    loadTemplate();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  function printTemplate() {
    if (!state.objectUrl) return;
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    iframe.src = state.objectUrl;
    document.body.appendChild(iframe);
    iframe.onload = () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } finally {
        window.setTimeout(() => iframe.remove(), 2000);
      }
    };
  }

  const metadata = state.metadata || {};
  const mimeType = metadata.mime_type || "";
  const isPdf = mimeType === "application/pdf";
  const isImage = mimeType.startsWith("image/");
  const isText = mimeType.startsWith("text/");

  return (
    <section className="orders-page">
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">Thank-You Letter</span>
          <h2>Print Thank-You Letter</h2>
          <p>Preview and print the shared shop thank-you letter imported from the desktop app.</p>
        </div>
        {state.objectUrl ? (
          <div className="thankyou-actions">
            <a className="ghost-button" href={state.objectUrl} target="_blank" rel="noreferrer">Open</a>
            <button className="ghost-button" type="button" onClick={printTemplate}>Print</button>
          </div>
        ) : null}
      </div>

      {state.loading ? (
        <div className="section-card">
          <div className="table-state"><div className="spinner" /><span>Loading shared thank-you letter...</span></div>
        </div>
      ) : state.error ? (
        <div className="section-card thankyou-missing">
          <div className="section-eyebrow">Missing Template</div>
          <h3>No shared thank-you letter yet</h3>
          <p>
            Open the desktop app, go to <strong>Settings → Docs</strong>, select your thank-you PDF,
            and click <strong>Save</strong>. Spaila will import it into the shared business profile so
            desktop and web use the same branded letter.
          </p>
        </div>
      ) : (
        <div className="thankyou-layout">
          <aside className="section-card thankyou-meta">
            <div className="section-eyebrow">Shared Template</div>
            <dl className="detail-list">
              <div className="detail-field"><dt>Name</dt><dd>{metadata.name || "Thank-you letter"}</dd></div>
              <div className="detail-field"><dt>Type</dt><dd>{metadata.mime_type || "Unknown"}</dd></div>
              <div className="detail-field"><dt>Updated</dt><dd>{metadata.updated_at ? new Date(metadata.updated_at).toLocaleString() : "Unknown"}</dd></div>
            </dl>
            <p>Stored as a shared Spaila business asset. The web app does not need the local desktop file path.</p>
          </aside>
          <div className="section-card thankyou-preview-card">
            {isPdf ? (
              <iframe className="thankyou-preview-frame" src={state.objectUrl} title="Thank-you letter preview" />
            ) : isImage ? (
              <img className="thankyou-preview-image" src={state.objectUrl} alt={metadata.name || "Thank-you letter"} />
            ) : isText ? (
              <pre className="thankyou-preview-text">{state.text}</pre>
            ) : (
              <div className="table-state">Preview is not available for this template type. Use Open or Print.</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// Unified avatar: shows logo image, falls back to initial letter circle.
// size="nav" → 26px top-nav style | size="sidebar" → 24px sidebar style | size="hero" → fills container
function ShopAvatar({ logoUrl, initial, size, name }) {
  const [imgFailed, setImgFailed] = React.useState(false);

  // Reset error state when logoUrl changes
  React.useEffect(() => { setImgFailed(false); }, [logoUrl]);

  if (!imgFailed) {
    if (size === "nav") {
      return (
        <img
          className="web-topnav-logo"
          src={logoUrl}
          alt={name}
          onError={() => setImgFailed(true)}
        />
      );
    }
    if (size === "sidebar") {
      return (
        <img
          className="web-sidebar-item-logo"
          src={logoUrl}
          alt=""
          onError={() => setImgFailed(true)}
        />
      );
    }
    if (size === "hero") {
      return (
        <img
          className="account-hero-logo"
          src={logoUrl}
          alt={name}
          onError={() => setImgFailed(true)}
        />
      );
    }
  }

  // Fallback: initial letter
  if (size === "nav") return <span className="web-topnav-avatar">{initial}</span>;
  if (size === "sidebar") return <span className="web-sidebar-item-avatar">{initial}</span>;
  if (size === "hero") return <span className="account-hero-initial">{initial}</span>;
  return <span>{initial}</span>;
}

function DesktopOnlyPanel({ label }) {
  return (
    <div className="section-card" style={{ display: "grid", gap: 10 }}>
      <div className="section-eyebrow">Desktop Only</div>
      <p style={{ margin: 0, color: "#64748b", fontSize: 14, lineHeight: 1.6 }}>
        <strong>{label}</strong> is managed in the Spaila desktop app. Open the desktop app and go to Settings → {label} to configure these options.
      </p>
    </div>
  );
}

function SettingsShell({ account, capabilities, onAccountUpdated, shopInitial, logoUrl, onSettingsSaved }) {
  const [settingsTab, setSettingsTab] = React.useState("account");

  const activeTab = SETTINGS_TABS.find((t) => t.id === settingsTab && !t.kind);

  return (
    <div className="web-settings-shell">
      {/* Settings sidebar */}
      <aside className="web-settings-sidebar">
        <div className="web-settings-sidebar-label">Settings</div>
        <nav className="web-settings-sidebar-nav">
          {SETTINGS_TABS.map((tab, index) => {
            if (tab.kind === "divider") {
              return <hr key={`sdiv-${index}`} className="web-sidebar-divider" />;
            }
            const isActive = settingsTab === tab.id;
            const isDesktopOnly = tab.desktopOnly === true;
            return (
              <button
                key={tab.id}
                type="button"
                className={isActive ? "active" : isDesktopOnly ? "desktop-only" : ""}
                disabled={isDesktopOnly}
                onClick={() => !isDesktopOnly && setSettingsTab(tab.id)}
              >
                {tab.id === "account" ? (
                  <ShopAvatar logoUrl={logoUrl} initial={shopInitial} size="sidebar" name="" />
                ) : null}
                {tab.label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Settings content panel */}
      <div className="web-settings-panel">
        {settingsTab === "account" ? (
          <AccountPage account={account} capabilities={capabilities} onAccountUpdated={onAccountUpdated} />
        ) : settingsTab === "general" ? (
          <SettingsPage onSettingsSaved={onSettingsSaved} />
        ) : settingsTab === "orders_cfg" ? (
          <OrdersSettingsPage onSettingsSaved={onSettingsSaved} />
        ) : settingsTab === "view" ? (
          <SearchSortSettingsPage onSettingsSaved={onSettingsSaved} />
        ) : settingsTab === "dates" ? (
          <DatesSettingsPage onSettingsSaved={onSettingsSaved} />
        ) : settingsTab === "status" ? (
          <StatusSettingsPage onSettingsSaved={onSettingsSaved} />
        ) : settingsTab === "pricing" ? (
          <PricingSettingsPage onSettingsSaved={onSettingsSaved} />
        ) : settingsTab === "printing" ? (
          <PrintingSettingsPage onSettingsSaved={onSettingsSaved} />
        ) : settingsTab === "emails" ? (
          <EmailsPage onSettingsSaved={onSettingsSaved} />
        ) : settingsTab === "support" ? (
          <SupportPage />
        ) : activeTab ? (
          <DesktopOnlyPanel label={activeTab.label} />
        ) : null}
      </div>
    </div>
  );
}

// Thank-you letter icon SVG
function IconThankYou() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 10h8M8 14h5" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H1.8a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 3.6 8a1.7 1.7 0 0 0-.34-1.88l-.06-.06A2 2 0 1 1 6.03 3.2l.06.06A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-.6A1.7 1.7 0 0 0 9.4 1.9V1.8a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 3.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 8c.2.38.52.7.9.9.31.16.66.24 1.01.24h.09a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
    </svg>
  );
}

export default function App() {
  const [account, setAccount] = React.useState(null);
  const [capabilities, setCapabilities] = React.useState(null);
  const [status, setStatus] = React.useState({ loading: true, error: "" });
  const [webSettings, setWebSettings] = React.useState(null);
  const [layoutRefreshKey, setLayoutRefreshKey] = React.useState(0);
  const [ordersRefreshKey, setOrdersRefreshKey] = React.useState(0);
  const [route, setRoute] = React.useState("orders");
  const [ordersTab, setOrdersTab] = React.useState("active");
  const [selectedOrderId, setSelectedOrderId] = React.useState("");
  const [orderSearch, setOrderSearch] = React.useState("");
  const [orderFilter, setOrderFilter] = React.useState("all");
  const [orderSortField, setOrderSortField] = React.useState("order_date");
  const [orderSortDirection, setOrderSortDirection] = React.useState("asc");
  const [orderSearchCounts, setOrderSearchCounts] = React.useState({});
  const [orderSheetSize, setOrderSheetSize] = React.useState(() => {
    try {
      return parseInt(localStorage.getItem(WEB_ORDER_SHEET_SIZE_KEY), 10) || DEFAULT_ORDER_SHEET_SIZE;
    } catch {
      return DEFAULT_ORDER_SHEET_SIZE;
    }
  });
  const [orderPrintHandler, setOrderPrintHandler] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    async function loadFoundations() {
      try {
        const [profile, capabilityMap, ws] = await Promise.all([
          api.get(API_ENDPOINTS.account),
          api.get(API_ENDPOINTS.accountCapabilities),
          settingsApi.getWebSettings().catch(() => null),
        ]);
        if (!cancelled) {
          setAccount(profile);
          setCapabilities(capabilityMap);
          if (ws) setWebSettings(ws);
          setStatus({ loading: false, error: "" });
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({ loading: false, error: error?.message || "Could not connect to the Spaila backend." });
        }
      }
    }
    loadFoundations();
    return () => { cancelled = true; };
  }, []);

  // Listen for settings changes made in the Settings panel so the header updates live
  const refreshWebSettings = React.useCallback(async () => {
    try {
      const ws = await settingsApi.getWebSettings();
      setWebSettings(ws);
      setLayoutRefreshKey((key) => key + 1);
    } catch { /* ignore */ }
  }, []);

  const shopName = account?.shop_name || "Spaila";
  const shopInitial = String(shopName).trim().slice(0, 1).toUpperCase() || "S";
  const logoUrl = "http://127.0.0.1:8055/account/logo";

  React.useEffect(() => {
    const titleName = String(shopName || "").trim() || "Spaila";
    document.title = titleName;
  }, [shopName]);

  // normalizeWebSettings guarantees these are always proper booleans; fall back to true if settings haven't loaded yet.
  const showCompletedTab = webSettings != null ? webSettings.show_completed_tab : true;
  const showInventoryTab = webSettings != null ? webSettings.show_inventory_tab : false;
  const showThankYouShortcut = webSettings != null ? webSettings.show_thank_you_shortcut : true;

  const showDetail = Boolean(selectedOrderId);
  const hasActiveOrderSearch = orderSearch.trim().length > 0;
  const topNavItems = [
    { id: "orders", label: "Active", route: "orders", ordersTab: "active", searchCount: orderSearchCounts.active },
    ...(showCompletedTab ? [{ id: "completed", label: "Completed", route: "orders", ordersTab: "completed", searchCount: orderSearchCounts.completed }] : []),
    ...(showInventoryTab ? [{ id: "inventory", label: "Inventory Needed", route: "orders", ordersTab: "inventory", searchCount: 0 }] : []),
  ];

  function changeOrderSheetSize(delta) {
    setOrderSheetSize((current) => {
      const next = Math.min(20, Math.max(9, current + delta));
      try {
        localStorage.setItem(WEB_ORDER_SHEET_SIZE_KEY, String(next));
      } catch (_) {}
      return next;
    });
  }

  React.useEffect(() => {
    if (!showCompletedTab && route === "orders" && ordersTab === "completed") {
      setOrdersTab("active");
    }
    if (!showInventoryTab && route === "orders" && ordersTab === "inventory") {
      setOrdersTab("active");
    }
  }, [showCompletedTab, showInventoryTab, route, ordersTab]);

  function navigate(nextRoute) {
    setSelectedOrderId("");
    setRoute(nextRoute);
  }

  async function navigateOrderScope(nextScope) {
    const leavingSettings = route === "settings";
    setSelectedOrderId("");
    setOrdersTab(nextScope);
    if (leavingSettings) {
      await refreshWebSettings();
    }
    setRoute("orders");
  }

  // When navigating to settings, refresh web settings when leaving (covers saves made there)
  function navigateFromSettings(nextRoute) {
    if (route === "settings") refreshWebSettings();
    navigate(nextRoute);
  }

  return (
    <div className="web-app-v2">
      {/* ── Top navigation bar ─────────────────────────────────────────── */}
      <header className="web-topnav">
        <div className="web-topnav-identity-row">
          <div className="web-topnav-brand">
            <ShopAvatar logoUrl={logoUrl} initial={shopInitial} size="nav" name={shopName} />
            <div className="web-topnav-shop">
              <span className="web-topnav-name">{shopName}</span>
              <span className="web-topnav-app-label">Spaila workspace</span>
            </div>
          </div>

          <div className="web-topnav-account-actions" aria-label="Account actions">
            {showThankYouShortcut ? (
              <button
                type="button"
                className={`web-header-icon-btn${route === "thankyou" ? " active" : ""}`}
                title="Thank-you letter"
                aria-label="Thank-you letter"
                onClick={() => navigate("thankyou")}
              >
                <IconThankYou />
              </button>
            ) : null}
            <button
              type="button"
              className={`web-header-icon-btn${route === "settings" ? " active" : ""}`}
              title="Settings"
              aria-label="Settings"
              onClick={() => navigateFromSettings("settings")}
            >
              <IconSettings />
            </button>
          </div>
        </div>

        <div className="web-topnav-ops-row">
          <nav className="web-topnav-tabs" aria-label="Main navigation">
            {topNavItems.map((item) => {
              const isOrdersTab = item.route === "orders";
              const isActive = !showDetail && (
                isOrdersTab
                  ? route === "orders" && ordersTab === item.ordersTab
                  : route === item.route
              );
              return (
                <button
                  key={item.id}
                  type="button"
                  className={isActive ? "active" : ""}
                  onClick={() => {
                    if (isOrdersTab) {
                      navigateOrderScope(item.ordersTab);
                    } else {
                      navigateFromSettings(item.route);
                    }
                  }}
                >
                  <span>{item.label}</span>
                  {hasActiveOrderSearch && Number(item.searchCount || 0) > 0 ? (
                    <span className="web-tab-search-badge" title={`${item.searchCount} search matches`}>
                      {item.searchCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          {!showDetail && route === "orders" ? (
            <div className="web-header-order-controls">
              <div className="web-header-size-controls" role="group" aria-label="Order sheet text size">
                <button type="button" onClick={() => changeOrderSheetSize(-1)} title="Decrease sheet text size">A-</button>
                <button type="button" onClick={() => changeOrderSheetSize(1)} title="Increase sheet text size">A+</button>
              </div>
              <div className={`web-header-search-wrap${hasActiveOrderSearch ? " active" : ""}`}>
                <input
                  className="web-header-search"
                  value={orderSearch}
                  onChange={(event) => setOrderSearch(event.target.value)}
                  placeholder="Search orders..."
                  aria-label="Search orders"
                />
                {hasActiveOrderSearch ? (
                  <button
                    type="button"
                    className="web-header-search-clear"
                    onClick={() => setOrderSearch("")}
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    ×
                  </button>
                ) : null}
              </div>
              {hasActiveOrderSearch ? (
                <span className="web-header-search-flag" title={`Filtering by "${orderSearch.trim()}"`}>
                  Search active
                </span>
              ) : null}
              <select
                className="web-header-select"
                value={orderSortField}
                onChange={(event) => setOrderSortField(event.target.value)}
                aria-label="Sort field"
              >
                <option value="order_date">Order Date</option>
                <option value="ship_by">Ship By</option>
                <option value="buyer_name">Buyer</option>
                <option value="order_number">Order #</option>
                <option value="price">Price</option>
                <option value="status">Status</option>
              </select>
              <select
                className="web-header-select direction"
                value={orderSortDirection}
                onChange={(event) => setOrderSortDirection(event.target.value)}
                aria-label="Sort direction"
              >
                <option value="asc">Ascending ↑</option>
                <option value="desc">Descending ↓</option>
              </select>
              <select
                className="web-header-select filter"
                value={orderFilter}
                onChange={(event) => setOrderFilter(event.target.value)}
                aria-label="Filter orders"
              >
                <option value="all">All</option>
                <option value="gift">Gift orders</option>
                <option value="has_notes">Has notes</option>
                <option value="needs_status">Needs status</option>
              </select>
              <button
                type="button"
                className="web-header-print"
                onClick={() => orderPrintHandler?.()}
                title="Print current sheet"
              >
                Print
              </button>
            </div>
          ) : null}
        </div>

      </header>

      {/* ── Page content ───────────────────────────────────────────────── */}
      <div className="web-page">
        {!showDetail ? (
          <div className="web-page-inner wide" style={{ display: route === "orders" ? undefined : "none" }}>
            <OrdersPage
              scope={ordersTab}
              activeTab={ordersTab}
              onTabChange={setOrdersTab}
              onSelectOrder={setSelectedOrderId}
              showCompletedTab={showCompletedTab}
              layoutRefreshKey={layoutRefreshKey}
              ordersRefreshKey={ordersRefreshKey}
              search={orderSearch}
              filter={orderFilter}
              sortField={orderSortField}
              sortDirection={orderSortDirection}
              sheetSize={orderSheetSize}
              onRegisterPrint={setOrderPrintHandler}
              onSearchCountsChange={setOrderSearchCounts}
              onClearSearch={() => setOrderSearch("")}
            />
          </div>
        ) : null}

        {showDetail ? (
          <div className="web-page-inner">
            <OrderDetail orderId={selectedOrderId} onBack={() => setSelectedOrderId("")} />
          </div>
        ) : route === "archive" ? (
          <div className="web-page-inner">
            <ArchivePage />
          </div>
        ) : route === "thankyou" ? (
          <div className="web-page-inner">
            <ThankYouPage />
          </div>
        ) : route === "settings" ? (
          <SettingsShell
            account={account}
            capabilities={capabilities}
            onAccountUpdated={setAccount}
            shopInitial={shopInitial}
            logoUrl={logoUrl}
            onSettingsSaved={refreshWebSettings}
          />
        ) : null}
      </div>
    </div>
  );
}
