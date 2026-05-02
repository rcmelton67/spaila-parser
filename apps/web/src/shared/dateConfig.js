export const DATE_FIELD_KEYS = new Set(["order_date", "ship_by"]);

export const DATE_FORMAT_OPTIONS = [
  { value: "short", label: "Short", example: "Apr 13, 2026" },
  { value: "numeric", label: "Numeric", example: "04/13/2026" },
  { value: "iso", label: "ISO", example: "2026-04-13" },
];

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDate(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
    const [year, month, day] = String(raw).split("-").map(Number);
    return new Date(year, month - 1, day);
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(raw, config = {}) {
  if (!raw) return "—";
  const date = parseDate(raw);
  if (!date) return String(raw);

  const format = config.format || "short";
  const showYear = config.showYear !== false;

  if (format === "iso") {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  if (format === "numeric") {
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return showYear ? `${month}/${day}/${date.getFullYear()}` : `${month}/${day}`;
  }

  const month = MONTHS_SHORT[date.getMonth()];
  const day = date.getDate();
  return showYear ? `${month} ${day}, ${date.getFullYear()}` : `${month} ${day}`;
}
