import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/device-helper.mjs", import.meta.url), "utf8");
const daemonSource = await readFile(
  new URL("../scripts/device-helper-daemon.mjs", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("the macOS helper installs a watcher without launching Codex at login", () => {
  assert.match(source, /com\.dashi-taskboard\.device-helper/);
  assert.match(source, /Library", "LaunchAgents/);
  assert.match(source, /device-helper-daemon\.mjs/);
  assert.doesNotMatch(source, /<string>--launch<\/string>/);
  assert.match(source, /CODEX_TASKBOARD_HOST/);
  assert.match(source, /<key>RunAtLoad<\/key>/);
  assert.doesNotMatch(source, /<key>SuccessfulExit<\/key>/);
  assert.match(source, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(source, /<string>Background<\/string>/);
  assert.match(source, /launchctl\(\["bootstrap"/);
  assert.match(source, /launchctl\(\["bootout"/);
  assert.match(packageJson.scripts["device-helper:install"], /device-helper\.mjs install/);
  assert.match(packageJson.scripts["device-helper:uninstall"], /device-helper\.mjs uninstall/);
});

test("the watcher intercepts only a user-started Codex process and stays idle after quit", () => {
  assert.match(daemonSource, /ignoredInitialPids/);
  assert.match(daemonSource, /watch\(codexDataDirectory/);
  assert.match(daemonSource, /startsWith\("Singleton"\)/);
  assert.match(daemonSource, /process\.kill\(app\.pid, "SIGTERM"\)/);
  assert.match(daemonSource, /\["--launch", "--watch", "--app-path", app\.appPath\]/);
  assert.match(
    daemonSource,
    /if \(apps\.length === 0\) \{\s*if \(!managedInjectorLaunchesApp\) stopInjector/,
  );
  assert.doesNotMatch(daemonSource, /open", \[|\/usr\/bin\/open/);
});
