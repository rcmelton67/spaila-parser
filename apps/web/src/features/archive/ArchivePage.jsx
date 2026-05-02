import React from "react";
import { archiveApi } from "../../api.js";

export default function ArchivePage() {
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("archived");
  const [rows, setRows] = React.useState([]);
  const [selected, setSelected] = React.useState(null);
  const [state, setState] = React.useState({ loading: false, error: "" });

  const searchArchive = React.useCallback(async () => {
    setState({ loading: true, error: "" });
    try {
      const result = await archiveApi.search({ q: query, status: statusFilter });
      setRows(result);
      setSelected((current) => current && result.find((row) => row.archive_id === current.archive_id) ? current : result[0] || null);
      setState({ loading: false, error: "" });
    } catch (error) {
      setState({ loading: false, error: error?.message || "Could not search archive." });
    }
  }, [query, statusFilter]);

  React.useEffect(() => {
    const timer = window.setTimeout(searchArchive, 220);
    return () => window.clearTimeout(timer);
  }, [searchArchive]);

  return (
    <section className="orders-page">
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">Archive Search</span>
          <h2>Historical Orders</h2>
          <p>Search archived orders and conversation history without exposing desktop filesystem paths.</p>
        </div>
        <button className="ghost-button" type="button" onClick={searchArchive} disabled={state.loading}>
          {state.loading ? "Searching..." : "Search"}
        </button>
      </div>

      <div className="toolbar">
        <label>
          <span>Search archive</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Order, buyer, email, pet, notes" />
        </label>
        <label>
          <span>Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="archived">Archived</option>
            <option value="all">All statuses</option>
          </select>
        </label>
      </div>

      {state.error ? <div className="error-banner">{state.error}</div> : null}

      <div className="archive-layout">
        <div className="archive-results">
          {state.loading ? (
            <div className="table-state"><div className="spinner" /><span>Searching archive...</span></div>
          ) : rows.length ? rows.map((row) => (
            <button
              key={row.archive_id}
              type="button"
              className={`archive-result ${selected?.archive_id === row.archive_id ? "active" : ""}`}
              onClick={() => setSelected(row)}
            >
              <strong>#{row.order_number || "Unnumbered"}</strong>
              <span>{row.buyer_name || row.buyer_email || "Unknown buyer"}</span>
              <em>{row.archived_at || "Archived"} · {row.archive_status}</em>
            </button>
          )) : (
            <div className="table-state table-state-empty">
              <strong>No archive results</strong>
              <span>Try a broader search term.</span>
            </div>
          )}
        </div>

        <section className="section-card archive-detail">
          {selected ? (
            <>
              <div className="section-eyebrow">Archived Order</div>
              <h2>#{selected.order_number || "Unnumbered"}</h2>
              <div className="status-badge status-badge-slate">Archived</div>
              <dl className="detail-list">
                <div className="detail-field"><dt>Buyer</dt><dd>{selected.buyer_name || "Not set"}</dd></div>
                <div className="detail-field"><dt>Email</dt><dd>{selected.buyer_email || "Not set"}</dd></div>
                <div className="detail-field"><dt>Pet</dt><dd>{selected.pet_name || "Not set"}</dd></div>
                <div className="detail-field"><dt>Order date</dt><dd>{selected.order_date || "Not set"}</dd></div>
                <div className="detail-field"><dt>Shipping</dt><dd>{selected.shipping_address || "Not set"}</dd></div>
              </dl>
              {selected.snippet ? <p className="note-block">{selected.snippet}</p> : null}
              {selected.conversation_text ? (
                <p className="note-block">{selected.conversation_text.slice(0, 700)}</p>
              ) : null}
              <p className="archive-guard">Restore remains desktop-guarded to preserve local archive integrity.</p>
            </>
          ) : (
            <div className="table-state table-state-empty">
              <strong>Select an archived order</strong>
              <span>Details will appear here.</span>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
