// OpenShell setup UI — vanilla JS, same-origin JSON API (routes.ts).
// Every server-supplied string is rendered with textContent, never innerHTML.
'use strict';

const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children)
    if (c !== undefined && c !== null) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `HTTP ${res.status}` };
  }
  return { status: res.status, data };
}

function pre(text) {
  return el('pre', {}, text && text.length ? text : '(no output)');
}

function table(headers, rows, empty) {
  if (!rows.length) return el('p', { class: 'hint' }, empty);
  return el('table', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h))), ...rows);
}

function execBlock(title, r) {
  if (!r) return null;
  return el(
    'div',
    {},
    el('div', { class: 'hint' }, `${title} — exit ${r.code === null ? 'n/a' : r.code}`),
    el('div', { class: 'hint' }, 'stdout'),
    pre(r.stdout),
    el('div', { class: 'hint' }, 'stderr'),
    pre(r.stderr),
  );
}

async function busy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    alert(String(err));
  } finally {
    button.disabled = false;
  }
}

function fail(out, data) {
  out.replaceChildren(el('p', { class: 'bad' }, data.error || 'Failed'));
}

// ---- credential (install-wide) ---------------------------------------------
function credentialLine(c, gateway) {
  if (gateway !== 'openshell')
    return el(
      'span',
      { class: 'bad' },
      `This install's gateway is '${gateway || 'unset'}', not openshell — the read-back below does not apply.`,
    );
  return c.credentials === 'configured'
    ? el('span', { class: 'ok' }, `Detected: ${c.kind} (read from ${c.source})`)
    : el('span', { class: 'bad' }, `No credential where the relay reads it (${c.source}).`);
}

$('cred-save').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const { data } = await api('POST', '/api/credential', { kind: $('cred-kind').value, value: $('cred-value').value });
    $('cred-value').value = '';
    const out = $('cred-result');
    if (data.credential) {
      out.replaceChildren(
        el('p', {}, credentialLine(data.credential, data.gateway)),
        execBlock('scripts/auth.ts', data.script),
      );
      $('cred-status').replaceChildren(credentialLine(data.credential, data.gateway));
    } else fail(out, data);
  }),
);

// ---- group selector + tabs ---------------------------------------------------
function group() {
  return $('group-select').value;
}
const loaders = {};
let activeTab = 'providers';

function showTab(name) {
  activeTab = name;
  for (const b of document.querySelectorAll('[role=tab]'))
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[role=tabpanel]')) p.hidden = p.id !== `tab-${name}`;
  if (group() && loaders[name]) loaders[name]().catch((err) => alert(String(err)));
}
for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

async function loadGroups() {
  const { data } = await api('GET', '/api/groups');
  const groups = data.groups || [];
  $('group-select').replaceChildren(
    ...(groups.length
      ? groups.map((g) => el('option', { value: g.id }, `${g.name} (${g.folder})`))
      : [el('option', { value: '' }, data.error ? `Groups unavailable: ${data.error}` : 'No agent groups yet')]),
  );
  showTab(activeTab);
}
$('group-select').addEventListener('change', () => {
  $('appr-sandbox').replaceChildren(el('option', { value: '' }, '(default)'));
  showTab(activeTab);
});

// ---- Providers tab -------------------------------------------------------------
let providerTypes = [];
function renderTemplates(templates, customError) {
  providerTypes = templates;
  const select = $('prov-type');
  const keep = select.value;
  select.replaceChildren(
    el('option', { value: '__existing__' }, '— already in the gateway (attach only) —'),
    ...providerTypes.map((p) =>
      el(
        'option',
        { value: p.id },
        `${p.id} — ${p.label}${p.source === 'custom' ? ' [custom]' : ''}${p.generic ? ' (generic)' : ''}`,
      ),
    ),
    el('option', { value: '__custom__' }, 'other type id… (generic)'),
  );
  if (keep && [...select.options].some((o) => o.value === keep)) select.value = keep;
  $('profile-error').textContent = customError ? `Custom profiles unavailable: ${customError}` : '';
  onTypeChange();
}

function kvRow(container, key, placeholderKey, isSecret) {
  const k = el('input', { type: 'text', placeholder: placeholderKey, value: key || '' });
  const v = el('input', { type: isSecret ? 'password' : 'text', placeholder: 'value', autocomplete: 'off' });
  const row = el(
    'div',
    { class: 'row' },
    k,
    v,
    el('button', { class: 'secondary', type: 'button', onclick: () => row.remove() }, '×'),
  );
  container.append(row);
}
function kvValues(container) {
  return [...container.querySelectorAll('.row')]
    .map((row) => {
      const [k, v] = row.querySelectorAll('input');
      return { key: k.value.trim(), value: v.value };
    })
    .filter((r) => r.key || r.value);
}
function onTypeChange() {
  const id = $('prov-type').value;
  $('prov-custom-wrap').hidden = id !== '__custom__';
  $('prov-create-fields').hidden = id === '__existing__';
  const profile = providerTypes.find((p) => p.id === id);
  $('profile-delete').hidden = !(profile && profile.source === 'custom');
  const config = $('prov-config');
  config.replaceChildren();
  for (const key of (profile && profile.configKeys) || []) kvRow(config, key, 'KEY', false);
  const creds = $('prov-creds');
  creds.replaceChildren();
  if (id === '__existing__') {
    $('prov-type-hint').textContent = 'The gateway must already have a provider with this name (checked first).';
  } else if (profile && profile.credentialKeys.length) {
    $('prov-type-hint').textContent = `Declared credential variables: ${profile.credentialKeys.join(', ')}.`;
    for (const key of profile.credentialKeys) kvRow(creds, key, 'ENV_VAR_NAME', true);
  } else {
    $('prov-type-hint').textContent = 'Generic: name the environment variable the workload expects and give its value.';
    kvRow(creds, '', 'ENV_VAR_NAME', true);
  }
}
$('prov-type').addEventListener('change', onTypeChange);
$('prov-add-cred').addEventListener('click', () => kvRow($('prov-creds'), '', 'ENV_VAR_NAME', true));
$('prov-add-config').addEventListener('click', () => kvRow($('prov-config'), '', 'KEY', false));

loaders.providers = async () => {
  const { data } = await api('GET', `/api/groups/providers?group=${encodeURIComponent(group())}`);
  const out = $('prov-attached');
  if (!data.providers) return fail(out, data);
  out.replaceChildren(
    table(
      ['Provider', 'Type', 'Credential keys', 'Attached', ''],
      data.providers.map((p) =>
        el(
          'tr',
          {},
          el('td', {}, p.name),
          el('td', {}, p.type || '—'),
          el('td', {}, (p.credentialKeys || []).join(', ') || '—'),
          el('td', {}, p.attachedAt),
          el(
            'td',
            {},
            el(
              'button',
              {
                class: 'secondary',
                onclick: (e) =>
                  busy(e.target, async () => {
                    if (!confirm(`Detach ${p.name}? The provider stays in the gateway.`)) return;
                    const r = await api(
                      'DELETE',
                      `/api/groups/providers?group=${encodeURIComponent(group())}&name=${encodeURIComponent(p.name)}`,
                    );
                    if (r.status !== 200) alert(r.data.error || 'Failed');
                    await loaders.providers();
                  }),
              },
              'Detach',
            ),
          ),
        ),
      ),
      'No OpenShell providers attached to this group.',
    ),
  );
};

$('prov-attach').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const choice = $('prov-type').value;
    const selected = providerTypes.find((p) => p.id === choice);
    const type =
      choice === '__existing__' ? '' : choice === '__custom__' ? $('prov-custom').value.trim() : selected.type;
    const body = { group: group(), name: $('prov-name').value.trim(), type };
    if (type) {
      body.credentials = kvValues($('prov-creds'));
      body.config = kvValues($('prov-config'));
    }
    const { status, data } = await api('POST', '/api/groups/providers', body);
    for (const input of $('prov-creds').querySelectorAll('input[type=password]')) input.value = '';
    const out = $('prov-result');
    if (status !== 200) return fail(out, data);
    out.replaceChildren(el('p', { class: 'ok' }, data.message || 'Attached.'));
    await loaders.providers();
  }),
);
$('prov-list').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const { data } = await api('GET', '/api/providers');
    $('prov-result').replaceChildren(execBlock('openshell provider list', data.list));
  }),
);

$('profile-save').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const keys = (v) =>
      v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    const { status, data } = await api('POST', '/api/profiles', {
      id: $('profile-id').value.trim(),
      label: $('profile-label').value.trim(),
      type: $('profile-type').value.trim(),
      credentialKeys: keys($('profile-creds').value),
      configKeys: keys($('profile-config').value),
    });
    if (status !== 200) return alert(data.error || 'Could not save the profile');
    renderTemplates(data.templates || [], data.customError);
    $('prov-type').value = data.profile.id;
    onTypeChange();
  }),
);
$('profile-delete').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const id = $('prov-type').value;
    if (!confirm(`Delete the custom profile '${id}'? Providers created with it are untouched.`)) return;
    const { status, data } = await api('DELETE', `/api/profiles?id=${encodeURIComponent(id)}`);
    if (status !== 200) return alert(data.error || 'Could not delete the profile');
    renderTemplates(data.templates || [], data.customError);
  }),
);

// ---- Network paths tab ---------------------------------------------------------
loaders.network = async () => {
  const { data } = await api('GET', `/api/groups/network?group=${encodeURIComponent(group())}`);
  const out = $('net-list');
  if (!data.rules) return fail(out, data);
  out.replaceChildren(
    table(
      ['Rule', 'Host', 'Ports', 'Binaries', ''],
      data.rules.map((r) =>
        el(
          'tr',
          {},
          el('td', {}, r.name),
          el('td', {}, r.host),
          el('td', {}, r.ports.join(', ')),
          el('td', {}, r.binaries.join(', ')),
          el(
            'td',
            {},
            el(
              'button',
              {
                class: 'secondary',
                onclick: (e) =>
                  busy(e.target, async () => {
                    const r2 = await api(
                      'DELETE',
                      `/api/groups/network?group=${encodeURIComponent(group())}&name=${encodeURIComponent(r.name)}`,
                    );
                    if (r2.status !== 200) alert(r2.data.error || 'Failed');
                    else liveOutcome($('net-result'), r2.data);
                    await loaders.network();
                  }),
              },
              'Remove',
            ),
          ),
        ),
      ),
      'No network paths for this group.',
    ),
  );
};
$('net-add').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const { status, data } = await api('POST', '/api/groups/network', {
      group: group(),
      name: $('net-name').value.trim(),
      host: $('net-host').value.trim(),
      ports: $('net-ports').value.trim(),
      binaries: $('net-binaries')
        .value.split(/[,\n]/)
        .map((x) => x.trim())
        .filter(Boolean),
    });
    const out = $('net-result');
    if (status !== 200) return fail(out, data);
    liveOutcome(out, data);
    await loaders.network();
  }),
);

// Saved durably either way; live apply is per running sandbox and may partly fail.
function liveOutcome(out, data) {
  const live = data.live || [];
  const failed = live.filter((l) => !l.ok);
  out.replaceChildren(
    el('p', { class: failed.length ? 'bad' : 'ok' }, data.message || 'Saved.'),
    live.length
      ? table(
          ['Running sandbox', 'Live apply'],
          live.map((l) => el('tr', {}, el('td', {}, l.sandbox), el('td', {}, l.ok ? 'applied' : `failed: ${l.error}`))),
          '',
        )
      : null,
  );
}

// ---- Pending approvals tab -----------------------------------------------------
loaders.approvals = async () => {
  const status = $('appr-status').value;
  const sandbox = $('appr-sandbox').value;
  const q = `group=${encodeURIComponent(group())}&status=${encodeURIComponent(status)}${sandbox ? `&sandbox=${encodeURIComponent(sandbox)}` : ''}`;
  const { data } = await api('GET', `/api/groups/policy?${q}`);
  const out = $('appr-result');
  if (data.chunks === undefined) return fail(out, data);
  $('appr-sandbox').replaceChildren(
    el('option', { value: '' }, '(default)'),
    ...(data.sandboxes || []).map((c) =>
      el('option', { value: c.sandbox }, `${c.sandbox} — session ${c.sessionId}, ${c.containerStatus}, ${c.createdAt}`),
    ),
  );
  if (sandbox) $('appr-sandbox').value = sandbox;
  if (!data.sandbox) return out.replaceChildren(el('p', { class: 'hint' }, data.note || 'No live sandbox.'));
  const rows = data.chunks.map((c) => {
    const actions = el('td', {});
    if (status === 'pending') {
      const reason = el('input', { type: 'text', placeholder: 'reason (to reject)' });
      actions.append(
        el('button', { onclick: (e) => busy(e.target, () => decide('approve', data.sandbox, c.chunkId)) }, 'Approve'),
        reason,
        el(
          'button',
          {
            class: 'secondary',
            onclick: (e) => busy(e.target, () => decide('reject', data.sandbox, c.chunkId, reason.value)),
          },
          'Reject',
        ),
      );
    }
    return el(
      'tr',
      {},
      el('td', {}, c.chunkId),
      el('td', {}, c.rule || ''),
      el('td', {}, c.binary || ''),
      el('td', {}, c.rationale || ''),
      el('td', {}, el('span', { class: 'badge' }, c.status || status)),
      actions,
    );
  });
  out.replaceChildren(
    el('div', { class: 'hint' }, `Sandbox ${data.sandbox}`),
    data.note ? el('div', { class: 'note' }, data.note) : null,
    data.error ? el('p', { class: 'bad' }, data.error) : null,
    table(['Chunk', 'Rule', 'Binary', 'Rationale', 'Status', ''], rows, `No ${status} proposals.`),
    el('div', { class: 'hint' }, 'Raw output'),
    pre(data.output),
  );
};
async function decide(action, sandbox, chunkId, reason) {
  const { data } = await api('POST', `/api/policy/${action}`, { group: group(), sandbox, chunkId, reason });
  alert(
    data.ok
      ? `${action === 'approve' ? 'Approved' : 'Rejected'} ${chunkId}.\n\n${data.output || ''}`
      : `Failed: ${data.error || ''}`,
  );
  await loaders.approvals();
}
$('appr-load').addEventListener('click', (e) => busy(e.target, loaders.approvals));

// ---- Audit log tab -------------------------------------------------------------
loaders.audit = async () => {
  const { data } = await api('GET', `/api/groups/audit?group=${encodeURIComponent(group())}`);
  const out = $('audit-result');
  if (!data.entries) return fail(out, data);
  out.replaceChildren(
    el('div', { class: 'hint' }, `Logs: ${data.logs.changes} · ${data.logs.decisions}`),
    data.remoteError ? el('p', { class: 'bad' }, `OpenShell listing failed: ${data.remoteError}`) : null,
    table(
      ['When', 'What', 'Outcome', 'Sandbox', 'Detail', 'By'],
      data.entries.map((a) =>
        el(
          'tr',
          {},
          el('td', {}, a.ts || '—'),
          el('td', {}, a.action),
          el('td', {}, el('span', { class: `badge ${a.outcome}` }, a.outcome)),
          el('td', {}, a.sandbox || '—'),
          el('td', {}, a.detail + (a.error ? ` · ${a.error}` : '')),
          el('td', {}, a.actor || a.source),
        ),
      ),
      'Nothing recorded for this group yet.',
    ),
  );
};
$('audit-load').addEventListener('click', (e) => busy(e.target, loaders.audit));

// ---- start ---------------------------------------------------------------------
(async () => {
  const { data } = await api('GET', '/api/status');
  $('cred-status').replaceChildren(credentialLine(data.credential, data.gateway));
  renderTemplates(data.providerTypes || [], data.customProfilesError);
  await loadGroups();
})().catch((err) => {
  $('cred-status').textContent = `Could not load status: ${err}`;
});
