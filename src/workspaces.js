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

function isInsideWorkspace(candidate, workspace) {
  const relative = path.relative(workspace, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function existingRealDirectory(input) {
  try {
    const realInput = fs.realpathSync(path.resolve(input));
    return fs.statSync(realInput).isDirectory() ? realInput : null;
  } catch {
    return null;
  }
}

function resolveLabelPath(input, config) {
  const [label, ...rest] = input.split(/[\\/]+/).filter(Boolean);
  if (!label) return null;

  const root = config.allowedWorkspaces.find((workspace) => workspaceLabel(workspace) === label);
  if (!root) return null;

  return existingRealDirectory(path.join(root, ...rest));
}

export function resolveAllowedWorkspace(input, config, currentCwd = config.defaultCwd) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const byLabelPath = resolveLabelPath(trimmed, config);
  if (byLabelPath && config.allowedWorkspaces.some((workspace) => isInsideWorkspace(byLabelPath, workspace))) {
    return byLabelPath;
  }

  const rawCandidate = path.isAbsolute(trimmed) ? trimmed : path.resolve(currentCwd, trimmed);
  const realCandidate = existingRealDirectory(rawCandidate);
  if (!realCandidate) return null;

  if (config.allowedWorkspaces.some((workspace) => isInsideWorkspace(realCandidate, workspace))) {
    return realCandidate;
  }

  return null;
}
