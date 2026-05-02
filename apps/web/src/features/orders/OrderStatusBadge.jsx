import React from "react";
import { ORDER_STATUSES } from "../../../../../shared/models/order.mjs";

export default function OrderStatusBadge({ status = "active", itemStatus = "" }) {
  const normalized = String(itemStatus || status || ORDER_STATUSES.active).toLowerCase();
  const label = normalized.replace(/_/g, " ") || "active";
  const tone = normalized === "completed"
    ? "green"
    : normalized === "archived"
      ? "slate"
      : normalized === "in_progress"
        ? "blue"
        : "amber";

  return <span className={`status-badge status-badge-${tone}`}>{label}</span>;
}
