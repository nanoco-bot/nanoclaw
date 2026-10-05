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

// ---- 1. credential --------------------------------------------------------
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

let providerTypes = [];
async function loadStatus() {
  const { data } = await api('GET', '/api/status');
  $('cred-status').replaceChildren(credentialLine(data.credential, data.gateway));
  providerTypes = data.providerTypes || [];
  const select = $('prov-type');
  select.replaceChildren(
    ...providerTypes.map((p) => el('option', { value: p.id }, `${p.id} — ${p.label}${p.generic ? ' (generic)' : ''}`)),
    el('option', { value: '__custom__' }, 'custom profile id… (generic)'),
  );
  onTypeChange();
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
    } else out.replaceChildren(el('p', { class: 'bad' }, data.error || 'Failed'));
  }),
);

// ---- 2. providers ---------------------------------------------------------
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
  const custom = id === '__custom__';
  $('prov-custom-wrap').hidden = !custom;
  const profile = providerTypes.find((p) => p.id === id);
  const creds = $('prov-creds');
  creds.replaceChildren();
  if (profile && profile.credentialKeys.length) {
    $('prov-type-hint').textContent =
      `Declared credential variables: ${profile.credentialKeys.join(', ')}. Fill the ones you have; add others below if needed.`;
    for (const key of profile.credentialKeys) kvRow(creds, key, 'ENV_VAR_NAME', true);
  } else {
    $('prov-type-hint').textContent =
      'Generic profile: name the environment variable the workload expects and give its value.';
    kvRow(creds, '', 'ENV_VAR_NAME', true);
  }
}
$('prov-type').addEventListener('change', onTypeChange);
$('prov-add-cred').addEventListener('click', () => kvRow($('prov-creds'), '', 'ENV_VAR_NAME', true));
$('prov-add-config').addEventListener('click', () => kvRow($('prov-config'), '', 'KEY', false));

$('prov-create').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const type = $('prov-type').value === '__custom__' ? $('prov-custom').value.trim() : $('prov-type').value;
    const { data } = await api('POST', '/api/providers', {
      name: $('prov-name').value.trim(),
      type,
      credentials: kvValues($('prov-creds')),
      config: kvValues($('prov-config')),
      globalProfile: $('prov-global').checked,
    });
    for (const input of $('prov-creds').querySelectorAll('input[type=password]')) input.value = '';
    const out = $('prov-result');
    if (!data.create) return out.replaceChildren(el('p', { class: 'bad' }, data.error || 'Failed'));
    out.replaceChildren(
      el(
        'p',
        { class: data.ok ? 'ok' : 'bad' },
        data.ok ? 'Provider created.' : 'OpenShell refused the provider — its own error text is below.',
      ),
      el('div', { class: 'hint' }, `Ran: ${data.argv.join(' ')}  (credential values passed via environment)`),
      data.missingDeclaredCredentials && data.missingDeclaredCredentials.length
        ? el('div', { class: 'hint' }, `Not supplied: ${data.missingDeclaredCredentials.join(', ')}`)
        : null,
      execBlock('provider create', data.create),
      data.readBack ? execBlock('read-back: openshell provider get', data.readBack) : null,
    );
  }),
);
$('prov-list').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const { data } = await api('GET', '/api/providers');
    $('prov-result').replaceChildren(execBlock('openshell provider list', data.list));
  }),
);

// ---- 3. policy -------------------------------------------------------------
function sandbox() {
  return $('pol-sandbox').value.trim();
}
async function listProposals() {
  const status = $('pol-status').value;
  const { data } = await api(
    'GET',
    `/api/policy?sandbox=${encodeURIComponent(sandbox())}&status=${encodeURIComponent(status)}`,
  );
  const out = $('pol-result');
  if (!data.ok && data.output === undefined)
    return out.replaceChildren(el('p', { class: 'bad' }, data.error || 'Failed'));
  const rows = (data.chunks || []).map((c) => {
    const actions = el('td', {});
    if (status === 'pending') {
      const reason = el('input', { type: 'text', placeholder: 'reason (to reject)' });
      actions.append(
        el('button', { onclick: (e) => busy(e.target, () => decide('approve', c.chunkId)) }, 'Approve'),
        reason,
        el(
          'button',
          { class: 'secondary', onclick: (e) => busy(e.target, () => decide('reject', c.chunkId, reason.value)) },
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
    data.note ? el('div', { class: 'note' }, data.note) : null,
    data.error ? el('p', { class: 'bad' }, data.error) : null,
    rows.length
      ? el(
          'table',
          {},
          el('tr', {}, ...['Chunk', 'Rule', 'Binary', 'Rationale', 'Status', ''].map((h) => el('th', {}, h))),
          ...rows,
        )
      : el('p', {}, `No ${status} proposals parsed for ${data.sandbox || 'this sandbox'}.`),
    el('div', { class: 'hint' }, 'Raw output'),
    pre(data.output),
  );
}
async function decide(action, chunkId, reason) {
  const { data } = await api('POST', `/api/policy/${action}`, { sandbox: sandbox(), chunkId, reason });
  alert(
    data.ok
      ? `${action === 'approve' ? 'Approved' : 'Rejected'} ${chunkId}.\n\n${data.output || ''}`
      : `Failed: ${data.error || ''}`,
  );
  await listProposals();
  await loadHistory();
}
$('pol-list').addEventListener('click', (e) => busy(e.target, listProposals));
$('pol-view').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const { data } = await api('GET', `/api/policy/view?sandbox=${encodeURIComponent(sandbox())}`);
    $('pol-result').replaceChildren(
      data.error ? el('p', { class: 'bad' }, data.error) : null,
      pre(data.policy ? JSON.stringify(data.policy, null, 2) : data.output),
    );
  }),
);

// ---- 4. history ------------------------------------------------------------
async function loadHistory() {
  const q = sandbox() ? `?sandbox=${encodeURIComponent(sandbox())}` : '';
  const { data } = await api('GET', `/api/history${q}`);
  const rows = (data.entries || []).map((h) =>
    el(
      'tr',
      {},
      el('td', {}, h.ts || '—'),
      el('td', {}, h.sandbox),
      el('td', {}, h.chunkId),
      el('td', {}, h.decision + (h.ok === false ? ' (failed)' : '')),
      el('td', {}, h.reason || h.error || ''),
      el('td', {}, el('span', { class: 'badge' }, h.source === 'ui-log' ? h.actor : 'openshell (outside UI)')),
    ),
  );
  $('hist-result').replaceChildren(
    el('div', { class: 'hint' }, `Log file: ${data.logFile || ''}`),
    data.remoteError ? el('p', { class: 'bad' }, `OpenShell listing failed: ${data.remoteError}`) : null,
    rows.length
      ? el(
          'table',
          {},
          el('tr', {}, ...['When', 'Sandbox', 'Chunk', 'Decision', 'Reason / error', 'By'].map((h) => el('th', {}, h))),
          ...rows,
        )
      : el('p', {}, 'No decisions recorded yet.'),
  );
}
$('hist-load').addEventListener('click', (e) => busy(e.target, loadHistory));

loadStatus().catch((err) => {
  $('cred-status').textContent = `Could not load status: ${err}`;
});
