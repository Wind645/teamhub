import assert from "node:assert/strict";
import { total } from "./math.mjs";

assert.equal(total([]), 0);
assert.equal(total([2, 3]), 5);
console.log("Both total checks passed.");
