const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

async function responseJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
    error.code = body?.error?.code;
    throw error;
  }
  return body;
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
    const workspacePath = config.projectMappings[trigger.project.id];
    const createsNewConversation = !trigger.task.threadId;
    let thread = null;
    let run = null;
    try {
      if (!workspacePath) {
        throw new Error(`Project '${trigger.project.id}' is not mapped on this device`);
      }
      thread = trigger.task.threadId
        ? this.aiChat.listThreads().find((candidate) => (
            candidate.codexThreadId === trigger.task.threadId
            && candidate.origin.issueId === trigger.task.id
            && candidate.status !== "running"
          )) ?? null
        : null;
      if (!thread) {
        thread = await this.aiChat.createResolvedThread({
          project: trigger.project,
          issue: trigger.task,
          workspacePath,
          codexThreadId: trigger.task.threadId ?? null,
          title: trigger.task.identifier,
          sandbox: "workspace-write",
        });
      }
      run = await this.aiChat.startTurn(thread.id, {
        message: createsNewConversation ? `\uFFFC${trigger.comment.body}` : trigger.comment.body,
        ...(createsNewConversation ? { skillIds: ["i-have-adhd:i-have-adhd"] } : {}),
      });
      const completed = await this.aiChat.waitForRun(run.id);
      const latestThread = this.aiChat.getThread(thread.id);
      if (completed.status !== "completed") {
        throw new Error(completed.error || "Codex did not complete the mentioned request");
      }
      await this.#remember(trigger, {
        status: "completed",
        threadId: latestThread.codexThreadId ?? trigger.task.threadId ?? undefined,
        runId: run.id,
        events: this.#runEvents(thread.id),
      });
      await this.#finish(trigger, {
        status: "completed",
        threadId: latestThread.codexThreadId ?? trigger.task.threadId ?? undefined,
      });
    } catch (error) {
      await this.#remember(trigger, {
        status: "failed",
        threadId: thread?.codexThreadId ?? trigger.task.threadId ?? undefined,
        runId: run?.id,
        events: this.#runEvents(thread?.id),
        error: error instanceof Error ? error.message : String(error),
      });
      await this.#finish(trigger, {
        status: "failed",
        threadId: thread?.codexThreadId ?? trigger.task.threadId ?? undefined,
        error: error instanceof Error ? error.message : String(error),
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
        trigger.comment.mentions.find((mention) => mention.status === "claimed")?.targetId
          ?? trigger.targetId
          ?? "",
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
