import type { UsageEvent, UsageScope } from "../protocol/index.js";
import { validateUsageEvent } from "../protocol/index.js";
import { mergeExact } from "../ecosystem-common.js";

export interface MultipleBotsTokenAttribution {
  readonly bot_id?: string;
  readonly worker_id?: string;
  readonly team_run_id?: string;
  readonly task_id?: string;
  readonly workspace_id?: string;
  readonly project_id?: string;
  readonly system_id?: string;
  readonly agent_id?: string;
  readonly skill_id?: string;
}

function assign(scope: UsageScope, key: keyof UsageScope, value: string | null | undefined): UsageScope {
  return value === undefined ? scope : { ...scope, [key]: value };
}

export function attributeMultipleBotsUsage(event: UsageEvent, attribution: MultipleBotsTokenAttribution): UsageEvent {
  let scope: UsageScope = { ...(event.scope ?? {}) };
  scope = assign(scope, "bot_id", mergeExact(scope.bot_id, attribution.bot_id, "bot_id"));
  scope = assign(scope, "worker_id", mergeExact(scope.worker_id, attribution.worker_id, "worker_id"));
  scope = assign(scope, "workspace_id", mergeExact(scope.workspace_id, attribution.workspace_id, "workspace_id"));
  scope = assign(scope, "project_id", mergeExact(scope.project_id, attribution.project_id, "project_id"));
  scope = assign(scope, "system_id", mergeExact(scope.system_id, attribution.system_id, "system_id"));
  scope = assign(scope, "agent_id", mergeExact(scope.agent_id, attribution.agent_id, "agent_id"));
  scope = assign(scope, "skill_id", mergeExact(scope.skill_id, attribution.skill_id, "skill_id"));
  const runId = mergeExact(event.run_id, attribution.team_run_id, "team_run_id");
  const taskId = mergeExact(event.task_id, attribution.task_id, "task_id");
  const candidate: UsageEvent = {
    ...event,
    ...(runId === undefined ? {} : { run_id: runId }),
    ...(taskId === undefined ? {} : { task_id: taskId }),
    scope
  };
  return validateUsageEvent(candidate);
}
