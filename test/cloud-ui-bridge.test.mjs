import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");

test("cloud metadata borrows Skill paths from the bridge without exposing local AI", () => {
  assert.match(
    apiSource,
    /const localMetadata = await localRequest;[\s\S]*?manageTaskboardSkillPath: localMetadata\.manageTaskboardSkillPath,[\s\S]*?iHaveAdhdSkill: localMetadata\.iHaveAdhdSkill,[\s\S]*?localCapabilities: \{ available: true \}/,
  );
  assert.doesNotMatch(
    apiSource,
    /const localMetadata = await localRequest;[\s\S]*?capabilities: localMetadata\.capabilities/,
  );
});

test("cloud worktrees are localized through the bridge and unmapped paths render safely", () => {
  assert.match(apiSource, /async function localizeWorktreeTasks/);
  assert.match(apiSource, /context\.branch === task\.developmentContext\?\.branch/);
  assert.match(apiSource, /return localizeWorktreeTasks\(projectId, data\.tasks, signal\)/);
  assert.match(apiSource, /function retainWorktreePath/);
  assert.match(editorSource, /context\.path\?\.split/);
  assert.match(detailSource, /context\.path\?\.split/);
});
