import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createMentionAutomationMemoryRecorder } from "../server/automation-memory.mjs";

function trigger() {
  return {
    targetId: "codex-device-1",
    project: { id: "project-1", name: "Project One" },
    task: { id: "task-1", identifier: "PROJECT1-7", title: "Refine the result" },
    comment: {
      id: "comment-1",
      mentions: [{ targetId: "codex-device-1", status: "claimed" }],
    },
  };
}

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-memory-"));
  const policiesPath = path.join(directory, "codex-automation-policies.json");
  const automationsDirectory = path.join(directory, "automations");
  const automationDirectory = path.join(automationsDirectory, "automation-1");
  const memoryPath = path.join(automationDirectory, "memory.md");
  await mkdir(automationDirectory, { recursive: true });
  await writeFile(policiesPath, JSON.stringify({
    "project-1": { automationId: "automation-1" },
  }));
  await writeFile(memoryPath, "# Existing automation memory\n");
  const record = createMentionAutomationMemoryRecorder({
    policiesPath,
    automationsDirectory,
    now: () => new Date("2026-08-05T04:30:00.000Z"),
  });
  return {
    directory,
    memoryPath,
    record,
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("completed @Codex runs append a concise, deduplicated automation memory entry", async () => {
  const fixture = await createFixture();
  try {
    const input = {
      trigger: trigger(),
      status: "completed",
      threadId: "codex-thread-1",
      runId: "run-1",
      events: [
        {
          runId: "older-run",
          type: "agent_message",
          role: "assistant",
          content: "Old result",
          data: { status: "completed" },
        },
        {
          runId: "run-1",
          type: "file_change",
          role: "activity",
          content: "src/app.mjs",
          data: { status: "completed", files: ["src/app.mjs"] },
        },
        {
          runId: "run-1",
          type: "agent_message",
          role: "assistant",
          content: "Updated the requested workflow.\nTests passed.",
          data: { status: "completed" },
        },
      ],
    };

    assert.equal((await fixture.record(input)).updated, true);
    assert.deepEqual(await fixture.record(input), {
      updated: false,
      reason: "already-recorded",
    });

    const memory = await readFile(fixture.memoryPath, "utf8");
    assert.match(memory, /## 2026-08-05 12:30:00 CST · @Codex/);
    assert.match(memory, /PROJECT1-7「Refine the result」/);
    assert.match(memory, /Codex 对话：codex-thread-1/);
    assert.match(memory, /变更文件：src\/app\.mjs/);
    assert.match(memory, /执行摘要：Updated the requested workflow\. Tests passed\./);
    assert.equal(memory.match(/dashi-taskboard-codex-mention:comment-1:codex-device-1/g)?.length, 1);
  } finally {
    await fixture.close();
  }
});

test("failed @Codex runs record the error without copying the triggering comment", async () => {
  const fixture = await createFixture();
  try {
    await fixture.record({
      trigger: {
        ...trigger(),
        comment: {
          ...trigger().comment,
          body: "private comment body that should not be copied",
        },
      },
      status: "failed",
      threadId: "codex-thread-1",
      runId: "run-2",
      events: [],
      error: "Codex exited with code 7",
    });
    const memory = await readFile(fixture.memoryPath, "utf8");
    assert.match(memory, /执行状态：failed/);
    assert.match(memory, /执行摘要：Codex exited with code 7/);
    assert.doesNotMatch(memory, /private comment body/);
  } finally {
    await fixture.close();
  }
});

test("projects without an automation memory are left untouched", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.record({
      trigger: { ...trigger(), project: { id: "project-2", name: "Project Two" } },
      status: "completed",
      runId: "run-1",
      events: [],
    });
    assert.deepEqual(result, { updated: false, reason: "automation-not-configured" });
    assert.equal(await readFile(fixture.memoryPath, "utf8"), "# Existing automation memory\n");
  } finally {
    await fixture.close();
  }
});
