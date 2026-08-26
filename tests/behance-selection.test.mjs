import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../behance-content.js", import.meta.url), "utf8");

test("Behance selection badge updates idempotently without replacing its text node", () => {
  assert.match(source, /if \(badge\.textContent !== badgeText\) badge\.textContent = badgeText/);
  assert.match(source, /badge\.dataset\.behanceBound !== "1"/);
  assert.doesNotMatch(source, /badge\.onclick\s*=/);
});

test("Behance observer ignores collector UI mutations and no longer watches class changes", () => {
  assert.match(source, /function mutationNeedsScan\(mutations\)/);
  assert.match(source, /if \(!mutationNeedsScan\(mutations\)\) return/);
  assert.match(source, /attributeFilter: \["src", "srcset", "data-src"\]/);
  assert.doesNotMatch(source, /attributeFilter:\s*\[[^\]]*"class"/);
});
