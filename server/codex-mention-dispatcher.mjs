import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildExecutionCheckpoint } from "./automation-memory.mjs";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const execFileAsync = promisify(execFile);

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
    error.code = body?.error?.code;
    throw error;
  }
  return body;
}

function compact(value, limit = 2_000) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function readGitState(workspacePath) {
  try {
    const [commitResult, branchResult, statusResult] = await Promise.all([
      execFileAsync("git", ["-C", workspacePath, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", workspacePath, "branch", "--show-current"]),
      execFileAsync("git", ["-C", workspacePath, "status", "--porcelain"]),
    ]);
    let ahead = null;
    try {
      const divergence = await execFileAsync(
        "git",
        ["-C", workspacePath, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      );
      ahead = Number(divergence.stdout.trim().split(/\s+/)[0]);
    } catch {}
    return {
      commit: commitResult.stdout.trim(),
      branch: branchResult.stdout.trim() || null,
      dirty: statusResult.stdout.trim().length > 0,
      ahead: Number.isSafeInteger(ahead) ? ahead : null,
    };
  } catch {
    return null;
  }
}

async function prepareGitWorkspace(workspacePath) {
  let state = await readGitState(workspacePath);
  if (!state) return null;
  if (state.dirty) {
    throw new Error("The assigned workspace has uncommitted changes; refusing an unsafe handoff");
  }
  await execFileAsync(
    "git",
    ["-C", workspacePath, "fetch", "--prune"],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  let upstream = null;
  try {
    const result = await execFileAsync(
      "git",
      ["-C", workspacePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    );
    upstream = result.stdout.trim() || null;
  } catch {}
  if (upstream) {
    await execFileAsync(
      "git",
      ["-C", workspacePath, "merge", "--ff-only", upstream],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
  }
  state = await readGitState(workspacePath);
  return state;
}

export function buildMentionAssignmentMessage(trigger) {
  const shared = compact(trigger.comment?.body);
  const instruction = compact(trigger.assignment?.instruction) || shared;
  const checkpoints = Array.isArray(trigger.context?.checkpoints)
    ? trigger.context.checkpoints.slice(0, 3)
    : [];
  const sections = [];
  if (shared && shared !== instruction) sections.push(`共享背景：\n${shared}`);
  sections.push(`你的设备任务：\n${instruction}`);
  if (checkpoints.length > 0) {
    sections.push(`最近接力记录：\n${checkpoints.map((checkpoint) => {
      const commit = checkpoint.resultCommit ? ` @ ${checkpoint.resultCommit}` : "";
      return `- ${checkpoint.targetName ?? checkpoint.targetId}: ${compact(checkpoint.summary, 800)}${commit}`;
    }).join("\n")}`);
  }
  sections.push([
    "执行约束：先读取最新议题和全部评论；遵守前置阻塞及绑定的 branch/worktree。",
    "改代码前 fetch，并仅做安全 fast-forward；工作区 dirty/diverged 时停止并说明。",
    "完成验证后自动 commit、push 当前议题分支；最终回复只写改动、验证、结果和剩余风险。",
    "若本评论还有其他等待或执行中的设备任务，只记录自己的结果，不提前把整个议题移到 in_review。",
  ].join("\n"));
  return sections.join("\n\n");
}

export class CodexMentionDispatcher {
  constructor({
    configStore,
    cloudProxy,
    aiChat,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    deviceName,
    recordAutomationMemory = async () => {},
    onError = (error) => console.error(`Codex mention dispatcher: ${error.message}`),
  }) {
    this.configStore = configStore;
    this.cloudProxy = cloudProxy;
    this.aiChat = aiChat;
    this.pollIntervalMs = pollIntervalMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.deviceName = deviceName;
    this.recordAutomationMemory = recordAutomationMemory;
    this.onError = onError;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.lastHeartbeatAt = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      let config = await this.configStore.read();
      if (!config.remoteUrl) return;
      const desiredName = this.deviceName ?? `Codex · ${config.actorName}`;
      if (!config.deviceTarget || config.deviceTarget.name !== desiredName) {
        config = await this.configStore.ensureDeviceTarget(desiredName);
      }
      if (Date.now() - this.lastHeartbeatAt >= this.heartbeatIntervalMs) {
        await this.#heartbeat(config);
        this.lastHeartbeatAt = Date.now();
      }
      const payload = await this.#cloudJson(
        `/api/codex-targets/${encodeURIComponent(config.deviceTarget.id)}/triggers/claim`,
        { method: "POST" },
      );
      if (payload.trigger) await this.#execute(config, payload.trigger);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.running = false;
    }
  }

  async #heartbeat(config) {
    await this.#cloudJson("/api/codex-targets/heartbeat", {
      method: "POST",
      body: {
        id: config.deviceTarget.id,
        name: config.deviceTarget.name,
        projectIds: Object.keys(config.projectMappings),
      },
    });
  }

  async #execute(config, trigger) {
    const mappedWorkspacePath = config.projectMappings[trigger.project.id];
    const workspacePath = trigger.task.developmentContext?.type === "worktree"
      && trigger.task.developmentContext.path
      ? trigger.task.developmentContext.path
      : mappedWorkspacePath;
    let thread = null;
    let run = null;
    let baseGit = null;
    try {
      if (!workspacePath) {
        throw new Error(`Project '${trigger.project.id}' is not mapped on this device`);
      }
      baseGit = await prepareGitWorkspace(workspacePath);
      const localThreads = this.aiChat.listThreads().filter((candidate) => (
        candidate.origin.issueId === trigger.task.id
        && candidate.status !== "running"
      ));
      thread = localThreads.find((candidate) => candidate.codexThreadId === trigger.task.threadId)
        ?? localThreads[0]
        ?? null;
      const createsNewConversation = !thread;
      if (!thread) {
        thread = await this.aiChat.createResolvedThread({
          project: trigger.project,
          issue: trigger.task,
          workspacePath,
          codexThreadId: null,
          title: trigger.task.identifier,
          sandbox: "workspace-write",
        });
      }
      const message = buildMentionAssignmentMessage(trigger);
      run = await this.aiChat.startTurn(thread.id, {
        message: createsNewConversation ? `\uFFFC${message}` : message,
        ...(createsNewConversation ? { skillIds: ["i-have-adhd:i-have-adhd"] } : {}),
      });
      const completed = await this.aiChat.waitForRun(run.id);
      const latestThread = this.aiChat.getThread(thread.id);
      if (completed.status !== "completed") {
        throw new Error(completed.error || "Codex did not complete the mentioned request");
      }
      const resultGit = await readGitState(workspacePath);
      if (resultGit?.dirty) {
        throw new Error("Codex finished with uncommitted changes; the assignment was not handed off");
      }
      if (
        baseGit
        && resultGit
        && resultGit.commit !== baseGit.commit
        && resultGit.ahead !== 0
      ) {
        throw new Error("The verified commit was not pushed to its upstream branch");
      }
      const events = this.#runEvents(thread.id);
      await this.#remember(trigger, {
        status: "completed",
        threadId: latestThread.codexThreadId ?? trigger.task.threadId ?? undefined,
        runId: run.id,
        events,
      });
      await this.#finish(trigger, {
        status: "completed",
        threadId: latestThread.codexThreadId ?? trigger.task.threadId ?? undefined,
        checkpoint: buildExecutionCheckpoint({
          status: "completed",
          runId: run.id,
          events,
          baseCommit: baseGit?.commit ?? trigger.context?.checkpoints?.[0]?.resultCommit ?? null,
          resultCommit: resultGit?.commit ?? null,
          branch: resultGit?.branch ?? trigger.task.developmentContext?.branch ?? null,
        }),
      });
    } catch (error) {
      const events = this.#runEvents(thread?.id);
      await this.#remember(trigger, {
        status: "failed",
        threadId: thread?.codexThreadId ?? trigger.task.threadId ?? undefined,
        runId: run?.id,
        events,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.#finish(trigger, {
        status: "failed",
        threadId: thread?.codexThreadId ?? trigger.task.threadId ?? undefined,
        error: error instanceof Error ? error.message : String(error),
        checkpoint: buildExecutionCheckpoint({
          status: "failed",
          runId: run?.id,
          events,
          error: error instanceof Error ? error.message : String(error),
          baseCommit: baseGit?.commit ?? trigger.context?.checkpoints?.[0]?.resultCommit ?? null,
          branch: baseGit?.branch ?? trigger.task.developmentContext?.branch ?? null,
        }),
      }).catch((finishError) => this.onError(
        finishError instanceof Error ? finishError : new Error(String(finishError)),
      ));
    }
  }

  #runEvents(threadId) {
    if (!threadId || typeof this.aiChat.getThreadSnapshot !== "function") return [];
    try {
      return this.aiChat.getThreadSnapshot(threadId)?.events ?? [];
    } catch {
      return [];
    }
  }

  async #remember(trigger, result) {
    try {
      await this.recordAutomationMemory({ trigger, ...result });
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #finish(trigger, result) {
    return this.#cloudJson(
      `/api/codex-triggers/${encodeURIComponent(trigger.comment.id)}/${encodeURIComponent(
        trigger.targetId ?? "",
      )}`,
      {
        method: "PATCH",
        body: {
          claimToken: trigger.claimToken,
          ...result,
        },
      },
    );
  }

  async #cloudJson(pathname, { method = "GET", body } = {}) {
    const request = new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return responseJson(await this.cloudProxy.forward(request));
  }
}
