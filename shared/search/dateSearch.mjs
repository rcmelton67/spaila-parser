const MONTHS = [
  ["jan", "january"],
  ["feb", "february"],
  ["mar", "march"],
  ["apr", "april"],
  ["may", "may"],
  ["jun", "june"],
  ["jul", "july"],
  ["aug", "august"],
  ["sep", "september"],
  ["oct", "october"],
  ["nov", "november"],
  ["dec", "december"],
];

const MONTH_LOOKUP = new Map(
  MONTHS.flatMap(([shortName, fullName], index) => [
    [shortName, index + 1],
    [fullName, index + 1],
  ]),
);

function normalizeText(value) {
  return String(value ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

function validParts(month, day, year = null) {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (year != null && (!Number.isInteger(year) || year < 1000 || year > 9999)) return false;
  return true;
}

export function parseDateSearchParts(value) {
  const text = normalizeText(value).replace(/,/g, "");
  if (!text) return null;

  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:t.*)?$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return validParts(month, day, year) ? { year, month, day } : null;
  }

  match = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    let year = match[3] ? Number(match[3]) : null;
    if (year != null && year < 100) year += 2000;
    return validParts(month, day, year) ? { year, month, day } : null;
  }

  match = text.match(/^([a-z]+)\.?\s+(\d{1,2})(?:\s+(\d{2,4}))?$/);
  if (match) {
    const month = MONTH_LOOKUP.get(match[1].slice(0, 3)) || MONTH_LOOKUP.get(match[1]);
    const day = Number(match[2]);
    let year = match[3] ? Number(match[3]) : null;
    if (year != null && year < 100) year += 2000;
    return validParts(month, day, year) ? { year, month, day } : null;
  }

  return null;
}

export function buildDateSearchAliases(value) {
  const parts = typeof value === "object" && value ? value : parseDateSearchParts(value);
  if (!parts) return [];

  const { year, month, day } = parts;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  const [shortName, fullName] = MONTHS[month - 1];
  const aliases = new Set([
    `${month}/${day}`,
    `${mm}/${dd}`,
    `${month}/${dd}`,
    `${mm}/${day}`,
    `${shortName} ${day}`,
    `${shortName} ${dd}`,
    `${fullName} ${day}`,
    `${fullName} ${dd}`,
  ]);

  if (year) {
    aliases.add(`${year}-${mm}-${dd}`);
    aliases.add(`${month}/${day}/${year}`);
    aliases.add(`${mm}/${dd}/${year}`);
    aliases.add(`${shortName} ${day} ${year}`);
    aliases.add(`${fullName} ${day} ${year}`);
  }

  return [...aliases].map(normalizeText);
}

export function expandSearchValueAliases(value) {
  const normalized = normalizeText(value);
  const aliases = new Set(normalized ? [normalized] : []);
  for (const alias of buildDateSearchAliases(value)) aliases.add(alias);
  return [...aliases];
}

export function normalizedSearchMatches(query, values, mode = "smart") {
  const needle = normalizeText(query);
  if (!needle) return true;

  const queryDateAliases = buildDateSearchAliases(needle);
  const expandedValues = values.flatMap(expandSearchValueAliases).filter(Boolean);
  if (!expandedValues.length) return false;

  if (queryDateAliases.length) {
    return queryDateAliases.some((alias) => expandedValues.includes(alias));
  }

  if (mode === "exact") return expandedValues.some((value) => value === needle);
  const terms = needle.split(/\s+/).filter(Boolean);
  const haystack = expandedValues.join(" ");
  return terms.every((term) => haystack.includes(term));
}

