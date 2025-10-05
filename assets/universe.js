import { supabase, getUser, getProfile, getMembership, hasAdminRole } from './supabase.js';

const state = {
  session: { user: null, profile: null, membership: null },
  runs: [],
  runId: null,
  filters: {
    search: '',
    stage: null,
    label: null,
    goDeep: null,
    sector: null
  },
  rows: [],
  limit: 50,
  total: 0,
  loading: false,
  facets: new Map()
};

const elements = {
  gate: document.getElementById('gate'),
  content: document.getElementById('universeContent'),
  runSelect: document.getElementById('runSelect'),
  search: document.getElementById('q'),
  refresh: document.getElementById('refreshBtn'),
  exportCsv: document.getElementById('exportCsvBtn'),
  copyJson: document.getElementById('copyJsonBtn'),
  stageFilters: document.getElementById('stageFilters'),
  labelFilters: document.getElementById('labelFilters'),
  goDeepFilters: document.getElementById('goDeepFilters'),
  sectorSelect: document.getElementById('sectorSelect'),
  tableBody: document.getElementById('tableBody'),
  loadMore: document.getElementById('loadMoreBtn'),
  tableStatus: document.getElementById('tableStatus'),
  metricTickers: document.getElementById('metricTickers'),
  metricTickersSub: document.getElementById('metricTickersSub'),
  metricGoDeep: document.getElementById('metricGoDeep'),
  metricGoDeepSub: document.getElementById('metricGoDeepSub'),
  metricReports: document.getElementById('metricReports'),
  metricReportsSub: document.getElementById('metricReportsSub'),
  metricSpend: document.getElementById('metricSpend'),
  metricSpendSub: document.getElementById('metricSpendSub')
};

function formatNumber(value, options = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('en-US', options).format(num);
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(num);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function titleCase(value) {
  if (!value) return '';
  return value
    .toString()
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function debounce(fn, wait = 300) {
  let timeout;
  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => fn(...args), wait);
  };
}

function setChipActive(group, target) {
  if (!group) return;
  [...group.querySelectorAll('.chip')].forEach((chip) => {
    chip.dataset.active = chip === target ? 'true' : 'false';
  });
}

function chipValue(target, attr) {
  if (!target) return null;
  const value = target.dataset[attr];
  if (value === undefined) return null;
  if (value === '') return null;
  if (attr === 'stage') return Number.parseInt(value, 10);
  if (attr === 'go') return value === 'true';
  return value;
}

async function ensureAccess() {
  const user = await getUser();
  if (!user) {
    elements.gate.hidden = false;
    elements.content.hidden = true;
    return false;
  }
  const [profile, membership] = await Promise.all([getProfile(), getMembership()]);
  if (!hasAdminRole({ user, profile, membership })) {
    elements.gate.hidden = false;
    elements.gate.querySelector('p').textContent = 'This cockpit is limited to analyst operators and admins. Please contact the FutureFunds team for access.';
    elements.content.hidden = true;
    return false;
  }
  state.session = { user, profile, membership };
  elements.gate.hidden = true;
  elements.content.hidden = false;
  return true;
}

async function loadRuns() {
  const { data, error } = await supabase
    .from('runs')
    .select('id, created_at, status, notes')
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) throw error;
  state.runs = data ?? [];
  renderRunOptions();
  if (!state.runId && state.runs.length) {
    state.runId = state.runs[0].id;
  }
}

function renderRunOptions() {
  if (!elements.runSelect) return;
  elements.runSelect.innerHTML = '';
  if (!state.runs.length) {
    const option = document.createElement('option');
    option.textContent = 'No runs yet';
    option.value = '';
    elements.runSelect.append(option);
    return;
  }
  state.runs.forEach((run) => {
    const option = document.createElement('option');
    option.value = run.id;
    const created = run.created_at ? new Date(run.created_at).toLocaleString() : 'Unknown date';
    option.textContent = `${created} — ${run.status ?? 'unknown'}`;
    if (run.id === state.runId) option.selected = true;
    elements.runSelect.append(option);
  });
}

async function fetchRows(reset = false) {
  if (!state.runId) return;
  if (state.loading) return;
  state.loading = true;
  if (reset) {
    state.rows = [];
  }
  renderTableState('Loading…');
  const params = {
    p_run_id: state.runId,
    p_search: state.filters.search || null,
    p_label: state.filters.label || null,
    p_stage: state.filters.stage ?? null,
    p_sector: state.filters.sector || null,
    p_go_deep: state.filters.goDeep ?? null,
    p_limit: state.limit,
    p_offset: reset ? 0 : state.rows.length
  };
  const { data, error } = await supabase.rpc('run_universe_rows', params);
  if (error) {
    console.error('run_universe_rows error', error);
    renderTableError(error.message);
    state.loading = false;
    return;
  }
  const total = data?.[0]?.total_count ?? (reset ? 0 : state.total);
  state.total = Number(total ?? 0);
  if (reset) {
    state.rows = data ?? [];
  } else {
    state.rows = state.rows.concat(data ?? []);
  }
  state.loading = false;
  renderTable();
  updateLoadMore();
  await refreshFacets();
  await refreshMetrics();
}

async function refreshFacets() {
  if (!state.runId) return;
  const params = {
    p_run_id: state.runId,
    p_search: state.filters.search || null,
    p_label: state.filters.label || null,
    p_stage: state.filters.stage ?? null,
    p_sector: state.filters.sector || null,
    p_go_deep: state.filters.goDeep ?? null
  };
  const { data, error } = await supabase.rpc('run_universe_facets', params);
  if (error) {
    console.warn('run_universe_facets error', error);
    return;
  }
  const facets = new Map();
  (data ?? []).forEach((row) => {
    const metric = row.metric ?? 'unknown';
    if (!facets.has(metric)) facets.set(metric, new Map());
    facets.get(metric).set(row.bucket ?? '', Number(row.total ?? 0));
  });
  state.facets = facets;
  renderFacetCounts();
}

async function refreshMetrics() {
  if (!state.runId) return;
  const [stageCountsRes, stage2Res, stage3Res, costRes] = await Promise.all([
    supabase.rpc('run_stage_status_counts', { p_run_id: state.runId }),
    supabase.rpc('run_stage2_summary', { p_run_id: state.runId }).maybeSingle(),
    supabase.rpc('run_stage3_summary', { p_run_id: state.runId }).maybeSingle(),
    supabase.rpc('run_cost_summary', { p_run_id: state.runId }).maybeSingle()
  ]);

  const stageCounts = stageCountsRes?.data ?? [];
  const totalTickers = stageCounts.reduce((acc, row) => acc + Number(row.total ?? 0), 0);
  elements.metricTickers.textContent = formatNumber(totalTickers);
  const stage3Completed = Number(stage3Res?.data?.completed ?? 0);
  const stage3Pending = Number(stage3Res?.data?.pending ?? 0);
  const stage2GoDeep = Number(stage2Res?.data?.go_deep ?? 0);
  elements.metricGoDeep.textContent = formatNumber(stage2GoDeep);
  elements.metricGoDeepSub.textContent = `${formatNumber(stage2Res?.data?.completed ?? 0)} completed, ${formatNumber(stage2Res?.data?.pending ?? 0)} pending`;
  elements.metricReports.textContent = formatNumber(stage3Completed);
  elements.metricReportsSub.textContent = `${formatNumber(stage3Pending)} deep dives in queue`;
  const totalCost = Number(costRes?.data?.total_cost ?? 0);
  elements.metricSpend.textContent = formatCurrency(totalCost);
  const tokensIn = Number(costRes?.data?.total_tokens_in ?? 0);
  const tokensOut = Number(costRes?.data?.total_tokens_out ?? 0);
  elements.metricSpendSub.textContent = `${formatNumber(tokensIn)} in / ${formatNumber(tokensOut)} out tokens`;
  elements.metricTickersSub.textContent = `${formatNumber(totalTickers)} tickers across stages`;
}

function renderFacetCounts() {
  updateChipCounts(elements.stageFilters, 'stage', (bucket) => {
    if (!state.facets.has('stage')) return 0;
    const map = state.facets.get('stage');
    if (bucket === '') {
      return Array.from(map.values()).reduce((acc, val) => acc + val, 0);
    }
    return map.get(String(bucket)) ?? 0;
  });

  updateChipCounts(elements.labelFilters, 'label', (bucket) => {
    if (!state.facets.has('label')) return bucket === '' ? state.total : 0;
    const map = state.facets.get('label');
    if (bucket === '') {
      return Array.from(map.values()).reduce((acc, val) => acc + val, 0);
    }
    return map.get(bucket) ?? 0;
  });

  updateChipCounts(elements.goDeepFilters, 'go', (bucket) => {
    if (!state.facets.has('go_deep')) return bucket === '' ? state.total : 0;
    const map = state.facets.get('go_deep');
    if (bucket === '') {
      return Array.from(map.values()).reduce((acc, val) => acc + val, 0);
    }
    return map.get(bucket) ?? 0;
  });

  if (elements.sectorSelect) {
    const selected = elements.sectorSelect.value;
    const map = state.facets.get('sector');
    const existing = new Set();
    if (map) {
      elements.sectorSelect.innerHTML = '<option value="">All sectors</option>';
      Array.from(map.entries())
        .sort((a, b) => (a[0] || '').localeCompare(b[0] || ''))
        .forEach(([sector, total]) => {
          const option = document.createElement('option');
          option.value = sector ?? '';
          const label = sector ? titleCase(sector) : 'Unknown';
          option.textContent = `${label} (${formatNumber(total)})`;
          elements.sectorSelect.append(option);
          existing.add(option.value);
        });
    }
    if (selected && !existing.has(selected)) {
      const option = document.createElement('option');
      option.value = selected;
      option.textContent = titleCase(selected);
      option.selected = true;
      elements.sectorSelect.append(option);
    } else if (selected) {
      elements.sectorSelect.value = selected;
    }
  }
}

function updateChipCounts(container, attr, getter) {
  if (!container) return;
  [...container.querySelectorAll('.chip')].forEach((chip) => {
    const bucket = chip.dataset[attr] ?? '';
    const total = getter(bucket);
    let badge = chip.querySelector('.chip-count');
    if (total === 0) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'chip-count';
      chip.append(badge);
    }
    badge.textContent = formatNumber(total);
  });
}

function renderTableState(message) {
  if (!elements.tableBody) return;
  elements.tableBody.innerHTML = `<tr><td class="table-empty" colspan="7">${message}</td></tr>`;
  elements.tableStatus.textContent = message;
}

function renderTableError(message) {
  renderTableState(`Error loading universe: ${message}`);
}

function renderTable() {
  if (!elements.tableBody) return;
  if (!state.rows.length) {
    renderTableState('No results match the current filters.');
    updateLoadMore();
    return;
  }
  elements.tableBody.innerHTML = '';
  state.rows.forEach((row) => {
    const tr = document.createElement('tr');

    const tickerCell = document.createElement('td');
    tickerCell.className = 'ticker-cell';
    const name = row.name ? row.name : 'Unknown company';
    tickerCell.innerHTML = `<div>${row.ticker}</div><div class="ticker-meta">${name} · ${row.exchange ?? 'n/a'}</div>`;
    tr.append(tickerCell);

    const stageCell = document.createElement('td');
    const stageClass = `stage-${row.stage ?? 0}`;
    const statusLabel = row.status ? row.status.toUpperCase() : 'UNKNOWN';
    stageCell.innerHTML = `<span class="stage-badge ${stageClass}">Stage ${row.stage ?? 0}</span><div class="ticker-meta">${statusLabel}</div>`;
    tr.append(stageCell);

    const labelCell = document.createElement('td');
    if (row.label) {
      labelCell.innerHTML = `<span class="label-pill">${titleCase(row.label)}</span>`;
    } else {
      labelCell.textContent = '—';
    }
    if (row.stage2_go_deep) {
      const goDeep = document.createElement('div');
      goDeep.className = 'ticker-meta';
      goDeep.textContent = 'Go-deep approved';
      labelCell.append(goDeep);
    }
    tr.append(labelCell);

    const scoresCell = document.createElement('td');
    scoresCell.className = 'score-stack';
    const scores = extractScores(row.stage2);
    if (scores.length) {
      scores.forEach((entry) => {
        const span = document.createElement('span');
        span.innerHTML = `<strong>${entry.label}</strong><span>${entry.score}</span>`;
        scoresCell.append(span);
      });
      const verdictSummary = getVerdictSummary(row.stage2);
      if (verdictSummary) {
        const small = document.createElement('small');
        small.className = 'ticker-meta';
        small.textContent = verdictSummary;
        scoresCell.append(small);
      }
    } else {
      scoresCell.textContent = '—';
    }
    tr.append(scoresCell);

    const summaryCell = document.createElement('td');
    summaryCell.className = 'summary-cell';
    if (row.stage3_summary) {
      const para = document.createElement('p');
      para.textContent = row.stage3_summary;
      summaryCell.append(para);
      const updated = document.createElement('small');
      updated.textContent = `Updated ${formatDate(row.updated_at)}`;
      summaryCell.append(updated);
    } else {
      summaryCell.innerHTML = '<span class="ticker-meta">Deep dive not yet available.</span>';
    }
    tr.append(summaryCell);

    const spendCell = document.createElement('td');
    spendCell.textContent = formatCurrency(row.spend_usd);
    tr.append(spendCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions-cell';
    const link = document.createElement('a');
    link.href = `/ticker.html?ticker=${encodeURIComponent(row.ticker)}&run=${encodeURIComponent(row.run_id)}`;
    link.textContent = 'View report';
    link.setAttribute('aria-label', `View detailed report for ${row.ticker}`);
    actionsCell.append(link);
    tr.append(actionsCell);

    elements.tableBody.append(tr);
  });

  elements.tableStatus.textContent = `Showing ${formatNumber(state.rows.length)} of ${formatNumber(state.total)} tickers`;
}

function updateLoadMore() {
  if (!elements.loadMore) return;
  const remaining = state.total - state.rows.length;
  elements.loadMore.disabled = state.loading || remaining <= 0;
  if (remaining <= 0) {
    elements.loadMore.textContent = 'All results loaded';
  } else {
    elements.loadMore.textContent = `Load ${Math.min(state.limit, remaining)} more`;
  }
}

function extractScores(stage2) {
  if (!stage2 || typeof stage2 !== 'object' || !stage2.scores) return [];
  const entries = [];
  try {
    const scores = stage2.scores;
    for (const [key, value] of Object.entries(scores)) {
      const score = Number((value && value.score) ?? value);
      if (!Number.isFinite(score)) continue;
      entries.push({ label: titleCase(key), score: `${score}/10` });
    }
  } catch (error) {
    console.warn('Failed to parse stage2 scores', error);
  }
  return entries;
}

function getVerdictSummary(stage2) {
  if (!stage2 || typeof stage2 !== 'object') return '';
  const verdict = stage2.verdict;
  if (!verdict) return '';
  if (typeof verdict.summary === 'string' && verdict.summary.trim()) {
    return verdict.summary.trim();
  }
  if (typeof verdict.why === 'string' && verdict.why.trim()) {
    return verdict.why.trim();
  }
  return '';
}

function applyFilter(type, value) {
  state.filters[type] = value;
  fetchRows(true);
}

function setupEvents() {
  if (elements.runSelect) {
    elements.runSelect.addEventListener('change', () => {
      const value = elements.runSelect.value;
      state.runId = value || null;
      fetchRows(true);
    });
  }

  if (elements.search) {
    elements.search.addEventListener('input', debounce((event) => {
      state.filters.search = event.target.value.trim();
      fetchRows(true);
    }, 250));
  }

  if (elements.refresh) {
    elements.refresh.addEventListener('click', () => fetchRows(true));
  }

  if (elements.exportCsv) {
    elements.exportCsv.addEventListener('click', exportCsv);
  }

  if (elements.copyJson) {
    elements.copyJson.addEventListener('click', copyJsonToClipboard);
  }

  if (elements.loadMore) {
    elements.loadMore.addEventListener('click', () => fetchRows(false));
  }

  setupChipGroup(elements.stageFilters, 'stage');
  setupChipGroup(elements.labelFilters, 'label');
  setupChipGroup(elements.goDeepFilters, 'go');

  if (elements.sectorSelect) {
    elements.sectorSelect.addEventListener('change', (event) => {
      const value = event.target.value;
      state.filters.sector = value ? value : null;
      fetchRows(true);
    });
  }
}

function setupChipGroup(container, attr) {
  if (!container) return;
  container.addEventListener('click', (event) => {
    const target = event.target.closest('.chip');
    if (!target) return;
    setChipActive(container, target);
    const value = chipValue(target, attr);
    if (attr === 'stage') {
      state.filters.stage = value;
    } else if (attr === 'label') {
      state.filters.label = value;
    } else if (attr === 'go') {
      state.filters.goDeep = value;
    }
    fetchRows(true);
  });
}

function exportCsv() {
  if (!state.rows.length) {
    alert('Nothing to export yet. Load a run first.');
    return;
  }
  const headers = ['Ticker', 'Name', 'Exchange', 'Stage', 'Status', 'Label', 'GoDeep', 'SpendUSD', 'Stage2Scores', 'Stage3Summary'];
  const lines = [headers.join(',')];
  state.rows.forEach((row) => {
    const scorePairs = extractScores(row.stage2).map((entry) => `${entry.label} ${entry.score}`).join(' | ');
    const values = [
      row.ticker,
      row.name ?? '',
      row.exchange ?? '',
      row.stage ?? 0,
      row.status ?? '',
      row.label ?? '',
      row.stage2_go_deep ? 'true' : 'false',
      Number(row.spend_usd ?? 0).toFixed(4),
      scorePairs.replace(/,/g, ';'),
      (row.stage3_summary ?? '').replace(/\r?\n|,/g, ' ')
    ];
    lines.push(values.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `run-${state.runId ?? 'universe'}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function copyJsonToClipboard() {
  if (!state.rows.length) {
    alert('Nothing to copy yet. Load a run first.');
    return;
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(state.rows, null, 2));
    elements.tableStatus.textContent = 'Copied current rows to clipboard';
    window.setTimeout(() => {
      elements.tableStatus.textContent = `Showing ${formatNumber(state.rows.length)} of ${formatNumber(state.total)} tickers`;
    }, 2400);
  } catch (error) {
    console.error('clipboard error', error);
    alert('Unable to copy to clipboard. Please copy manually from the console.');
  }
}

async function init() {
  const allowed = await ensureAccess();
  if (!allowed) return;
  setupEvents();
  await loadRuns();
  if (state.runId) {
    fetchRows(true);
  } else {
    renderTableState('Create a run in the planner to populate the universe.');
  }
}

init().catch((error) => {
  console.error('universe init error', error);
  renderTableError(error.message ?? 'Unknown error');
});
