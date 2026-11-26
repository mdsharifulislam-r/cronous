// Chronos dashboard. Plain ES modules, no build step, no third-party code.
// All dynamic text is inserted with text nodes (never innerHTML): job names, error
// messages and webhook responses are untrusted input.

const TOKEN_KEY = 'chronos.token';
const SELECTION_KEY = 'chronos.selection';

const state = {
  token: safeGet(sessionStorage, TOKEN_KEY),
  me: null,
  orgId: null,
  projectId: null,
  projects: [],
  tab: 'overview',
  drawer: null,
  refreshTimer: null,
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function safeGet(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}
function safeSet(storage, key, value) {
  try { value === null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* storage unavailable */ }
}

/** Creates an element. Children may be nodes, strings, numbers, arrays, null/false. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key in el && key !== 'list') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  const append = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return child.forEach(append);
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(append);
  return el;
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function fmtRelative(value) {
  if (!value) return '—';
  const diff = new Date(value).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units = [['day', 86400000], ['hour', 3600000], ['minute', 60000], ['second', 1000]];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff / ms), unit);
    }
  }
  return '—';
}

const STATUS_TONE = {
  SUCCEEDED: 'ok', ONLINE: 'ok', ACTIVE: 'ok',
  FAILED: 'bad', DEAD_LETTERED: 'bad', OFFLINE: 'muted', TIMED_OUT: 'bad', ABANDONED: 'warn',
  RUNNING: 'info', QUEUED: 'info', PENDING: 'muted', RETRY_SCHEDULED: 'warn', CANCELLED: 'muted',
  PAUSED: 'warn', COMPLETED: 'muted', DRAINING: 'warn',
};
const badge = (status) => h('span', { class: `badge ${STATUS_TONE[status] ?? 'muted'}` }, status);

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function api(path, options = {}) {
  const response = await fetch(`/v1${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && state.token) logout();
    throw new ApiError(response.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `HTTP ${response.status}`);
  }
  return json?.data ?? null;
}

function toast(message, isError = false) {
  const el = h('div', { class: isError ? 'card error' : 'card', role: 'status', style: 'position:fixed;bottom:16px;left:16px;z-index:20;max-width:420px' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

async function act(label, fn) {
  try {
    await fn();
    toast(label);
    await render();
  } catch (error) {
    toast(error.message, true);
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function logout() {
  state.token = null;
  state.me = null;
  safeSet(sessionStorage, TOKEN_KEY, null);
  render();
}

async function renderLogin(root) {
  let bootstrapped = true;
  try { bootstrapped = (await api('/bootstrap/status')).bootstrapped; } catch { /* server unreachable */ }
  const error = h('div', { class: 'error', role: 'alert' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', {
    class: 'form',
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        const result = await api('/auth/login', { method: 'POST', body: { email: email.value, password: password.value } });
        state.token = result.token;
        safeSet(sessionStorage, TOKEN_KEY, result.token);
        await render();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    },
  }, h('label', {}, 'Email', email), h('label', {}, 'Password', password), submit, error);

  root.append(h('div', { class: 'card login' },
    h('h2', {}, 'Chronos'),
    bootstrapped ? null : h('div', { class: 'notice' },
      'This installation is not bootstrapped yet. Use the bootstrap token printed in the server log with POST /v1/bootstrap (see docs/DEPLOYMENT_GUIDE.md).'),
    form,
  ));
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const TABS = [
  ['overview', 'Overview'],
  ['jobs', 'Jobs'],
  ['executions', 'Executions'],
  ['agents', 'Agents'],
  ['workers', 'Workers'],
  ['credentials', 'Credentials'],
];

function currentRole() {
  return state.me?.organizations.find((org) => org.id === state.orgId)?.role ?? null;
}
const canEdit = () => ['OWNER', 'ADMIN', 'MEMBER'].includes(currentRole());
const isAdmin = () => ['OWNER', 'ADMIN'].includes(currentRole());

async function loadContext() {
  state.me = await api('/auth/me');
  const saved = JSON.parse(safeGet(localStorage, SELECTION_KEY) ?? '{}');
  const orgs = state.me.organizations;
  state.orgId = orgs.some((org) => org.id === state.orgId) ? state.orgId : (orgs.find((org) => org.id === saved.orgId) ?? orgs[0])?.id ?? null;
  state.projects = state.orgId ? await api(`/organizations/${state.orgId}/projects`) : [];
  const preferred = state.projects.find((p) => p.id === state.projectId) ?? state.projects.find((p) => p.id === saved.projectId) ?? state.projects[0];
  state.projectId = preferred?.id ?? null;
  safeSet(localStorage, SELECTION_KEY, JSON.stringify({ orgId: state.orgId, projectId: state.projectId }));
}

function topbar() {
  const orgSelect = h('select', {
    'aria-label': 'Organization',
    onchange: async (event) => { state.orgId = event.target.value; state.projectId = null; await render(true); },
  }, state.me.organizations.map((org) => h('option', { value: org.id, selected: org.id === state.orgId }, org.name)));
  const projectSelect = h('select', {
    'aria-label': 'Project',
    onchange: async (event) => { state.projectId = event.target.value; await render(true); },
  }, state.projects.map((project) => h('option', { value: project.id, selected: project.id === state.projectId }, `${project.name} (${project.timezone})`)));
  return h('header', { class: 'topbar' },
    h('span', { class: 'brand' }, 'Chronos'), orgSelect, projectSelect,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted' }, `${state.me.email} · ${currentRole() ?? ''}`),
    h('button', { class: 'btn', onclick: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => undefined); logout(); } }, 'Sign out'),
  );
}

function tabs() {
  return h('nav', { class: 'tabs', role: 'tablist' }, TABS.map(([id, label]) =>
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === id), onclick: () => { state.tab = id; render(); } }, label)));
}

let rendering = false;
async function render(reloadContext = false) {
  if (rendering) return;
  rendering = true;
  const root = document.getElementById('app');
  try {
    if (!state.token) {
      root.replaceChildren();
      await renderLogin(root);
      return;
    }
    if (!state.me || reloadContext) await loadContext();
    const main = h('main');
    if (!state.projectId) {
      main.append(h('div', { class: 'card' }, 'No projects yet. Create one with POST /v1/organizations/:orgId/projects.'));
    } else {
      await VIEWS[state.tab](main);
    }
    root.replaceChildren(topbar(), tabs(), main);
    if (state.drawer) root.append(await state.drawer());
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
    root.replaceChildren(h('main', {}, h('div', { class: 'card error' }, `Failed to load: ${error.message}`)));
  } finally {
    rendering = false;
  }
}

function table(headers, rows, onRowClick) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, headers.map((label) => h('th', { scope: 'col' }, label)))),
    h('tbody', {}, rows.length === 0
      ? h('tr', {}, h('td', { colSpan: headers.length, class: 'muted' }, 'Nothing here yet.'))
      : rows.map(({ cells, key }) => h('tr', { class: onRowClick ? 'clickable' : '', onclick: onRowClick ? () => onRowClick(key) : undefined }, cells.map((cell) => h('td', {}, cell))))),
  ));
}

const P = () => `/projects/${state.projectId}`;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const VIEWS = {
  async overview(main) {
    const [stats, failures] = await Promise.all([
      api(`${P()}/stats?hours=24`),
      api(`${P()}/executions?status=FAILED,DEAD_LETTERED&limit=10`),
    ]);
    const count = (status) => stats.executions[status] ?? 0;
    const tile = (label, value) => h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, String(value)));
    main.append(
      h('div', { class: 'tiles' },
        tile('Jobs', stats.jobs), tile('Agents online', stats.agentsOnline),
        tile('Succeeded (24h)', count('SUCCEEDED')), tile('Running', count('RUNNING') + count('QUEUED')),
        tile('Retrying', count('RETRY_SCHEDULED')), tile('Failed / dead (24h)', count('FAILED') + count('DEAD_LETTERED'))),
      h('div', { class: 'card' }, h('h2', {}, 'Recent failures'), executionsTable(failures.items)),
    );
  },

  async jobs(main) {
    const jobs = await api(`${P()}/jobs`);
    const rows = jobs.map((job) => ({
      key: job.id,
      cells: [
        h('strong', {}, job.name),
        job.mode,
        job.schedule ? (job.schedule.cron ? h('code', {}, job.schedule.cron) : `once @ ${fmtDate(job.schedule.runAt)}`) : h('span', { class: 'muted' }, 'manual'),
        job.schedule ? job.schedule.timezone : '—',
        job.schedule?.nextRunAt ? h('span', { title: fmtDate(job.schedule.nextRunAt) }, fmtRelative(job.schedule.nextRunAt)) : '—',
        job.enabled ? (job.schedule ? badge(job.schedule.state) : badge('ACTIVE')) : badge('DISABLED'),
        job.source,
        canEdit() ? h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); act('Triggered', () => api(`${P()}/jobs/${job.id}/trigger`, { method: 'POST', body: {} })); } }, 'Run now'),
          job.schedule && job.schedule.state !== 'COMPLETED'
            ? h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); const op = job.schedule.state === 'PAUSED' ? 'resume' : 'pause'; act(op === 'pause' ? 'Paused' : 'Resumed', () => api(`${P()}/jobs/${job.id}/${op}`, { method: 'POST' })); } }, job.schedule.state === 'PAUSED' ? 'Resume' : 'Pause')
            : null,
          h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); act(job.enabled ? 'Disabled' : 'Enabled', () => api(`${P()}/jobs/${job.id}`, { method: 'PATCH', body: { enabled: !job.enabled } })); } }, job.enabled ? 'Disable' : 'Enable'),
        ) : null,
      ],
    }));
    main.append(h('div', { class: 'card' }, h('h2', {}, 'Jobs'),
      table(['Name', 'Mode', 'Schedule', 'Time zone', 'Next run', 'State', 'Source', ''], rows, (jobId) => {
        state.tab = 'executions';
        executionFilter.jobId = jobId;
        render();
      })));
  },

  async executions(main) {
    const params = new URLSearchParams({ limit: '50' });
    if (executionFilter.status) params.set('status', executionFilter.status);
    if (executionFilter.jobId) params.set('jobId', executionFilter.jobId);
    const page = await api(`${P()}/executions?${params}`);
    const statusSelect = h('select', {
      'aria-label': 'Status filter',
      onchange: (event) => { executionFilter.status = event.target.value; render(); },
    }, ['', 'RUNNING', 'QUEUED', 'PENDING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED']
      .map((status) => h('option', { value: status, selected: executionFilter.status === status }, status || 'All statuses')));
    main.append(h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', { style: 'margin:0' }, 'Executions'), statusSelect,
        executionFilter.jobId ? h('button', { class: 'btn', onclick: () => { executionFilter.jobId = null; render(); } }, 'Clear job filter') : null,
        h('button', { class: 'btn', onclick: () => render() }, 'Refresh')),
      executionsTable(page.items),
    ));
  },

  async agents(main) {
    const agents = await api(`${P()}/agents`);
    main.append(h('div', { class: 'card' }, h('h2', {}, 'Agents (SDK processes)'),
      table(['Status', 'Host', 'Instance', 'SDK', 'Tasks', 'Last heartbeat', 'Connected'], agents.map((agent) => ({
        key: agent.id,
        cells: [badge(agent.status), agent.hostname ?? '—', h('code', {}, agent.instanceId.slice(0, 12)), agent.sdkVersion,
          agent.handlers.join(', '), fmtRelative(agent.lastHeartbeatAt), fmtDate(agent.connectedAt)],
      })))));
  },

  async workers(main) {
    const workers = await api('/workers');
    main.append(h('div', { class: 'card' }, h('h2', {}, 'Workers'),
      table(['Status', 'Host', 'Instance', 'Version', 'Concurrency', 'Last heartbeat', 'Started'], workers.map((worker) => ({
        key: worker.id,
        cells: [badge(worker.status), worker.hostname ?? '—', h('code', {}, worker.instanceId.slice(0, 12)), worker.version,
          String(worker.concurrency), fmtRelative(worker.lastHeartbeatAt), fmtDate(worker.startedAt)],
      })))));
  },

  async credentials(main) {
    if (!isAdmin()) {
      main.append(h('div', { class: 'card muted' }, 'Only organization owners and admins can manage credentials.'));
      return;
    }
    const credentials = await api(`${P()}/credentials`);
    const name = h('input', { placeholder: 'e.g. api-server production', required: true, maxLength: 80 });
    const kind = h('select', {}, h('option', { value: 'AGENT' }, 'Agent token (SDK)'), h('option', { value: 'PROJECT' }, 'Project API key'));
    const reveal = h('div');
    const showSecret = (token) => reveal.replaceChildren(h('div', { class: 'notice' },
      h('p', {}, 'Copy this token now. It will not be shown again.'), h('div', { class: 'secret' }, token)));
    main.append(
      h('div', { class: 'card' }, h('h2', {}, 'Create credential'),
        h('form', {
          class: 'form', onsubmit: async (event) => {
            event.preventDefault();
            try {
              const created = await api(`${P()}/credentials`, { method: 'POST', body: { kind: kind.value, name: name.value } });
              await render();
              document.querySelector('#reveal')?.replaceWith(reveal);
              showSecret(created.token);
            } catch (error) { toast(error.message, true); }
          },
        }, h('label', {}, 'Type', kind), h('label', {}, 'Name', name), h('button', { class: 'btn primary', type: 'submit' }, 'Create')),
        h('div', { id: 'reveal' }, reveal)),
      h('div', { class: 'card' }, h('h2', {}, 'Active credentials'),
        table(['Name', 'Type', 'Prefix', 'Last used', 'Expires', 'Created', ''], credentials.map((credential) => ({
          key: credential.id,
          cells: [credential.name, credential.kind, h('code', {}, `${credential.displayPrefix}…`), fmtRelative(credential.lastUsedAt),
            credential.expiresAt ? fmtDate(credential.expiresAt) : 'never', fmtDate(credential.createdAt),
            h('div', { class: 'actions' },
              h('button', { class: 'btn', onclick: async () => {
                if (!confirm(`Rotate "${credential.name}"? The old token keeps working for 1 hour.`)) return;
                try {
                  const rotated = await api(`${P()}/credentials/${credential.id}/rotate`, { method: 'POST', body: { gracePeriodSeconds: 3600 } });
                  await render();
                  document.querySelector('#reveal')?.replaceWith(reveal);
                  showSecret(rotated.credential.token);
                } catch (error) { toast(error.message, true); }
              } }, 'Rotate'),
              h('button', { class: 'btn danger', onclick: () => {
                if (confirm(`Revoke "${credential.name}" immediately?`)) act('Revoked', () => api(`${P()}/credentials/${credential.id}`, { method: 'DELETE' }));
              } }, 'Revoke')),
          ],
        })))),
    );
  },
};

const executionFilter = { status: '', jobId: null };

function executionsTable(items) {
  return table(['Status', 'Job', 'Trigger', 'Scheduled for', 'Attempts', 'Finished', 'Last error'], items.map((execution) => ({
    key: execution.id,
    cells: [badge(execution.status), execution.jobName, execution.trigger, fmtDate(execution.scheduledFor),
      h('span', { class: 'num' }, `${execution.attemptCount}/${execution.maxAttempts}`), fmtRelative(execution.finishedAt),
      execution.lastError ? h('span', { class: 'muted', title: execution.lastError }, execution.lastError.slice(0, 80)) : '—'],
  })), (executionId) => openExecution(executionId));
}

function openExecution(executionId) {
  state.drawer = async () => {
    const execution = await api(`${P()}/executions/${executionId}`);
    const close = () => { state.drawer = null; render(); };
    const finished = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTERED'].includes(execution.status);
    return h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Execution details' },
      h('header', {}, h('h3', {}, execution.jobName), badge(execution.status), h('span', { class: 'spacer' }),
        canEdit() && !finished ? h('button', { class: 'btn danger', onclick: () => act('Cancelled', () => api(`${P()}/executions/${executionId}/cancel`, { method: 'POST' })) }, 'Cancel') : null,
        canEdit() && ['FAILED', 'DEAD_LETTERED', 'CANCELLED'].includes(execution.status)
          ? h('button', { class: 'btn', onclick: () => act('Re-queued', () => api(`${P()}/executions/${executionId}/retry`, { method: 'POST' })) }, 'Retry') : null,
        h('button', { class: 'btn', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('dl', { class: 'meta' },
        h('dt', {}, 'Execution'), h('dd', {}, h('code', {}, execution.id)),
        h('dt', {}, 'Idempotency key'), h('dd', {}, h('code', {}, execution.idempotencyKey)),
        h('dt', {}, 'Trigger'), h('dd', {}, execution.trigger),
        h('dt', {}, 'Scheduled for'), h('dd', {}, fmtDate(execution.scheduledFor)),
        h('dt', {}, 'Attempts'), h('dd', {}, `${execution.attemptCount} of ${execution.maxAttempts}`),
        h('dt', {}, 'Next attempt'), h('dd', {}, execution.status === 'RETRY_SCHEDULED' ? fmtDate(execution.nextAttemptAt) : '—'),
        h('dt', {}, 'Finished'), h('dd', {}, fmtDate(execution.finishedAt)),
        h('dt', {}, 'Last error'), h('dd', {}, execution.lastError ?? '—')),
      execution.payload !== null ? [h('h4', {}, 'Payload'), h('pre', {}, JSON.stringify(execution.payload, null, 2))] : null,
      execution.result !== null ? [h('h4', {}, 'Result'), h('pre', {}, JSON.stringify(execution.result, null, 2))] : null,
      h('h4', {}, 'Attempts'),
      table(['#', 'Status', 'Executor', 'Started', 'Finished', 'Error'], execution.attempts.map((attempt) => ({
        key: attempt.id,
        cells: [String(attempt.attemptNumber), badge(attempt.status),
          attempt.agent ? `agent ${attempt.agent.hostname ?? attempt.agent.instanceId.slice(0, 8)}` : attempt.worker ? `worker ${attempt.worker.hostname ?? attempt.worker.instanceId.slice(0, 8)}` : '—',
          fmtDate(attempt.startedAt), fmtDate(attempt.finishedAt),
          attempt.errorMessage ? `${attempt.errorCode ? `[${attempt.errorCode}] ` : ''}${attempt.errorMessage}` : (attempt.httpStatus ? `HTTP ${attempt.httpStatus}` : '—')],
      }))),
      h('h4', {}, 'Logs'),
      execution.logs.length === 0 ? h('p', { class: 'muted' }, 'No log lines.') :
        h('div', {}, execution.logs.map((log) => h('div', { class: 'log-line' },
          h('span', { class: 'muted' }, new Date(log.createdAt).toLocaleTimeString()), h('span', {}, log.level),
          h('span', {}, log.message, log.data ? ` ${JSON.stringify(log.data)}` : '')))),
    );
  };
  render();
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.drawer) { state.drawer = null; render(); }
});

// Light auto-refresh while visible; skipped while a drawer or form is in use.
setInterval(() => {
  if (document.visibilityState === 'visible' && state.token && !state.drawer && !['credentials'].includes(state.tab)) render();
}, 15000);

render();
