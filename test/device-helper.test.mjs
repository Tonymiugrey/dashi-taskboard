import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/device-helper.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the macOS helper installs a scoped login LaunchAgent with explicit lifecycle commands", () => {
  assert.match(source, /com\.dashi-taskboard\.device-helper/);
  assert.match(source, /Library", "LaunchAgents/);
  assert.match(source, /--launch/);
  assert.match(source, /--watch/);
  assert.match(source, /CODEX_TASKBOARD_HOST/);
  assert.match(source, /<key>RunAtLoad<\/key>/);
  assert.match(source, /<key>SuccessfulExit<\/key>/);
  assert.match(source, /launchctl\(\["bootstrap"/);
  assert.match(source, /launchctl\(\["bootout"/);
  assert.match(packageJson.scripts["device-helper:install"], /device-helper\.mjs install/);
  assert.match(packageJson.scripts["device-helper:uninstall"], /device-helper\.mjs uninstall/);
});
