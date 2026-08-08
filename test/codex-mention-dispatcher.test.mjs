import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexMentionDispatcher } from "../server/codex-mention-dispatcher.mjs";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a device assignment reuses only a matching local issue conversation", async () => {
  const trigger = {
    targetId: "codex-device-1",
    claimToken: "claim-1",
    project: { id: "project-1", name: "Project One" },
    task: {
      id: "task-1",
      identifier: "PROJECT1-7",
      threadId: "existing-codex-thread",
    },
    comment: {
      id: "comment-1",
      body: "共享背景。",
      mentions: [{ targetId: "codex-device-1", status: "claimed", instruction: "修改 API。" }],
    },
    assignment: { targetId: "codex-device-1", instruction: "修改 API。" },
    context: { checkpoints: [] },
  };
  const calls = [];
  let claimed = false;
  const cloudProxy = {
    async forward(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" || request.method === "PATCH"
        ? await request.json().catch(() => undefined)
        : undefined;
      calls.push({ pathname: url.pathname, method: request.method, body });
      if (url.pathname === "/api/codex-targets/heartbeat") {
        return json({ target: { id: "codex-device-1" } });
      }
      if (url.pathname.endsWith("/triggers/claim")) {
        if (claimed) return json({ trigger: null });
        claimed = true;
        return json({ trigger });
      }
      if (url.pathname.startsWith("/api/codex-triggers/")) {
        return json({ comment: trigger.comment });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    },
  };
  const aiCalls = [];
  const memoryCalls = [];
  const aiChat = {
    listThreads() {
      return [{
        id: "bridge-thread",
        codexThreadId: "existing-codex-thread",
        origin: { issueId: "task-1" },
        status: "idle",
      }];
    },
    async createResolvedThread(input) {
      aiCalls.push({ type: "create", input });
      return { id: "bridge-thread", codexThreadId: input.codexThreadId };
    },
    async startTurn(threadId, input) {
      aiCalls.push({ type: "turn", threadId, input });
      return { id: "run-1" };
    },
    async waitForRun() {
      return { status: "completed" };
    },
    getThread() {
      return { codexThreadId: "existing-codex-thread" };
    },
    getThreadSnapshot() {
      return {
        events: [{
          runId: "run-1",
          type: "agent_message",
          role: "assistant",
          content: "Finished",
          data: { status: "completed" },
        }],
      };
    },
  };
  const configStore = {
    async read() {
      return {
        remoteUrl: "https://taskboard.example.test",
        actorName: "Mac mini",
        deviceTarget: { id: "codex-device-1", name: "Codex · Mac mini" },
        projectMappings: { "project-1": "/workspace/project-one" },
      };
    },
  };
  const dispatcher = new CodexMentionDispatcher({
    configStore,
    cloudProxy,
    aiChat,
    recordAutomationMemory: async (input) => memoryCalls.push(input),
    heartbeatIntervalMs: 60_000,
  });
  dispatcher.stopped = false;
  await dispatcher.tick();
  await dispatcher.tick();
  dispatcher.stop();

  assert.equal(aiCalls.filter((call) => call.type === "create").length, 0);
  assert.match(aiCalls[0].input.message, /共享背景：\n共享背景。/);
  assert.match(aiCalls[0].input.message, /你的设备任务：\n修改 API。/);
  assert.deepEqual(memoryCalls, [{
    trigger,
    status: "completed",
    threadId: "existing-codex-thread",
    runId: "run-1",
    events: [{
      runId: "run-1",
      type: "agent_message",
      role: "assistant",
      content: "Finished",
      data: { status: "completed" },
    }],
  }]);
  assert.deepEqual(calls.at(-1), {
    pathname: "/api/codex-targets/codex-device-1/triggers/claim",
    method: "POST",
    body: undefined,
  });
  const completion = calls.find((call) => call.pathname.startsWith("/api/codex-triggers/"));
  assert.deepEqual(completion, {
    pathname: "/api/codex-triggers/comment-1/codex-device-1",
    method: "PATCH",
    body: {
      claimToken: "claim-1",
      status: "completed",
      threadId: "existing-codex-thread",
      checkpoint: {
        summary: "Finished",
        changedFiles: [],
        baseCommit: null,
        resultCommit: null,
        branch: null,
      },
    },
  });
});

test("a targeted comment starts a missing conversation with the ADHD skill", async () => {
  const trigger = {
    targetId: "codex-device-1",
    claimToken: "claim-2",
    project: { id: "project-1", name: "Project One" },
    task: { id: "task-2", identifier: "PROJECT1-8", threadId: null },
    comment: {
      id: "comment-2",
      body: "继续处理这个返工。",
      mentions: [{ targetId: "codex-device-1", status: "claimed" }],
    },
    assignment: { targetId: "codex-device-1", instruction: "只处理设备专属返工。" },
    context: { checkpoints: [] },
  };
  let claimed = false;
  const turns = [];
  const dispatcher = new CodexMentionDispatcher({
    configStore: {
      async read() {
        return {
          remoteUrl: "https://taskboard.example.test",
          actorName: "Mac mini",
          deviceTarget: { id: "codex-device-1", name: "Codex · Mac mini" },
          projectMappings: { "project-1": "/workspace/project-one" },
        };
      },
    },
    cloudProxy: {
      async forward(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/codex-targets/heartbeat") return json({});
        if (pathname.endsWith("/triggers/claim")) {
          if (claimed) return json({ trigger: null });
          claimed = true;
          return json({ trigger });
        }
        if (pathname.startsWith("/api/codex-triggers/")) return json({});
        throw new Error(`Unexpected path ${pathname}`);
      },
    },
    aiChat: {
      listThreads: () => [],
      async createResolvedThread(input) {
        assert.equal(input.codexThreadId, null);
        return { id: "bridge-thread-2", codexThreadId: null };
      },
      async startTurn(threadId, input) {
        turns.push({ threadId, input });
        return { id: "run-2" };
      },
      async waitForRun() { return { status: "completed" }; },
      getThread() { return { codexThreadId: "new-codex-thread" }; },
      getThreadSnapshot() { return { events: [] }; },
    },
    heartbeatIntervalMs: 60_000,
  });
  dispatcher.stopped = false;
  await dispatcher.tick();
  dispatcher.stop();

  assert.deepEqual(turns, [{
    threadId: "bridge-thread-2",
    input: {
        message: `\uFFFC共享背景：
继续处理这个返工。

你的设备任务：
只处理设备专属返工。

执行约束：先读取最新议题和全部评论；遵守前置阻塞及绑定的 branch/worktree。
改代码前 fetch，并仅做安全 fast-forward；工作区 dirty/diverged 时停止并说明。
完成验证后自动 commit、push 当前议题分支；最终回复只写改动、验证、结果和剩余风险。
若本评论还有其他等待或执行中的设备任务，只记录自己的结果，不提前把整个议题移到 in_review。`,
      skillIds: ["i-have-adhd:i-have-adhd"],
    },
  }]);
});
