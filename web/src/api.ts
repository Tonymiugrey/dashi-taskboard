import type {
  ActorIdentity,
  AiChatCatalog,
  AiChatAttachmentInput,
  AiChatRun,
  AiChatSandbox,
  AiChatThread,
  AiChatThreadSnapshot,
  Attachment,
  Comment,
  CodexTarget,
  CodexTargetAutomation,
  DevelopmentScan,
  IssueRelationType,
  Project,
  Task,
  TaskboardMetadata,
  TaskDraft,
  TaskStatus,
  WorkflowCapabilities,
  WorkflowWorkspaceRecord,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

let currentUserActor = DEFAULT_USER_ACTOR;
let hostBridgeSessionNonce: string | null = null;

interface PendingLocalCapabilityRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  cleanup?: () => void;
}

const pendingLocalCapabilityRequests = new Map<string, PendingLocalCapabilityRequest>();

function isBridgeSessionNonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

export function setHostBridgeSession(sessionNonce?: string) {
  const next = isBridgeSessionNonce(sessionNonce) ? sessionNonce : null;
  if (next === hostBridgeSessionNonce) return;
  hostBridgeSessionNonce = next;
  for (const pending of pendingLocalCapabilityRequests.values()) {
    window.clearTimeout(pending.timeoutId);
    pending.cleanup?.();
    pending.reject(new Error("Codex 本机桥会话已更新，请重试"));
  }
  pendingLocalCapabilityRequests.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
    const message = event.data as { type?: string; payload?: unknown };
    if (message.type !== "taskboard:local-capability-response" || !message.payload) return;
    const payload = message.payload as {
      requestId?: unknown;
      sessionNonce?: unknown;
      ok?: unknown;
      data?: unknown;
      error?: unknown;
    };
    if (
      typeof payload.requestId !== "string"
      || payload.sessionNonce !== hostBridgeSessionNonce
    ) return;
    const pending = pendingLocalCapabilityRequests.get(payload.requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pending.cleanup?.();
    pendingLocalCapabilityRequests.delete(payload.requestId);
    if (payload.ok === true) pending.resolve(payload.data);
    else pending.reject(new Error(
      typeof payload.error === "string" ? payload.error : "Codex 本机桥请求失败",
    ));
  });
}

function requestLocalCapability<T>(path: string, signal?: AbortSignal): Promise<T> | null {
  if (!hostBridgeSessionNonce || typeof window === "undefined" || window.parent === window) return null;
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const requestId = window.crypto.randomUUID();
  const sessionNonce = hostBridgeSessionNonce;
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      pendingLocalCapabilityRequests.get(requestId)?.cleanup?.();
      pendingLocalCapabilityRequests.delete(requestId);
      reject(new Error("Codex 本机桥没有响应"));
    }, 10_000);
    const abort = () => {
      window.clearTimeout(timeoutId);
      pendingLocalCapabilityRequests.delete(requestId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) signal.addEventListener("abort", abort, { once: true });
    pendingLocalCapabilityRequests.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
      timeoutId,
      ...(signal ? { cleanup: () => signal.removeEventListener("abort", abort) } : {}),
    });
    window.parent.postMessage({
      type: "taskboard:local-capability-request",
      payload: { requestId, sessionNonce, path },
    }, "*");
  });
}

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", currentUserActor.id);
    headers.set("X-Taskboard-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) {
      headers.set("X-Taskboard-User-Avatar", currentUserActor.avatarUrl);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "无法连接 Taskboard 服务，请检查网络或重新打开任务面板。",
      },
    });
  }
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", { signal });
  return data.projects;
}

export async function getTaskboardMetadata(signal?: AbortSignal): Promise<TaskboardMetadata> {
  const cloudMetadata = await request<TaskboardMetadata>("/api/meta", { signal });
  const localRequest = requestLocalCapability<TaskboardMetadata>("/api/meta", signal);
  if (!localRequest) return cloudMetadata;
  const localMetadata = await localRequest;
  return {
    ...cloudMetadata,
    manageTaskboardSkillPath: localMetadata.manageTaskboardSkillPath,
    iHaveAdhdSkill: localMetadata.iHaveAdhdSkill,
    localCapabilities: { available: true },
  };
}

export async function getTaskboardRevision(
  since: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; revision: number }> {
  const query = new URLSearchParams({ since: String(since) });
  return request<{ changed: boolean; revision: number }>(`/api/revisions?${query}`, { signal });
}

export async function getAiChatCatalog(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiChatCatalog> {
  return request<AiChatCatalog>(
    `/api/local/ai/catalog?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
}

export async function listAiChatThreads(signal?: AbortSignal): Promise<AiChatThread[]> {
  const data = await request<{ threads: AiChatThread[] }>("/api/local/ai/threads", { signal });
  return data.threads;
}

export async function createAiChatThread(input: {
  projectId: string;
  issueId?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: AiChatSandbox;
}): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>("/api/local/ai/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.thread;
}

export async function getAiChatThread(
  threadId: string,
  signal?: AbortSignal,
): Promise<AiChatThreadSnapshot> {
  return request<AiChatThreadSnapshot>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { signal },
  );
}

export async function updateAiChatThread(
  threadId: string,
  input: {
    title?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  },
): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return data.thread;
}

export async function deleteAiChatThread(threadId: string): Promise<void> {
  await request<void>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
  );
}

export async function startAiChatTurn(
  threadId: string,
  input: {
    message: string;
    skillIds?: string[];
    attachments?: AiChatAttachmentInput[];
    dangerFullAccessConfirmed?: boolean;
  },
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.run;
}

export async function interruptAiChatRun(runId: string): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/runs/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" },
  );
  return data.run;
}

export function subscribeAiChatThread(
  threadId: string,
  onHint: (type: "ai.event" | "ai.run") => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/local/ai/threads/${encodeURIComponent(threadId)}/events`);
  source.addEventListener("ai.event", () => onHint("ai.event"));
  source.addEventListener("ai.run", () => onHint("ai.run"));
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}

export async function listDeviceWorkspaces(signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const localRequest = requestLocalCapability<{ workspaces: Record<string, string> }>(
      "/api/device-workspaces",
      signal,
    );
    const data = localRequest
      ? await localRequest
      : await request<{ workspaces: Record<string, string> }>("/api/device-workspaces", { signal });
    return data.workspaces;
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCAL_COMPANION_REQUIRED") return {};
    throw error;
  }
}

export async function listWorkflowCapabilities(
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<WorkflowCapabilities> {
  const query = new URLSearchParams();
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  const path = `/api/workflow-capabilities${suffix}`;
  return requestLocalCapability<WorkflowCapabilities>(path, signal)
    ?? request<WorkflowCapabilities>(path, { signal });
}

export async function getWorkflowWorkspace<T>(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    { signal },
  );
  return data.workflow;
}

export async function saveWorkflowWorkspace<T>(
  projectId: string,
  workspace: T,
  version: number,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    {
      method: "PUT",
      body: JSON.stringify({ version, workspace }),
    },
  );
  return data.workflow;
}

export async function createProject(input: {
  id: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function listDevelopmentContexts(
  projectId: string,
  codexProjectId?: string,
  codexThreadId?: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const query = new URLSearchParams();
  if (codexProjectId) query.set("codexProjectId", codexProjectId);
  if (codexThreadId) query.set("codexThreadId", codexThreadId);
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  const path = `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`;
  return requestLocalCapability<DevelopmentScan>(path, signal)
    ?? request<DevelopmentScan>(path, { signal });
}

type TaskDraftPayload = Omit<TaskDraft, "developmentContext"> & {
  developmentContext: TaskDraft["developmentContext"] | {
    type: "worktree";
    branch: string | null;
  };
};

function taskDraftPayload(draft: TaskDraft): TaskDraftPayload {
  if (draft.developmentContext?.type !== "worktree" || draft.developmentContext.path) return draft;
  return {
    ...draft,
    developmentContext: {
      type: "worktree",
      branch: draft.developmentContext.branch,
    },
  };
}

function retainWorktreePath(task: Task, source?: Task | TaskDraft): Task {
  if (
    task.developmentContext?.type !== "worktree"
    || task.developmentContext.path
    || source?.developmentContext?.type !== "worktree"
    || !source.developmentContext.path
  ) return task;
  return {
    ...task,
    developmentContext: {
      ...task.developmentContext,
      path: source.developmentContext.path,
    },
  };
}

async function localizeWorktreeTasks(
  projectId: string,
  tasks: Task[],
  signal?: AbortSignal,
): Promise<Task[]> {
  if (!tasks.some((task) => task.developmentContext?.type === "worktree")) return tasks;
  const localRequest = requestLocalCapability<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts`,
    signal,
  );
  if (!localRequest) return tasks;
  try {
    const scan = await localRequest;
    return tasks.map((task) => {
      if (task.developmentContext?.type !== "worktree" || task.developmentContext.path) return task;
      const local = scan.contexts.find((context) => (
        context.type === "worktree" && context.branch === task.developmentContext?.branch
      ));
      return local ? { ...task, developmentContext: local } : task;
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return tasks;
  }
}

export async function listTasks(projectId: string, signal?: AbortSignal): Promise<Task[]> {
  const params = new URLSearchParams({ projectId, archived: "false" });
  const data = await request<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal });
  return localizeWorktreeTasks(projectId, data.tasks, signal);
}

export async function createTask(projectId: string, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectId, ...taskDraftPayload(draft), ...(threadId ? { threadId } : {}) }),
  });
  return retainWorktreePath(data.task, draft);
}

export async function updateTask(task: Task, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, ...taskDraftPayload(draft), ...(threadId ? { threadId } : {}) }),
  });
  return retainWorktreePath(data.task, draft);
}

export async function moveTask(
  task: Task,
  status: TaskStatus,
  sortOrder: number,
  threadId?: string,
): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, status, sortOrder, ...(threadId ? { threadId } : {}) }),
    },
  );
  return retainWorktreePath(data.task, task);
}

export async function archiveTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return retainWorktreePath(data.task, task);
}

export async function restoreTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return retainWorktreePath(data.task, task);
}

export async function addTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function removeTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function listComments(taskId: string, signal?: AbortSignal): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    { signal },
  );
  return data.comments;
}

export async function listCodexTargets(
  projectId: string,
  signal?: AbortSignal,
): Promise<CodexTarget[]> {
  const query = new URLSearchParams({ projectId });
  const data = await request<{ targets: CodexTarget[] }>(`/api/codex-targets?${query}`, { signal });
  return data.targets;
}

export async function updateCodexTargetAutomation(
  targetId: string,
  projectId: string,
  automation: Pick<
    CodexTargetAutomation,
    "enabledByUser" | "quotaAware" | "intervalMinutes" | "model" | "reasoningEffort" | "version"
  >,
): Promise<CodexTargetAutomation> {
  const data = await request<{ automation: CodexTargetAutomation }>(
    `/api/codex-targets/${encodeURIComponent(targetId)}/automations`,
    {
      method: "PATCH",
      body: JSON.stringify({
        projectId,
        version: automation.version,
        enabledByUser: automation.enabledByUser,
        quotaAware: automation.quotaAware,
        intervalMinutes: automation.intervalMinutes,
        model: automation.model,
        reasoningEffort: automation.reasoningEffort,
      }),
    },
  );
  return data.automation;
}

export async function createComment(
  taskId: string,
  body: string,
  threadId?: string,
  mentions: Array<{ targetId: string; instruction: string }> = [],
): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({
        body,
        ...(threadId ? { threadId } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
      }),
    },
  );
  return data.comment;
}

export async function updateComment(comment: Comment, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/comments/${encodeURIComponent(comment.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version: comment.version, body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function deleteComment(comment: Comment, threadId?: string): Promise<void> {
  await request(`/api/comments/${encodeURIComponent(comment.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: comment.version, ...(threadId ? { threadId } : {}) }),
  });
}

export async function listAttachments(taskId: string, signal?: AbortSignal): Promise<Attachment[]> {
  const data = await request<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    { signal },
  );
  return data.attachments;
}

export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function uploadCommentAttachment(commentId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/comments/${encodeURIComponent(commentId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function deleteAttachment(attachment: Attachment): Promise<void> {
  await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    method: "DELETE",
  });
}

export function attachmentContentUrl(attachment: Attachment): string {
  return `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
}
