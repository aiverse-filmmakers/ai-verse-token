import type { UsageEvent, UsageScope } from "../protocol/index.js";
import { validateUsageEvent } from "../protocol/index.js";
import { mergeExact } from "../ecosystem-common.js";

export interface TokenCorrelationMetadata {
  readonly workspace_id?: string;
  readonly project_id?: string;
  readonly agent_id?: string;
  readonly skill_id?: string;
  readonly automation_id?: string;
  readonly tool_id?: string;
  readonly task_id?: string;
  readonly run_id?: string;
}

function assign(scope: UsageScope, key: keyof UsageScope, value: string | null | undefined): UsageScope {
  return value === undefined ? scope : { ...scope, [key]: value };
}

export function correlateTokenUsage(event: UsageEvent, metadata: TokenCorrelationMetadata): UsageEvent {
  let scope: UsageScope = { ...(event.scope ?? {}) };
  scope = assign(scope, "workspace_id", mergeExact(scope.workspace_id, metadata.workspace_id, "workspace_id"));
  scope = assign(scope, "project_id", mergeExact(scope.project_id, metadata.project_id, "project_id"));
  scope = assign(scope, "agent_id", mergeExact(scope.agent_id, metadata.agent_id, "agent_id"));
  scope = assign(scope, "skill_id", mergeExact(scope.skill_id, metadata.skill_id, "skill_id"));
  scope = assign(scope, "automation_id", mergeExact(scope.automation_id, metadata.automation_id, "automation_id"));
  scope = assign(scope, "tool_id", mergeExact(scope.tool_id, metadata.tool_id, "tool_id"));
  const runId = mergeExact(event.run_id, metadata.run_id, "run_id");
  const taskId = mergeExact(event.task_id, metadata.task_id, "task_id");
  const candidate: UsageEvent = {
    ...event,
    ...(runId === undefined ? {} : { run_id: runId }),
    ...(taskId === undefined ? {} : { task_id: taskId }),
    scope
  };
  return validateUsageEvent(candidate);
}
