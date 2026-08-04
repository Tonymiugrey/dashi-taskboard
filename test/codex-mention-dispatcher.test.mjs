import assert from "node:assert/strict";
import { test } from "node:test";

import { CodexMentionDispatcher } from "../server/codex-mention-dispatcher.mjs";

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("a targeted comment is sent verbatim to the issue's existing Codex conversation", async () => {
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
      body: "把正文直接发到评论区，不要重新生成 summary。",
      mentions: [{ targetId: "codex-device-1", status: "claimed" }],
    },
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
      return [];
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

  assert.equal(aiCalls.filter((call) => call.type === "create").length, 1);
  assert.equal(aiCalls[0].input.codexThreadId, "existing-codex-thread");
  assert.equal(aiCalls[1].input.message, trigger.comment.body);
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
      message: `\uFFFC${trigger.comment.body}`,
      skillIds: ["i-have-adhd:i-have-adhd"],
    },
  }]);
});
