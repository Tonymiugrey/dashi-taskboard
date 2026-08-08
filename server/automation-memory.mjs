import { appendFile, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const AUTOMATION_ID_PATTERN = /^[a-z0-9._-]{1,256}$/i;
const SUMMARY_LIMIT = 1_200;
const FILE_LIMIT = 20;

function compactText(value, limit = SUMMARY_LIMIT) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1)}…`;
}

function displayTimestamp(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}

function mentionTargetId(trigger) {
  return trigger.comment.mentions.find((mention) => mention.status === "claimed")?.targetId
    ?? trigger.targetId
    ?? "unknown";
}

function markerFor(trigger) {
  return `<!-- dashi-taskboard-codex-mention:${compactText(trigger.comment.id, 256)}:${compactText(mentionTargetId(trigger), 256)} -->`;
}

function runEvents(events, runId) {
  if (!Array.isArray(events) || !runId) return [];
  return events.filter((event) => event?.runId === runId);
}

function changedFiles(events) {
  const files = [];
  for (const event of events) {
    if (event?.type !== "file_change" || !Array.isArray(event.data?.files)) continue;
    for (const file of event.data.files) {
      const value = compactText(file, 512);
      if (value && !files.includes(value)) files.push(value);
      if (files.length >= FILE_LIMIT) return files;
    }
  }
  return files;
}

function assistantSummary(events) {
  return compactText(
    events.findLast((event) => (
      event?.type === "agent_message"
      && event.role === "assistant"
      && event.data?.status === "completed"
      && compactText(event.content)
    ))?.content
      ?? events.findLast((event) => (
        event?.role === "assistant" && compactText(event.content)
      ))?.content
      ?? "",
  );
}

export function buildExecutionCheckpoint({
  status,
  runId,
  events,
  error,
  baseCommit = null,
  resultCommit = null,
  branch = null,
}) {
  const relevantEvents = runEvents(events, runId);
  return {
    summary: status === "completed"
      ? assistantSummary(relevantEvents) || "Codex completed the assigned work."
      : compactText(error) || "Codex did not complete the assigned work.",
    changedFiles: changedFiles(relevantEvents),
    baseCommit,
    resultCommit,
    branch,
  };
}

function buildEntry({ trigger, status, threadId, runId, events, error, now }) {
  const checkpoint = buildExecutionCheckpoint({ status, runId, events, error });
  const files = checkpoint.changedFiles;
  const summary = checkpoint.summary;
  const taskIdentifier = compactText(trigger.task.identifier, 300);
  const taskTitle = compactText(trigger.task.title, 300);
  const taskLabel = taskIdentifier && taskTitle
    ? `${taskIdentifier}「${taskTitle}」`
    : taskIdentifier || taskTitle || compactText(trigger.task.id, 256);
  const lines = [
    "",
    `## ${displayTimestamp(now())} CST · @Codex`,
    "",
    markerFor(trigger),
    `- 项目：${compactText(trigger.project.name, 300)}（${compactText(trigger.project.id, 256)}）。`,
    `- 议题：${taskLabel}。`,
    `- 触发评论：${compactText(trigger.comment.id, 256)}；执行状态：${status}。`,
  ];
  if (threadId) lines.push(`- Codex 对话：${compactText(threadId, 256)}。`);
  if (files.length > 0) lines.push(`- 变更文件：${files.join("、")}。`);
  lines.push(`- 执行摘要：${summary}`);
  return `${lines.join("\n")}\n`;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export function createMentionAutomationMemoryRecorder({
  policiesPath,
  automationsDirectory,
  now = () => new Date(),
}) {
  return async function recordMentionAutomationMemory(input) {
    let policies;
    try {
      policies = JSON.parse(await readFile(policiesPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { updated: false, reason: "policy-not-found" };
      throw error;
    }
    const policy = policies?.[input.trigger.project.id];
    if (!AUTOMATION_ID_PATTERN.test(policy?.automationId ?? "")) {
      return { updated: false, reason: "automation-not-configured" };
    }

    let root;
    let memoryPath;
    try {
      [root, memoryPath] = await Promise.all([
        realpath(automationsDirectory),
        realpath(path.join(automationsDirectory, policy.automationId, "memory.md")),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") return { updated: false, reason: "memory-not-found" };
      throw error;
    }
    if (!isInside(root, memoryPath)) throw new Error("Automation memory path escapes its root");

    const current = await readFile(memoryPath, "utf8");
    const marker = markerFor(input.trigger);
    if (current.includes(marker)) return { updated: false, reason: "already-recorded" };
    await appendFile(memoryPath, buildEntry({ ...input, now }), { encoding: "utf8" });
    return { updated: true, memoryPath };
  };
}
