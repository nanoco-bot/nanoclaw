/**
 * `ncl openshell-provider-profile-*` — custom OpenShell provider profile hints,
 * install-wide (openshell_provider_profiles). Verbs: create / list / delete.
 *
 * A template for `openshell provider create` (type + credential env-var names
 * + config keys), shown in the setup UI next to OpenShell's shipped profiles.
 * Hints only: the OpenShell gateway decides whether a type exists (v0.1.2
 * needs it imported: `openshell provider profile import -f <profile.yaml>`).
 * No credential values, ever.
 */
import {
  createProviderProfile,
  deleteProviderProfile,
  listProviderProfiles,
  normalizeProfile,
  type CustomProviderProfile,
} from '../../db/openshell-provider-profiles.js';
import { registerResource, type ColumnDef } from '../crud.js';

const ID_ARG: ColumnDef = { name: 'id', type: 'string', required: true, description: 'Profile id (lowercase).' };

function render(data: unknown): string {
  const d = data as { profiles?: CustomProviderProfile[]; message?: string };
  if (d.message) return d.message;
  const rows = d.profiles ?? [];
  if (rows.length === 0)
    return 'No custom OpenShell provider profiles. (OpenShell’s shipped profiles are listed in the setup UI.)';
  return rows
    .map(
      (p) =>
        `${p.id}  "${p.label}"  --type ${p.type}  credentials: ${p.credentialKeys.join(', ') || '(generic)'}` +
        (p.configKeys.length ? `  config: ${p.configKeys.join(', ')}` : ''),
    )
    .join('\n');
}

registerResource({
  name: 'openshell-provider-profile',
  plural: 'openshell-provider-profile',
  table: '',
  idColumn: 'id',
  description:
    'Custom OpenShell provider profile hints (install-wide): templates for `openshell provider create`. ' +
    'The gateway stays the authority on which types exist. Operator-only.',
  columns: [ID_ARG],
  operations: {},
  customOperations: {
    create: {
      access: 'approval',
      hostOnly: true,
      description:
        'Save a custom provider profile hint: its OpenShell --type, credential env-var names and config keys.',
      args: [
        ID_ARG,
        { name: 'label', type: 'string', description: 'Display name (default: the id).' },
        { name: 'type', type: 'string', description: 'OpenShell provider type for --type (default: the id).' },
        {
          name: 'credential_keys',
          type: 'string',
          description: 'Credential env-var names, comma-separated (empty = generic).',
        },
        { name: 'config_keys', type: 'string', description: 'Config keys, comma-separated.' },
        { name: 'description', type: 'string', description: 'One line on what it is for.' },
      ],
      examples: [
        'ncl openshell-provider-profile create --id acme-crm --label "ACME CRM" --credential-keys ACME_API_KEY --config-keys region',
      ],
      handler: async (args) => {
        const profile = await createProviderProfile(
          normalizeProfile({
            id: args.id,
            label: args.label,
            type: args.type,
            credentialKeys: args.credential_keys,
            configKeys: args.config_keys,
            description: args.description,
          }),
        );
        return { profile, message: `Saved custom provider profile ${profile.id} (--type ${profile.type}).` };
      },
      formatHuman: render,
    },
    list: {
      access: 'open',
      hostOnly: true,
      description: 'Custom provider profile hints.',
      args: [],
      examples: ['ncl openshell-provider-profile list'],
      handler: async () => ({ profiles: await listProviderProfiles() }),
      formatHuman: render,
    },
    delete: {
      access: 'approval',
      hostOnly: true,
      description: 'Delete a custom provider profile hint (providers already created with it are untouched).',
      args: [ID_ARG],
      examples: ['ncl openshell-provider-profile delete --id acme-crm'],
      handler: async (args) => {
        const id = String(args.id);
        if (!(await deleteProviderProfile(id))) throw new Error(`no custom provider profile '${id}'`);
        return { id, message: `Deleted custom provider profile ${id}.` };
      },
      formatHuman: render,
    },
  },
});
