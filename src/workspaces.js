import fs from 'node:fs';
import path from 'node:path';

export function workspaceLabel(workspace) {
  return path.basename(workspace) || workspace;
}

export function listWorkspaces(config) {
  return config.allowedWorkspaces.map((workspace) => ({
    path: workspace,
    label: workspaceLabel(workspace),
  }));
}

export function resolveAllowedWorkspace(input, config) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const byLabel = config.allowedWorkspaces.find((workspace) => workspaceLabel(workspace) === trimmed);
  if (byLabel) return byLabel;

  const byPath = config.allowedWorkspaces.find((workspace) => workspace === trimmed);
  if (byPath) return byPath;

  let realInput;
  try {
    realInput = fs.realpathSync(path.resolve(trimmed));
  } catch {
    return null;
  }

  return config.allowedWorkspaces.find((workspace) => workspace === realInput) || null;
}
