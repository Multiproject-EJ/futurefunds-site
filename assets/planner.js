import { supabase, ensureProfile, hasAdminRole, isMembershipActive, SUPABASE_URL } from './supabase.js';

const STORAGE_KEY = 'ff-planner-settings-v1';
const PRICES = {
  '5': { in: 1.25, out: 10.0 },
  '5-mini': { in: 0.25, out: 2.0 },
  '4o-mini': { in: 0.15, out: 0.60 }
};

const defaults = {
  universe: 40000,
  surviveStage2: 15,
  surviveStage3: 12,
  stage1: { model: '4o-mini', inTokens: 3000, outTokens: 600 },
  stage2: { model: '5-mini', inTokens: 30000, outTokens: 6000 },
  stage3: { model: '5', inTokens: 100000, outTokens: 20000 }
};

const $ = (id) => document.getElementById(id);

const inputs = {
  universe: $('universeInput'),
  stage2Slider: $('stage2Slider'),
  stage3Slider: $('stage3Slider'),
  stage1Model: $('modelStage1'),
  stage2Model: $('modelStage2'),
  stage3Model: $('modelStage3'),
  stage1In: $('stage1InputTokens'),
  stage1Out: $('stage1OutputTokens'),
  stage2In: $('stage2InputTokens'),
  stage2Out: $('stage2OutputTokens'),
  stage3In: $('stage3InputTokens'),
  stage3Out: $('stage3OutputTokens'),
  status: $('startRunStatus'),
  log: $('statusLog'),
  costOut: $('costOutput'),
  totalCost: $('totalCost'),
  survivorSummary: $('survivorSummary'),
  stage2Value: $('stage2Value'),
  stage3Value: $('stage3Value'),
  startBtn: $('startRunBtn'),
  resetBtn: $('resetDefaultsBtn'),
  runIdInput: $('runIdInput'),
  applyRunIdBtn: $('applyRunIdBtn'),
  clearRunIdBtn: $('clearRunIdBtn'),
  runIdDisplay: $('runIdDisplay'),
  runStatusText: $('runStatusText'),
  runStopText: $('runStopText'),
  runMetaStatus: $('runMetaStatus'),
  stopRunBtn: $('stopRunBtn'),
  resumeRunBtn: $('resumeRunBtn'),
  stage1Btn: $('processStage1Btn'),
  stage1RefreshBtn: $('refreshStage1Btn'),
  stage1Status: $('stage1Status'),
  stage1Total: $('stage1Total'),
  stage1Pending: $('stage1Pending'),
  stage1Completed: $('stage1Completed'),
  stage1Failed: $('stage1Failed'),
  stage1RecentBody: $('stage1RecentBody'),
  stage2Btn: $('processStage2Btn'),
  stage2RefreshBtn: $('refreshStage2Btn'),
  stage2Status: $('stage2Status'),
  stage2Total: $('stage2Total'),
  stage2Pending: $('stage2Pending'),
  stage2Completed: $('stage2Completed'),
  stage2Failed: $('stage2Failed'),
  stage2GoDeep: $('stage2GoDeep'),
  stage2RecentBody: $('stage2RecentBody'),
  stage3Btn: $('processStage3Btn'),
  stage3RefreshBtn: $('refreshStage3Btn'),
  stage3Status: $('stage3Status'),
  stage3Finalists: $('stage3Finalists'),
  stage3Pending: $('stage3Pending'),
  stage3Completed: $('stage3Completed'),
  stage3Spend: $('stage3Spend'),
  stage3Failed: $('stage3Failed'),
  stage3RecentBody: $('stage3RecentBody'),
  sectorNotesList: $('sectorNotesList'),
  sectorNotesEmpty: $('sectorNotesEmpty')
};

const FUNCTIONS_BASE = SUPABASE_URL.replace(/\.supabase\.co$/, '.functions.supabase.co');
const RUNS_CREATE_ENDPOINT = `${FUNCTIONS_BASE}/runs-create`;
const STAGE1_CONSUME_ENDPOINT = `${FUNCTIONS_BASE}/stage1-consume`;
const STAGE2_CONSUME_ENDPOINT = `${FUNCTIONS_BASE}/stage2-consume`;
const STAGE3_CONSUME_ENDPOINT = `${FUNCTIONS_BASE}/stage3-consume`;
const RUNS_STOP_ENDPOINT = `${FUNCTIONS_BASE}/runs-stop`;
const RUN_STORAGE_KEY = 'ff-active-run-id';

let authContext = {
  user: null,
  profile: null,
  membership: null,
  token: null,
  isAdmin: false,
  membershipActive: false
};
let lastAccessState = 'unknown';
let activeRunId = null;
let currentRunMeta = null;
let runChannel = null;
let stage1RefreshTimer = null;
let stage2RefreshTimer = null;
let stage3RefreshTimer = null;
let sectorNotesChannel = null;
let sectorNotesReady = false;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return { ...defaults };
    return {
      universe: Number(saved.universe) || defaults.universe,
      surviveStage2: Number(saved.surviveStage2) || defaults.surviveStage2,
      surviveStage3: Number(saved.surviveStage3) || defaults.surviveStage3,
      stage1: { ...defaults.stage1, ...saved.stage1 },
      stage2: { ...defaults.stage2, ...saved.stage2 },
      stage3: { ...defaults.stage3, ...saved.stage3 }
    };
  } catch (error) {
    console.warn('Unable to parse saved planner settings', error);
    return { ...defaults };
  }
}

function persistSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function getSettingsFromInputs() {
  return {
    universe: Number(inputs.universe?.value) || 0,
    surviveStage2: Number(inputs.stage2Slider?.value) || 0,
    surviveStage3: Number(inputs.stage3Slider?.value) || 0,
    stage1: {
      model: inputs.stage1Model?.value || defaults.stage1.model,
      inTokens: Number(inputs.stage1In?.value) || 0,
      outTokens: Number(inputs.stage1Out?.value) || 0
    },
    stage2: {
      model: inputs.stage2Model?.value || defaults.stage2.model,
      inTokens: Number(inputs.stage2In?.value) || 0,
      outTokens: Number(inputs.stage2Out?.value) || 0
    },
    stage3: {
      model: inputs.stage3Model?.value || defaults.stage3.model,
      inTokens: Number(inputs.stage3In?.value) || 0,
      outTokens: Number(inputs.stage3Out?.value) || 0
    }
  };
}

function applySettings(settings) {
  if (!inputs.startBtn) return;
  inputs.universe.value = settings.universe;
  inputs.stage2Slider.value = settings.surviveStage2;
  inputs.stage3Slider.value = settings.surviveStage3;
  inputs.stage2Value.textContent = `${settings.surviveStage2}%`;
  inputs.stage3Value.textContent = `${settings.surviveStage3}%`;
  inputs.stage1Model.value = settings.stage1.model;
  inputs.stage1In.value = settings.stage1.inTokens;
  inputs.stage1Out.value = settings.stage1.outTokens;
  inputs.stage2Model.value = settings.stage2.model;
  inputs.stage2In.value = settings.stage2.inTokens;
  inputs.stage2Out.value = settings.stage2.outTokens;
  inputs.stage3Model.value = settings.stage3.model;
  inputs.stage3In.value = settings.stage3.inTokens;
  inputs.stage3Out.value = settings.stage3.outTokens;
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function updateRunDisplay() {
  if (inputs.runIdDisplay) {
    inputs.runIdDisplay.textContent = activeRunId ?? '—';
  }

  if (inputs.runIdInput && document.activeElement !== inputs.runIdInput) {
    inputs.runIdInput.value = activeRunId ?? '';
  }
}

function updateRunMeta(meta = null, { message } = {}) {
  currentRunMeta = meta ?? null;

  const statusText = meta?.status ? String(meta.status).replace(/_/g, ' ') : null;
  const stopText = meta ? (meta.stop_requested ? 'Yes' : 'No') : null;

  if (inputs.runStatusText) {
    inputs.runStatusText.textContent = statusText ? statusText : '—';
  }

  if (inputs.runStopText) {
    inputs.runStopText.textContent = stopText ?? '—';
  }

  const defaultMessage = !activeRunId
    ? 'Select a run to manage stop requests.'
    : meta
      ? meta.stop_requested
        ? 'Run flagged to stop. Workers finish the active batch and halt new processing.'
        : 'Run active. Flag a stop request to pause new work after current batches.'
      : 'Loading run details…';

  if (inputs.runMetaStatus) {
    inputs.runMetaStatus.textContent = message || defaultMessage;
  }

  applyAccessState({ preserveStatus: true });
}

function clearStage1RefreshTimer() {
  if (stage1RefreshTimer) {
    clearTimeout(stage1RefreshTimer);
    stage1RefreshTimer = null;
  }
}

function scheduleStage1Refresh({ immediate = false } = {}) {
  clearStage1RefreshTimer();
  if (!activeRunId) return;
  if (immediate) {
    fetchStage1Summary({ silent: true }).catch((error) => {
      console.error('Auto refresh failed', error);
    });
    return;
  }

  stage1RefreshTimer = window.setTimeout(() => {
    stage1RefreshTimer = null;
    fetchStage1Summary({ silent: true }).catch((error) => {
      console.error('Auto refresh failed', error);
    });
  }, 400);
}

function clearStage2RefreshTimer() {
  if (stage2RefreshTimer) {
    clearTimeout(stage2RefreshTimer);
    stage2RefreshTimer = null;
  }
}

function scheduleStage2Refresh({ immediate = false } = {}) {
  clearStage2RefreshTimer();
  if (!activeRunId) return;
  if (immediate) {
    fetchStage2Summary({ silent: true }).catch((error) => {
      console.error('Stage 2 auto refresh failed', error);
    });
    return;
  }

  stage2RefreshTimer = window.setTimeout(() => {
    stage2RefreshTimer = null;
    fetchStage2Summary({ silent: true }).catch((error) => {
      console.error('Stage 2 auto refresh failed', error);
    });
  }, 500);
}

function clearStage3RefreshTimer() {
  if (stage3RefreshTimer) {
    clearTimeout(stage3RefreshTimer);
    stage3RefreshTimer = null;
  }
}

function scheduleStage3Refresh({ immediate = false } = {}) {
  clearStage3RefreshTimer();
  if (!activeRunId) return;
  if (immediate) {
    fetchStage3Summary({ silent: true }).catch((error) => {
      console.error('Stage 3 auto refresh failed', error);
    });
    return;
  }

  stage3RefreshTimer = window.setTimeout(() => {
    stage3RefreshTimer = null;
    fetchStage3Summary({ silent: true }).catch((error) => {
      console.error('Stage 3 auto refresh failed', error);
    });
  }, 650);
}

function unsubscribeFromRunChannel() {
  clearStage1RefreshTimer();
  clearStage2RefreshTimer();
  clearStage3RefreshTimer();
  if (runChannel) {
    try {
      supabase.removeChannel(runChannel);
    } catch (error) {
      console.warn('Failed to remove previous realtime channel', error);
    }
    runChannel = null;
  }
}

function subscribeToRunChannel(runId) {
  unsubscribeFromRunChannel();
  if (!runId) return;

  runChannel = supabase
    .channel(`planner-run-${runId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'run_items', filter: `run_id=eq.${runId}` }, () => {
      scheduleStage1Refresh();
      scheduleStage2Refresh();
      scheduleStage3Refresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'answers', filter: `run_id=eq.${runId}` }, () => {
      scheduleStage1Refresh();
      scheduleStage2Refresh();
      scheduleStage3Refresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'runs', filter: `id=eq.${runId}` }, () => {
      fetchRunMeta({ silent: true }).catch((error) => {
        console.error('Realtime run meta refresh failed', error);
      });
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        scheduleStage1Refresh({ immediate: true });
        scheduleStage2Refresh({ immediate: true });
        scheduleStage3Refresh({ immediate: true });
        fetchRunMeta({ silent: true }).catch((error) => {
          console.error('Initial run meta load failed', error);
        });
      }
    });
}

async function fetchRunMeta({ silent = false } = {}) {
  if (!activeRunId) {
    updateRunMeta(null);
    return null;
  }

  if (!silent && inputs.runMetaStatus) {
    inputs.runMetaStatus.textContent = 'Loading run details…';
  }

  try {
    const { data, error } = await supabase
      .from('runs')
      .select('id, created_at, status, stop_requested, notes')
      .eq('id', activeRunId)
      .maybeSingle();

    if (error) throw error;

    updateRunMeta(data ?? null);
    return data ?? null;
  } catch (error) {
    console.error('Failed to load run details', error);
    updateRunMeta(null, { message: 'Unable to load run details. Try refreshing.' });
    return null;
  }
}

async function toggleRunStop(stopRequested) {
  if (!activeRunId) {
    if (inputs.runMetaStatus) inputs.runMetaStatus.textContent = 'Select a run before toggling stop requests.';
    return;
  }

  await syncAccess({ preserveStatus: true });

  if (!authContext.user) {
    if (inputs.runMetaStatus) inputs.runMetaStatus.textContent = 'Sign in required to manage runs.';
    return;
  }

  if (!authContext.isAdmin) {
    if (inputs.runMetaStatus) inputs.runMetaStatus.textContent = 'Admin access required to toggle stop requests.';
    return;
  }

  if (!authContext.token) {
    if (inputs.runMetaStatus) inputs.runMetaStatus.textContent = 'Session expired. Sign in again to continue.';
    await syncAccess();
    return;
  }

  const primaryBtn = stopRequested ? inputs.stopRunBtn : inputs.resumeRunBtn;
  const secondaryBtn = stopRequested ? inputs.resumeRunBtn : inputs.stopRunBtn;

  if (primaryBtn) primaryBtn.disabled = true;
  if (secondaryBtn) secondaryBtn.disabled = true;

  if (inputs.runMetaStatus) {
    inputs.runMetaStatus.textContent = stopRequested
      ? 'Flagging run to stop…'
      : 'Clearing stop request…';
  }

  try {
    const response = await fetch(RUNS_STOP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authContext.token}`
      },
      body: JSON.stringify({
        run_id: activeRunId,
        stop_requested: Boolean(stopRequested),
        client_meta: {
          origin: window.location.origin,
          triggered_at: new Date().toISOString()
        }
      })
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        console.warn('Unable to parse runs-stop response JSON', error);
      }
    }

    if (!response.ok) {
      const message = payload?.error || `runs-stop endpoint responded ${response.status}`;
      throw new Error(message);
    }

    const run = payload?.run ?? null;
    updateRunMeta(run ?? currentRunMeta, {
      message: stopRequested
        ? 'Stop request recorded. Workers will finish the active batch and halt.'
        : 'Stop request cleared. Workers may resume new batches.'
    });

    const logMessage = stopRequested ? 'Stop requested for active run.' : 'Stop request cleared for active run.';
    logStatus(logMessage);
    scheduleStage1Refresh({ immediate: true });
    scheduleStage2Refresh({ immediate: true });
  } catch (error) {
    console.error('Failed to toggle stop request', error);
    if (inputs.runMetaStatus) {
      inputs.runMetaStatus.textContent = `Failed to update run: ${error.message}`;
    }
    logStatus(`Stop toggle failed: ${error.message}`);
  } finally {
    if (secondaryBtn) secondaryBtn.disabled = false;
    if (primaryBtn) primaryBtn.disabled = false;
    applyAccessState({ preserveStatus: true });
  }
}

function updateStage1Metrics(metrics = null) {
  const formatter = (value) => {
    if (value == null || Number.isNaN(value)) return '—';
    return Number(value).toLocaleString();
  };

  if (inputs.stage1Total) inputs.stage1Total.textContent = formatter(metrics?.total);
  if (inputs.stage1Pending) inputs.stage1Pending.textContent = formatter(metrics?.pending);
  if (inputs.stage1Completed) inputs.stage1Completed.textContent = formatter(metrics?.completed);
  if (inputs.stage1Failed) inputs.stage1Failed.textContent = formatter(metrics?.failed);
}

function renderRecentClassifications(entries = []) {
  const body = inputs.stage1RecentBody;
  if (!body) return;

  body.innerHTML = '';

  if (!entries.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4" class="recent-empty">No classifications yet.</td>';
    body.appendChild(row);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('tr');
    const safeSummary = entry.summary ? String(entry.summary) : '—';
    const updated = entry.updated_at
      ? new Date(entry.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    row.innerHTML = `
      <td>${entry.ticker ?? '—'}</td>
      <td data-label>${entry.label ?? '—'}</td>
      <td>${safeSummary}</td>
      <td>${updated}</td>
    `;
    body.appendChild(row);
  });
}

function updateStage2Metrics(metrics = null) {
  const formatter = (value) => {
    if (value == null || Number.isNaN(value)) return '—';
    return Number(value).toLocaleString();
  };

  if (inputs.stage2Total) inputs.stage2Total.textContent = formatter(metrics?.total);
  if (inputs.stage2Pending) inputs.stage2Pending.textContent = formatter(metrics?.pending);
  if (inputs.stage2Completed) inputs.stage2Completed.textContent = formatter(metrics?.completed);
  if (inputs.stage2Failed) inputs.stage2Failed.textContent = formatter(metrics?.failed);
  if (inputs.stage2GoDeep) inputs.stage2GoDeep.textContent = formatter(metrics?.goDeep);
}

function renderStage2Insights(entries = []) {
  const body = inputs.stage2RecentBody;
  if (!body) return;

  body.innerHTML = '';

  if (!entries.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4" class="recent-empty">No Stage 2 calls yet.</td>';
    body.appendChild(row);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('tr');
    const goDeep = entry.go_deep ? 'Yes' : entry.status === 'failed' ? 'Failed' : 'No';
    const updated = entry.updated_at
      ? new Date(entry.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    row.innerHTML = `
      <td>${entry.ticker ?? '—'}</td>
      <td data-label>${goDeep}</td>
      <td>${entry.summary ?? '—'}</td>
      <td>${updated}</td>
    `;
    body.appendChild(row);
  });
}

function updateStage3Metrics(metrics = null) {
  const formatter = (value) => {
    if (value == null || Number.isNaN(value)) return '—';
    return Number(value).toLocaleString();
  };

  if (inputs.stage3Finalists) inputs.stage3Finalists.textContent = formatter(metrics?.finalists);
  if (inputs.stage3Pending) inputs.stage3Pending.textContent = formatter(metrics?.pending);
  if (inputs.stage3Completed) inputs.stage3Completed.textContent = formatter(metrics?.completed);
  if (inputs.stage3Spend) {
    const spend = metrics?.spend;
    inputs.stage3Spend.textContent = spend == null || Number.isNaN(spend) ? '—' : formatCurrency(Number(spend));
  }
  if (inputs.stage3Failed) inputs.stage3Failed.textContent = formatter(metrics?.failed);
}

function renderStage3Reports(entries = []) {
  const body = inputs.stage3RecentBody;
  if (!body) return;

  body.innerHTML = '';

  if (!entries.length) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="4" class="recent-empty">No deep-dive reports yet.</td>';
    body.appendChild(row);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('tr');
    const verdict = entry.verdict ? String(entry.verdict) : '—';
    const thesis = entry.summary ?? entry.answer_text ?? '—';
    const updated = entry.updated_at
      ? new Date(entry.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    row.innerHTML = `
      <td>${entry.ticker ?? '—'}</td>
      <td data-label>${verdict}</td>
      <td>${thesis}</td>
      <td>${updated}</td>
    `;
    body.appendChild(row);
  });
}

async function fetchStage1Summary({ silent = false } = {}) {
  if (!inputs.stage1Status) return;

  if (!activeRunId) {
    updateStage1Metrics();
    renderRecentClassifications([]);
    if (!silent) inputs.stage1Status.textContent = 'Set a run ID to monitor triage progress.';
    return;
  }

  if (!silent) inputs.stage1Status.textContent = 'Fetching Stage 1 progress…';

  try {
    const [totalRes, pendingRes, completedRes, failedRes, answersRes] = await Promise.all([
      supabase
        .from('run_items')
        .select('*', { count: 'exact', head: true })
        .eq('run_id', activeRunId),
      supabase
        .from('run_items')
        .select('*', { count: 'exact', head: true })
        .eq('run_id', activeRunId)
        .eq('status', 'pending')
        .eq('stage', 0),
      supabase
        .from('run_items')
        .select('*', { count: 'exact', head: true })
        .eq('run_id', activeRunId)
        .eq('status', 'ok')
        .gte('stage', 1),
      supabase
        .from('run_items')
        .select('*', { count: 'exact', head: true })
        .eq('run_id', activeRunId)
        .eq('status', 'failed'),
      supabase
        .from('answers')
        .select('ticker, answer_json, created_at')
        .eq('run_id', activeRunId)
        .eq('stage', 1)
        .order('created_at', { ascending: false })
        .limit(8)
    ]);

    if (totalRes.error) throw totalRes.error;
    if (pendingRes.error) throw pendingRes.error;
    if (completedRes.error) throw completedRes.error;
    if (failedRes.error) throw failedRes.error;
    if (answersRes.error) throw answersRes.error;

    const metrics = {
      total: totalRes.count ?? 0,
      pending: pendingRes.count ?? 0,
      completed: completedRes.count ?? 0,
      failed: failedRes.count ?? 0
    };

    updateStage1Metrics(metrics);

    const recent = (answersRes.data ?? []).map((row) => {
      const answer = row.answer_json ?? {};
      let summary = '';
      if (Array.isArray(answer.reasons) && answer.reasons.length) {
        summary = answer.reasons[0];
      } else if (typeof answer.summary === 'string') {
        summary = answer.summary;
      } else if (typeof answer.reason === 'string') {
        summary = answer.reason;
      }

      return {
        ticker: row.ticker,
        label: answer.label ?? answer.classification ?? null,
        summary: summary || '—',
        updated_at: row.created_at
      };
    });

    renderRecentClassifications(recent);

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    inputs.stage1Status.textContent = `Last updated ${timestamp}`;
  } catch (error) {
    console.error('Failed to load Stage 1 summary', error);
    inputs.stage1Status.textContent = 'Failed to load Stage 1 progress.';
  }
}

async function fetchStage2Summary({ silent = false } = {}) {
  if (!inputs.stage2Status) return;

  if (!activeRunId) {
    updateStage2Metrics();
    renderStage2Insights([]);
    if (!silent) inputs.stage2Status.textContent = 'Set a run ID to monitor Stage 2 progress.';
    return;
  }

  if (!silent) inputs.stage2Status.textContent = 'Fetching Stage 2 progress…';

  try {
    const [summaryResult, answersResult] = await Promise.all([
      supabase.rpc('run_stage2_summary', { p_run_id: activeRunId }).maybeSingle(),
      supabase
        .from('answers')
        .select('ticker, answer_json, created_at')
        .eq('run_id', activeRunId)
        .eq('stage', 2)
        .order('created_at', { ascending: false })
        .limit(8)
    ]);

    if (summaryResult.error) throw summaryResult.error;
    if (answersResult.error) throw answersResult.error;

    const summary = summaryResult.data ?? null;
    const metrics = {
      total: summary ? Number(summary.total_survivors ?? 0) : 0,
      pending: summary ? Number(summary.pending ?? 0) : 0,
      completed: summary ? Number(summary.completed ?? 0) : 0,
      failed: summary ? Number(summary.failed ?? 0) : 0,
      goDeep: summary ? Number(summary.go_deep ?? 0) : 0
    };

    updateStage2Metrics(metrics);

    const recent = (answersResult.data ?? []).map((row) => {
      const answer = row.answer_json ?? {};
      const verdict = answer?.verdict ?? {};
      const rawGoDeep = verdict?.go_deep;
      const goDeep = typeof rawGoDeep === 'boolean'
        ? rawGoDeep
        : typeof rawGoDeep === 'string'
          ? rawGoDeep.toLowerCase() === 'true'
          : false;
      let summaryText = typeof verdict?.summary === 'string' ? verdict.summary : '';
      if (!summaryText && Array.isArray(answer?.next_steps) && answer.next_steps.length) {
        summaryText = String(answer.next_steps[0]);
      }
      return {
        ticker: row.ticker,
        go_deep: goDeep,
        summary: summaryText || '—',
        updated_at: row.created_at,
        status: 'ok'
      };
    });

    renderStage2Insights(recent);

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    inputs.stage2Status.textContent = `Last updated ${timestamp}`;
  } catch (error) {
    console.error('Failed to load Stage 2 summary', error);
    inputs.stage2Status.textContent = 'Failed to load Stage 2 progress.';
  }
}

async function fetchStage3Summary({ silent = false } = {}) {
  if (!inputs.stage3Status) return;

  if (!activeRunId) {
    updateStage3Metrics();
    renderStage3Reports([]);
    if (!silent) inputs.stage3Status.textContent = 'Set a run ID to monitor Stage 3 deep dives.';
    return;
  }

  if (!silent) inputs.stage3Status.textContent = 'Fetching Stage 3 progress…';

  try {
    const [summaryResult, answersResult, costResult] = await Promise.all([
      supabase.rpc('run_stage3_summary', { p_run_id: activeRunId }).maybeSingle(),
      supabase
        .from('answers')
        .select('ticker, answer_json, answer_text, question_group, created_at')
        .eq('run_id', activeRunId)
        .eq('stage', 3)
        .order('created_at', { ascending: false })
        .limit(10),
      supabase.rpc('run_cost_breakdown', { p_run_id: activeRunId })
    ]);

    if (summaryResult.error) throw summaryResult.error;
    if (answersResult.error) throw answersResult.error;
    if (costResult.error) throw costResult.error;

    const summary = summaryResult.data ?? null;
    const metrics = {
      finalists: summary ? Number(summary.total_finalists ?? summary.finalists ?? 0) : 0,
      pending: summary ? Number(summary.pending ?? 0) : 0,
      completed: summary ? Number(summary.completed ?? 0) : 0,
      failed: summary ? Number(summary.failed ?? 0) : 0,
      spend: 0
    };

    const breakdown = Array.isArray(costResult.data) ? costResult.data : [];
    const stage3Spend = breakdown
      .filter((row) => Number(row.stage) === 3)
      .reduce((acc, row) => acc + Number(row.cost_usd ?? 0), 0);
    metrics.spend = stage3Spend;

    updateStage3Metrics(metrics);

    const reports = (answersResult.data ?? [])
      .filter((row) => (row.question_group ?? '').toLowerCase() === 'summary')
      .map((row) => {
        const answer = row.answer_json ?? {};
        const verdict = answer.verdict ?? answer.rating ?? answer.recommendation ?? null;
        const summaryText =
          answer.thesis ??
          answer.summary ??
          answer.narrative ??
          (Array.isArray(answer.takeaways) && answer.takeaways.length ? answer.takeaways[0] : null) ??
          row.answer_text ??
          '—';
        return {
          ticker: row.ticker,
          verdict,
          summary: summaryText,
          answer_text: row.answer_text ?? null,
          updated_at: row.created_at
        };
      });

    renderStage3Reports(reports);

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    inputs.stage3Status.textContent = `Last updated ${timestamp}`;
  } catch (error) {
    console.error('Failed to load Stage 3 summary', error);
    inputs.stage3Status.textContent = 'Failed to load Stage 3 progress.';
  }
}

function setActiveRunId(value, { announce = true, silent = false } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized && !isValidUuid(normalized)) {
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'Run ID must be a valid UUID.';
    return false;
  }

  const previous = activeRunId;
  activeRunId = normalized || null;
  const changed = previous !== activeRunId;

  if (activeRunId) {
    localStorage.setItem(RUN_STORAGE_KEY, activeRunId);
  } else {
    localStorage.removeItem(RUN_STORAGE_KEY);
  }

  updateRunDisplay();
  applyAccessState({ preserveStatus: true });

  if (!activeRunId) {
    unsubscribeFromRunChannel();
    updateRunMeta(null);
    updateStage1Metrics();
    renderRecentClassifications([]);
    updateStage2Metrics();
    renderStage2Insights([]);
    updateStage3Metrics();
    renderStage3Reports([]);
    if (announce && inputs.stage1Status) inputs.stage1Status.textContent = 'Active run cleared. Set a run ID to continue.';
    if (announce) logStatus('Active run cleared.');
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Active run cleared.';
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Active run cleared.';
    return changed;
  }

  subscribeToRunChannel(activeRunId);

  fetchRunMeta({ silent }).catch((error) => {
    console.error('Failed to refresh run details', error);
  });

  if (announce) {
    const message = `Active run set to ${activeRunId}`;
    if (inputs.stage1Status) inputs.stage1Status.textContent = message;
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Loading Stage 2 progress…';
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Loading Stage 3 progress…';
    logStatus(message);
  }

  fetchStage1Summary({ silent }).catch((error) => {
    console.error('Failed to refresh Stage 1 summary', error);
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'Failed to load Stage 1 progress.';
  });

  fetchStage2Summary({ silent }).catch((error) => {
    console.error('Failed to refresh Stage 2 summary', error);
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Failed to load Stage 2 progress.';
  });

  fetchStage3Summary({ silent }).catch((error) => {
    console.error('Failed to refresh Stage 3 summary', error);
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Failed to load Stage 3 progress.';
  });

  return changed;
}

async function processStage1Batch() {
  if (!inputs.stage1Btn) return;

  if (!activeRunId) {
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'Assign a run ID before processing.';
    return;
  }

  if (currentRunMeta?.stop_requested) {
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'Run flagged to stop. Clear the stop request to continue processing.';
    return;
  }

  await syncAccess({ preserveStatus: true });

  if (!authContext.user) {
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'Sign in required.';
    return;
  }

  if (!authContext.isAdmin) {
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'Admin access required.';
    return;
  }

  if (!authContext.token) {
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'Session expired. Sign in again to continue.';
    await syncAccess();
    return;
  }

  inputs.stage1Btn.disabled = true;
  if (inputs.stage1Status) inputs.stage1Status.textContent = 'Processing Stage 1 batch…';

  try {
    const response = await fetch(STAGE1_CONSUME_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authContext.token}`
      },
      body: JSON.stringify({
        run_id: activeRunId,
        limit: 8,
        client_meta: {
          origin: window.location.origin,
          triggered_at: new Date().toISOString()
        }
      })
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        console.warn('Unable to parse Stage 1 response JSON', error);
      }
    }

    if (!response.ok) {
      const message = payload?.error || `Stage 1 endpoint responded ${response.status}`;
      throw new Error(message);
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    if (results.length) {
      renderRecentClassifications(results);
    }

    const message = payload.message || `Processed ${results.length} ticker${results.length === 1 ? '' : 's'}.`;
    if (inputs.stage1Status) inputs.stage1Status.textContent = message;
    logStatus(`[Stage 1] ${message}`);
  } catch (error) {
    console.error('Stage 1 batch error', error);
    if (inputs.stage1Status) inputs.stage1Status.textContent = `Stage 1 failed: ${error.message}`;
    logStatus(`Stage 1 batch failed: ${error.message}`);
  } finally {
    try {
      await fetchStage1Summary({ silent: true });
    } catch (error) {
      console.error('Failed to refresh Stage 1 summary after batch', error);
    }
    try {
      await fetchStage2Summary({ silent: true });
    } catch (error) {
      console.error('Failed to refresh Stage 2 summary after Stage 1 batch', error);
    }
    applyAccessState({ preserveStatus: true });
  }
}

async function processStage2Batch() {
  if (!inputs.stage2Btn) return;

  if (!activeRunId) {
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Assign a run ID before processing.';
    return;
  }

  if (currentRunMeta?.stop_requested) {
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Run flagged to stop. Clear the stop request to continue processing.';
    return;
  }

  await syncAccess({ preserveStatus: true });
  if (!authContext.isAdmin) {
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Admin access required for Stage 2.';
    return;
  }
  if (!authContext.token) {
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Session expired. Refresh and try again.';
    return;
  }

  inputs.stage2Btn.disabled = true;
  if (inputs.stage2Status) inputs.stage2Status.textContent = 'Processing Stage 2 batch…';

  try {
    const response = await fetch(STAGE2_CONSUME_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authContext.token}`
      },
      body: JSON.stringify({
        run_id: activeRunId,
        limit: 4,
        client_meta: {
          origin: window.location.origin,
          triggered_at: new Date().toISOString()
        }
      })
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        console.warn('Unable to parse Stage 2 response JSON', error);
      }
    }

    if (!response.ok) {
      const message = payload?.error || `Stage 2 endpoint responded ${response.status}`;
      throw new Error(message);
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    if (results.length) {
      renderStage2Insights(results);
    }

    if (payload.metrics) {
      updateStage2Metrics({
        total: Number(payload.metrics.total_survivors ?? payload.metrics.total ?? 0),
        pending: Number(payload.metrics.pending ?? 0),
        completed: Number(payload.metrics.completed ?? 0),
        failed: Number(payload.metrics.failed ?? 0),
        goDeep: Number(payload.metrics.go_deep ?? payload.metrics.goDeep ?? 0)
      });
    }

    const message = payload.message || `Processed ${results.length} ticker${results.length === 1 ? '' : 's'}.`;
    if (inputs.stage2Status) inputs.stage2Status.textContent = message;
    logStatus(`[Stage 2] ${message}`);
  } catch (error) {
    console.error('Stage 2 batch error', error);
    if (inputs.stage2Status) inputs.stage2Status.textContent = `Stage 2 failed: ${error.message}`;
    logStatus(`Stage 2 batch failed: ${error.message}`);
  } finally {
    try {
      await fetchStage2Summary({ silent: true });
    } catch (error) {
      console.error('Failed to refresh Stage 2 summary after batch', error);
    }
    applyAccessState({ preserveStatus: true });
  }
}

async function processStage3Batch() {
  if (!inputs.stage3Btn) return;

  if (!activeRunId) {
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Assign a run ID before processing deep dives.';
    return;
  }

  if (currentRunMeta?.stop_requested) {
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Run flagged to stop. Clear the stop request to continue.';
    return;
  }

  await syncAccess({ preserveStatus: true });
  if (!authContext.isAdmin) {
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Admin access required for Stage 3.';
    return;
  }
  if (!authContext.token) {
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Session expired. Refresh and try again.';
    return;
  }

  inputs.stage3Btn.disabled = true;
  if (inputs.stage3Status) inputs.stage3Status.textContent = 'Processing Stage 3 batch…';

  try {
    const response = await fetch(STAGE3_CONSUME_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authContext.token}`
      },
      body: JSON.stringify({
        run_id: activeRunId,
        limit: 2,
        client_meta: {
          origin: window.location.origin,
          triggered_at: new Date().toISOString()
        }
      })
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        console.warn('Unable to parse Stage 3 response JSON', error);
      }
    }

    if (!response.ok) {
      const message = payload?.error || `Stage 3 endpoint responded ${response.status}`;
      throw new Error(message);
    }

    const reports = Array.isArray(payload.results) ? payload.results : [];
    if (reports.length) {
      renderStage3Reports(reports);
    }

    if (payload.metrics) {
      updateStage3Metrics({
        finalists: Number(payload.metrics.total_finalists ?? payload.metrics.finalists ?? payload.metrics.total ?? 0),
        pending: Number(payload.metrics.pending ?? 0),
        completed: Number(payload.metrics.completed ?? 0),
        failed: Number(payload.metrics.failed ?? 0),
        spend: Number(payload.metrics.spend ?? payload.metrics.total_spend ?? 0)
      });
    }

    const message = payload.message || `Processed ${reports.length} finalist${reports.length === 1 ? '' : 's'}.`;
    if (inputs.stage3Status) inputs.stage3Status.textContent = message;
    logStatus(`[Stage 3] ${message}`);
  } catch (error) {
    console.error('Stage 3 batch error', error);
    if (inputs.stage3Status) inputs.stage3Status.textContent = `Stage 3 failed: ${error.message}`;
    logStatus(`Stage 3 batch failed: ${error.message}`);
  } finally {
    try {
      await fetchStage3Summary({ silent: true });
    } catch (error) {
      console.error('Failed to refresh Stage 3 summary after batch', error);
    }
    applyAccessState({ preserveStatus: true });
  }
}

function stageCost(n, inTok, outTok, modelKey) {
  const model = PRICES[modelKey];
  if (!model || !n) return { total: 0, inCost: 0, outCost: 0 };
  const inCost = (n * inTok / 1_000_000) * model.in;
  const outCost = (n * outTok / 1_000_000) * model.out;
  return { total: inCost + outCost, inCost, outCost };
}

function formatCurrency(amount) {
  return `$${amount.toFixed(2)}`;
}

function updateCostOutput() {
  if (!inputs.costOut) return;
  const settings = getSettingsFromInputs();
  persistSettings(settings);

  const survivorsStage2 = Math.round(settings.universe * (settings.surviveStage2 / 100));
  const survivorsStage3 = Math.round(survivorsStage2 * (settings.surviveStage3 / 100));

  const s1 = stageCost(settings.universe, settings.stage1.inTokens, settings.stage1.outTokens, settings.stage1.model);
  const s2 = stageCost(survivorsStage2, settings.stage2.inTokens, settings.stage2.outTokens, settings.stage2.model);
  const s3 = stageCost(survivorsStage3, settings.stage3.inTokens, settings.stage3.outTokens, settings.stage3.model);

  const total = s1.total + s2.total + s3.total;

  const rows = inputs.costOut.querySelectorAll('li');
  if (rows[0]) rows[0].lastElementChild.textContent = formatCurrency(s1.total);
  if (rows[1]) rows[1].lastElementChild.textContent = formatCurrency(s2.total);
  if (rows[2]) rows[2].lastElementChild.textContent = formatCurrency(s3.total);
  inputs.totalCost.textContent = formatCurrency(total);
  inputs.survivorSummary.textContent = `Stage 2 survivors: ${survivorsStage2.toLocaleString()} • Stage 3 finalists: ${survivorsStage3.toLocaleString()}`;
}

function logStatus(message) {
  if (!inputs.log) return;
  const now = new Date();
  const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  inputs.log.textContent = `[${timestamp}] ${message}\n\n${inputs.log.textContent}`.trim();
}

const defaultSectorEmptyText = inputs.sectorNotesEmpty?.textContent ??
  'No sector notes yet. Add heuristics to customise Stage 2 scoring.';

function truncateNotes(text, limit = 180) {
  if (!text) return '';
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function clearSectorNotes() {
  if (inputs.sectorNotesList) {
    inputs.sectorNotesList.innerHTML = '';
    inputs.sectorNotesList.hidden = true;
  }
  if (inputs.sectorNotesEmpty) {
    inputs.sectorNotesEmpty.textContent = defaultSectorEmptyText;
    inputs.sectorNotesEmpty.hidden = false;
  }
  sectorNotesReady = false;
}

function renderSectorNotes(records = []) {
  if (!inputs.sectorNotesList || !inputs.sectorNotesEmpty) return;
  if (!records.length) {
    clearSectorNotes();
    return;
  }

  const fragment = document.createDocumentFragment();
  records.forEach((record) => {
    const item = document.createElement('li');
    item.className = 'sector-notes__item';
    const title = document.createElement('strong');
    title.textContent = record.sector;
    const body = document.createElement('p');
    body.textContent = truncateNotes(record.notes);
    item.append(title, body);
    fragment.append(item);
  });

  inputs.sectorNotesList.innerHTML = '';
  inputs.sectorNotesList.appendChild(fragment);
  inputs.sectorNotesList.hidden = false;
  inputs.sectorNotesEmpty.hidden = true;
}

async function refreshSectorNotes({ silent = false } = {}) {
  if (!authContext.isAdmin || !inputs.sectorNotesList) return;
  if (!silent && inputs.sectorNotesEmpty) {
    inputs.sectorNotesEmpty.textContent = 'Loading sector guidance…';
    inputs.sectorNotesEmpty.hidden = false;
  }
  try {
    const { data, error } = await supabase
      .from('sector_prompts')
      .select('sector, notes')
      .order('sector', { ascending: true })
      .limit(12);
    if (error) throw error;
    const records = (data || []).map((entry) => ({
      sector: String(entry.sector || 'Unknown'),
      notes: String(entry.notes || '')
    }));
    sectorNotesReady = true;
    renderSectorNotes(records);
  } catch (error) {
    console.error('Failed to refresh sector notes', error);
    if (inputs.sectorNotesEmpty) {
      inputs.sectorNotesEmpty.textContent = 'Unable to load sector notes right now.';
      inputs.sectorNotesEmpty.hidden = false;
    }
  }
}

function detachSectorNotesChannel() {
  if (sectorNotesChannel) {
    supabase.removeChannel(sectorNotesChannel);
    sectorNotesChannel = null;
  }
}

function subscribeSectorNotes() {
  if (!authContext.isAdmin || !inputs.sectorNotesList) return;
  detachSectorNotesChannel();
  sectorNotesChannel = supabase
    .channel('planner-sector-prompts')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sector_prompts' }, () => {
      refreshSectorNotes({ silent: true });
    });
  sectorNotesChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      refreshSectorNotes({ silent: sectorNotesReady });
    }
  });
}

function applyAccessState({ preserveStatus = false } = {}) {
  const previousState = lastAccessState;
  const state = !authContext.user
    ? 'signed-out'
    : authContext.isAdmin
      ? 'admin-ok'
      : 'no-admin';

  if (state === 'admin-ok' && previousState !== 'admin-ok') {
    subscribeSectorNotes();
    refreshSectorNotes({ silent: true });
  } else if (state !== 'admin-ok' && previousState === 'admin-ok') {
    detachSectorNotesChannel();
    clearSectorNotes();
  } else if (state === 'admin-ok' && !sectorNotesReady) {
    refreshSectorNotes({ silent: true });
  }

  if (inputs.startBtn) {
    inputs.startBtn.disabled = state !== 'admin-ok';
  }

  if (inputs.stage1Btn) {
    inputs.stage1Btn.disabled = state !== 'admin-ok' || !activeRunId || (currentRunMeta?.stop_requested ?? false);
  }

  if (inputs.stage1RefreshBtn) {
    inputs.stage1RefreshBtn.disabled = !activeRunId;
  }

  if (inputs.stage2Btn) {
    inputs.stage2Btn.disabled =
      state !== 'admin-ok' || !activeRunId || (currentRunMeta?.stop_requested ?? false);
  }

  if (inputs.stage2RefreshBtn) {
    inputs.stage2RefreshBtn.disabled = !activeRunId;
  }

  if (inputs.stage3Btn) {
    inputs.stage3Btn.disabled =
      state !== 'admin-ok' || !activeRunId || (currentRunMeta?.stop_requested ?? false);
  }

  if (inputs.stage3RefreshBtn) {
    inputs.stage3RefreshBtn.disabled = !activeRunId;
  }

  if (inputs.stopRunBtn) {
    inputs.stopRunBtn.disabled = state !== 'admin-ok' || !activeRunId || (currentRunMeta?.stop_requested ?? false);
  }

  if (inputs.resumeRunBtn) {
    inputs.resumeRunBtn.disabled = state !== 'admin-ok' || !activeRunId || !(currentRunMeta?.stop_requested ?? false);
  }

  if (!inputs.status) {
    lastAccessState = state;
    return;
  }

  const changed = state !== lastAccessState;
  if (changed) {
    if (!preserveStatus) {
      if (state === 'admin-ok') inputs.status.textContent = 'Ready';
      else if (state === 'signed-out') inputs.status.textContent = 'Sign in required';
      else inputs.status.textContent = 'Admin access required';
    }

    const logMessage = state === 'admin-ok'
      ? 'Authenticated as admin. Automation ready to launch.'
      : state === 'signed-out'
        ? 'Sign in to launch automated runs.'
        : 'Current user lacks admin privileges. Contact an administrator to continue.';
    logStatus(logMessage);
    lastAccessState = state;
  }
}

async function refreshAuthContext() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? null;
    const user = session?.user ?? null;
    let profile = null;
    let membership = null;

    if (user) {
      try {
        await ensureProfile(user);
      } catch (error) {
        console.warn('ensureProfile failed', error);
      }

      const [profileResult, membershipResult] = await Promise.all([
        supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .maybeSingle(),
        supabase
          .from('memberships')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle()
      ]);

      if (profileResult.error) {
        console.warn('profiles fetch error', profileResult.error);
      } else {
        profile = profileResult.data ?? null;
      }

      if (membershipResult.error) {
        console.warn('memberships fetch error', membershipResult.error);
      } else {
        membership = membershipResult.data ?? null;
      }
    }

    authContext = {
      user,
      profile,
      membership,
      token,
      isAdmin: hasAdminRole({ user, profile, membership }),
      membershipActive: isMembershipActive(membership, { user, profile, membership })
    };
  } catch (error) {
    console.error('Failed to refresh auth context', error);
    authContext = {
      user: null,
      profile: null,
      membership: null,
      token: null,
      isAdmin: false,
      membershipActive: false
    };
  }

  return authContext;
}

async function syncAccess(options = {}) {
  await refreshAuthContext();
  applyAccessState(options);
}

async function startRun() {
  if (!inputs.startBtn || !inputs.status) return;
  await syncAccess({ preserveStatus: true });

  if (!authContext.user) {
    inputs.status.textContent = 'Sign in required';
    logStatus('Launch blocked: no active session.');
    return;
  }

  if (!authContext.isAdmin) {
    inputs.status.textContent = 'Admin access required';
    logStatus('Launch blocked: admin privileges needed.');
    return;
  }

  if (!authContext.token) {
    inputs.status.textContent = 'Session expired';
    logStatus('Launch blocked: refresh the page or sign in again to renew your session.');
    await syncAccess();
    return;
  }

  const settings = getSettingsFromInputs();
  inputs.startBtn.disabled = true;
  inputs.status.textContent = 'Launching…';
  logStatus(`Submitting run to ${RUNS_CREATE_ENDPOINT}`);

  try {
    const response = await fetch(RUNS_CREATE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authContext.token}`
      },
      body: JSON.stringify({
        planner: settings,
        client_meta: {
          origin: window.location.origin,
          pathname: window.location.pathname,
          triggered_at: new Date().toISOString()
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API responded ${response.status}: ${text}`);
    }

    const data = await response.json();
    const runId = typeof data.run_id === 'string' ? data.run_id : null;
    inputs.status.textContent = `Run created: ${runId || 'unknown id'}`;
    if (runId) {
      setActiveRunId(runId, { announce: true, silent: true });
      if (inputs.stage1Status) inputs.stage1Status.textContent = 'Run queued. Process Stage 1 batches to begin triage.';
    }
    const total = typeof data.total_items === 'number' ? data.total_items : 'n/a';
    logStatus(`Run created successfully with ${total} tickers queued.`);
  } catch (error) {
    console.error(error);
    inputs.status.textContent = 'Launch failed';
    logStatus(`Launch failed: ${error.message}`);
  } finally {
    applyAccessState({ preserveStatus: true });
  }
}

function resetDefaults() {
  persistSettings(defaults);
  applySettings(defaults);
  updateCostOutput();
  logStatus('Settings restored to defaults.');
  if (inputs.status) inputs.status.textContent = 'Defaults restored';
}

function bindEvents() {
  const watchedInputs = [
    inputs.universe,
    inputs.stage2Slider,
    inputs.stage3Slider,
    inputs.stage1Model,
    inputs.stage2Model,
    inputs.stage3Model,
    inputs.stage1In,
    inputs.stage1Out,
    inputs.stage2In,
    inputs.stage2Out,
    inputs.stage3In,
    inputs.stage3Out
  ].filter(Boolean);

  watchedInputs.forEach((element) => {
    element.addEventListener('input', () => {
      if (element === inputs.stage2Slider) {
        inputs.stage2Value.textContent = `${element.value}%`;
      }
      if (element === inputs.stage3Slider) {
        inputs.stage3Value.textContent = `${element.value}%`;
      }
      updateCostOutput();
    });
  });

  inputs.startBtn?.addEventListener('click', startRun);
  inputs.resetBtn?.addEventListener('click', resetDefaults);
  inputs.stage1Btn?.addEventListener('click', processStage1Batch);
  inputs.stage1RefreshBtn?.addEventListener('click', () => fetchStage1Summary());
  inputs.stage2Btn?.addEventListener('click', processStage2Batch);
  inputs.stage2RefreshBtn?.addEventListener('click', () => fetchStage2Summary());
  inputs.stage3Btn?.addEventListener('click', processStage3Batch);
  inputs.stage3RefreshBtn?.addEventListener('click', () => fetchStage3Summary());
  inputs.stopRunBtn?.addEventListener('click', () => toggleRunStop(true));
  inputs.resumeRunBtn?.addEventListener('click', () => toggleRunStop(false));
  inputs.applyRunIdBtn?.addEventListener('click', () => {
    const value = inputs.runIdInput?.value ?? '';
    setActiveRunId(value, { announce: true });
  });
  inputs.clearRunIdBtn?.addEventListener('click', () => {
    if (inputs.runIdInput) inputs.runIdInput.value = '';
    setActiveRunId('', { announce: true });
  });
  inputs.runIdInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      setActiveRunId(inputs.runIdInput.value, { announce: true });
    }
  });
}

async function bootstrap() {
  if (!inputs.startBtn || !inputs.log) {
    console.warn('Planner controls missing. Skipping initialisation.');
    return;
  }

  const initialSettings = loadSettings();
  applySettings(initialSettings);
  bindEvents();
  updateCostOutput();
  logStatus('Planner ready. Configure and launch when models are wired.');
  inputs.status.textContent = 'Checking access…';

  const storedRunId = localStorage.getItem(RUN_STORAGE_KEY);
  if (storedRunId) {
    setActiveRunId(storedRunId, { announce: false, silent: true });
  } else {
    updateRunDisplay();
    updateRunMeta(null);
    updateStage1Metrics();
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'No active run selected.';
    updateStage2Metrics();
    renderStage2Insights([]);
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'No active run selected.';
    updateStage3Metrics();
    renderStage3Reports([]);
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'No active run selected.';
  }

  await syncAccess();

  supabase.auth.onAuthStateChange(async () => {
    await syncAccess();
  });
}

bootstrap();
