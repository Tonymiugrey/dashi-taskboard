import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_VERSION = 1;

class CloudConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CloudConfigError";
    this.code = code;
  }
}

function emptyConfig() {
  return {
    version: CONFIG_VERSION,
    remoteUrl: null,
    actorName: null,
    sharedKey: null,
    projectMappings: {},
  };
}

export function normalizeCloudUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CloudConfigError("INVALID_CLOUD_URL", "Cloud taskboard URL must be a valid URL");
  }
  const isLoopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback))
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) {
    throw new CloudConfigError(
      "INVALID_CLOUD_URL",
      "Cloud taskboard URL must be an HTTPS origin (loopback HTTP is allowed for development)",
    );
  }
  return url.origin;
}

function validateCredentials(actorName, sharedKey) {
  if (
    typeof actorName !== "string"
    || !actorName.trim()
    || actorName.length > 120
    || actorName.includes(":")
  ) {
    throw new CloudConfigError(
      "INVALID_CLOUD_ACTOR",
      "Cloud actor name must be 1 to 120 characters and cannot contain ':'",
    );
  }
  if (typeof sharedKey !== "string" || !sharedKey || sharedKey.length > 4096) {
    throw new CloudConfigError(
      "INVALID_CLOUD_KEY",
      "Cloud shared key must be 1 to 4096 characters",
    );
  }
  return { actorName: actorName.trim(), sharedKey };
}

function validateProjectMappings(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudConfigError("INVALID_CLOUD_CONFIG", "Cloud project mappings are invalid");
  }
  const projectMappings = {};
  for (const [projectId, workspacePath] of Object.entries(value)) {
    if (!projectId || typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
      throw new CloudConfigError("INVALID_CLOUD_CONFIG", "Cloud project mappings are invalid");
    }
    projectMappings[projectId] = workspacePath;
  }
  return projectMappings;
}

function parseConfig(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== CONFIG_VERSION
  ) {
    throw new CloudConfigError("INVALID_CLOUD_CONFIG", "Cloud companion configuration is invalid");
  }
  const allowedKeys = new Set([
    "version",
    "remoteUrl",
    "actorName",
    "sharedKey",
    "projectMappings",
    "deviceTarget",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new CloudConfigError("INVALID_CLOUD_CONFIG", "Cloud companion configuration is invalid");
  }
  const projectMappings = validateProjectMappings(value.projectMappings);
  let deviceTarget = null;
  if (value.deviceTarget !== undefined && value.deviceTarget !== null) {
    if (
      typeof value.deviceTarget !== "object"
      || Array.isArray(value.deviceTarget)
      || !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(value.deviceTarget.id ?? "")
      || typeof value.deviceTarget.name !== "string"
      || !value.deviceTarget.name.trim()
      || value.deviceTarget.name.length > 120
      || Object.keys(value.deviceTarget).some((key) => key !== "id" && key !== "name")
    ) {
      throw new CloudConfigError("INVALID_CLOUD_CONFIG", "Cloud device target is invalid");
    }
    deviceTarget = { id: value.deviceTarget.id, name: value.deviceTarget.name.trim() };
  }
  if (value.remoteUrl === null && value.actorName === null && value.sharedKey === null) {
    return {
      ...emptyConfig(),
      projectMappings,
      ...(deviceTarget ? { deviceTarget } : {}),
    };
  }
  const credentials = validateCredentials(value.actorName, value.sharedKey);
  return {
    version: CONFIG_VERSION,
    remoteUrl: normalizeCloudUrl(value.remoteUrl),
    ...credentials,
    projectMappings,
    ...(deviceTarget ? { deviceTarget } : {}),
  };
}

export function createCloudConfigStore({ configPath }) {
  if (!configPath) throw new Error("configPath is required");
  let pendingWrite = Promise.resolve();

  async function readFromDisk() {
    try {
      return parseConfig(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return emptyConfig();
      throw error;
    }
  }

  async function writeAtomically(config) {
    await mkdir(path.dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, configPath);
  }

  function update(mutator) {
    const operation = pendingWrite.then(async () => {
      const next = mutator(await readFromDisk());
      await writeAtomically(next);
      return next;
    });
    pendingWrite = operation.catch(() => {});
    return operation;
  }

  return {
    async read() {
      await pendingWrite;
      return readFromDisk();
    },
    async configure({ remoteUrl, actorName, sharedKey }) {
      const normalizedUrl = normalizeCloudUrl(remoteUrl);
      const credentials = validateCredentials(actorName, sharedKey);
      return update((config) => ({
        ...config,
        remoteUrl: normalizedUrl,
        ...credentials,
      }));
    },
    clearCloud() {
      return update((config) => ({
        ...config,
        remoteUrl: null,
        actorName: null,
        sharedKey: null,
      }));
    },
    setProjectWorkspace(projectId, workspacePath) {
      if (typeof projectId !== "string" || !projectId.trim()) {
        throw new CloudConfigError("INVALID_PROJECT_MAPPING", "projectId is required");
      }
      if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) {
        throw new CloudConfigError(
          "INVALID_PROJECT_MAPPING",
          "workspacePath must be absolute",
        );
      }
      return update((config) => ({
        ...config,
        projectMappings: {
          ...config.projectMappings,
          [projectId]: workspacePath,
        },
      }));
    },
    ensureDeviceTarget(name) {
      if (typeof name !== "string" || !name.trim() || name.length > 120) {
        throw new CloudConfigError("INVALID_DEVICE_TARGET", "Device target name is invalid");
      }
      return update((config) => ({
        ...config,
        deviceTarget: {
          id: config.deviceTarget?.id ?? `codex-${randomUUID()}`,
          name: name.trim(),
        },
      }));
    },
  };
}
