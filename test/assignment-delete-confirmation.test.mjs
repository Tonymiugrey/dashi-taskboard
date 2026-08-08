import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { resolveAssignmentBackspace } from "../shared/assignment-delete-confirmation.mjs";

const boundary = {
  key: "Backspace",
  targetId: "codex-mini",
  armedTargetId: null,
  selectionStart: 0,
  selectionEnd: 0,
  adjacent: true,
};

test("an adjacent Backspace arms an assignment before deleting it", () => {
  assert.equal(resolveAssignmentBackspace(boundary), "arm");
  assert.equal(resolveAssignmentBackspace({
    ...boundary,
    armedTargetId: "codex-mini",
  }), "delete");
});

test("holding Backspace cannot skip the second deliberate key press", () => {
  assert.equal(resolveAssignmentBackspace({
    ...boundary,
    armedTargetId: "codex-mini",
    repeat: true,
  }), "arm");
});

test("ordinary editing and text selections pass through unchanged", () => {
  assert.equal(resolveAssignmentBackspace({ ...boundary, key: "a" }), "pass");
  assert.equal(resolveAssignmentBackspace({ ...boundary, adjacent: false }), "pass");
  assert.equal(resolveAssignmentBackspace({
    ...boundary,
    selectionStart: null,
    selectionEnd: null,
  }), "pass");
  assert.equal(resolveAssignmentBackspace({
    ...boundary,
    selectionStart: 0,
    selectionEnd: 2,
  }), "pass");
});

test("the comment composer inserts assignments inline and wires both neutral delete boundaries", async () => {
  const [detail, composer, styles] = await Promise.all([
    readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/InlineMediaComposer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /inlineMediaAssignments\(commentSegments\)/);
  assert.doesNotMatch(detail, /codex-assignment-drafts/);
  assert.match(composer, /type: "codex-assignment"/);
  assert.match(composer, /candidate\.id === segment\.id \? \[before, assignment, after\]/);
  assert.match(composer, /previous\?\.type === "codex-assignment"/);
  assert.match(composer, /event\.currentTarget\.selectionStart === 0/);
  assert.match(composer, /assignment\.instruction\.length === 0/);
  assert.match(composer, /onSelect=\{\(\) => \{/);
  assert.match(composer, /再次退格删除/);
  assert.match(composer, /inline-codex-assignment/);
  assert.match(composer, /data-mention-menu-open/);
  const confirmationStyles = styles.match(
    /\.inline-codex-assignment\.is-delete-confirming \{[^}]+\}/,
  )?.[0] ?? "";
  assert.match(confirmationStyles, /var\(--border-strong\)/);
  assert.match(confirmationStyles, /var\(--surface-hover\)/);
  assert.doesNotMatch(confirmationStyles, /danger|#[a-f\d]{3,8}|red/i);
});
