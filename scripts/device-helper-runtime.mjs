import path from "node:path";

export function parseCodexAppProcesses(processList) {
  const processes = [];
  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    const executable = command.match(/^(.+?\.app)\/Contents\/MacOS\/(?:ChatGPT|Codex)(?=\s|$)/);
    if (!executable) continue;
    const portMatch = command.match(/(?:^|\s)--remote-debugging-port(?:=(\d+)|\s+(\d+))(?=\s|$)/);
    processes.push({
      pid,
      appPath: path.resolve(executable[1]),
      debuggingPort: portMatch ? Number(portMatch[1] ?? portMatch[2]) : null,
    });
  }
  return processes;
}
export function parseTaskboardInjectorProcesses(processList, injectorPath) {
  const escapedPath = injectorPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scriptPattern = new RegExp(`(?:^|\\s)${escapedPath}(?=\\s|$)`);
  const processes = [];
  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const command = match[2];
    if (!scriptPattern.test(command) || !/(?:^|\s)--watch(?=\s|$)/.test(command)) continue;
    const portMatch = command.match(/(?:^|\s)--port(?:=(\d+)|\s+(\d+))(?=\s|$)/);
    processes.push({
      pid: Number(match[1]),
      debuggingPort: portMatch ? Number(portMatch[1] ?? portMatch[2]) : 9229,
    });
  }
  return processes;
}
