/**
 * The dashboard's static assets.
 *
 * No framework, no CDN, no inline script or style: the server sets a strict content
 * security policy and these three files are served from the same loopback origin. All data
 * is inserted with `textContent`, never `innerHTML`, because ticket text and file paths are
 * untrusted input.
 */

export const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>anvil dashboard</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header>
  <h1>anvil</h1>
  <span id="scope"></span>
  <span id="stamp"></span>
  <button id="refresh" type="button">Refresh</button>
</header>
<nav>
  <button class="tab active" data-view="task" type="button">Task brief</button>
  <button class="tab" data-view="repository" type="button">Repository</button>
  <button class="tab" data-view="context" type="button">Context</button>
  <button class="tab" data-view="work" type="button">Work</button>
</nav>
<main>
  <p id="notes" class="notes"></p>
  <section id="task">
    <div class="card">
      <h2>Start from a task</h2>
      <p class="muted">Paste a ticket or a task description. The brief is built from this repository's snapshot; the text is not sent anywhere else, and nothing is created in a tracker.</p>
      <label class="muted" for="task-text">Task text</label>
      <textarea id="task-text" rows="6" maxlength="4000" placeholder="Paste the ticket title and body, or describe the change you want to make."></textarea>
      <div class="row">
        <button id="task-submit" type="button">Build brief</button>
        <span id="task-error" class="muted" role="status"></span>
      </div>
    </div>
    <div class="card">
      <h2>Or start from a repository suggestion</h2>
      <p class="muted">From <code>anvil plan</code>, which reads this repository's own findings. These are engineering improvements, not confirmed team priorities.</p>
      <div id="task-suggestions"></div>
    </div>
    <div id="task-brief"></div>
  </section>
  <section id="repository" hidden></section>
  <section id="context" hidden></section>
  <section id="work" hidden></section>
</main>
<script src="/app.js" defer></script>
</body>
</html>
`

export const CSS = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; padding: 0 1rem 3rem; }
header { display: flex; gap: 1rem; align-items: baseline; padding: 1rem 0; border-bottom: 1px solid #8886; }
h1 { margin: 0; font-size: 1.4rem; }
#scope { color: #888; }
#stamp { color: #888; font-size: 0.85rem; }
#refresh { margin-left: auto; }
nav { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 1rem 0; }
button { cursor: pointer; }
.tab.active { font-weight: bold; text-decoration: underline; }
section { max-width: 70rem; }
h2 { font-size: 1.1rem; margin-top: 1.5rem; }
h3 { font-size: 0.95rem; margin: 1rem 0 0.35rem; }
.notes { color: #888; font-size: 0.85rem; }
.card { border: 1px solid #8886; border-radius: 6px; padding: 0.75rem 1rem; margin: 0.5rem 0; }
.error { border-left: 4px solid #c33; background: #c33110; padding: 0.5rem 0.75rem; margin: 0.5rem 0; }
.badge { display: inline-block; border-radius: 4px; padding: 0 0.35rem; margin-right: 0.4rem; font-size: 0.8rem; border: 1px solid #8888; }
.badge.fail, .badge.blocker, .badge.high, .badge.missing, .badge.empty, .badge.unreachable, .badge.unsatisfied { color: #c33; border-color: #c338; }
.badge.warn, .badge.medium { color: #a60; border-color: #a608; }
.badge.unknown, .badge.na { color: #888; }
.badge.ok, .badge.pass, .badge.verified, .badge.available, .badge.satisfied, .badge.present, .badge.reachable { color: #282; border-color: #2828; }
.row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: baseline; }
.muted { color: #888; font-size: 0.85rem; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #8881; padding: 0.5rem; border-radius: 4px; }
code { font-family: ui-monospace, monospace; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #8884; vertical-align: top; }
label { display: block; margin: 0.5rem 0 0.25rem; }
textarea { width: 100%; padding: 0.5rem; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; font: inherit; resize: vertical; }
.objective { white-space: pre-wrap; overflow-wrap: anywhere; }
.path { font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.suggestion { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-start; padding: 0.5rem 0; border-top: 1px solid #8884; }
.suggestion:first-child { border-top: 0; }
.suggestion .body { flex: 1 1 24rem; min-width: 0; }
.check { padding: 0.4rem 0; border-top: 1px solid #8884; }
.check:first-of-type { border-top: 0; }
.check .path { display: block; margin-top: 0.15rem; }
ul { margin: 0.25rem 0; padding-left: 1.25rem; }
li { margin: 0.2rem 0; }
`

export const JS = `const state = { view: 'task', snapshot: null, loading: false, brief: null, taskError: null, taskPending: false };

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// Exact statuses, not substrings: unavailable contains available, but it is an absence
// of evidence and must never inherit the success colour.
const BADGE_KINDS = {
  fail: 'fail',
  blocker: 'blocker',
  high: 'high',
  warn: 'warn',
  medium: 'medium',
  missing: 'missing',
  empty: 'empty',
  unreachable: 'unreachable',
  unsatisfied: 'unsatisfied',
  incompatible: 'fail',
  blocked: 'blocker',
  unavailable: 'unknown',
  declared: 'warn',
  pass: 'pass',
  ok: 'ok',
  verified: 'verified',
  available: 'available',
  satisfied: 'satisfied',
  present: 'present',
  reachable: 'reachable',
  unknown: 'unknown',
  na: 'na',
};

function badge(text) {
  const normalized = String(text === undefined || text === null || text === '' ? 'unknown' : text).toLowerCase();
  const kind = BADGE_KINDS[normalized] || 'muted';
  return make('span', 'badge ' + kind, text);
}

function sourceCard(parent, source, label) {
  const card = make('div', 'card');
  card.appendChild(make('h2', '', label));
  if (!source || source.ok === false) {
    card.appendChild(make('div', 'error', (source && source.error) || 'no data'));
    if (source && source.command) card.appendChild(make('div', 'muted', source.command));
    parent.appendChild(card);
    return false;
  }
  card.appendChild(make('div', 'muted', source.command + ' · ' + source.fetchedAt));
  parent.appendChild(card);
  return true;
}

function summaryLine(parent, label, value) {
  parent.appendChild(make('div', 'row', label + ': ' + (value === undefined || value === null ? 'unknown' : String(value))));
}

/** Every required need that made the readiness report blocked, with its own status and cause. */
function blockedNeeds(report) {
  const needs = [];
  function add(list, idOf, statuses) {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      // An optional capability that is missing is guidance, not a blocker. Context entries
      // have no required field and are always real needs, so they pass this check.
      if (entry && entry.required === false) continue;
      const status = String(entry && entry.status ? entry.status : 'unknown');
      if (!statuses.includes(status)) continue;
      needs.push({
        id: idOf(entry),
        status,
        reason: entry && entry.reason ? entry.reason : (entry && entry.detail) || null,
      });
    }
  }
  add(report.tools, (t) => t.id || t.bin || 'tool', ['missing', 'unavailable', 'incompatible']);
  add(report.env, (e) => e.name || 'environment variable', ['missing', 'empty']);
  add(report.services, (s) => s.id || 'service', ['unreachable']);
  add(report.references, (r) => r.path || r.id || 'reference', ['missing']);
  add(report.credentials, (c) => c.id || 'credential', ['missing', 'empty']);
  add(report.access, (a) => a.id || a.kind || 'access', ['missing', 'empty']);
  add(report.hardware, (h) => h.id || 'hardware', ['unsatisfied']);
  add(report.context, (c) => c.label || c.id || 'context', ['blocked']);
  return needs;
}

function renderFindings(parent, report) {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const notable = findings.filter((f) => ['fail', 'warn', 'blocker'].includes(String(f.status)));
  parent.appendChild(make('h2', '', 'Findings'));
  if (notable.length === 0) {
    parent.appendChild(make('div', 'muted', 'No failed or warning findings in this snapshot.'));
    return;
  }
  for (const finding of notable.slice(0, 30)) {
    const row = make('div', 'card');
    row.appendChild(badge(finding.status));
    row.appendChild(badge(finding.severity || 'unknown'));
    row.appendChild(make('strong', '', finding.id || 'finding'));
    const detail = finding.detail || finding.message || finding.fix || '';
    if (detail) row.appendChild(make('div', '', detail));
    const evidence = finding.evidence;
    if (evidence) row.appendChild(make('div', 'muted', Array.isArray(evidence) ? evidence.join('; ') : String(evidence)));
    parent.appendChild(row);
  }
}

function renderRepository(root, snap) {
  const parent = root.querySelector('#repository');
  parent.replaceChildren();
  const doctor = snap.repository.doctor;
  if (sourceCard(parent, doctor, 'Repository readiness')) {
    const data = doctor.data || {};
    summaryLine(parent, 'Score', data.score === undefined ? 'unknown' : String(data.score) + '/100 ' + (data.grade || ''));
    if (Array.isArray(data.degraded) && data.degraded.length > 0) {
      parent.appendChild(make('div', 'error', 'Incomplete profile: ' + data.degraded.map((d) => d.reason || String(d)).join('; ')));
    }
    renderFindings(parent, data);
  }
  const ready = snap.repository.ready;
  if (sourceCard(parent, ready, 'What an AI needs here')) {
    const data = ready.data || {};
    summaryLine(parent, 'Status', data.status);
    summaryLine(parent, 'Checked', data.checked ? 'yes' : 'no (pass --check to probe)');
    const blocked = blockedNeeds(data);
    if (blocked.length > 0) {
      const card = make('div', 'card');
      card.appendChild(make('h2', '', 'Blocked needs'));
      for (const need of blocked) {
        const row = make('div', 'row');
        row.appendChild(badge(need.status));
        row.appendChild(make('strong', '', need.id));
        if (need.reason) row.appendChild(make('span', '', need.reason));
        card.appendChild(row);
      }
      parent.appendChild(card);
    }
  }
  const plan = snap.repository.plan;
  if (sourceCard(parent, plan, 'Recommended next steps')) {
    const data = plan.data || {};
    summaryLine(parent, 'Suggestions', data.satisfied === undefined ? '' : String(data.satisfied) + ' already satisfied');
    const suggestions = Array.isArray(data.suggestions) ? data.suggestions.slice(0, 12) : [];
    for (const suggestion of suggestions) {
      const row = make('div', 'card');
      row.appendChild(badge(suggestion.tier));
      row.appendChild(make('strong', '', suggestion.id || 'suggestion'));
      if (suggestion.title) row.appendChild(make('span', '', suggestion.title));
      const detail = suggestion.detail || suggestion.why;
      if (detail) row.appendChild(make('div', '', detail));
      if (Array.isArray(suggestion.evidence) && suggestion.evidence.length > 0) {
        row.appendChild(make('div', 'muted', suggestion.evidence.join('; ')));
      }
      parent.appendChild(row);
    }
  }
}

function renderContext(root, snap) {
  const parent = root.querySelector('#context');
  parent.replaceChildren();
  const brief = snap.context.brief;
  if (sourceCard(parent, brief, 'Verified context')) {
    const data = brief.data || {};
    summaryLine(parent, 'Target', data.target);
    const gaps = Array.isArray(data.gaps) ? data.gaps : [];
    parent.appendChild(make('h2', '', 'Open gaps'));
    if (gaps.length === 0) parent.appendChild(make('div', 'muted', 'No gaps reported.'));
    for (const gap of gaps.slice(0, 20)) {
      parent.appendChild(make('div', 'card', typeof gap === 'string' ? gap : (gap.title || gap.id || JSON.stringify(gap))));
    }
  }
  const staged = snap.context.staged;
  if (sourceCard(parent, staged, 'Staged changes')) {
    const data = staged.data || {};
    if (!data.exists) {
      parent.appendChild(make('div', 'muted', 'No staged bundle. Run anvil init to prepare one; this view never prepares it for you.'));
    } else {
      summaryLine(parent, 'Created', data.createdAt);
      summaryLine(parent, 'Summary', (data.summary && data.summary.files) + ' file(s), +' + (data.summary && data.summary.added) + ' -' + (data.summary && data.summary.removed));
      const files = Array.isArray(data.files) ? data.files : [];
      for (const file of files) {
        const card = make('div', 'card');
        card.appendChild(make('strong', '', file.path));
        if (file.error) {
          card.appendChild(make('div', 'error', file.error));
        } else {
          if (file.edited) card.appendChild(badge('edited since staging'));
          if (file.diff) card.appendChild(make('pre', '', file.diff));
          else card.appendChild(make('div', 'muted', 'No changes against the repository copy.'));
        }
        parent.appendChild(card);
      }
    }
  }
}

/** The CLI labels a missing worktree orphaned; the table must not show it as active. */
function worktreeState(person) {
  if (person.orphaned === true) return 'orphaned';
  if (person.present === false) return 'gone';
  return person.state === undefined || person.state === null ? '-' : String(person.state);
}

function renderWork(root, snap) {
  const parent = root.querySelector('#work');
  parent.replaceChildren();
  const crew = snap.work.crew;
  if (sourceCard(parent, crew, 'Claims and worktrees')) {
    const people = Array.isArray(crew.data && crew.data.crew) ? crew.data.crew : [];
    if (people.length === 0) {
      parent.appendChild(make('div', 'muted', 'No claims. Run anvil claim with a ticket to start one.'));
    } else {
      const table = make('table');
      const head = make('tr');
      for (const label of ['key', 'branch', 'worktree', 'uncommitted', 'unpushed', 'agent', 'state']) head.appendChild(make('th', '', label));
      table.appendChild(head);
      for (const person of people) {
        const row = make('tr');
        const present = person.present !== false;
        const values = [
          person.key,
          person.branch,
          person.worktree,
          present ? person.uncommitted : '-',
          present ? person.unpushed : '-',
          person.agentAlive === null ? '-' : person.agentAlive ? 'alive' : 'dead',
          worktreeState(person),
        ];
        for (const value of values) {
          row.appendChild(make('td', '', value === undefined || value === null ? '-' : String(value)));
        }
        table.appendChild(row);
      }
      parent.appendChild(table);
    }
  }
  const card = make('div', 'card');
  card.appendChild(make('h2', '', 'Verification'));
  card.appendChild(badge('unavailable'));
  card.appendChild(make('div', '', snap.verification.reason));
  parent.appendChild(card);
}

/** The brief itself: what to do, where to look, how to check, and what is still unknown. */
function renderBrief(parent, brief) {
  parent.replaceChildren();
  if (!brief) return;
  const card = make('div', 'card');
  card.appendChild(make('h2', '', 'Task brief'));
  card.appendChild(make('div', 'muted', 'From the snapshot at ' + brief.generatedAt + '. Nothing was run, written or sent to a tracker.'));
  card.appendChild(make('strong', '', brief.title));
  if (brief.objective) card.appendChild(make('div', 'objective', brief.objective));

  card.appendChild(make('h3', '', 'Start here'));
  const start = Array.isArray(brief.startHere) ? brief.startHere : [];
  if (start.length === 0) {
    card.appendChild(make('div', 'muted', 'No file in this repository matched the task. It may be a new file, or the task needs more context.'));
  } else {
    const list = make('ul');
    for (const item of start) {
      const entry = make('li');
      entry.appendChild(badge(item.kind));
      entry.appendChild(make('code', 'path', item.path));
      entry.appendChild(make('span', 'muted', ' · ' + item.reason));
      list.appendChild(entry);
    }
    card.appendChild(list);
  }

  card.appendChild(make('h3', '', 'How to check'));
  const checks = Array.isArray(brief.howToCheck) ? brief.howToCheck : [];
  if (checks.length === 0) {
    card.appendChild(make('div', 'muted', 'No verification command was detected or declared for this repository.'));
  } else {
    for (const check of checks) {
      const row = make('div', 'check');
      row.appendChild(make('strong', '', check.kind));
      row.appendChild(make('code', 'path', check.cmd));
      const detail = 'from ' + check.source + (check.evidence ? ' (' + check.evidence + ')' : '') + ' · run from ' + check.cwd;
      row.appendChild(make('div', 'muted', detail));
      card.appendChild(row);
    }
  }
  card.appendChild(make('div', 'muted', 'Not run: this page cannot execute commands. Run one in a worktree to produce evidence.'));

  card.appendChild(make('h3', '', 'Blocked or missing'));
  const blockers = Array.isArray(brief.blockers) ? brief.blockers : [];
  if (blockers.length === 0) {
    card.appendChild(make('div', 'muted', 'No blocked requirement is reported by anvil ready.'));
  } else {
    for (const blocker of blockers) {
      const row = make('div', 'row');
      row.appendChild(badge(blocker.status));
      row.appendChild(make('strong', '', blocker.label));
      if (blocker.reason) row.appendChild(make('span', '', blocker.reason));
      card.appendChild(row);
    }
  }

  card.appendChild(make('h3', '', 'Unknowns'));
  const unknowns = Array.isArray(brief.unknowns) ? brief.unknowns : [];
  const list = make('ul');
  for (const unknown of unknowns) list.appendChild(make('li', '', unknown));
  card.appendChild(list);
  parent.appendChild(card);
}

/** Suggested contributions come only from derived plan fixes, never from external reading. */
function renderSuggestions(parent, snap) {
  parent.replaceChildren();
  const plan = snap.repository.plan;
  if (!plan || plan.ok === false) {
    parent.appendChild(make('div', 'error', (plan && plan.error) || 'The plan source is unavailable.'));
    return;
  }
  const all = plan.data && Array.isArray(plan.data.suggestions) ? plan.data.suggestions : [];
  const suggestions = all.filter((entry) => entry && entry.tier === 'derived' && entry.external !== true).slice(0, 8);
  if (suggestions.length === 0) {
    parent.appendChild(make('div', 'muted', 'No repository suggestion is open. Paste a task above instead.'));
    return;
  }
  for (const suggestion of suggestions) {
    const row = make('div', 'suggestion');
    const button = make('button', '', 'Build brief');
    button.dataset.suggestion = suggestion.id || '';
    button.setAttribute('aria-label', 'Build a brief from: ' + (suggestion.title || suggestion.id || 'this suggestion'));
    button.addEventListener('click', function () { requestBrief({ suggestionId: suggestion.id || '' }); });
    row.appendChild(button);
    const body = make('div', 'body');
    body.appendChild(badge(suggestion.tier));
    if (suggestion.severity) body.appendChild(badge(suggestion.severity));
    body.appendChild(make('strong', '', suggestion.title || suggestion.id || 'suggestion'));
    if (suggestion.detail) body.appendChild(make('div', '', suggestion.detail));
    if (Array.isArray(suggestion.evidence) && suggestion.evidence.length > 0) {
      body.appendChild(make('div', 'muted', suggestion.evidence.join('; ')));
    }
    row.appendChild(body);
    parent.appendChild(row);
  }
}

function renderTask(root, snap) {
  const submit = root.querySelector('#task-submit');
  if (submit) {
    submit.disabled = state.taskPending || !snap;
    submit.textContent = state.taskPending ? 'Building...' : 'Build brief';
  }
  if (!snap) return;
  const suggestions = root.querySelector('#task-suggestions');
  if (suggestions) renderSuggestions(suggestions, snap);
  const target = root.querySelector('#task-brief');
  if (target) renderBrief(target, state.brief);
  const error = root.querySelector('#task-error');
  if (error) error.textContent = state.taskError || '';
}

function render() {
  const snap = state.snapshot;
  const root = document;
  if (!snap) return;
  root.querySelector('#stamp').textContent = 'snapshot ' + snap.fetchedAt;
  const ready = snap.repository.ready;
  if (ready && ready.ok && ready.data && ready.data.root) root.querySelector('#scope').textContent = ready.data.root;
  root.querySelector('#notes').textContent = snap.notes.join(' ');
  renderTask(root, snap);
  renderRepository(root, snap);
  renderContext(root, snap);
  renderWork(root, snap);
  for (const section of ['task', 'repository', 'context', 'work']) {
    root.querySelector('#' + section).hidden = section !== state.view;
  }
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.view === state.view);
  }
}

async function requestBrief(input) {
  if (state.taskPending) return;
  state.taskPending = true;
  state.taskError = null;
  renderTask(document, state.snapshot);
  try {
    const response = await fetch('/api/brief', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(function () { return null; });
    if (!response.ok) throw new Error((payload && payload.error) || 'brief request failed: ' + response.status);
    state.brief = payload;
  } catch (error) {
    state.taskError = error instanceof Error ? error.message : String(error);
  } finally {
    state.taskPending = false;
    renderTask(document, state.snapshot);
  }
}

async function load(refresh) {
  if (state.loading) return;
  state.loading = true;
  document.querySelector('#refresh').disabled = true;
  try {
    const response = await fetch('/api/snapshot' + (refresh ? '?refresh=1' : ''), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('snapshot request failed: ' + response.status);
    const next = await response.json();
    // A brief is bound to the snapshot it was built from; a refresh invalidates it.
    if (state.snapshot) {
      state.brief = null;
      state.taskError = null;
    }
    state.snapshot = next;
    render();
  } catch (error) {
    const target = document.querySelector('#' + state.view);
    target.replaceChildren();
    target.appendChild(make('div', 'error', error instanceof Error ? error.message : String(error)));
  } finally {
    state.loading = false;
    document.querySelector('#refresh').disabled = false;
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', function () {
    state.view = tab.dataset.view;
    render();
  });
}
document.querySelector('#refresh').addEventListener('click', function () { load(true); });
document.querySelector('#task-submit').addEventListener('click', function () {
  const field = document.querySelector('#task-text');
  requestBrief({ text: field && typeof field.value === 'string' ? field.value : '' });
});
load(false);
`
