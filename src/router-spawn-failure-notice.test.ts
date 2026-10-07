/**
 * A wake that fails with a user-facing reason (e.g. the OpenShell gateway has
 * no model credential) is answered in the chat instead of silence — through
 * the REAL routeInbound path, once, not on every retry.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wake = vi.hoisted(() => ({ fail: true }));

vi.mock('./container-runner.js', async () => {
  const notices = await import('./spawn-failure-notice.js');
  return {
    wakeContainer: vi.fn(async (session: { id: string }) => {
      if (!wake.fail) return true;
      notices.recordSpawnFailure(
        session.id,
        Object.assign(new Error('relay has no credential'), { userMessage: 'No Claude credential is configured.' }),
      );
      return false;
    }),
    isContainerRunning: vi.fn().mockReturnValue(false),
    getActiveContainerCount: vi.fn().mockReturnValue(0),
    killContainer: vi.fn(),
  };
});
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-spawn-notice' };
});
const outbound = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('./session-manager.js')>('./session-manager.js');
  return { ...actual, writeOutboundDirect: outbound };
});

import {
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  closeDb,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import type { ChannelDefaults } from './channels/adapter.js';
import { routeInbound } from './router.js';

const TEST_DIR = '/tmp/nanoclaw-test-spawn-notice';
const now = () => new Date().toISOString();
const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

async function inbound(id: string): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text: 'hi' }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
    },
  });
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  outbound.mockClear();
  wake.fail = true;
  registerChannelAdapter('testchat', {
    factory: () => ({
      name: 'testchat',
      channelType: 'testchat',
      supportsThreads: true,
      defaults,
      setup: async () => {},
      teardown: async () => {},
      isConnected: () => true,
      deliver: async () => undefined,
    }),
    defaults,
  });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
});
afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('user-facing spawn failure', () => {
  it('posts the reason to the chat once, not on every follow-up', async () => {
    await inbound('m1');
    expect(outbound).toHaveBeenCalledTimes(1);
    const [, , message] = outbound.mock.calls[0] as unknown as [
      string,
      string,
      { kind: string; platformId: string; channelType: string; content: string },
    ];
    expect(message).toMatchObject({ kind: 'chat', platformId: 'testchat:C1', channelType: 'testchat' });
    expect(JSON.parse(message.content).text).toBe('No Claude credential is configured.');

    await inbound('m2');
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the wake succeeds', async () => {
    wake.fail = false;
    await inbound('m1');
    expect(outbound).not.toHaveBeenCalled();
  });
});
