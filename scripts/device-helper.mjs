#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABEL = "com.dashi-taskboard.device-helper";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentDirectory = path.join(os.homedir(), "Library", "LaunchAgents");
const agentPath = path.join(agentDirectory, `${LABEL}.plist`);
const logPath = path.join(os.homedir(), "Library", "Logs", "dashi-taskboard-helper.log");
const domain = `gui/${process.getuid()}`;

function xml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function plist() {
  const injector = path.join(projectRoot, "scripts", "codex-injector.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(injector)}</string>
    <string>--launch</string>
    <string>--watch</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_TASKBOARD_HOST</key>
    <string>127.0.0.1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function launchctl(args, { allowFailure = false, capture = false } = {}) {
  const result = spawnSync("/bin/launchctl", args, {
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`launchctl ${args[0]} failed with exit code ${result.status}`);
  }
  return result;
}

async function install() {
  if (process.platform !== "darwin") throw new Error("The device helper currently supports macOS only");
  await mkdir(agentDirectory, { recursive: true });
  await mkdir(path.dirname(logPath), { recursive: true });
  launchctl(["bootout", domain, agentPath], { allowFailure: true });
  await writeFile(agentPath, plist(), { mode: 0o644 });
  await chmod(agentPath, 0o644);
  launchctl(["bootstrap", domain, agentPath]);
  console.log(`Installed ${LABEL}. Codex and the Taskboard bridge will start at login.`);
  console.log(`LaunchAgent: ${agentPath}`);
}

async function uninstall() {
  launchctl(["bootout", domain, agentPath], { allowFailure: true });
  await unlink(agentPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  console.log(`Uninstalled ${LABEL}.`);
}

function start() {
  launchctl(["kickstart", "-k", `${domain}/${LABEL}`]);
}

async function status() {
  const result = launchctl(["print", `${domain}/${LABEL}`], {
    allowFailure: true,
    capture: true,
  });
  if (result.status !== 0) {
    const installed = await readFile(agentPath, "utf8").then(() => true).catch(() => false);
    console.log(installed ? "installed but not loaded" : "not installed");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.stdout);
}

const command = process.argv[2];
if (command === "install") await install();
else if (command === "uninstall") await uninstall();
else if (command === "start") start();
else if (command === "status") await status();
else {
  console.error("Usage: node scripts/device-helper.mjs <install|uninstall|start|status>");
  process.exitCode = 2;
}
