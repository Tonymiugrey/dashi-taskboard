import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseCodexAppProcesses,
  parseTaskboardInjectorProcesses,
} from "../scripts/device-helper-runtime.mjs";

test("Codex app discovery ignores helper processes and reads optional CDP ports", () => {
  const processes = parseCodexAppProcesses(`
101 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
102 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9231
103 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer)
104 /Applications/Codex.app/Contents/MacOS/Codex --remote-debugging-port 9229
`);
  assert.deepEqual(processes, [
    { pid: 101, appPath: "/Applications/ChatGPT.app", debuggingPort: null },
    { pid: 102, appPath: "/Applications/ChatGPT.app", debuggingPort: 9231 },
    { pid: 104, appPath: "/Applications/Codex.app", debuggingPort: 9229 },
  ]);
});

test("Taskboard injector discovery is scoped to this absolute script", () => {
  const injectorPath = "/repo/scripts/codex-injector.mjs";
  const processes = parseTaskboardInjectorProcesses(`
201 node /repo/scripts/codex-injector.mjs --watch --port 9231
202 node /repo/scripts/codex-injector.mjs --watch
203 node /other/scripts/codex-injector.mjs --watch --port 9231
204 node /repo/scripts/codex-injector.mjs --refresh
`, injectorPath);
  assert.deepEqual(processes, [
    { pid: 201, debuggingPort: 9231 },
    { pid: 202, debuggingPort: 9229 },
  ]);
});
