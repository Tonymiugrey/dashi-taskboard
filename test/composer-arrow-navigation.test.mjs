import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { resolveComposerArrowBoundary } from "../shared/composer-arrow-navigation.mjs";

const boundary = {
  key: "ArrowLeft",
  selectionStart: 0,
  selectionEnd: 0,
  valueLength: 4,
};

test("collapsed arrow keys cross the left and right segment boundaries", () => {
  assert.equal(resolveComposerArrowBoundary(boundary), "previous");
  assert.equal(resolveComposerArrowBoundary({
    ...boundary,
    key: "ArrowRight",
    selectionStart: 4,
    selectionEnd: 4,
  }), "next");
});

test("arrows within text, selections, and modified arrows stay native", () => {
  assert.equal(resolveComposerArrowBoundary({ ...boundary, selectionStart: 2, selectionEnd: 2 }), "pass");
  assert.equal(resolveComposerArrowBoundary({ ...boundary, selectionEnd: 1 }), "pass");
  assert.equal(resolveComposerArrowBoundary({ ...boundary, shiftKey: true }), "pass");
  assert.equal(resolveComposerArrowBoundary({ ...boundary, altKey: true }), "pass");
  assert.equal(resolveComposerArrowBoundary({ ...boundary, ctrlKey: true }), "pass");
  assert.equal(resolveComposerArrowBoundary({ ...boundary, metaKey: true }), "pass");
  assert.equal(resolveComposerArrowBoundary({ ...boundary, key: "ArrowUp" }), "pass");
});

test("the inline composer moves focus through text, assignment, and trailing text segments", async () => {
  const composer = await readFile(
    new URL("../web/src/components/InlineMediaComposer.tsx", import.meta.url),
    "utf8",
  );
  assert.match(composer, /function moveAcrossSegmentBoundary/);
  assert.match(composer, /segments\[segmentIndex \+ \(action === "previous" \? -1 : 1\)\]/);
  assert.match(composer, /destination\?\.type === "text"/);
  assert.match(composer, /destination\?\.type === "codex-assignment"/);
  assert.match(composer, /element\.focus\(\)/);
  assert.match(composer, /action === "previous" \? element\.value\.length : 0/);
  assert.match(composer, /onArmedAssignmentChange\?\.\(null\)/);
  assert.match(composer, /handleAssignmentKeyDown\(event, segment, index\)/);
});
