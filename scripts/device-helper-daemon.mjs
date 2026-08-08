#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, watch } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

import {
  parseCodexAppProcesses,
  parseTaskboardInjectorProcesses,
} from "./device-helper-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injectorPath = path.join(projectRoot, "scripts", "codex-injector.mjs");
const ignoredInitialPids = new Set();
let managedInjector = null;
let managedInjectorLaunchesApp = false;
let stopping = false;

function createChangeSignal() {
  let dirty = false;
  let wake = null;
  return {
    notify() {
      if (wake) {
        const resolve = wake;
        wake = null;
        resolve();
      } else {
        dirty = true;
      }
    },
    async wait(timeoutMs) {
      if (dirty) {
        dirty = false;
        return;
      }
      let resolveEvent;
      const event = new Promise((resolve) => {
        resolveEvent = resolve;
        wake = resolve;
      });
      await Promise.race([event, delay(timeoutMs)]);
      if (wake === resolveEvent) wake = null;
    },
  };
}

const processChanges = createChangeSignal();

function processList() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("Could not inspect running applications");
  return result.stdout;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await delay(50);
  }
  return false;
}

function stopInjector(child) {
  if (child?.exitCode === null && !child.killed) child.kill("SIGTERM");
}

function startInjector(args, { launchesApp = false } = {}) {
  if (managedInjector?.exitCode === null && !managedInjector.killed) return;
  managedInjectorLaunchesApp = launchesApp;
  managedInjector = spawn(process.execPath, [injectorPath, ...args], {
    cwd: projectRoot,
    env: { ...process.env, CODEX_TASKBOARD_HOST: "127.0.0.1" },
    stdio: "inherit",
  });
  managedInjector.once("exit", () => {
    managedInjector = null;
    managedInjectorLaunchesApp = false;
    processChanges.notify();
  });
}

async function interceptLaunch(app) {
  console.log(`Detected ${app.appPath}; reopening it with the local Taskboard bridge.`);
  process.kill(app.pid, "SIGTERM");
  if (!(await waitForExit(app.pid))) {
    console.error(`Codex process ${app.pid} did not exit; Taskboard injection was skipped.`);
    ignoredInitialPids.add(app.pid);
    return;
  }
  startInjector(
    ["--launch", "--watch", "--app-path", app.appPath],
    { launchesApp: true },
  );
}

function attachToDebuggableApp(app) {
  startInjector([
    "--watch",
    "--attach-existing",
    "--port",
    String(app.debuggingPort),
  ]);
}

function stopStaleInjectors(apps, injectors) {
  const livePorts = new Set(apps.map((app) => app.debuggingPort).filter(Number.isInteger));
  for (const injector of injectors) {
    if (injector.pid === managedInjector?.pid || livePorts.has(injector.debuggingPort)) continue;
    try {
      process.kill(injector.pid, "SIGTERM");
    } catch {}
  }
}

async function main() {
  const codexDataDirectory = path.join(os.homedir(), "Library", "Application Support", "Codex");
  mkdirSync(codexDataDirectory, { recursive: true });
  const applicationWatcher = watch(codexDataDirectory, (_, filename) => {
    if (String(filename || "").startsWith("Singleton")) processChanges.notify();
  });
  const initialProcesses = processList();
  const initialApps = parseCodexAppProcesses(initialProcesses);
  initialApps.filter((app) => !app.debuggingPort).forEach((app) => ignoredInitialPids.add(app.pid));

  while (!stopping) {
    const processes = processList();
    const apps = parseCodexAppProcesses(processes);
    const injectors = parseTaskboardInjectorProcesses(processes, injectorPath);
    const liveAppPids = new Set(apps.map((app) => app.pid));
    for (const pid of ignoredInitialPids) {
      if (!liveAppPids.has(pid)) ignoredInitialPids.delete(pid);
    }

    stopStaleInjectors(apps, injectors);

    if (apps.length === 0) {
      if (!managedInjectorLaunchesApp) stopInjector(managedInjector);
    } else {
      const app = apps[0];
      const injectorPresent = injectors.some(
        (injector) => injector.debuggingPort === app.debuggingPort,
      );
      if (app.debuggingPort && !injectorPresent) {
        attachToDebuggableApp(app);
      } else if (
        !app.debuggingPort
        && !ignoredInitialPids.has(app.pid)
        && !managedInjector
      ) {
        await interceptLaunch(app);
      }
    }

    await processChanges.wait(apps.length === 0 ? 5_000 : 2_000);
  }
  applicationWatcher.close();
}

function stop() {
  stopping = true;
  stopInjector(managedInjector);
  processChanges.notify();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
