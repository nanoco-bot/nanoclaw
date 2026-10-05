/**
 * Agent-provider authentication for the OpenShell gateway.
 *
 * This gateway has no vault: its model relay reads ANTHROPIC_API_KEY (or
 * CLAUDE_CODE_OAUTH_TOKEN) from the NanoClaw host SERVICE environment at
 * request time and never writes it anywhere. So "authenticating" here means
 * telling the operator where the credential must live — it is never prompted
 * for, stored in `.env`, or passed to an agent.
 */
import { getSystemdUnit } from '../../../../src/install-slug.js';

const provider = (process.argv[2] ?? 'claude').trim().toLowerCase();
if (provider !== 'claude') {
  console.error(
    `The OpenShell gateway relays Anthropic model credentials only; provider '${provider}' is not supported with it.`,
  );
  process.exit(1);
}

const present = Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
const unit = getSystemdUnit();
console.log(
  [
    'OpenShell gateway: model credentials are added by a relay on this host, never inside a sandbox.',
    present
      ? 'A credential is set in this shell. The background service does not inherit it.'
      : 'No ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set in this shell.',
    'Give the NanoClaw service one of them in its own environment, for example:',
    `  systemctl --user edit ${unit}    # add: [Service] Environment=ANTHROPIC_API_KEY=...`,
    `  systemctl --user restart ${unit}`,
    'For `pnpm run dev`, export it in the shell that runs the host. Do not put it in .env.',
    'Until then, agents receive a clear "model relay has no credential" error.',
  ].join('\n'),
);
