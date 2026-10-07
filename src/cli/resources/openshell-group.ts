/**
 * Agent-group resolution for the per-group OpenShell commands
 * (`ncl openshell-provider-*`, `ncl openshell-network-*`) and the setup UI.
 * A group is named the way an operator knows it — id, folder, or display name —
 * never by a sandbox name: a group can have several live sandboxes, and its
 * providers / rules apply to every sandbox it gets.
 */
import { getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../../db/agent-groups.js';
import type { AgentGroup } from '../../types.js';

export async function resolveAgentGroup(ref: unknown): Promise<AgentGroup> {
  const r = typeof ref === 'string' ? ref.trim() : '';
  if (!r) throw new Error('--group is required (agent group id, folder or name)');
  const byId = await getAgentGroup(r);
  if (byId) return byId;
  const byFolder = await getAgentGroupByFolder(r);
  if (byFolder) return byFolder;
  const byName = (await getAllAgentGroups()).filter((g) => g.name === r);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `more than one agent group is named '${r}' (folders: ${byName.map((g) => g.folder).join(', ')}); give the folder`,
    );
  }
  throw new Error(`agent group not found: ${r}`);
}
