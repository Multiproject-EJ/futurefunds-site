import { supabase, getUser, getProfile, getMembership, hasAdminRole, isMembershipActive } from './supabase.js';

const params = new URLSearchParams(window.location.search);
const state = {
  ticker: (params.get('ticker') || '').trim().toUpperCase(),
  runId: params.get('run') || null,
  runs: [],
  detail: null
};

const elements = {
  gate: document.getElementById('tickerGate'),
  gateMessage: document.getElementById('tickerGateMessage'),
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
  stage2Citations: document.getElementById('stage2Citations'),
  stage2CitationList: document.getElementById('stage2CitationList'),
  stage3Summary: document.getElementById('stage3Summary'),
  stage3Citations: document.getElementById('stage3Citations'),
  stage3CitationList: document.getElementById('stage3CitationList'),
  stage3Scorecard: document.getElementById('stage3Scorecard'),
  stage3Questions: document.getElementById('stage3Questions')
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

function formatDateOnly(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function titleCase(value) {
  if (!value) return '';
  return value
    .toString()
    .split(/[\s_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

const questionMemory = (window.equityQuestionCache = window.equityQuestionCache || new Map());

function extractHostname(url) {
  if (!url) return '';
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./i, '');
  } catch (error) {
    console.warn('Failed to parse citation URL', error);
    return '';
  }
}

function normalizeCitations(value) {
  if (!value) return [];
  const array = Array.isArray(value) ? value : [];
  const seen = new Set();
  const results = [];
  array.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry;
    let ref = record.ref ?? record.reference ?? `D${index + 1}`;
    if (typeof ref !== 'string') ref = String(ref ?? `D${index + 1}`);
    ref = ref.replace(/[\[\]]/g, '').trim().toUpperCase();
    if (!ref) ref = `D${results.length + 1}`;
    const title = record.title != null ? String(record.title) : null;
    const sourceType = record.source_type != null ? String(record.source_type) : null;
    const publishedAt = record.published_at != null ? String(record.published_at) : null;
    const sourceUrl = record.source_url != null ? String(record.source_url) : null;
    const similarity = record.similarity != null ? Number(record.similarity) : null;
    const key = `${ref}|${sourceUrl || ''}|${title || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      ref,
      title,
      source_type: sourceType,
      published_at: publishedAt,
      source_url: sourceUrl,
      similarity: Number.isFinite(similarity) ? similarity : null
    });
  });
  return results;
}

function formatCitationMeta(citation) {
  const parts = [];
  if (citation.source_type) parts.push(citation.source_type);
  const dateLabel = formatDateOnly(citation.published_at);
  if (dateLabel) parts.push(dateLabel);
  const host = extractHostname(citation.source_url);
  if (host) parts.push(host);
  if (typeof citation.similarity === 'number') {
    const similarity = citation.similarity >= 0 && citation.similarity <= 1
      ? citation.similarity.toFixed(2)
      : citation.similarity.toString();
    parts.push(`sim ${similarity}`);
  }
  return parts.join(' · ');
}

function createCitationItem(citation) {
  const li = document.createElement('li');
  li.className = 'citation-item';
  li.dataset.ref = citation.ref;

  const refSpan = document.createElement('span');
  refSpan.className = 'citation-ref';
  refSpan.textContent = `[${citation.ref}]`;
  li.append(refSpan);

  const body = document.createElement('div');
  body.className = 'citation-body';

  const titleLine = document.createElement('div');
  titleLine.className = 'citation-title';
  if (citation.source_url) {
    const link = document.createElement('a');
    link.href = citation.source_url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = citation.title || citation.source_url;
    titleLine.append(link);
  } else {
    titleLine.textContent = citation.title || 'Untitled source';
  }
  body.append(titleLine);

  const meta = formatCitationMeta(citation);
  if (meta) {
    const metaLine = document.createElement('div');
    metaLine.className = 'citation-meta';
    metaLine.textContent = meta;
    body.append(metaLine);
  }

  li.append(body);
  return li;
}

function populateCitationList(listEl, citations) {
  if (!listEl) return;
  listEl.innerHTML = '';
  citations.forEach((citation) => {
    listEl.append(createCitationItem(citation));
  });
}

function renderCitationSection(section, listEl, citations) {
  if (!section || !listEl) return;
  if (!citations.length) {
    listEl.innerHTML = '';
    section.hidden = true;
    return;
  }
  section.hidden = false;
  populateCitationList(listEl, citations);
}

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry)).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function verdictTone(value) {
  const text = String(value ?? '').toLowerCase();
  if (!text) return 'neutral';
  if (text.startsWith('bad') || text.includes('risk') || text.includes('bear')) return 'bad';
  if (text.startsWith('good') || text.includes('bull') || text.includes('positive')) return 'good';
  return 'neutral';
}

function cacheKey() {
  return `${state.runId ?? 'run'}:${state.ticker ?? 'ticker'}`;
}

function cacheQuestionGraph(detail) {
  questionMemory.set(cacheKey(), {
    dimension_scores: detail.dimension_scores ?? [],
    question_results: detail.question_results ?? [],
    updated_at: detail.updated_at ?? new Date().toISOString()
  });
}

function recallQuestionGraph() {
  return questionMemory.get(cacheKey()) ?? { dimension_scores: [], question_results: [] };
}

function setGate(message) {
  if (elements.gateMessage) {
    elements.gateMessage.textContent = message;
  }
  elements.gate.hidden = false;
  elements.content.hidden = true;
}

async function ensureAccess() {
  const user = await getUser();
  if (!user) {
    setGate('Sign in with your FutureFunds.ai membership to open the full Stage 1–3 dossier.');
    return false;
  }

  const [profile, membership] = await Promise.all([getProfile(), getMembership()]);
  const admin = hasAdminRole({ user, profile, membership });
  const memberActive = isMembershipActive(membership, { profile, user });

  if (!admin && !memberActive) {
    setGate('An active FutureFunds.ai membership unlocks raw analyst dossiers and citations.');
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
  renderStage3(detail);
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
  if (elements.stage2Citations) {
    elements.stage2Citations.hidden = true;
  }
  if (elements.stage2CitationList) {
    elements.stage2CitationList.innerHTML = '';
  }
  elements.stage3Summary.classList.add('muted');
  elements.stage3Summary.textContent = 'Deep dive not yet available.';
  if (elements.stage3Citations) {
    elements.stage3Citations.hidden = true;
  }
  if (elements.stage3CitationList) {
    elements.stage3CitationList.innerHTML = '';
  }
  if (elements.stage3Scorecard) {
    elements.stage3Scorecard.hidden = true;
    elements.stage3Scorecard.innerHTML = '';
  }
  if (elements.stage3Questions) {
    elements.stage3Questions.innerHTML = '<p class="muted">Deep dive not yet available.</p>';
  }
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
    renderCitationSection(elements.stage2Citations, elements.stage2CitationList, []);
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

  const stage2Citations = normalizeCitations(
    stage2.context_citations ?? stage2.verdict?.context_citations ?? []
  );
  renderCitationSection(elements.stage2Citations, elements.stage2CitationList, stage2Citations);
}

function renderStage3(detail) {
  const summaryJson = detail?.stage3_summary && typeof detail.stage3_summary === 'object' ? detail.stage3_summary : null;
  const summaryText = detail?.stage3_text ?? null;
  const summary = summaryText || summaryJson?.summary || summaryJson?.thesis || summaryJson?.narrative;
  if (summary) {
    elements.stage3Summary.classList.remove('muted');
    elements.stage3Summary.textContent = summary;
  } else {
    elements.stage3Summary.classList.add('muted');
    elements.stage3Summary.textContent = 'Deep dive not yet available.';
  }

  const summaryCitations = normalizeCitations(summaryJson?.context_citations ?? []);
  renderCitationSection(elements.stage3Citations, elements.stage3CitationList, summaryCitations);

  const currentDimensions = Array.isArray(detail?.dimension_scores) ? detail.dimension_scores : [];
  const currentQuestions = Array.isArray(detail?.question_results) ? detail.question_results : [];

  if (currentDimensions.length || currentQuestions.length) {
    cacheQuestionGraph(detail);
  }

  const cached = recallQuestionGraph();
  const dimensions = currentDimensions.length ? currentDimensions : cached.dimension_scores;
  const questions = currentQuestions.length ? currentQuestions : cached.question_results;

  renderScorecard(dimensions);
  renderQuestionGrid(questions);
}

function renderScorecard(rows = []) {
  if (!elements.stage3Scorecard) return;
  elements.stage3Scorecard.innerHTML = '';
  if (!Array.isArray(rows) || !rows.length) {
    elements.stage3Scorecard.hidden = true;
    return;
  }
  elements.stage3Scorecard.hidden = false;
  rows.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'scorecard-item';
    const tone = verdictTone(entry?.verdict);
    card.dataset.tone = tone;

    const title = document.createElement('h3');
    title.textContent = entry?.name ?? entry?.dimension ?? 'Dimension';
    card.append(title);

    if (Number.isFinite(Number(entry?.score))) {
      const score = document.createElement('div');
      score.className = 'score';
      score.textContent = `${Math.round(Number(entry.score))}`;
      card.append(score);
    }

    if (entry?.summary) {
      const summary = document.createElement('p');
      summary.className = 'question-summary';
      summary.textContent = entry.summary;
      card.append(summary);
    }

    const tags = normalizeArray(entry?.tags);
    if (tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'tags';
      tags.forEach((tag) => {
        const span = document.createElement('span');
        span.textContent = tag;
        tagRow.append(span);
      });
      card.append(tagRow);
    }

    elements.stage3Scorecard.append(card);
  });
}

function renderQuestionGrid(results = []) {
  if (!elements.stage3Questions) return;
  elements.stage3Questions.innerHTML = '';
  if (!Array.isArray(results) || !results.length) {
    elements.stage3Questions.innerHTML = '<p class="muted">Deep dive questions have not run yet.</p>';
    return;
  }

  const dependencyMap = new Map();
  results.forEach((entry) => {
    if (entry?.question) dependencyMap.set(entry.question, entry);
  });

  results.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'question-card';
    const tone = verdictTone(entry?.verdict);
    card.dataset.tone = tone;

    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = `${entry?.dimension_name ?? entry?.dimension ?? 'Dimension'} · ${entry?.question ?? 'Question'}`;
    header.append(title);
    const badge = document.createElement('span');
    badge.className = 'verdict-badge';
    badge.dataset.tone = tone;
    badge.textContent = (entry?.verdict ?? 'neutral').toUpperCase();
    header.append(badge);
    card.append(header);

    if (Number.isFinite(Number(entry?.score))) {
      const meta = document.createElement('div');
      meta.className = 'question-meta';
      meta.textContent = `Score: ${Math.round(Number(entry.score))}`;
      card.append(meta);
    }

    if (entry?.summary) {
      const summary = document.createElement('p');
      summary.className = 'question-summary';
      summary.textContent = entry.summary;
      card.append(summary);
    }

    const tags = normalizeArray(entry?.tags);
    if (tags.length) {
      const tagRow = document.createElement('div');
      tagRow.className = 'question-tags';
      tags.forEach((tag) => {
        const span = document.createElement('span');
        span.textContent = tag;
        tagRow.append(span);
      });
      card.append(tagRow);
    }

    const deps = normalizeArray(entry?.dependencies);
    if (deps.length) {
      const depBlock = document.createElement('div');
      depBlock.className = 'question-deps';
      const heading = document.createElement('strong');
      heading.textContent = 'Depends on';
      depBlock.append(heading);
      deps.forEach((dep) => {
        const ref = dependencyMap.get(dep);
        const line = document.createElement('span');
        if (ref) {
          const refTone = verdictTone(ref.verdict);
          line.textContent = `${dep}: ${ref.verdict ?? 'unknown'}${ref.summary ? ` — ${ref.summary.slice(0, 160)}` : ''}`;
          line.dataset.tone = refTone;
        } else {
          line.textContent = `${dep}: pending`;
        }
        depBlock.append(line);
      });
      card.append(depBlock);
    }

    const raw = entry?.answer ?? entry;
    if (raw) {
      const rawBlock = document.createElement('div');
      rawBlock.className = 'question-raw';
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'View JSON';
      details.append(summary);
      const pre = document.createElement('pre');
      try {
        pre.textContent = JSON.stringify(raw, null, 2);
      } catch (error) {
        pre.textContent = String(raw);
      }
      details.append(pre);
      rawBlock.append(details);
      card.append(rawBlock);
    }

    const questionCitations = normalizeCitations(entry?.answer?.context_citations ?? entry?.context_citations ?? []);
    if (questionCitations.length) {
      const citeBlock = document.createElement('div');
      citeBlock.className = 'question-citations';
      const heading = document.createElement('strong');
      heading.textContent = 'Sources';
      citeBlock.append(heading);
      const list = document.createElement('ol');
      list.className = 'citation-list citation-list--compact';
      populateCitationList(list, questionCitations);
      citeBlock.append(list);
      card.append(citeBlock);
    }

    elements.stage3Questions.append(card);
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
