// OpenShell setup UI — vanilla JS, same-origin JSON API (routes.ts).
// Every server-supplied string is rendered with textContent, never innerHTML.
'use strict';

const $ = (id) => document.getElementById(id);
const enc = encodeURIComponent;

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat())
    if (c !== undefined && c !== null && c !== false)
      node.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
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
  return { status: res.status, ok: res.status >= 200 && res.status < 300, data };
}

// ---- small UI helpers ----------------------------------------------------------
function toast(title, detail, kind = 'ok') {
  const t = el(
    'div',
    { class: `toast ${kind}`, role: 'status' },
    el('div', { class: 't' }, title),
    detail ? el('div', { class: 'muted small' }, detail) : null,
  );
  t.addEventListener('click', () => t.remove());
  $('toasts').append(t);
  if (kind !== 'bad') setTimeout(() => t.remove(), 7000);
}

async function busy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast('Something went wrong', String(err && err.message ? err.message : err), 'bad');
  } finally {
    button.disabled = false;
  }
}

/** replaceChildren that skips null/undefined/false (which it would otherwise render as text). */
function fill(node, ...kids) {
  node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
}

function spinner(text) {
  return el('p', { class: 'muted small' }, el('span', { class: 'spinner' }), ' ', text || 'Loading…');
}
function empty(title, hint) {
  return el('div', { class: 'empty' }, el('strong', {}, title), hint || '');
}

/** A button that asks inline ("Detach? Yes / No") instead of a browser confirm(). */
function confirmButton(label, question, run, cls = 'danger sm') {
  const wrap = el('span', {});
  const reset = () => fill(wrap, el('button', { class: cls, type: 'button', onclick: ask }, label));
  function ask() {
    const yes = el('button', { class: 'danger solid sm', type: 'button' }, 'Yes');
    const no = el('button', { class: 'ghost sm', type: 'button', onclick: reset }, 'No');
    yes.addEventListener('click', () => busy(yes, run));
    fill(wrap, el('span', { class: 'confirm' }, question, yes, no));
  }
  reset();
  return wrap;
}

function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString();
}

const shortBin = (p) =>
  String(p || '')
    .split('/')
    .pop() || p;
const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
const envName = (s) =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
const radio = (name) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;

// Programs inside the agent sandbox that commonly make network calls.
const PROGRAMS = [
  { path: '/usr/bin/curl', label: 'curl', on: true },
  { path: '/usr/local/bin/node', label: 'node', on: true },
  { path: '/usr/local/bin/bun', label: 'bun', on: true },
  { path: '/usr/bin/git', label: 'git', on: false },
];
function programPicker(container) {
  const custom = el('input', {
    type: 'text',
    placeholder: '/other/program',
    style: 'max-width:12rem',
    spellcheck: 'false',
  });
  fill(
    container,
    ...PROGRAMS.map((p) =>
      el(
        'label',
        { class: 'check', title: p.path },
        el('input', { type: 'checkbox', value: p.path, checked: p.on }),
        p.label,
      ),
    ),
    custom,
  );
  return () => [
    ...[...container.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value),
    ...custom.value
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  ];
}

/** A toast for a group change: saved for the group, and whether the running sandbox took it. */
function liveToast(data, okTitle) {
  const live = data.live || [];
  const failed = live.filter((l) => !l.ok);
  const where = live.length
    ? failed.length
      ? `Saved, but the running sandbox did not take it: ${failed.map((f) => f.error).join('; ')}`
      : 'Saved for the group and applied to the running sandbox.'
    : 'Saved for the group. No sandbox is running; the next one gets it.';
  toast(okTitle, where, failed.length ? 'warn' : 'ok');
}

// ---- state ---------------------------------------------------------------------
const state = { groups: [], tab: 'providers', types: [], sandboxes: [] };
const group = () => $('group-select').value;
const loaders = {};

// ---- header: gateway, credential, sandboxes ------------------------------------
function pill(id, kind, text) {
  const p = $(id);
  p.className = `pill ${kind}`;
  p.querySelector('.txt').textContent = text;
}

async function loadGateway() {
  const { data } = await api('GET', '/api/gateway');
  if (data.connected) pill('pill-gateway', 'ok', `OpenShell${data.version ? ` v${data.version}` : ''} · connected`);
  else pill('pill-gateway', 'bad', `OpenShell gateway unreachable${data.error ? ` — ${data.error}` : ''}`);
}

function credText(c, gateway) {
  if (gateway && gateway !== 'openshell') return ['bad', `Credential gateway is '${gateway}', not OpenShell`];
  if (c && c.credentials === 'configured')
    return ['ok', `Claude · ${c.kind === 'oauth' ? 'OAuth token' : c.kind === 'api-key' ? 'API key' : c.kind}`];
  return ['bad', 'Claude credential missing'];
}
function showCred(c, gateway) {
  const [kind, text] = credText(c, gateway);
  pill('pill-cred', kind, text);
  fill(
    $('cred-status'),
    el('span', { class: `badge ${kind}` }, kind === 'ok' ? 'Configured' : 'Not configured'),
    c && c.source ? ` · read from ${c.source}` : '',
  );
}

function showSandboxes(list) {
  state.sandboxes = list || [];
  const n = state.sandboxes.length;
  pill(
    'pill-sandbox',
    n ? 'ok' : 'warn',
    n ? `${n} sandbox${n > 1 ? 'es' : ''} running` : 'No sandbox running — the next message starts one',
  );
}

$('cred-open').addEventListener('click', () => $('cred-dialog').showModal());
$('cred-close').addEventListener('click', () => $('cred-dialog').close());
$('cred-save').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const value = $('cred-value').value;
    if (!value.trim()) return toast('Paste the credential first', '', 'warn');
    const { ok, data } = await api('POST', '/api/credential', { kind: $('cred-kind').value, value });
    $('cred-value').value = '';
    if (data.credential) showCred(data.credential, data.gateway);
    const run = data.script;
    fill(
      $('cred-result'),
      run
        ? el(
            'details',
            {},
            el('summary', {}, `Output of scripts/auth.ts (exit ${run.code})`),
            el('pre', {}, [run.stdout, run.stderr].filter(Boolean).join('\n') || '(no output)'),
          )
        : null,
    );
    if (ok) {
      toast('Credential saved', 'OpenShell holds it; new requests use it.');
      $('cred-dialog').close();
    } else toast('Credential not saved', data.error || 'See the output in the dialog.', 'bad');
  }),
);

// ---- groups + tabs -------------------------------------------------------------
function showTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll('[role=tab]'))
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const p of document.querySelectorAll('[role=tabpanel]')) p.hidden = p.id !== `tab-${name}`;
  try {
    localStorage.setItem('openshell-ui-tab', name);
  } catch {
    // storage unavailable: the tab just isn't remembered
  }
  if (group() && loaders[name]) loaders[name]().catch((err) => toast('Could not load', String(err), 'bad'));
}
for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => showTab(b.dataset.tab));

function groupLabel() {
  const g = state.groups.find((x) => x.id === group());
  return g ? g.name : 'this group';
}

async function loadGroups() {
  const { data } = await api('GET', '/api/groups');
  state.groups = data.groups || [];
  const select = $('group-select');
  fill(
    select,
    ...(state.groups.length
      ? state.groups.map((g) => el('option', { value: g.id }, `${g.name} · ${g.folder}`))
      : [el('option', { value: '' }, data.error ? 'Groups unavailable' : 'No agent groups yet')]),
  );
  if (data.error) toast('Agent groups unavailable', data.error, 'bad');
  try {
    const saved = localStorage.getItem('openshell-ui-group');
    if (saved && state.groups.some((g) => g.id === saved)) select.value = saved;
  } catch {
    // storage unavailable
  }
  onGroupChange();
}

function onGroupChange() {
  for (const n of document.querySelectorAll('.group-name')) n.textContent = groupLabel();
  try {
    localStorage.setItem('openshell-ui-group', group());
  } catch {
    // storage unavailable
  }
  for (const id of ['prov-attached', 'net-list', 'appr-result', 'audit-result']) $(id).replaceChildren();
  fill($('appr-sandbox'));
  if (!group()) return;
  refreshCounts().catch(() => {});
  showTab(state.tab);
}
$('group-select').addEventListener('change', onGroupChange);

/** Tab counts and the sandbox pill, for the selected group. */
async function refreshCounts() {
  if (!group()) return;
  const g = enc(group());
  const [prov, net, appr] = await Promise.all([
    api('GET', `/api/groups/providers?group=${g}`),
    api('GET', `/api/groups/network?group=${g}`),
    api('GET', `/api/groups/policy?group=${g}&status=pending`),
  ]);
  $('count-providers').textContent = prov.data.providers ? prov.data.providers.length : '!';
  $('count-network').textContent = net.data.rules ? net.data.rules.length : '!';
  const pending = (appr.data.chunks || []).length;
  const c = $('count-approvals');
  c.textContent = appr.data.sandbox ? pending : '–';
  c.classList.toggle('attn', pending > 0);
  showSandboxes(appr.data.sandboxes);
}

// ---- Providers -----------------------------------------------------------------
loaders.providers = async () => {
  const out = $('prov-attached');
  if (!out.childElementCount) fill(out, spinner());
  const { data } = await api('GET', `/api/groups/providers?group=${enc(group())}`);
  if (!data.providers) return fill(out, el('p', { class: 'note' }, data.error || 'Could not load providers.'));
  $('count-providers').textContent = data.providers.length;
  if (!data.providers.length)
    return fill(
      out,
      empty('No providers yet', 'Attach one to give the agent a key for a service like GitHub or Granola.'),
    );
  fill(
    out,
    el(
      'div',
      { class: 'list' },
      data.providers.map((p) => {
        const type = state.types.find((t) => t.id === p.type);
        return el(
          'div',
          { class: 'item' },
          el('div', { class: 'icon', 'aria-hidden': 'true' }, (p.name[0] || '?').toUpperCase()),
          el(
            'div',
            { class: 'body' },
            el(
              'div',
              { class: 'title' },
              p.name,
              p.type ? el('span', { class: 'badge' }, type ? type.label : p.type) : null,
            ),
            el(
              'div',
              { class: 'meta' },
              (p.credentialKeys || []).length
                ? ['key ', ...p.credentialKeys.map((k) => el('span', { class: 'tag' }, k)), ' · ']
                : '',
              type && type.endpoints.length ? `reaches ${type.endpoints.map((e) => e.host).join(', ')} · ` : '',
              `attached ${relTime(p.attachedAt)}`,
            ),
          ),
          confirmButton('Detach', `Detach ${p.name}?`, async () => {
            const r = await api('DELETE', `/api/groups/providers?group=${enc(group())}&name=${enc(p.name)}`);
            if (!r.ok) return toast(`Could not detach ${p.name}`, r.data.error, 'bad');
            liveToast(r.data, `Detached ${p.name}`);
            await loaders.providers();
          }),
        );
      }),
    ),
  );
};

async function loadTypes() {
  const { data } = await api('GET', '/api/types');
  state.types = data.types || [];
  $('count-types').textContent = state.types.length;
  const out = $('types-list');
  if (data.error) fill(out, el('p', { class: 'note' }, `Could not read OpenShell's service types: ${data.error}`));
  else if (!state.types.length)
    fill(
      out,
      empty(
        'No service types yet',
        'OpenShell ships none. Create one for each service the agent should call with a key.',
      ),
    );
  else
    fill(
      out,
      el(
        'div',
        { class: 'list' },
        state.types.map((t) =>
          el(
            'div',
            { class: 'item' },
            el(
              'div',
              { class: 'body' },
              el('div', { class: 'title' }, t.label, el('span', { class: 'tag' }, t.id)),
              el(
                'div',
                { class: 'meta' },
                t.endpoints.map((e) => `${e.host}:${e.port}${e.access ? ` (${e.access})` : ''}`).join(', ') ||
                  'no hosts',
                ' · ',
                t.binaries.map(shortBin).join(', ') || 'no programs',
                t.credentialKeys.length ? [' · key ', el('span', { class: 'tag' }, t.credentialKeys.join(', '))] : '',
              ),
            ),
            el('button', { class: 'ghost sm', type: 'button', onclick: () => openAttach(t.id) }, 'Attach'),
            confirmButton('Delete', `Delete type ${t.id}?`, async () => {
              const r = await api('DELETE', `/api/types?id=${enc(t.id)}`);
              if (!r.ok) return toast(`Could not delete ${t.id}`, r.data.error, 'bad');
              toast(`Deleted service type ${t.id}`, 'Providers already created from it are untouched.');
              await loadTypes();
            }),
          ),
        ),
      ),
    );
  renderAttachTypes();
}

// Attach form
function renderAttachTypes(selected) {
  const select = $('attach-type');
  const keep = selected || select.value;
  fill(
    select,
    ...state.types.map((t) => el('option', { value: t.id }, `${t.label}${t.description ? ` — ${t.description}` : ''}`)),
    el('option', { value: '__existing__' }, 'A provider already created in OpenShell…'),
  );
  if (keep && [...select.options].some((o) => o.value === keep)) select.value = keep;
  onAttachTypeChange();
}

function credRow(key) {
  const input = el('input', {
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    'data-key': key,
    placeholder: 'paste the key',
  });
  const show = el('button', { class: 'link small', type: 'button' }, 'show');
  show.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    show.textContent = input.type === 'password' ? 'show' : 'hide';
  });
  return el(
    'label',
    { class: 'field' },
    el('span', {}, key, ' ', show),
    input,
    el('small', {}, 'Goes only to OpenShell; NanoClaw keeps a hash.'),
  );
}

function onAttachTypeChange() {
  const id = $('attach-type').value;
  const t = state.types.find((x) => x.id === id);
  const creds = $('attach-creds');
  if (id === '__existing__' || !t) {
    $('attach-type-desc').textContent = 'Attach a provider that already exists in OpenShell, by its name.';
    $('attach-name').value = '';
    $('attach-name-hint').textContent = 'Its exact OpenShell provider name.';
    fill(creds);
    return;
  }
  const access = t.endpoints[0] && t.endpoints[0].access ? ` (${t.endpoints[0].access})` : '';
  $('attach-type-desc').textContent =
    `Lets ${t.binaries.map(shortBin).join(', ') || 'no programs'} reach ` +
    `${t.endpoints.map((e) => `${e.host}:${e.port}`).join(', ')}${access}.`;
  $('attach-name').value = slug(`${t.id}-${groupLabel()}`);
  $('attach-name-hint').textContent = 'How it is listed; letters, digits and dashes.';
  fill(creds, ...(t.credentialKeys.length ? t.credentialKeys : ['API_KEY']).map(credRow));
}
$('attach-type').addEventListener('change', onAttachTypeChange);

function openAttach(typeId) {
  $('attach-card').hidden = false;
  renderAttachTypes(typeId);
  $('attach-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('attach-name').focus();
}
$('attach-open').addEventListener('click', () => {
  if (!state.types.length) {
    toast('Create a service type first', 'OpenShell needs to know the service before a key can be attached.', 'warn');
    return openTypeForm();
  }
  openAttach();
});
$('attach-close').addEventListener('click', () => ($('attach-card').hidden = true));

$('attach-submit').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const id = $('attach-type').value;
    const existing = id === '__existing__';
    const name = $('attach-name').value.trim();
    if (!name) return toast('Give the provider a name', '', 'warn');
    const credentials = [...$('attach-creds').querySelectorAll('input[data-key]')].map((i) => ({
      key: i.dataset.key,
      value: i.value,
    }));
    if (!existing && credentials.some((c) => !c.value)) return toast('Paste the key first', '', 'warn');
    const { ok, data } = await api('POST', '/api/groups/providers', {
      group: group(),
      name,
      type: existing ? '' : id,
      ...(existing ? {} : { credentials }),
      restart: $('attach-restart').checked,
    });
    for (const i of $('attach-creds').querySelectorAll('input')) i.value = '';
    if (!ok) return toast('Could not attach', data.error, 'bad');
    if (data.restart && data.restart.ok)
      toast(`Attached ${name}`, 'The agent was restarted with the key; it picks up from your next message.');
    else if (data.restart)
      toast(
        `Attached ${name}, but the agent was not restarted`,
        `${data.restart.error}. The key reaches it once its sandbox restarts.`,
        'warn',
      );
    else liveToast(data, `Attached ${name}`);
    $('attach-card').hidden = true;
    await loaders.providers();
  }),
);

// New service type form
let typeBins = () => [];
function openTypeForm() {
  $('type-card').hidden = false;
  typeBins = programPicker($('type-bins'));
  $('type-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('type-label').focus();
}
$('type-open').addEventListener('click', openTypeForm);
$('type-close').addEventListener('click', () => ($('type-card').hidden = true));
let keyTouched = false;
$('type-key').addEventListener('input', () => (keyTouched = true));
$('type-label').addEventListener('input', () => {
  const v = $('type-label').value;
  $('type-id-preview').textContent = slug(v) || '–';
  if (!keyTouched) $('type-key').value = v ? `${envName(v)}_API_KEY` : '';
});
for (const r of document.querySelectorAll('input[name=type-auth]'))
  r.addEventListener('change', () => ($('type-header').hidden = radio('type-auth') !== 'header'));
for (const r of document.querySelectorAll('input[name=type-mode]'))
  r.addEventListener('change', () => {
    const yaml = radio('type-mode') === 'yaml';
    $('type-form').hidden = yaml;
    $('type-yaml-wrap').hidden = !yaml;
  });

$('type-submit').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const body =
      radio('type-mode') === 'yaml'
        ? { yaml: $('type-yaml').value }
        : {
            id: slug($('type-label').value),
            label: $('type-label').value.trim(),
            credentialKey: $('type-key').value.trim(),
            authStyle: radio('type-auth'),
            authName: $('type-header').value.trim(),
            endpoints: [
              {
                host: $('type-host').value.trim(),
                port: Number($('type-port').value || 443),
                access: radio('type-access'),
              },
            ],
            binaries: typeBins(),
          };
    const { ok, data } = await api('POST', '/api/types', body);
    if (!ok) return toast('Could not create the service type', data.error, 'bad');
    toast(`Service type ${data.id} created`, 'Now attach it to a group with its key.');
    $('type-card').hidden = true;
    for (const id of ['type-label', 'type-host', 'type-key', 'type-header', 'type-yaml']) $(id).value = '';
    $('type-id-preview').textContent = '–';
    keyTouched = false;
    await loadTypes();
    openAttach(data.id);
  }),
);

// ---- Network access --------------------------------------------------------------
let netBins = () => [];
loaders.network = async () => {
  const out = $('net-list');
  if (!out.childElementCount) fill(out, spinner());
  const { data } = await api('GET', `/api/groups/network?group=${enc(group())}`);
  if (!data.rules) return fill(out, el('p', { class: 'note' }, data.error || 'Could not load network access.'));
  $('count-network').textContent = data.rules.length;
  if (!data.rules.length)
    return fill(out, empty('Nothing allowed yet', 'Add a host below, or allow a blocked request from Approvals.'));
  fill(
    out,
    el(
      'div',
      { class: 'list' },
      data.rules.map((r) =>
        el(
          'div',
          { class: 'item' },
          el('div', { class: 'icon', 'aria-hidden': 'true' }, '↗'),
          el(
            'div',
            { class: 'body' },
            el('div', { class: 'title mono' }, `${r.host}:${r.ports.join(',')}`),
            el(
              'div',
              { class: 'meta' },
              r.name,
              ' · from ',
              r.binaries.map((b) => el('span', { class: 'tag', title: b }, shortBin(b))),
            ),
          ),
          confirmButton('Remove', `Remove ${r.host}?`, async () => {
            const res = await api('DELETE', `/api/groups/network?group=${enc(group())}&name=${enc(r.name)}`);
            if (!res.ok) return toast(`Could not remove ${r.host}`, res.data.error, 'bad');
            liveToast(res.data, `Removed ${r.host}`);
            await loaders.network();
          }),
        ),
      ),
    ),
  );
};
$('net-add').addEventListener('click', (e) =>
  busy(e.target, async () => {
    const host = $('net-host')
      .value.trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!host) return toast('Enter a host', '', 'warn');
    const ports = $('net-ports').value.trim() || '443';
    const name = $('net-name').value.trim() || slug(`${host}-${ports.split(',')[0]}`).replace(/-/g, '_');
    const { ok, data } = await api('POST', '/api/groups/network', {
      group: group(),
      name,
      host,
      ports,
      binaries: netBins(),
    });
    if (!ok) return toast('Could not allow it', data.error, 'bad');
    liveToast(data, `Allowed ${host}`);
    $('net-host').value = '';
    $('net-name').value = '';
    await loaders.network();
  }),
);

// ---- Approvals -------------------------------------------------------------------
for (const r of document.querySelectorAll('input[name=appr-status]'))
  r.addEventListener('change', () => loaders.approvals());
$('appr-sandbox').addEventListener('change', () => loaders.approvals());
$('appr-load').addEventListener('click', (e) => busy(e.target, () => loaders.approvals()));

loaders.approvals = async () => {
  const status = radio('appr-status');
  const sandbox = $('appr-sandbox').value;
  const out = $('appr-result');
  if (!out.childElementCount) fill(out, spinner());
  const q = `group=${enc(group())}&status=${enc(status)}${sandbox ? `&sandbox=${enc(sandbox)}` : ''}`;
  const { data } = await api('GET', `/api/groups/policy?${q}`);
  showSandboxes(data.sandboxes);
  const sel = $('appr-sandbox');
  sel.hidden = (data.sandboxes || []).length < 2;
  fill(
    sel,
    ...(data.sandboxes || []).map((c) => el('option', { value: c.sandbox }, `${c.sandbox} · ${c.containerStatus}`)),
  );
  if (data.sandbox) sel.value = data.sandbox;
  if (data.chunks === undefined) return fill(out, el('p', { class: 'note' }, data.error || 'Could not load.'));
  if (!data.sandbox)
    return fill(
      out,
      empty('No running sandbox', 'Send the agent a message; its sandbox starts and blocked requests show up here.'),
    );
  if (status === 'pending') {
    $('count-approvals').textContent = data.chunks.length;
    $('count-approvals').classList.toggle('attn', data.chunks.length > 0);
  }
  const words = { pending: 'waiting', approved: 'allowed', rejected: 'denied' };
  fill(
    out,
    data.error ? el('p', { class: 'note' }, data.error) : null,
    data.chunks.length
      ? el(
          'div',
          { class: 'list' },
          data.chunks.map((c) => proposalCard(c, data.sandbox, status)),
        )
      : empty(
          `No ${words[status]} requests`,
          status === 'pending' ? 'Everything the agent tried is allowed, or it has not tried anything new.' : '',
        ),
    data.note
      ? el('details', {}, el('summary', {}, 'About agent-drafted rules'), el('p', { class: 'small muted' }, data.note))
      : null,
    el('details', {}, el('summary', {}, 'Raw OpenShell output'), el('pre', {}, data.output || '(none)')),
  );
};

function proposalCard(c, sandbox, status) {
  const targets = c.targets || [];
  const bin = c.binary || '';
  const route = targets.length
    ? targets.map((t) => `${t.host}:${t.port}`).join(', ')
    : (c.rule || '').replace(/^allow_/, '');
  const btns = el('div', { class: 'btns' });
  if (status === 'pending') {
    const always = el(
      'button',
      { class: 'ok sm', type: 'button', title: 'Allow now and for every future sandbox of this group' },
      'Always allow',
    );
    const once = el(
      'button',
      { class: 'ghost sm', type: 'button', title: 'Allow in the running sandbox only' },
      'Just this sandbox',
    );
    const deny = el('button', { class: 'danger sm', type: 'button' }, 'Deny');
    always.addEventListener('click', () =>
      busy(always, async () => {
        if (!(await decide('approve', sandbox, c))) return;
        if (!targets.length || !bin) {
          toast('Allowed for this sandbox', 'Could not read the host to save it for the group.', 'warn');
          return loaders.approvals();
        }
        const t = targets[0];
        const r = await api('POST', '/api/groups/network', {
          group: group(),
          name: (c.rule || slug(`${t.host}-${t.port}`)).slice(0, 63),
          host: t.host,
          ports: targets
            .filter((x) => x.host === t.host)
            .map((x) => x.port)
            .join(','),
          binaries: [bin],
        });
        if (r.ok) toast(`Always allowed ${t.host}`, 'Saved for the group; future sandboxes get it too.');
        else
          toast(`Allowed ${t.host} for this sandbox only`, `Saving it for the group failed: ${r.data.error}`, 'warn');
        await loaders.approvals();
        refreshCounts().catch(() => {});
      }),
    );
    once.addEventListener('click', () =>
      busy(once, async () => {
        if (await decide('approve', sandbox, c)) toast(`Allowed ${route}`, 'In the running sandbox only.');
        await loaders.approvals();
      }),
    );
    deny.addEventListener('click', () => {
      const reason = el('input', { type: 'text', placeholder: 'reason (optional)', style: 'max-width:14rem' });
      const go = el('button', { class: 'danger solid sm', type: 'button' }, 'Deny');
      go.addEventListener('click', () =>
        busy(go, async () => {
          if (await decide('reject', sandbox, c, reason.value || 'denied from the setup UI')) toast(`Denied ${route}`);
          await loaders.approvals();
        }),
      );
      fill(
        btns,
        reason,
        go,
        el('button', { class: 'ghost sm', type: 'button', onclick: () => loaders.approvals() }, 'Cancel'),
      );
      reason.focus();
    });
    btns.append(always, once, deny);
  } else {
    btns.append(
      el(
        'span',
        { class: `badge ${status === 'approved' ? 'ok' : 'bad'}` },
        status === 'approved' ? 'allowed' : 'denied',
      ),
    );
  }
  return el(
    'div',
    { class: 'item proposal' },
    el('div', { class: 'icon', 'aria-hidden': 'true' }, '⛔'),
    el(
      'div',
      { class: 'body' },
      el(
        'div',
        { class: 'route' },
        el('span', { class: 'tag', title: bin }, shortBin(bin) || '?'),
        ' → ',
        el('b', {}, route),
      ),
      el(
        'div',
        { class: 'why' },
        [c.rationale, c.hits ? `${c.hits.split(' ')[0]} attempts` : null].filter(Boolean).join(' · '),
      ),
    ),
    btns,
  );
}

async function decide(action, sandbox, c, reason) {
  const { ok, data } = await api('POST', `/api/policy/${action}`, {
    group: group(),
    sandbox,
    chunkId: c.chunkId,
    reason,
  });
  if (!ok || !data.ok) {
    toast(`Could not ${action}`, data.error || '', 'bad');
    return false;
  }
  return true;
}

// ---- Activity ----------------------------------------------------------------------
const ACTIONS = {
  'provider-attach': 'Provider attached',
  'provider-detach': 'Provider detached',
  'network-add': 'Host allowed',
  'network-remove': 'Host removed',
  'add-rule': 'Rule added',
  'apply-preset': 'Preset applied',
  approve: 'Request allowed',
  reject: 'Request denied',
};
loaders.audit = async () => {
  const out = $('audit-result');
  if (!out.childElementCount) fill(out, spinner());
  const { data } = await api('GET', `/api/groups/audit?group=${enc(group())}`);
  if (!data.entries) return fill(out, el('p', { class: 'note' }, data.error || 'Could not load activity.'));
  const entries = [...data.entries].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  fill(
    out,
    data.remoteError
      ? el('p', { class: 'note' }, `OpenShell's own decision list is unavailable: ${data.remoteError}`)
      : null,
    entries.length
      ? el(
          'ul',
          { class: 'feed' },
          entries.map((a) => {
            const good = ['applied', 'approved'].includes(a.outcome);
            const bad = ['rejected', 'failed'].includes(a.outcome);
            return el(
              'li',
              {},
              el('span', { class: 'when', title: a.ts || '' }, relTime(a.ts)),
              el(
                'div',
                {},
                el(
                  'div',
                  { class: 'what' },
                  ACTIONS[a.action] || a.action,
                  a.sandbox ? el('span', { class: 'muted small' }, ' · in the running sandbox') : null,
                ),
                el('div', { class: 'detail' }, a.detail + (a.error ? ` — ${a.error}` : '')),
              ),
              el('span', { class: `badge ${good ? 'ok' : bad ? 'bad' : ''}` }, a.outcome),
            );
          }),
        )
      : empty('Nothing yet', 'Changes made here, and decisions on blocked requests, show up in this list.'),
    el(
      'p',
      { class: 'muted small' },
      'Logs: ',
      el('code', {}, data.logs.changes),
      ' · ',
      el('code', {}, data.logs.decisions),
    ),
  );
};
$('audit-load').addEventListener('click', (e) => busy(e.target, () => loaders.audit()));

// ---- start -------------------------------------------------------------------------
(async () => {
  netBins = programPicker($('net-bins'));
  try {
    const saved = localStorage.getItem('openshell-ui-tab');
    if (saved && $(`tab-${saved}`)) state.tab = saved;
  } catch {
    // storage unavailable
  }
  const status = api('GET', '/api/status').then(({ data }) => showCred(data.credential, data.gateway));
  await Promise.all([status, loadGateway(), loadTypes()]);
  await loadGroups();
  // Keep the header and the waiting-request count fresh while the page is open.
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !group()) return;
    refreshCounts().catch(() => {});
    if (state.tab === 'approvals') loaders.approvals().catch(() => {});
  }, 20000);
})().catch((err) => toast('Could not load the page', String(err), 'bad'));
