import { supabase, getUser, getProfile, getMembership, hasAdminRole } from './supabase.js';

const params = new URLSearchParams(window.location.search);
const state = {
  ticker: (params.get('ticker') || '').trim().toUpperCase(),
  runId: params.get('run') || null,
  runs: [],
  detail: null
};

const elements = {
  gate: document.getElementById('tickerGate'),
  content: document.getElementById('tickerContent'),
  title: document.getElementById('tickerTitle'),
  subtitle: document.getElementById('tickerSubtitle'),
  runPicker: document.getElementById('runPicker'),
  exportJson: document.getElementById('exportJson'),
  copySummary: document.getElementById('copySummary'),
  metaStatus: document.getElementById('metaStatus'),
  metaStage: document.getElementById('metaStage'),
  metaLabel: document.getElementById('metaLabel'),
  metaGoDeep: document.getElementById('metaGoDeep'),
  metaSpend: document.getElementById('metaSpend'),
  metaUpdated: document.getElementById('metaUpdated'),
  stage1Body: document.getElementById('stage1Body'),
  stage2Scores: document.getElementById('stage2Scores'),
  stage2Verdict: document.getElementById('stage2Verdict'),
  stage2Next: document.getElementById('stage2Next'),
  stage3Summary: document.getElementById('stage3Summary'),
  stage3Groups: document.getElementById('stage3Groups')
};

function isUuid(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
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
    elements.gate.querySelector('p').textContent = 'Only analyst operators and admins can view raw stage outputs. Contact the FutureFunds team to request access.';
    elements.content.hidden = true;
    return false;
  }
  elements.gate.hidden = true;
  elements.content.hidden = false;
  return true;
}

async function loadRunsForTicker() {
  const { data, error } = await supabase
    .from('run_items')
    .select('run_id, updated_at, stage, status, runs(created_at, status)')
    .eq('ticker', state.ticker)
    .order('updated_at', { ascending: false })
    .limit(40);
  if (error) {
    console.error('Failed to load runs for ticker', error);
    throw error;
  }
  const seen = new Set();
  state.runs = [];
  (data ?? []).forEach((row) => {
    if (!row.run_id || seen.has(row.run_id)) return;
    seen.add(row.run_id);
    state.runs.push({
      id: row.run_id,
      created_at: row.runs?.created_at ?? row.updated_at ?? null,
      status: row.runs?.status ?? row.status ?? 'unknown'
    });
  });
  if (!state.runId || !isUuid(state.runId) || !seen.has(state.runId)) {
    state.runId = state.runs[0]?.id ?? null;
  }
  renderRunPicker();
}

function renderRunPicker() {
  if (!elements.runPicker) return;
  elements.runPicker.innerHTML = '';
  if (!state.runs.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No runs available';
    elements.runPicker.append(option);
    return;
  }
  state.runs.forEach((run) => {
    const option = document.createElement('option');
    option.value = run.id;
    const created = run.created_at ? new Date(run.created_at).toLocaleString() : 'Unknown date';
    option.textContent = `${created} — ${run.status ?? 'unknown'}`;
    if (run.id === state.runId) option.selected = true;
    elements.runPicker.append(option);
  });
}

async function loadDetails() {
  if (!state.runId || !state.ticker) return;
  const { data, error } = await supabase.rpc('run_ticker_details', {
    p_run_id: state.runId,
    p_ticker: state.ticker
  });
  if (error) {
    console.error('run_ticker_details error', error);
    throw error;
  }
  const detail = data?.[0] ?? null;
  state.detail = detail;
  if (!detail) {
    elements.subtitle.textContent = 'No data for this ticker in the selected run yet.';
    clearPanels();
    return;
  }
  updateHero(detail);
  renderContext(detail);
  renderStage1(detail.stage1, detail.label);
  renderStage2(detail.stage2);
  renderStage3(detail.stage3_summary, detail.stage3_text, detail.stage3_groups);
}

function updateHero(detail) {
  elements.title.textContent = `${state.ticker} — ${detail.name ?? 'Unknown company'}`;
  elements.subtitle.textContent = `${detail.exchange ?? 'Unknown exchange'} · ${detail.sector ?? 'Unknown sector'} · ${detail.country ?? 'Unknown country'}`;
  document.title = `FutureFunds — ${state.ticker} deep dive`;
}

function renderContext(detail) {
  elements.metaStatus.textContent = detail.status ? detail.status.toUpperCase() : 'UNKNOWN';
  elements.metaStage.textContent = detail.stage != null ? `Stage ${detail.stage}` : '—';
  elements.metaLabel.textContent = detail.label ? titleCase(detail.label) : '—';
  elements.metaGoDeep.textContent = detail.stage2_go_deep ? 'Approved' : 'Not approved';
  elements.metaSpend.textContent = formatCurrency(detail.spend_usd ?? 0);
  elements.metaUpdated.textContent = formatDate(detail.updated_at);
}

function clearPanels() {
  elements.stage1Body.innerHTML = '<p class="muted">No triage output captured for this run.</p>';
  elements.stage2Scores.textContent = '';
  elements.stage2Verdict.textContent = '';
  elements.stage2Next.textContent = '';
  elements.stage3Summary.classList.add('muted');
  elements.stage3Summary.textContent = 'Deep dive not yet available.';
  elements.stage3Groups.innerHTML = '';
}

function renderStage1(stage1, label) {
  elements.stage1Body.innerHTML = '';
  if (!stage1 || typeof stage1 !== 'object') {
    elements.stage1Body.innerHTML = '<p class="muted">No triage output captured for this run.</p>';
    return;
  }

  if (stage1.summary) {
    const summary = document.createElement('p');
    summary.textContent = stage1.summary;
    elements.stage1Body.append(summary);
  }

  const reasons = Array.isArray(stage1.reasons) ? stage1.reasons : [];
  if (reasons.length) {
    const header = document.createElement('h3');
    header.textContent = 'Key reasons';
    elements.stage1Body.append(header);
    const list = document.createElement('ul');
    list.className = 'list';
    reasons.forEach((reason) => {
      const li = document.createElement('li');
      li.textContent = String(reason);
      list.append(li);
    });
    elements.stage1Body.append(list);
  }

  const flags = stage1.flags && typeof stage1.flags === 'object' ? stage1.flags : null;
  if (flags) {
    const entries = Object.entries(flags).filter(([, value]) => value !== null && value !== false && value !== 'false');
    if (entries.length) {
      const header = document.createElement('h3');
      header.textContent = 'Risk flags';
      elements.stage1Body.append(header);
      const list = document.createElement('ul');
      list.className = 'list';
      entries.forEach(([key, value]) => {
        const li = document.createElement('li');
        li.textContent = `${titleCase(key)}: ${String(value)}`;
        list.append(li);
      });
      elements.stage1Body.append(list);
    }
  }

  if (!reasons.length && !flags && !stage1.summary) {
    elements.stage1Body.innerHTML = '<p class="muted">Stage 1 returned a label with no additional commentary.</p>';
  }
}

function renderStage2(stage2) {
  elements.stage2Scores.innerHTML = '';
  elements.stage2Verdict.innerHTML = '';
  elements.stage2Next.innerHTML = '';

  if (!stage2 || typeof stage2 !== 'object') {
    elements.stage2Scores.innerHTML = '<p class="muted">Stage 2 scoring has not run yet.</p>';
    return;
  }

  if (stage2.scores && typeof stage2.scores === 'object') {
    const header = document.createElement('h3');
    header.textContent = 'Scores';
    elements.stage2Scores.append(header);
    const list = document.createElement('ul');
    list.className = 'list';
    Object.entries(stage2.scores).forEach(([key, value]) => {
      const score = Number(value?.score ?? value);
      if (!Number.isFinite(score)) return;
      const rationale = value?.rationale ? ` — ${value.rationale}` : '';
      const li = document.createElement('li');
      li.textContent = `${titleCase(key)}: ${score}/10${rationale}`;
      list.append(li);
    });
    elements.stage2Scores.append(list);
  }

  if (stage2.verdict) {
    const header = document.createElement('h3');
    header.textContent = 'Verdict';
    elements.stage2Verdict.append(header);
    const paragraph = document.createElement('p');
    const summary = stage2.verdict.summary || stage2.verdict.why || 'No summary provided.';
    paragraph.textContent = summary;
    elements.stage2Verdict.append(paragraph);

    const verdictList = [];
    if (Array.isArray(stage2.verdict.opportunities) && stage2.verdict.opportunities.length) {
      verdictList.push({ title: 'Opportunities', values: stage2.verdict.opportunities });
    }
    if (Array.isArray(stage2.verdict.risks) && stage2.verdict.risks.length) {
      verdictList.push({ title: 'Risks', values: stage2.verdict.risks });
    }
    verdictList.forEach((entry) => {
      const subHeader = document.createElement('h3');
      subHeader.textContent = entry.title;
      elements.stage2Verdict.append(subHeader);
      const list = document.createElement('ul');
      list.className = 'list';
      entry.values.forEach((item) => {
        const li = document.createElement('li');
        li.textContent = String(item);
        list.append(li);
      });
      elements.stage2Verdict.append(list);
    });
  }

  if (Array.isArray(stage2.next_steps) && stage2.next_steps.length) {
    const header = document.createElement('h3');
    header.textContent = 'Next steps';
    elements.stage2Next.append(header);
    const list = document.createElement('ul');
    list.className = 'list';
    stage2.next_steps.forEach((step) => {
      const li = document.createElement('li');
      li.textContent = String(step);
      list.append(li);
    });
    elements.stage2Next.append(list);
  }
}

function renderStage3(summaryJson, summaryText, groupsJson) {
  const summary = summaryText || summaryJson?.summary || summaryJson?.thesis || summaryJson?.narrative;
  if (summary) {
    elements.stage3Summary.classList.remove('muted');
    elements.stage3Summary.textContent = summary;
  } else {
    elements.stage3Summary.classList.add('muted');
    elements.stage3Summary.textContent = 'Deep dive not yet available.';
  }

  elements.stage3Groups.innerHTML = '';
  const groups = Array.isArray(groupsJson) ? groupsJson : [];
  if (!groups.length) return;

  groups.forEach((group) => {
    const card = document.createElement('section');
    card.className = 'group-card';
    const title = document.createElement('h4');
    title.textContent = group.question_group ? titleCase(group.question_group) : 'Analysis';
    card.append(title);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(group.answer_json ?? group, null, 2);
    card.append(pre);
    elements.stage3Groups.append(card);
  });
}

function bindEvents() {
  if (elements.runPicker) {
    elements.runPicker.addEventListener('change', () => {
      const value = elements.runPicker.value;
      state.runId = isUuid(value) ? value : null;
      loadDetails().catch((error) => console.error('loadDetails error', error));
    });
  }

  if (elements.exportJson) {
    elements.exportJson.addEventListener('click', () => {
      if (!state.detail) {
        alert('Nothing to export yet.');
        return;
      }
      const blob = new Blob([JSON.stringify(state.detail, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${state.ticker}-${state.runId || 'report'}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
  }

  if (elements.copySummary) {
    elements.copySummary.addEventListener('click', async () => {
      const summary = elements.stage3Summary.textContent;
      if (!summary || summary === 'Deep dive not yet available.') {
        alert('No deep dive summary to copy yet.');
        return;
      }
      try {
        await navigator.clipboard.writeText(summary);
        elements.copySummary.textContent = 'Copied!';
        window.setTimeout(() => {
          elements.copySummary.textContent = 'Copy thesis';
        }, 2000);
      } catch (error) {
        console.error('clipboard error', error);
        alert('Unable to copy to clipboard.');
      }
    });
  }
}

async function init() {
  if (!state.ticker) {
    elements.title.textContent = 'Ticker missing';
    elements.subtitle.textContent = 'Pass ?ticker=SYMBOL in the URL to load a report.';
    return;
  }
  const allowed = await ensureAccess();
  if (!allowed) return;
  bindEvents();
  await loadRunsForTicker();
  if (!state.runId) {
    elements.subtitle.textContent = 'No runs have processed this ticker yet.';
    return;
  }
  await loadDetails();
}

init().catch((error) => {
  console.error('ticker init error', error);
  elements.subtitle.textContent = error.message ?? 'Failed to load ticker.';
});
