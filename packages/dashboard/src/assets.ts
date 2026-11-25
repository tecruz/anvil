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
  <p id="refresh-error" class="error" hidden></p>
  <div id="snapshot-error" hidden></div>
  <section id="task">
    <div class="card">
      <h2>Start from a task</h2>
      <p class="muted">Paste a ticket or a task description, or start from this repository's own findings. The text stays on this loopback page, is limited to 4,000 characters, and is not stored or sent anywhere else.</p>
      <label class="muted" for="task-text">Task text</label>
      <textarea id="task-text" rows="6" maxlength="4000" placeholder="Paste the ticket title and body, or describe the change you want to make."></textarea>
      <div class="row">
        <button id="task-submit" type="button" disabled>Build brief</button>
        <span id="task-error" class="muted" role="status"></span>
      </div>
    </div>
    <div class="card">
      <h2>Or start from a repository suggestion</h2>
      <p class="muted">From <code>anvil plan</code>, which reads this repository's own findings. These are engineering improvements, not confirmed team priorities, and they carry no approval gate or owner.</p>
      <div id="task-suggestions"></div>
    </div>
    <div id="task-brief"></div>
    <div id="task-map"></div>
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
.action-output { white-space: pre-wrap; }
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
.gate { border-left: 4px solid #a608; }
blockquote { margin: 0.4rem 0 0; padding-left: 0.6rem; border-left: 2px solid #8886; }
ul { margin: 0.25rem 0; padding-left: 1.25rem; }
li { margin: 0.2rem 0; }
.mapgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.6rem; }
.mapcolumn { border: 1px solid #8884; border-radius: 4px; padding: 0.5rem; }
.mapnode { display: block; width: 100%; text-align: left; margin: 0.25rem 0; padding: 0.35rem 0.5rem; border: 1px solid #8886; border-radius: 4px; background: transparent; color: inherit; overflow-wrap: anywhere; }
.mapnode.selected { outline: 2px solid #282; }
.mapnode.unknown { border-style: dashed; }
.mapedge { padding: 0.2rem 0; border-top: 1px solid #8884; overflow-wrap: anywhere; }
`

export const JS = `const state = { view: 'task', snapshot: null, snapshotGeneration: 0, loading: false, brief: null, taskError: null, taskPending: false, mapView: 'map', mapSearch: '', mapSelection: null, actionResult: null, refreshError: null };

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

// A build must not be submitted before there is a snapshot to build from, nor while a
// snapshot load is pending. Clicking during the first load used to POST with an empty cache,
// get a 409, and leave the "Reload the page" error on screen after the load succeeded.
// Both entry points share this gate: the suggestion buttons used to stay live during Refresh,
// so a click could pin a brief to a snapshot that was about to be replaced.
function briefEntriesDisabled() {
  return state.loading || state.taskPending || !state.snapshot;
}

function renderBriefEntries(root) {
  const disabled = briefEntriesDisabled();
  const submit = root.querySelector('#task-submit');
  if (submit) {
    submit.disabled = disabled;
    submit.textContent = state.taskPending ? 'Building...' : 'Build brief';
  }
  const suggestions = root.querySelector('#task-suggestions');
  if (suggestions && typeof suggestions.querySelectorAll === 'function') {
    for (const button of suggestions.querySelectorAll('button')) button.disabled = disabled;
  }
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
  card.appendChild(badge(snap.verification && snap.verification.status === 'recorded' ? 'recorded' : 'unavailable'));
  card.appendChild(make('div', '', snap.verification.reason));
  parent.appendChild(card);
  renderActions(parent);
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

  // The gate the ticket states is a team decision quoted from the task, not a repository fact.
  const gates = Array.isArray(brief.gates) ? brief.gates : [];
  if (gates.length > 0) {
    card.appendChild(make('h3', '', 'Approval gate (quoted from the task)'));
    for (const gate of gates) {
      const row = make('div', 'card gate');
      const startLine = make('div', 'row');
      if (gate.startNow) {
        startLine.appendChild(badge('ok'));
        startLine.appendChild(make('strong', '', 'Start now: '));
        startLine.appendChild(make('span', '', gate.startNow));
        row.appendChild(startLine);
      }
      if (gate.waitFor) {
        const waitLine = make('div', 'row');
        waitLine.appendChild(badge('blocker'));
        waitLine.appendChild(make('strong', '', 'Wait for approval: '));
        waitLine.appendChild(make('span', '', gate.waitFor));
        row.appendChild(waitLine);
      }
      if (!gate.startNow && !gate.waitFor) {
        const unknownLine = make('div', 'row');
        unknownLine.appendChild(badge('unknown'));
        unknownLine.appendChild(make('span', '', 'Approval is required, but the task does not say what may start first.'));
        row.appendChild(unknownLine);
      }
      row.appendChild(make('blockquote', 'muted', '“' + gate.evidence + '”'));
      card.appendChild(row);
    }
  }

  card.appendChild(make('h3', '', 'How to check (selected)'));
  const checks = Array.isArray(brief.howToCheck) ? brief.howToCheck : [];
  const selection = brief.checkSelection;
  // Say the boundary in every state, including "unknown": a short list must never read as an
  // exhaustive CI inventory just because the profile failed or its coverage count is missing.
  if (selection) {
    const boundary = selection.complete === null
      ? 'Workflow check coverage is unknown because the profile source failed. This is not an exhaustive CI inventory.'
      : selection.complete
        ? 'Selected checks include every workflow check the profile detected; it is not an exhaustive CI inventory and not a pass claim.'
        : 'Selected ' + selection.selected + ' check(s); the profile detected ' + selection.detectedCiChecks +
          ' workflow check(s). This is not an exhaustive CI inventory.';
    card.appendChild(make('div', 'muted', boundary));
  }
  if (checks.length === 0) {
    card.appendChild(make('div', 'muted', 'No verification command was detected or declared for this repository.'));
  } else {
    for (const check of checks) {
      const row = make('div', 'check');
      const scope = check.scope === 'device' ? 'device · manual' : check.scope === 'ci' ? 'CI' : 'local';
      row.appendChild(make('strong', '', check.kind + ' · ' + scope));
      row.appendChild(make('code', 'path', check.cmd));
      const detail = 'from ' + check.source + (check.evidence ? ' (' + check.evidence + ')' : '') + ' · run from ' + check.cwd;
      row.appendChild(make('div', 'muted', detail));
      card.appendChild(row);
    }
  }
  card.appendChild(make('div', 'muted', 'Not run: this page cannot execute commands. Run one in a worktree to produce evidence.'));

  const verification = brief.verification || { status: 'unavailable', reason: '', evidence: [] };
  card.appendChild(make('h3', '', 'Recorded verification'));
  if (verification.status === 'recorded' && Array.isArray(verification.evidence) && verification.evidence.length > 0) {
    for (const item of verification.evidence) {
      const row = make('div', 'check');
      row.appendChild(make('code', 'path', item.command));
      const exitCode = item.exitCode === null || item.exitCode === undefined ? 'unknown' : String(item.exitCode);
      const revision = item.revision || 'unknown revision';
      const timestamp = item.timestamp || 'unknown time';
      const revisionNote =
        item.matchesCurrent === false
          ? ' · recorded at a different commit than the one sampled at dashboard startup'
          : item.matchesCurrent === null
            ? ' · revision not compared (current revision unknown)'
            : '';
      row.appendChild(make('div', 'muted', 'exit ' + exitCode + ' · ' + revision + ' · ' + timestamp + revisionNote));
      card.appendChild(row);
    }
  } else {
    card.appendChild(make('div', 'muted', verification.reason || 'No bounded verification evidence has been recorded.'));
  }

  card.appendChild(make('h3', '', 'Blocked or missing'));
  const blockers = Array.isArray(brief.blockers) ? brief.blockers : [];
  const readiness = brief.readiness || {};
  if (readiness.ok === false) {
    // A failed readiness report is an absence of evidence, not a clean bill of health.
    card.appendChild(make('div', 'error', 'anvil ready failed, so blockers and tool availability are unknown. Run anvil ready for a real answer.'));
  } else if (blockers.length > 0) {
    for (const blocker of blockers) {
      const row = make('div', 'row');
      row.appendChild(badge(blocker.status));
      row.appendChild(make('strong', '', blocker.label));
      if (blocker.reason) row.appendChild(make('span', '', blocker.reason));
      card.appendChild(row);
    }
  } else if (readiness.checked === false) {
    card.appendChild(make('div', 'muted', 'No blocker is reported, but the environment was not probed (anvil ready --check), so a missing tool or service would not appear here.'));
  } else {
    card.appendChild(make('div', 'muted', 'No blocked requirement is reported by anvil ready.'));
  }

  const handoff = brief.handoff;
  if (handoff) {
    card.appendChild(make('h3', '', 'Blocker handoff'));
    const area = make('textarea');
    area.rows = 12;
    area.readOnly = true;
    area.value = handoff.text || '';
    card.appendChild(area);
    const copy = make('button', '', 'Copy handoff');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(area.value).then(function () {
          copy.textContent = 'Copied';
        }, function () {
          copy.textContent = 'Copy failed — select the text';
        });
        return;
      }
      if (typeof area.select === 'function') area.select();
      copy.textContent = 'Selected — press Ctrl+C';
    });
    card.appendChild(copy);
    card.appendChild(make('div', 'muted', handoff.available ? 'Copy this to the owner named in the ticket. The owner is never guessed from repository files.' : 'No measured blocker is available to hand off yet.'));
  }

  card.appendChild(make('h3', '', 'Unknowns'));
  const unknowns = Array.isArray(brief.unknowns) ? brief.unknowns : [];
  const list = make('ul');
  for (const unknown of unknowns) list.appendChild(make('li', '', unknown));
  card.appendChild(list);
  parent.appendChild(card);
}

/** A stable key for an edge: its endpoints, never its position in a filtered list. */
function edgeSelectionKey(edge) {
  return 'edge:' + edge.from + '::' + edge.to;
}

/**
 * The task's 2D map: a subgraph of the matched files, their modules, one-hop dependencies and
 * verify commands. Selecting a node or edge shows the CLI value behind it; the list view is a
 * keyboard-friendly alternative. There is no 3D view and no inferred edge.
 */
function renderTaskMap(target, brief, restoreSearchFocus) {
  target.replaceChildren();
  if (!brief || !brief.map) return;
  const map = brief.map;
  const card = make('div', 'card');
  card.appendChild(make('h2', '', 'Task map'));
  card.appendChild(make('div', 'muted', map.focus + ' — subgraph plus one hop. Every node names the CLI value behind it.'));

  const controls = make('div', 'row');
  const search = make('input');
  search.type = 'search';
  search.placeholder = 'Filter modules, files and checks';
  search.value = state.mapSearch;
  search.addEventListener('input', function () {
    state.mapSearch = search.value;
    renderTaskMap(target, brief, true);
  });
  controls.appendChild(search);
  for (const mode of ['map', 'list']) {
    const button = make('button', '', mode === 'map' ? 'Map' : 'List');
    button.type = 'button';
    button.addEventListener('click', function () {
      state.mapView = mode;
      renderTaskMap(target, brief);
    });
    controls.appendChild(button);
  }
  card.appendChild(controls);

  const query = state.mapSearch.trim().toLowerCase();
  const nodes = (Array.isArray(map.nodes) ? map.nodes : []).filter(function (node) {
    return query === '' || (node.label + ' ' + node.reason + ' ' + (node.evidence || '')).toLowerCase().includes(query);
  });
  const nodeIds = new Set(nodes.map(function (node) { return node.id; }));
  const edges = (Array.isArray(map.edges) ? map.edges : []).filter(function (edge) {
    return nodeIds.has(edge.from) && nodeIds.has(edge.to);
  });

  // Filtering must not silently retarget the selected edge to whatever now sits at the same
  // index. A selection the filter hides is cleared explicitly instead of being re-pointed.
  if (state.mapSelection !== null) {
    const stillVisible =
      nodes.some(function (node) { return node.id === state.mapSelection; }) ||
      (typeof state.mapSelection === 'string' &&
        state.mapSelection.startsWith('edge:') &&
        edges.some(function (edge) { return edgeSelectionKey(edge) === state.mapSelection; }));
    if (!stillVisible) state.mapSelection = null;
  }

  if (nodes.length === 0) {
    card.appendChild(make('div', 'muted', 'No node matches that search.'));
  } else if (state.mapView === 'list') {
    const table = make('table');
    const head = make('tr');
    for (const label of ['node', 'kind', 'why', 'evidence']) head.appendChild(make('th', '', label));
    table.appendChild(head);
    for (const node of nodes) {
      const row = make('tr');
      for (const value of [node.label, node.kind, node.reason, node.evidence || 'unknown']) {
        row.appendChild(make('td', '', value));
      }
      table.appendChild(row);
    }
    card.appendChild(table);
  } else {
    const grid = make('div', 'mapgrid');
    for (const kind of ['file', 'module', 'check', 'unknown']) {
      const column = make('div', 'mapcolumn');
      column.appendChild(make('h3', '', kind));
      for (const node of nodes.filter(function (n) { return n.kind === kind; })) {
        const button = make('button', 'mapnode' + (node.kind === 'unknown' ? ' unknown' : '') + (state.mapSelection === node.id ? ' selected' : ''), node.label);
        button.type = 'button';
        button.addEventListener('click', function () {
          state.mapSelection = node.id;
          renderTaskMap(target, brief);
        });
        column.appendChild(button);
      }
      grid.appendChild(column);
    }
    card.appendChild(grid);
    const edgeList = make('div');
    for (const edge of edges) {
      const row = make('div', 'mapedge', edge.from + '  →  ' + edge.to + '  (' + edge.label + ')');
      row.addEventListener('click', function () {
        state.mapSelection = edgeSelectionKey(edge);
        renderTaskMap(target, brief);
      });
      edgeList.appendChild(row);
    }
    card.appendChild(edgeList);
  }

  const detail = make('div', 'muted');
  const selectedNode = nodes.find(function (node) { return node.id === state.mapSelection; });
  const selectedEdge =
    typeof state.mapSelection === 'string' && state.mapSelection.startsWith('edge:')
      ? edges.find(function (candidate) { return edgeSelectionKey(candidate) === state.mapSelection; })
      : null;
  if (selectedNode) {
    detail.textContent = selectedNode.label + ' — ' + selectedNode.reason + ' Evidence: ' + (selectedNode.evidence || 'unknown');
  } else if (selectedEdge) {
    detail.textContent = selectedEdge.from + ' → ' + selectedEdge.to + ' (' + selectedEdge.label + ') Evidence: ' + (selectedEdge.evidence || 'unknown');
  } else {
    detail.textContent = 'Select a node or edge to see its evidence.';
  }
  card.appendChild(detail);
  if (map.hasUnknown) {
    card.appendChild(make('div', 'muted', 'Dashed nodes are unknown, not "no dependency". The profile did not analyse them.'));
  }
  target.appendChild(card);
  if (restoreSearchFocus && typeof search.focus === 'function') {
    search.focus();
    if (typeof search.setSelectionRange === 'function') search.setSelectionRange(search.value.length, search.value.length);
  }
}

/** A derived fix reads as "action -- why"; the action is the useful heading for a task. */
function suggestionAction(suggestion) {
  const detail = String(suggestion.detail || '');
  const marker = detail.indexOf(' -- ');
  if (marker <= 0) return '';
  return detail.slice(0, marker).trim();
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
    // The same gate as the pasted-text submit: no build is possible without a loaded
    // snapshot, and none may start while a load/refresh is in flight.
    button.disabled = briefEntriesDisabled();
    const heading = suggestionAction(suggestion) || suggestion.title || suggestion.id || 'this suggestion';
    button.setAttribute('aria-label', 'Build a brief from: ' + heading);
    button.addEventListener('click', function () { requestBrief({ suggestionId: suggestion.id || '' }); });
    row.appendChild(button);
    const body = make('div', 'body');
    body.appendChild(badge(suggestion.tier));
    if (suggestion.severity) body.appendChild(badge(suggestion.severity));
    body.appendChild(make('strong', '', suggestionAction(suggestion) || suggestion.title || suggestion.id || 'suggestion'));
    if (suggestion.detail) body.appendChild(make('div', '', suggestion.detail));
    if (Array.isArray(suggestion.evidence) && suggestion.evidence.length > 0) {
      body.appendChild(make('div', 'muted', suggestion.evidence.join('; ')));
    }
    row.appendChild(body);
    parent.appendChild(row);
  }
}

function renderTask(root, snap) {
  renderBriefEntries(root);
  if (!snap) return;
  const suggestions = root.querySelector('#task-suggestions');
  if (suggestions) renderSuggestions(suggestions, snap);
  const target = root.querySelector('#task-brief');
  if (target) renderBrief(target, state.brief);
  const mapTarget = root.querySelector('#task-map');
  if (mapTarget) renderTaskMap(mapTarget, state.brief);
  const error = root.querySelector('#task-error');
  if (error) error.textContent = state.taskError || '';
}

/**
 * Explicit, confirm-gated write actions. The page never builds a command: it posts an action
 * name and one bounded reference to the closed endpoint. Ship takes an existing claim key
 * and always runs with --probe on the CLI side, so verification is never skipped. Failures
 * are printed beside the snapshot and kept across refreshes.
 */
function renderActions(parent) {
  const card = make('div', 'card');
  card.appendChild(make('h2', '', 'Actions'));
  card.appendChild(make('div', 'muted', 'Optional. Each action re-runs the same CLI command and approval checks; confirm before it starts. Ship verifies with --probe.'));

  const claimRow = make('div');
  const ticket = make('input');
  ticket.type = 'text';
  ticket.placeholder = 'ticket reference';
  // Match the server's MAX_TICKET_URL_LENGTH (500): a 200-char cap silently cut nested issue
  // URLs such as https://gitlab.example.com/group/project/-/issues/123, dropping the ref.
  ticket.maxLength = 500;
  claimRow.appendChild(ticket);
  const claimButton = make('button', '', 'Claim');
  claimButton.type = 'button';
  claimButton.addEventListener('click', function () {
    runAction({ action: 'claim', ref: ticket.value.trim() }, claimButton);
  });
  claimRow.appendChild(claimButton);
  card.appendChild(claimRow);

  const shipRow = make('div');
  const claims = state.snapshot && state.snapshot.work.crew.ok && state.snapshot.work.crew.data
    ? (Array.isArray(state.snapshot.work.crew.data.crew) ? state.snapshot.work.crew.data.crew : [])
    : [];
  const keys = claims.map(function (c) { return c.key; }).filter(function (key) { return typeof key === 'string' && key.length > 0; });
  if (keys.length === 0) {
    shipRow.appendChild(make('span', 'muted', 'No claim to ship yet.'));
  } else {
    const select = make('select');
    for (const key of keys) {
      const option = make('option', '', key);
      option.value = key;
      select.appendChild(option);
    }
    shipRow.appendChild(select);
    const shipButton = make('button', '', 'Ship (with verification)');
    shipButton.type = 'button';
    shipButton.addEventListener('click', function () {
      runAction({ action: 'ship', ref: select.value }, shipButton);
    });
    shipRow.appendChild(shipButton);
  }
  card.appendChild(shipRow);

  const verifyButton = make('button', '', 'Verify crew');
  verifyButton.type = 'button';
  verifyButton.addEventListener('click', function () {
    runAction({ action: 'verify' }, verifyButton);
  });
  card.appendChild(verifyButton);

  const output = make('div', (state.actionResult && !state.actionResult.ok ? 'error' : 'muted') + ' action-output');
  output.setAttribute('role', 'status');
  if (state.actionResult) output.textContent = formatActionResult(state.actionResult);
  card.appendChild(output);
  parent.appendChild(card);
}

/** Show the CLI's own verdict, not just its exit code: a partial ship has real FAIL stages. */
function formatActionResult(result) {
  const detail = result.ok ? 'exit ' + result.exitCode : (result.error || 'refused');
  const lines = [result.command + ' - ' + detail];
  for (const stage of result.stages || []) {
    lines.push('  ' + (stage.ok ? 'ok  ' : 'FAIL') + ' ' + stage.name + ': ' + stage.detail);
  }
  if (result.skipped && result.skipped.length > 0) lines.push('  skipped: ' + result.skipped.join('; '));
  if (result.warnings && result.warnings.length > 0) lines.push('  warning: ' + result.warnings.join('; '));
  return lines.join('\\n');
}

async function runAction(body, button) {
  if (!window.confirm('Run anvil ' + body.action + ' with the repository CLI? This may write to the repository.')) return;
  button.disabled = true;
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    let result = null;
    try { result = await response.json(); } catch { result = null; }
    if (response.ok && result && typeof result === 'object') {
      state.actionResult = result;
    } else {
      // A non-JSON error body is still shown as a readable failure, never as a parse error.
      state.actionResult = {
        ok: false, command: 'anvil ' + body.action, exitCode: response.status,
        error: (result && result.error) || ('HTTP ' + response.status),
        stages: [], skipped: [], warnings: [],
      };
    }
  } catch (error) {
    state.actionResult = {
      ok: false, command: 'anvil ' + body.action, error: error instanceof Error ? error.message : String(error),
      stages: [], skipped: [], warnings: [],
    };
  } finally {
    button.disabled = false;
  }
  // Re-render first so the result is on screen, then refresh in the background; a failed
  // refresh must not erase the CLI's answer.
  render();
  await load(true);
}

/** A failed refresh is shown on its own line; it never overwrites the view or the action result. */
function renderRefreshError() {
  const target = document.querySelector('#refresh-error');
  if (!target) return;
  target.textContent = state.refreshError || '';
  target.hidden = !state.refreshError;
}

function render() {
  renderRefreshError();
  const snap = state.snapshot;
  const root = document;
  // Runs before the early return so both build buttons are disabled during a pending load.
  renderBriefEntries(root);
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

/** Bind a brief request to the snapshot the page is actually showing. */
function briefRequest(input) {
  const request = Object.assign({}, input);
  const snapshotId = state.snapshot && state.snapshot.snapshotId;
  if (typeof snapshotId === 'string') request.snapshotId = snapshotId;
  return request;
}

async function requestBrief(input) {
  if (state.taskPending) return;
  // A brief is a view over one particular snapshot. Remember which generation it belongs
  // to: if a refresh delivers a newer snapshot before the answer arrives, the answer is
  // stale and must not be painted over the new snapshot.
  const generation = state.snapshotGeneration;
  state.taskPending = true;
  state.taskError = null;
  renderTask(document, state.snapshot);
  try {
    const response = await fetch('/api/brief', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(briefRequest(input)),
    });
    const payload = await response.json().catch(function () { return null; });
    if (generation !== state.snapshotGeneration) return;
    if (!response.ok) throw new Error((payload && payload.error) || 'brief request failed: ' + response.status);
    state.brief = payload;
    state.mapSelection = null;
    state.mapSearch = '';
  } catch (error) {
    // The failure belongs to the snapshot that started this request. A refresh may have
    // delivered a newer snapshot while the request was in flight; showing the old error over
    // that snapshot left a stale "Reload the page" message on a page that had recovered.
    if (generation === state.snapshotGeneration) {
      state.taskError = error instanceof Error ? error.message : String(error);
    }
  } finally {
    state.taskPending = false;
    renderBriefEntries(document);
    renderTask(document, state.snapshot);
  }
}

/** A failed first load must not delete the draft, and must not claim a fallback snapshot. */
function showSnapshotError(message) {
  const node = document.querySelector('#snapshot-error');
  if (!node) return;
  node.replaceChildren();
  if (!message) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const tail = state.snapshot
    ? ' The form below still works from the last snapshot it loaded.'
    : ' Nothing is loaded yet, so a brief cannot be built until a load succeeds. Press Refresh to retry.';
  node.appendChild(make('div', 'error', 'Could not read the snapshot: ' + message + '.' + tail));
}

async function load(refresh) {
  if (state.loading) return;
  state.loading = true;
  document.querySelector('#refresh').disabled = true;
  renderBriefEntries(document);
  try {
    const response = await fetch('/api/snapshot' + (refresh ? '?refresh=1' : ''), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('snapshot request failed: ' + response.status);
    const next = await response.json();
    // A brief is bound to the snapshot it was built from; a refresh invalidates it, but the
    // draft in the textarea belongs to the reader and is left alone.
    if (state.snapshot) {
      state.brief = null;
    }
    // Supersede any brief still in flight: its response is bound to the previous snapshot and
    // must be discarded even if it arrives after this one. The counter also tags future builds.
    state.snapshotGeneration += 1;
    // A snapshot arriving clears any brief error, including a 409 from a build that raced the
    // first load. Leaving it set showed a stale "Reload the page" over a good snapshot.
    state.taskError = null;
    state.snapshot = next;
    showSnapshotError(null);
    state.refreshError = null;
    renderRefreshError();
    render();
  } catch (error) {
    // Keep the last good snapshot, any refused action result and the typed draft on screen.
    // The refresh failure gets its own elements, so a transient 500 cannot erase the CLI's answer.
    state.refreshError = error instanceof Error ? error.message : String(error);
    renderRefreshError();
    showSnapshotError(state.refreshError);
  } finally {
    state.loading = false;
    document.querySelector('#refresh').disabled = false;
    renderBriefEntries(document);
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
