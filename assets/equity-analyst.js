import {
  supabase,
  ensureProfile,
  hasAdminRole,
  isMembershipActive,
  getUser,
  getProfile,
  getMembership
} from './supabase.js';

const RUN_STORAGE_KEY = 'ff-analyst-active-run';
const REFRESH_INTERVAL_MS = 30000;

const selectors = {
  runSelect: document.getElementById('runSelect'),
  refreshRunsBtn: document.getElementById('refreshRunsBtn'),
  accessNotice: document.getElementById('accessNotice'),
  dashboardStatus: document.getElementById('dashboardStatus'),
  runStatus: document.getElementById('runStatus'),
  runCreated: document.getElementById('runCreated'),
  runStage1Pending: document.getElementById('runStage1Pending'),
  runFailures: document.getElementById('runFailures'),
  runStopRequested: document.getElementById('runStopRequested'),
  runNotes: document.getElementById('runNotes'),
  costBreakdownList: document.getElementById('costBreakdownList'),
  metricTotalTickers: document.getElementById('metricTotalTickers'),
  metricStage1Complete: document.getElementById('metricStage1Complete'),
  metricStage2Queue: document.getElementById('metricStage2Queue'),
  metricStage3Queue: document.getElementById('metricStage3Queue'),
  metricSpend: document.getElementById('metricSpend'),
  metricTokens: document.getElementById('metricTokens'),
  metricStage1Pending: document.getElementById('metricStage1Pending'),
  metricStage1Done: document.getElementById('metricStage1Done'),
  metricStage2Done: document.getElementById('metricStage2Done'),
  metricStage3Done: document.getElementById('metricStage3Done'),
  metricFailures: document.getElementById('metricFailures'),
  stage1Percent: document.getElementById('stage1Percent'),
  stage1Progress: document.getElementById('stage1Progress'),
  stage1CompletedCount: document.getElementById('stage1CompletedCount'),
  stage1PendingCount: document.getElementById('stage1PendingCount'),
  stage1FailedCount: document.getElementById('stage1FailedCount'),
  stage1LabelList: document.getElementById('stage1LabelList'),
  stage2Percent: document.getElementById('stage2Percent'),
  stage2Progress: document.getElementById('stage2Progress'),
  stage2CompletedCount: document.getElementById('stage2CompletedCount'),
  stage2QueueCount: document.getElementById('stage2QueueCount'),
  stage2FailedCount: document.getElementById('stage2FailedCount'),
  stage3Percent: document.getElementById('stage3Percent'),
  stage3Progress: document.getElementById('stage3Progress'),
  stage3CompletedCount: document.getElementById('stage3CompletedCount'),
  stage3QueueCount: document.getElementById('stage3QueueCount'),
  stage3FailedCount: document.getElementById('stage3FailedCount'),
  activityBody: document.getElementById('activityBody'),
  activityEmpty: document.getElementById('activityEmpty'),
  pipelineUpdated: document.getElementById('pipelineUpdated')
};

const stageNames = new Map([
  [0, 'Queued'],
  [1, 'Stage 1'],
  [2, 'Stage 2'],
  [3, 'Stage 3']
]);

const state = {
  runs: [],
  activeRunId: null,
  pollTimer: null,
  auth: {
    ready: false,
    admin: false,
    membershipActive: false,
    userEmail: null
  }
};

function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

function formatCompactNumber(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatCurrency(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

function formatTokens(inTokens, outTokens) {
  if ((inTokens == null || Number.isNaN(inTokens)) && (outTokens == null || Number.isNaN(outTokens))) {
    return '—';
  }
  const inbound = formatCompactNumber(inTokens ?? 0);
  const outbound = formatCompactNumber(outTokens ?? 0);
  return `${inbound} in / ${outbound} out`;
}

function formatDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch (error) {
    console.warn('Unable to format date', value, error);
    return '—';
  }
}

function formatFullDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date(value));
  } catch (error) {
    return '—';
  }
}

function setText(element, value) {
  if (!element) return;
  element.textContent = value;
}

function setStatus(message, isError = false) {
  const el = selectors.dashboardStatus;
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    el.classList.remove('notice--warning');
    return;
  }
  el.hidden = false;
  el.textContent = message;
  if (isError) {
    el.classList.add('notice--warning');
  } else {
    el.classList.remove('notice--warning');
  }
}

function updateAccessNotice(message, isError = false) {
  const el = selectors.accessNotice;
  if (!el) return;
  el.textContent = message;
  if (isError) {
    el.classList.add('notice--warning');
  } else {
    el.classList.remove('notice--warning');
  }
}

function disableControls() {
  if (selectors.runSelect) selectors.runSelect.disabled = true;
  if (selectors.refreshRunsBtn) selectors.refreshRunsBtn.disabled = true;
}

function enableControls() {
  if (selectors.runSelect) selectors.runSelect.disabled = false;
  if (selectors.refreshRunsBtn) selectors.refreshRunsBtn.disabled = false;
}

function stageLabel(stage) {
  return stageNames.get(Number(stage)) ?? `Stage ${stage}`;
}

function setProgressBar(bar, percent) {
  if (!bar) return;
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  bar.style.width = `${clamped}%`;
  const parent = bar.parentElement;
  if (parent) {
    parent.setAttribute('aria-valuenow', String(clamped));
  }
}

function clearList(listEl, emptyMessage) {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (emptyMessage) {
    const li = document.createElement('li');
    li.textContent = emptyMessage;
    listEl.appendChild(li);
  }
}

function clearDashboard() {
  setText(selectors.runStatus, '—');
  setText(selectors.runCreated, '—');
  setText(selectors.runStage1Pending, '—');
  setText(selectors.runFailures, '—');
  setText(selectors.runStopRequested, '—');
  if (selectors.runNotes) {
    selectors.runNotes.textContent = '';
    selectors.runNotes.classList.remove('run-notes--visible');
  }

  setText(selectors.metricTotalTickers, '—');
  setText(selectors.metricStage1Complete, '—');
  setText(selectors.metricStage2Queue, '—');
  setText(selectors.metricStage3Queue, '—');
  setText(selectors.metricSpend, '—');
  setText(selectors.metricTokens, '—');
  setText(selectors.metricStage1Pending, '—');
  setText(selectors.metricStage1Done, '—');
  setText(selectors.metricStage2Done, '—');
  setText(selectors.metricStage3Done, '—');
  setText(selectors.metricFailures, '—');

  setText(selectors.stage1Percent, '0%');
  setText(selectors.stage2Percent, '0%');
  setText(selectors.stage3Percent, '0%');
  setProgressBar(selectors.stage1Progress, 0);
  setProgressBar(selectors.stage2Progress, 0);
  setProgressBar(selectors.stage3Progress, 0);
  setText(selectors.stage1CompletedCount, '—');
  setText(selectors.stage1PendingCount, '—');
  setText(selectors.stage1FailedCount, '—');
  setText(selectors.stage2CompletedCount, '—');
  setText(selectors.stage2QueueCount, '—');
  setText(selectors.stage2FailedCount, '—');
  setText(selectors.stage3CompletedCount, '—');
  setText(selectors.stage3QueueCount, '—');
  setText(selectors.stage3FailedCount, '—');
  clearList(selectors.stage1LabelList, 'No Stage 1 verdicts yet.');
  clearList(selectors.costBreakdownList, 'No spend recorded yet.');
  if (selectors.pipelineUpdated) setText(selectors.pipelineUpdated, '—');

  if (selectors.activityBody) selectors.activityBody.innerHTML = '';
  if (selectors.activityEmpty) selectors.activityEmpty.hidden = false;
}

function buildStageMetrics(rows = []) {
  const stageMap = new Map();
  let totalFailures = 0;

  rows.forEach((row) => {
    const stage = Number(row.stage ?? 0);
    const status = String(row.status ?? '').toLowerCase() || 'pending';
    const total = Number(row.total ?? 0);

    if (!stageMap.has(stage)) {
      stageMap.set(stage, { total: 0, statuses: {} });
    }
    const bucket = stageMap.get(stage);
    bucket.total += total;
    bucket.statuses[status] = (bucket.statuses[status] ?? 0) + total;

    if (status === 'failed') {
      totalFailures += total;
    }
  });

  const totalTickers = Array.from(stageMap.values()).reduce((sum, bucket) => sum + bucket.total, 0);
  const stage1Pending = stageMap.get(0)?.statuses?.pending ?? 0;
  const stage1Failed = stageMap.get(0)?.statuses?.failed ?? 0;
  const stage1Skipped = stageMap.get(0)?.statuses?.skipped ?? 0;

  let stage1Completed = 0;
  let stage2Completed = 0;
  let stage3Completed = 0;
  let stage2Failed = 0;
  let stage3Failed = 0;

  for (const [stage, bucket] of stageMap.entries()) {
    const ok = bucket.statuses.ok ?? 0;
    const failed = bucket.statuses.failed ?? 0;

    if (stage >= 1) stage1Completed += ok;
    if (stage >= 2) stage2Completed += ok;
    if (stage >= 3) stage3Completed += ok;

    if (stage === 1) stage2Failed += failed;
    if (stage >= 2) stage3Failed += failed;
  }

  const stage2Queue = stageMap.get(1)?.statuses?.ok ?? 0;
  const stage3Queue = stageMap.get(2)?.statuses?.ok ?? 0;

  return {
    stageMap,
    totalTickers,
    stage1Pending,
    stage1Completed,
    stage2Completed,
    stage3Completed,
    stage2Queue,
    stage3Queue,
    totalFailures,
    stage1Failed,
    stage2Failed,
    stage3Failed,
    stage1Skipped
  };
}

function populateRunSelect() {
  const select = selectors.runSelect;
  if (!select) return;
  const previousValue = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select a run…';
  select.appendChild(placeholder);

  state.runs.forEach((run) => {
    const option = document.createElement('option');
    option.value = run.id;
    const status = (run.status ?? 'queued').toUpperCase();
    option.textContent = `${formatDate(run.created_at)} · ${status}`;
    select.appendChild(option);
  });

  if (state.activeRunId) {
    select.value = state.activeRunId;
  } else if (previousValue && state.runs.some((run) => run.id === previousValue)) {
    select.value = previousValue;
  }
}

function renderLabelList(labels = [], totalCompleted = 0) {
  const list = selectors.stage1LabelList;
  if (!list) return;
  list.innerHTML = '';
  if (!labels.length) {
    const li = document.createElement('li');
    li.textContent = 'No Stage 1 verdicts yet.';
    list.appendChild(li);
    return;
  }
  labels.forEach((row) => {
    const li = document.createElement('li');
    const label = (row.label ?? 'Unlabeled').toString();
    const total = Number(row.total ?? 0);
    const percent = totalCompleted > 0 ? Math.round((total / totalCompleted) * 100) : 0;
    li.innerHTML = `<strong>${label}</strong> — ${formatNumber(total)} (${percent}%)`;
    list.appendChild(li);
  });
}

function renderCostBreakdown(rows = []) {
  const list = selectors.costBreakdownList;
  if (!list) return;
  list.innerHTML = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = 'No spend recorded yet.';
    list.appendChild(li);
    return;
  }
  rows.forEach((row) => {
    const li = document.createElement('li');
    const stage = stageLabel(row.stage);
    const model = row.model ?? 'unknown model';
    const cost = formatCurrency(row.cost_usd ?? 0);
    const tokens = formatTokens(row.tokens_in ?? 0, row.tokens_out ?? 0);
    li.innerHTML = `<strong>${stage}</strong> · ${model} — ${cost} (${tokens})`;
    list.appendChild(li);
  });
}

function renderActivity(rows = []) {
  const tbody = selectors.activityBody;
  const empty = selectors.activityEmpty;
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!rows.length) {
    if (empty) empty.hidden = false;
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement('tr');

    const createdCell = document.createElement('td');
    createdCell.textContent = formatDate(row.created_at);
    createdCell.title = formatFullDate(row.created_at);
    tr.appendChild(createdCell);

    const tickerCell = document.createElement('td');
    tickerCell.textContent = row.ticker ?? '—';
    tr.appendChild(tickerCell);

    const stageCell = document.createElement('td');
    stageCell.textContent = stageLabel(row.stage);
    tr.appendChild(stageCell);

    const labelCell = document.createElement('td');
    labelCell.textContent = row.label ?? '—';
    tr.appendChild(labelCell);

    const summaryCell = document.createElement('td');
    const summary = row.summary ?? '—';
    summaryCell.textContent = summary;
    tr.appendChild(summaryCell);

    tbody.appendChild(tr);
  });

  if (empty) empty.hidden = true;
}

function updateRunMeta(run, metrics) {
  setText(selectors.runStatus, (run?.status ?? '—').toUpperCase());
  setText(selectors.runCreated, formatFullDate(run?.created_at));
  setText(selectors.runStage1Pending, formatNumber(metrics.stage1Pending));
  setText(selectors.runFailures, formatNumber(metrics.totalFailures));
  setText(selectors.runStopRequested, run?.stop_requested ? 'Yes' : 'No');

  if (selectors.runNotes) {
    const notes = (run?.notes ?? '').trim();
    if (notes) {
      selectors.runNotes.textContent = notes;
      selectors.runNotes.classList.add('run-notes--visible');
    } else {
      selectors.runNotes.textContent = '';
      selectors.runNotes.classList.remove('run-notes--visible');
    }
  }
}

function updateHero(metrics, costSummary) {
  setText(selectors.metricTotalTickers, formatNumber(metrics.totalTickers));
  setText(selectors.metricStage1Complete, formatNumber(metrics.stage1Completed));
  setText(selectors.metricStage2Queue, formatNumber(metrics.stage2Queue));
  setText(selectors.metricStage3Queue, formatNumber(metrics.stage3Queue));

  const totalCost = costSummary?.[0]?.total_cost ?? 0;
  const totalTokensIn = costSummary?.[0]?.total_tokens_in ?? 0;
  const totalTokensOut = costSummary?.[0]?.total_tokens_out ?? 0;

  setText(selectors.metricSpend, formatCurrency(totalCost));
  setText(selectors.metricTokens, formatTokens(totalTokensIn, totalTokensOut));

  setText(selectors.metricStage1Pending, formatNumber(metrics.stage1Pending));
  setText(selectors.metricStage1Done, formatNumber(metrics.stage1Completed));
  setText(selectors.metricStage2Done, formatNumber(metrics.stage2Completed));
  setText(selectors.metricStage3Done, formatNumber(metrics.stage3Completed));
  setText(selectors.metricFailures, formatNumber(metrics.totalFailures));
}

function updateStageCards(metrics) {
  const stage1PercentVal = metrics.totalTickers > 0
    ? Math.round((metrics.stage1Completed / metrics.totalTickers) * 100)
    : 0;
  const stage2PercentVal = metrics.stage1Completed > 0
    ? Math.round((metrics.stage2Completed / metrics.stage1Completed) * 100)
    : 0;
  const stage3PercentVal = metrics.stage2Completed > 0
    ? Math.round((metrics.stage3Completed / metrics.stage2Completed) * 100)
    : 0;

  setText(selectors.stage1Percent, `${stage1PercentVal}%`);
  setText(selectors.stage2Percent, `${stage2PercentVal}%`);
  setText(selectors.stage3Percent, `${stage3PercentVal}%`);
  setProgressBar(selectors.stage1Progress, stage1PercentVal);
  setProgressBar(selectors.stage2Progress, stage2PercentVal);
  setProgressBar(selectors.stage3Progress, stage3PercentVal);

  setText(selectors.stage1CompletedCount, formatNumber(metrics.stage1Completed));
  setText(selectors.stage1PendingCount, formatNumber(metrics.stage1Pending));
  setText(selectors.stage1FailedCount, formatNumber(metrics.stage1Failed));
  setText(selectors.stage2CompletedCount, formatNumber(metrics.stage2Completed));
  setText(selectors.stage2QueueCount, formatNumber(metrics.stage2Queue));
  setText(selectors.stage2FailedCount, formatNumber(metrics.stage2Failed));
  setText(selectors.stage3CompletedCount, formatNumber(metrics.stage3Completed));
  setText(selectors.stage3QueueCount, formatNumber(metrics.stage3Queue));
  setText(selectors.stage3FailedCount, formatNumber(metrics.stage3Failed));
}

async function loadRuns() {
  if (!state.auth.admin) return;
  setStatus('Loading runs…');
  const { data, error } = await supabase
    .from('runs')
    .select('id, created_at, status, stop_requested, notes')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error('Failed to load runs', error);
    setStatus(`Failed to load runs: ${error.message}`, true);
    state.runs = [];
    populateRunSelect();
    return;
  }

  state.runs = data ?? [];
  populateRunSelect();

  if (!state.runs.length) {
    setStatus('No runs found. Launch a run from the planner to populate telemetry.');
  } else {
    setStatus('');
  }
}

async function loadRunDashboard(runId, { silent = false } = {}) {
  if (!state.auth.admin || !runId) {
    clearDashboard();
    return;
  }

  if (!silent) {
    setStatus('Fetching telemetry…');
  }

  const [{ data: run, error: runError }, statusCounts, labelCounts, costBreakdown, costSummary, latest] = await Promise.all([
    supabase.from('runs').select('id, created_at, status, stop_requested, notes').eq('id', runId).maybeSingle(),
    supabase.rpc('run_stage_status_counts', { p_run_id: runId }),
    supabase.rpc('run_stage1_labels', { p_run_id: runId }),
    supabase.rpc('run_cost_breakdown', { p_run_id: runId }),
    supabase.rpc('run_cost_summary', { p_run_id: runId }),
    supabase.rpc('run_latest_activity', { p_run_id: runId, p_limit: 12 })
  ]);

  if (runError) {
    console.error('Failed to load run metadata', runError);
    setStatus(`Unable to load run ${runId}: ${runError.message}`, true);
    clearDashboard();
    return;
  }

  const statusRows = statusCounts.error ? [] : statusCounts.data ?? [];
  const labelRows = labelCounts.error ? [] : labelCounts.data ?? [];
  const costRows = costBreakdown.error ? [] : costBreakdown.data ?? [];
  const costSummaryRows = costSummary.error ? [] : costSummary.data ?? [];
  const activityRows = latest.error ? [] : latest.data ?? [];

  if (statusCounts.error) {
    console.error('Stage status query failed', statusCounts.error);
  }
  if (labelCounts.error) {
    console.error('Label distribution query failed', labelCounts.error);
  }
  if (costBreakdown.error) {
    console.error('Cost breakdown query failed', costBreakdown.error);
  }
  if (costSummary.error) {
    console.error('Cost summary query failed', costSummary.error);
  }
  if (latest.error) {
    console.error('Latest activity query failed', latest.error);
  }

  const metrics = buildStageMetrics(statusRows);
  updateRunMeta(run, metrics);
  updateHero(metrics, costSummaryRows);
  updateStageCards(metrics);
  renderLabelList(labelRows, metrics.stage1Completed);
  renderCostBreakdown(costRows);
  renderActivity(activityRows);

  if (selectors.pipelineUpdated) {
    const timestamp = new Date();
    selectors.pipelineUpdated.textContent = `Last updated ${formatDate(timestamp)}`;
  }

  setStatus('');
}

function applySavedRun() {
  const savedId = localStorage.getItem(RUN_STORAGE_KEY);
  if (!savedId) return;
  if (state.runs.some((run) => run.id === savedId)) {
    state.activeRunId = savedId;
    if (selectors.runSelect) selectors.runSelect.value = savedId;
    loadRunDashboard(savedId, { silent: true }).catch((error) => {
      console.error('Failed to load saved run', error);
    });
  }
}

function attachListeners() {
  if (selectors.runSelect) {
    selectors.runSelect.addEventListener('change', (event) => {
      const value = event.target.value || null;
      state.activeRunId = value;
      if (value) {
        localStorage.setItem(RUN_STORAGE_KEY, value);
        loadRunDashboard(value).catch((error) => {
          console.error('Failed to load run dashboard', error);
          setStatus(`Unable to load run: ${error.message}`, true);
        });
      } else {
        localStorage.removeItem(RUN_STORAGE_KEY);
        clearDashboard();
      }
    });
  }

  if (selectors.refreshRunsBtn) {
    selectors.refreshRunsBtn.addEventListener('click', () => {
      loadRuns()
        .then(() => {
          if (state.activeRunId && state.runs.some((run) => run.id === state.activeRunId)) {
            loadRunDashboard(state.activeRunId, { silent: true }).catch((error) => {
              console.error('Dashboard refresh failed', error);
            });
          } else {
            applySavedRun();
          }
        })
        .catch((error) => {
          console.error('Run refresh failed', error);
        });
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.activeRunId) {
      loadRunDashboard(state.activeRunId, { silent: true }).catch((error) => {
        console.error('Failed to refresh on focus', error);
      });
    }
  });
}

function startPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    if (!state.activeRunId) return;
    loadRunDashboard(state.activeRunId, { silent: true }).catch((error) => {
      console.error('Polling refresh failed', error);
    });
  }, REFRESH_INTERVAL_MS);
}

async function bootstrapAuth() {
  const user = await getUser();
  if (!user) {
    updateAccessNotice('Sign in with analyst access to load run telemetry.', true);
    disableControls();
    return;
  }

  await ensureProfile(user).catch((error) => {
    console.warn('ensureProfile failed', error);
  });

  const [profile, membership] = await Promise.all([getProfile(), getMembership()]);
  const admin = hasAdminRole({ user, profile, membership });
  const membershipActive = isMembershipActive(membership, { user, profile, membership });

  state.auth = {
    ready: true,
    admin,
    membershipActive,
    userEmail: user.email ?? null
  };

  if (!admin) {
    updateAccessNotice('Analyst permissions required. Ask an admin to grant access.', true);
    disableControls();
    return;
  }

  if (!membershipActive) {
    updateAccessNotice('Membership inactive. Renew access to view live telemetry.', true);
    disableControls();
    return;
  }

  updateAccessNotice(`Signed in as ${user.email ?? 'analyst'} · access granted.`);
  enableControls();
}

async function init() {
  clearDashboard();
  disableControls();
  await bootstrapAuth();
  attachListeners();
  if (!state.auth.admin) {
    return;
  }
  await loadRuns();
  if (state.runs.length) {
    applySavedRun();
    if (!state.activeRunId) {
      const [first] = state.runs;
      if (first) {
        state.activeRunId = first.id;
        if (selectors.runSelect) selectors.runSelect.value = first.id;
        localStorage.setItem(RUN_STORAGE_KEY, first.id);
        await loadRunDashboard(first.id, { silent: true });
      }
    }
  }
  startPolling();
}

init().catch((error) => {
  console.error('Failed to initialise analyst dashboard', error);
  setStatus(`Unable to initialise dashboard: ${error.message}`, true);
});
