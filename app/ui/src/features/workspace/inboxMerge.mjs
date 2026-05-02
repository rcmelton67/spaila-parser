export function getInboxItemId(item) {
  return String(item?.id || item?.email_id || "").trim();
}

export function normalizeProcessedEmailRef(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase();
}

/** Extract the bare IMAP UID from a {timestamp}_{uid}.eml filename or path. */
export function extractEmlUid(filePath) {
  const name = String(filePath || "").replace(/\\/g, "/").split("/").pop();
  const match = name.match(/^\d+_([A-Za-z0-9]+)\.eml$/i);
  return match ? match[1].toLowerCase() : "";
}

export function getProcessedEmailRefVariants(value) {
  const ref = normalizeProcessedEmailRef(value);
  if (!ref) return [];
  const parts = ref.split("/").filter(Boolean);
  const filename = parts[parts.length - 1] || "";
  return filename && filename !== ref ? [ref, filename] : [ref];
}

export function getInboxItemRefs(item) {
  return [
    item?.id,
    item?.email_id,
    item?.message_id,
    item?.imap_uid,
    item?.path,
    item?.relativePath,
    item?.source_eml_path,
    item?.name,
  ].flatMap(getProcessedEmailRefVariants).filter(Boolean);
}

export function isProcessedInboxItem(item, processedRefs) {
  return getInboxItemRefs(item).some((ref) => processedRefs.has(ref));
}

export function hasStableReceivedAt(item) {
  const receivedAt = String(item?.received_at || "").trim();
  return receivedAt && Number.isFinite(Date.parse(receivedAt));
}

export function filterProcessedInboxItems(items = [], processedRefs = new Set(), options = {}) {
  const nextProcessedRefs = new Set(processedRefs);
  const filtered = [];
  let removed = 0;
  let missingReceivedAt = 0;
  for (const item of items || []) {
    const manualImported = item?.manual_imported === true;
    if (!manualImported && !hasStableReceivedAt(item)) {
      missingReceivedAt += 1;
      continue;
    }
    if (!manualImported && isProcessedInboxItem(item, nextProcessedRefs)) {
      removed += 1;
      for (const ref of getInboxItemRefs(item)) {
        nextProcessedRefs.add(ref);
      }
      continue;
    }
    filtered.push(item);
  }
  if (removed || missingReceivedAt) {
    console.log("[INBOX_PROCESSED_FILTER]", { removed, missing_received_at: missingReceivedAt });
  }
  if (nextProcessedRefs.size !== processedRefs.size) {
    options.onProcessedRefsExpanded?.(nextProcessedRefs);
  }
  return filtered;
}

export function mergeInboxItems(previousItems = [], fetchedItems = [], processedRefs = new Set(), options = {}) {
  const previousVisibleItems = filterProcessedInboxItems(previousItems, processedRefs, options);
  const filteredFetchedItems = filterProcessedInboxItems(fetchedItems, processedRefs, options);
  const previousById = new Map();
  for (const item of previousVisibleItems) {
    const id = getInboxItemId(item);
    if (id && !previousById.has(id)) {
      previousById.set(id, item);
    }
  }

  const seenFetchedIds = new Set();
  const mergedItems = [];
  let newCount = 0;
  let existingCount = 0;
  for (const fresh of filteredFetchedItems) {
    const id = getInboxItemId(fresh);
    if (id && seenFetchedIds.has(id)) {
      continue;
    }
    if (id) {
      seenFetchedIds.add(id);
    }
    const previous = id ? previousById.get(id) : null;
    if (previous) {
      existingCount += 1;
      mergedItems.push({ ...previous, ...fresh });
    } else {
      newCount += 1;
      mergedItems.push(fresh);
    }
  }

  const prunedCount = previousVisibleItems.filter((item) => {
    const id = getInboxItemId(item);
    return id && !seenFetchedIds.has(id);
  }).length;

  console.log("[INBOX_MERGE]", {
    previous_count: previousVisibleItems.length,
    fetched_count: filteredFetchedItems.length,
    pruned_count: prunedCount,
    new_count: newCount,
    existing_count: existingCount,
  });
  console.log("[INBOX_AUTHORITATIVE_REFRESH]", { verified: true });
  return mergedItems;
}
