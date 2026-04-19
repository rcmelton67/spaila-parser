import React from "react";
import EditOrderModal from "./EditOrderModal.jsx";
import SettingsModal from "./SettingsModal.jsx";

const API = "http://127.0.0.1:8055";

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

const primaryButton = {
  padding: "6px 14px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
};

const COLUMNS = [
  { key: "order_number", label: "Order #",  defaultWidth: 140 },
  { key: "buyer_name",   label: "Buyer",    defaultWidth: 220 },
  { key: "price",        label: "Price",    defaultWidth: 100 },
  { key: "quantity",     label: "Qty",      defaultWidth: 80  },
  { key: "custom_1",     label: "Custom 1", defaultWidth: 180 },
  { key: "custom_2",     label: "Custom 2", defaultWidth: 180 },
  { key: "custom_3",     label: "Custom 3", defaultWidth: 180 },
];

export default function OrdersPage({ onImport, refreshKey }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [tab, setTab] = React.useState("active");
  const [search, setSearch] = React.useState("");
  const [editingOrder, setEditingOrder] = React.useState(null);
  const [showSettings, setShowSettings] = React.useState(false);
  const [contextMenu, setContextMenu] = React.useState({ visible: false, x: 0, y: 0, row: null });
  const [confirmDelete, setConfirmDelete] = React.useState({ open: false, rows: [] });
  const [selectedIds, setSelectedIds] = React.useState(new Set());

  function toggleRow(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((r) => r.id)));
    }
  }

  function closeContextMenu() {
    setContextMenu((m) => ({ ...m, visible: false, row: null }));
  }

  function handleContextMenu(e, row) {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, row });
  }

  // Returns all selected rows if the right-clicked row is part of the selection,
  // otherwise falls back to just the right-clicked row.
  function getTargetRows() {
    const { row } = contextMenu;
    if (!row) return [];
    if (selectedIds.has(row.id) && selectedIds.size > 1) {
      return filtered.filter((r) => selectedIds.has(r.id));
    }
    return [row];
  }

  async function handleMoveToCompleted() {
    const targets = getTargetRows();
    closeContextMenu();
    if (!targets.length) return;
    await Promise.all(
      targets.map((r) =>
        fetch(`${API}/orders/${r.order_id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "completed" }),
        })
      )
    );
    loadOrders();
  }

  function handleDelete() {
    const targets = getTargetRows();
    closeContextMenu();
    if (!targets.length) return;
    setConfirmDelete({ open: true, rows: targets });
  }

  async function confirmDeleteOrder() {
    const { rows } = confirmDelete;
    setConfirmDelete({ open: false, rows: [] });
    if (!rows.length) return;
    await Promise.all(
      rows.map((r) => fetch(`${API}/orders/${r.order_id}`, { method: "DELETE" }))
    );
    loadOrders();
  }

  // Close context menu on any click or ESC
  React.useEffect(() => {
    if (!contextMenu.visible) return;
    function onDown() { closeContextMenu(); }
    function onKey(e) { if (e.key === "Escape") closeContextMenu(); }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu.visible]);
  const [colWidths, setColWidths] = React.useState(
    Object.fromEntries(COLUMNS.map((c) => [c.key, c.defaultWidth])),
  );

  function startResize(e, key) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = colWidths[key];

    function onMove(ev) {
      const newWidth = Math.max(60, startWidth + (ev.clientX - startX));
      setColWidths((prev) => ({ ...prev, [key]: newWidth }));
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function loadOrders() {
    setLoading(true);
    setError("");
    fetch(`${API}/orders/list`)
      .then((res) => res.json())
      .then((data) => {
        setRows(data);
        setSelectedIds(new Set());
        setLoading(false);
      })
      .catch((err) => {
        setError("Failed to load orders: " + err.message);
        setLoading(false);
      });
  }

  React.useEffect(() => {
    loadOrders();
  }, [refreshKey]);

  const filtered = rows.filter((r) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (r.order_number || "").toLowerCase().includes(q) ||
      (r.buyer_name || "").toLowerCase().includes(q) ||
      (r.custom_1 || "").toLowerCase().includes(q)
    );
  });

  const allSelected = filtered.length > 0 && selectedIds.size === filtered.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "'Segoe UI', sans-serif", background: "#f5f5f5" }}>

      {/* Command bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 16px",
        borderBottom: "1px solid #ddd",
        background: "#f7f7f7",
        flexShrink: 0,
      }}>

        {/* Left: tabs */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={tab === "active" ? tabStyleActive : tabStyle} onClick={() => setTab("active")}>
            Orders ({rows.length})
          </button>
          <button style={tab === "completed" ? tabStyleActive : tabStyle} onClick={() => setTab("completed")}>
            Completed
          </button>
        </div>

        {/* Right: actions */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search orders…"
            style={{
              padding: "6px 10px",
              border: "1px solid #ccc",
              borderRadius: "4px",
              fontSize: "13px",
              width: "180px",
            }}
          />
          <button onClick={loadOrders} style={{ ...tabStyle, padding: "6px 12px" }}>
            Refresh
          </button>
          <button onClick={onImport} style={primaryButton}>
            + Import Order
          </button>
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "18px",
              color: "#666",
              padding: "4px 6px",
              lineHeight: 1,
              opacity: 0.75,
              transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.75")}
          >
            ⚙
          </button>
        </div>

      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px" }}>

        {error ? (
          <div style={{ padding: "12px 16px", background: "#fee2e2", borderRadius: "6px", color: "#991b1b", fontSize: "13px" }}>
            {error}
          </div>
        ) : loading ? (
          <div style={{ color: "#888", padding: "12px", fontSize: "13px" }}>Loading…</div>
        ) : tab === "completed" ? (
          <div style={{ color: "#888", padding: "12px", fontSize: "13px" }}>No completed orders yet.</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ color: "#888", fontSize: "14px", marginBottom: "14px" }}>
              {search ? "No orders match your search." : "No active orders yet."}
            </div>
            {!search && (
              <button onClick={onImport} style={primaryButton}>
                + Import your first order
              </button>
            )}
          </div>
        ) : (
          <table style={{ borderCollapse: "collapse", fontSize: "14px", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 36 }} />
              {COLUMNS.map((c) => (
                <col key={c.key} style={{ width: colWidths[c.key] }} />
              ))}
            </colgroup>
            <thead style={{ background: "#e5e5e5" }}>
              <tr>
                {/* Select-all checkbox */}
                <th style={{
                  width: 36,
                  padding: "9px 0 9px 10px",
                  borderBottom: "1px solid #ccc",
                  userSelect: "none",
                }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                    style={{ cursor: "pointer" }}
                  />
                </th>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    style={{
                      width: colWidths[c.key],
                      padding: "9px 10px",
                      textAlign: "left",
                      fontWeight: 600,
                      fontSize: "12px",
                      color: "#555",
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      borderBottom: "1px solid #ccc",
                      position: "relative",
                      userSelect: "none",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                    }}
                  >
                    {c.label}
                    <div
                      onMouseDown={(e) => startResize(e, c.key)}
                      style={{
                        position: "absolute",
                        right: 0,
                        top: 0,
                        width: 5,
                        height: "100%",
                        cursor: "col-resize",
                        background: "transparent",
                      }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const isSelected = selectedIds.has(r.id);
                return (
                  <tr
                    key={r.id}
                    onDoubleClick={() => setEditingOrder(r)}
                    onContextMenu={(e) => handleContextMenu(e, r)}
                    style={{
                      cursor: "pointer",
                      background: isSelected
                        ? "#eff6ff"
                        : i % 2 === 0 ? "#fff" : "#fafafa",
                    }}
                  >
                    {/* Row checkbox */}
                    <td
                      style={{
                        width: 36,
                        padding: "8px 0 8px 10px",
                        borderBottom: "1px solid #eee",
                      }}
                      onClick={(e) => { e.stopPropagation(); toggleRow(r.id); }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRow(r.id)}
                        style={{ cursor: "pointer" }}
                      />
                    </td>
                    {COLUMNS.map((c) => (
                      <td
                        key={c.key}
                        style={{
                          width: colWidths[c.key],
                          padding: "8px 10px",
                          borderBottom: "1px solid #eee",
                          color: r[c.key] ? "#1a1a1a" : "#bbb",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r[c.key] || "—"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

      </div>

      {editingOrder && (
        <EditOrderModal
          order={editingOrder}
          onClose={() => setEditingOrder(null)}
          onSaved={() => {
            setEditingOrder(null);
            loadOrders();
          }}
        />
      )}

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
      />

      {confirmDelete.open && (
        <div
          onClick={(e) => e.target === e.currentTarget && setConfirmDelete({ open: false, rows: [] })}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            zIndex: 9998,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{
            background: "#fff",
            borderRadius: "8px",
            boxShadow: "0 20px 60px rgba(0,0,0,0.22)",
            width: "380px",
            padding: "24px",
          }}>
            <div style={{ fontWeight: 700, fontSize: "16px", color: "#111", marginBottom: "10px" }}>
              {confirmDelete.rows.length > 1 ? `Delete ${confirmDelete.rows.length} Orders?` : "Delete Order?"}
            </div>
            <div style={{ fontSize: "13px", color: "#444", lineHeight: 1.6, marginBottom: "24px" }}>
              {confirmDelete.rows.length > 1 ? (
                <>
                  Are you sure you want to delete{" "}
                  <strong>{confirmDelete.rows.length} orders</strong>?
                  <div style={{ marginTop: "8px", maxHeight: "120px", overflowY: "auto" }}>
                    {confirmDelete.rows.map((r) => (
                      <div key={r.id} style={{ color: "#555", fontSize: "12px" }}>
                        #{r.order_number} — {r.buyer_name || "Unknown"}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  Are you sure you want to delete order{" "}
                  <strong>#{confirmDelete.rows[0]?.order_number}</strong> for{" "}
                  <strong>{confirmDelete.rows[0]?.buyer_name || "this buyer"}</strong>?
                </>
              )}
              <br />
              <span style={{ color: "#888" }}>This cannot be undone.</span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setConfirmDelete({ open: false, rows: [] })}
                style={{
                  padding: "7px 16px",
                  border: "1px solid #d1d5db",
                  borderRadius: "5px",
                  background: "#fff",
                  cursor: "pointer",
                  fontSize: "13px",
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteOrder}
                style={{
                  padding: "7px 18px",
                  border: "none",
                  borderRadius: "5px",
                  background: "#dc2626",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: "13px",
                  fontWeight: 600,
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {contextMenu.visible && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            background: "#fff",
            border: "1px solid #d1d5db",
            borderRadius: "6px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.14)",
            zIndex: 9999,
            padding: "4px 0",
            minWidth: "170px",
            fontSize: "13px",
          }}
        >
          {(() => {
            const n = contextMenu.row && selectedIds.has(contextMenu.row.id) && selectedIds.size > 1
              ? selectedIds.size
              : 1;
            return [
              { label: n > 1 ? `Move ${n} to Completed` : "Move to Completed", action: handleMoveToCompleted, color: "#111" },
              { label: n > 1 ? `Delete ${n} Orders`     : "Delete Order",       action: handleDelete,          color: "#dc2626" },
            ];
          })().map(({ label, action, color }) => (
            <div
              key={label}
              onClick={action}
              style={{ padding: "8px 16px", cursor: "pointer", color, userSelect: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
