import assert from "node:assert/strict";
import { buildDateSearchAliases, normalizedSearchMatches } from "../shared/search/dateSearch.mjs";

const recordValues = ["2026-05-03", "2026-05-10"];
const queries = ["5/3", "5/03", "05/3", "05/03", "May 3", "may 3", "MAY 3", "2026-05-03"];

for (const query of queries) {
  assert.equal(
    normalizedSearchMatches(query, recordValues),
    true,
    `${query} should match the May 3 order date`,
  );
}

const baselineMatches = queries.map((query) => (
  recordValues
    .map((value, index) => normalizedSearchMatches(query, [value]) ? index : null)
    .filter((index) => index !== null)
));

for (const matches of baselineMatches) {
  assert.deepEqual(matches, baselineMatches[0], "equivalent date searches should return the same records");
}

assert.ok(buildDateSearchAliases("2026-05-03").includes("5/3"));
assert.ok(buildDateSearchAliases("2026-05-03").includes("05/03"));
assert.ok(buildDateSearchAliases("2026-05-03").includes("may 3"));
assert.equal(normalizedSearchMatches("buyer", ["Buyer Name"]), true, "general text search should still work");

