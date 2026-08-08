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

test("the comment composer wires both boundaries to a neutral confirmation state", async () => {
  const [detail, composer, styles] = await Promise.all([
    readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/components/InlineMediaComposer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../web/src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /event\.currentTarget\.value\.length === 0/);
  assert.match(detail, /event\.currentTarget\.selectionStart === event\.currentTarget\.value\.length/);
  assert.match(detail, /pendingMentions\.at\(-1\)\?\.target\.id/);
  assert.match(detail, /再次退格删除/);
  assert.match(detail, /is-delete-confirming/);
  assert.match(composer, /data-mention-menu-open/);
  const confirmationStyles = styles.match(
    /\.codex-assignment-drafts > label\.is-delete-confirming \{[^}]+\}/,
  )?.[0] ?? "";
  assert.match(confirmationStyles, /var\(--border-strong\)/);
  assert.match(confirmationStyles, /var\(--surface-hover\)/);
  assert.doesNotMatch(confirmationStyles, /danger|#[a-f\d]{3,8}|red/i);
});
