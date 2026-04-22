import React from "react";
import { createRoot } from "react-dom/client";
import ParserApp from "./features/parser/ParserApp.jsx";
import OrdersPage from "./features/orders/OrdersPage.jsx";
import "./features/parser/styles.css";

function Shell() {
  // "orders" | "parser"
  const [page, setPage] = React.useState("orders");
  const [refreshKey, setRefreshKey] = React.useState(0);

  function goToParser() {
    setPage("parser");
  }

  function goToOrders() {
    setPage("orders");
  }

  function handleCreated() {
    setRefreshKey((k) => k + 1);
    setPage("orders");
  }

  return (
    <>
      {/* Orders page is always mounted so its state is preserved */}
      <div style={{ display: page === "orders" ? "flex" : "none", flexDirection: "column", height: "100vh" }}>
        <OrdersPage
          onImport={goToParser}
          refreshKey={refreshKey}
        />
      </div>

      {/* Parser page — full screen, rendered only when navigated to */}
      {page === "parser" && (
        <div className="parser-page">
          <ParserApp
            onCreated={handleCreated}
            onBack={goToOrders}
          />
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")).render(<Shell />);
