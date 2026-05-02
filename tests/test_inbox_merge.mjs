import assert from "node:assert/strict";
import { mergeInboxItems } from "../app/ui/src/features/workspace/inboxMerge.mjs";

const receivedA = "2026-04-10T12:00:00.000Z";
const receivedB = "2026-04-10T12:05:00.000Z";
const receivedC = "2026-04-10T12:10:00.000Z";

{
  const previous = [
    { email_id: "A", received_at: receivedA, ui_state: "selected" },
    { email_id: "B", received_at: receivedB, ui_state: "expanded" },
  ];
  const fetched = [
    { email_id: "B", received_at: receivedB, subject: "Still present" },
    { email_id: "C", received_at: receivedC, subject: "New mail" },
  ];

  const merged = mergeInboxItems(previous, fetched);

  assert.deepEqual(merged.map((item) => item.email_id), ["B", "C"]);
  assert.equal(merged.some((item) => item.email_id === "A"), false, "previous-only stale inbox rows must be pruned");
  assert.equal(merged[0].ui_state, "expanded", "matching rows keep previous UI-only metadata");
  assert.equal(merged[0].subject, "Still present", "fresh fetched metadata wins for matching rows");
  assert.equal(merged[1].subject, "New mail", "new fetched rows are added");
}

{
  const previous = [
    { email_id: "A", received_at: receivedA },
    { email_id: "B", received_at: receivedB },
  ];
  const fetched = [
    { email_id: "A", received_at: receivedA },
    { email_id: "B", received_at: receivedB },
    { email_id: "C", received_at: receivedC },
  ];
  const processedRefs = new Set(["b"]);

  const merged = mergeInboxItems(previous, fetched, processedRefs);

  assert.deepEqual(merged.map((item) => item.email_id), ["A", "C"]);
  assert.equal(merged.some((item) => item.email_id === "B"), false, "processed refs must remain filtered");
}

console.log("inboxMerge regression tests passed");
