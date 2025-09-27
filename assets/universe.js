// /assets/universe.js
import { supabase, isMembershipActive } from './supabase.js';

const state = {
  rows: [],
  filtered: [],
  q: localStorage.getItem('universe_q') || '',
  viewMode: localStorage.getItem('universe_view_mode') || 'tags',
  loading: false,
  error: null,
  isMember: false,
  isSignedIn: false,
  authReady: false,
  previewCount: 0,
  lockedCount: 0,
};

document.addEventListener('DOMContentLoaded', () => {
  UniversePage().catch((err) => console.error('Universe init error', err));
});

async function UniversePage() {
  const $ = (sel) => document.querySelector(sel);
  const tbody = $('#tbody');
  const headerRow = $('#headerRow');
  const qInput = $('#q');
  const viewButtons = Array.from(document.querySelectorAll('[data-mode]'));

  const BASE_HEADERS = [
    { key: 'company', label: 'Company name', style: 'min-width:220px' },
    { key: 'price', label: 'Current Price', style: 'width:130px' },
    { key: 'risk', label: 'Risk Rating', style: 'width:120px' },
    { key: 'date', label: 'Date', style: 'width:110px' },
    { key: 'financials', label: 'Financials', style: 'width:120px' },
    { key: 'analysis', label: 'Analysis', style: 'width:110px' },
  ];

  const VIEW_CONFIG = {
    tags: {
      columns: [
        { key: 'tag_moat', label: '[Tag] Moat/quality type', getter: (row) => findTagMatch(row.tags, ['moat', 'quality']) },
        { key: 'tag_leverage', label: '[Tag] Leverage', getter: (row) => findTagMatch(row.tags, ['lever']) },
        { key: 'tag_cannibal', label: '[Tag] Cannibal', getter: (row) => findTagMatch(row.tags, ['cannibal']) },
        { key: 'tag_valuetrap', label: '[Tag] Valuetrap?', getter: (row) => findTagMatch(row.tags, ['value trap', 'valuetrap']) },
        { key: 'tag_options', label: '[Tag] Options', getter: (row) => findTagMatch(row.tags, ['option']) },
        { key: 'tag_writedowns', label: '[Tag] Writedowns', getter: (row) => findTagMatch(row.tags, ['writedown']) },
        { key: 'tag_asymmetric', label: '[Tag] Assymetric/Swingtrade', getter: (row) => findTagMatch(row.tags, ['swing', 'asym']) },
        { key: 'tag_superinvestors', label: '[Tag] Superinvestors', getter: (row) => findTagMatch(row.tags, ['superinvestor', 'guru']) },
        { key: 'tag_industry', label: '[Tag] Industry', getter: (row) => findTagMatch(row.tags, ['industry', 'sector', 'tech', 'consumer', 'energy', 'financial', 'health', 'industrial']) },
      ],
    },
    strategies: {
      columns: [
        { key: 'strategy_focus', label: 'Strategy focus', getter: (row) => row.strategies?.focus ?? row.strategy_focus },
        { key: 'strategy_plan', label: 'Entry plan', getter: (row) => row.strategies?.entry ?? row.strategy_entry },
        { key: 'strategy_exit', label: 'Exit plan', getter: (row) => row.strategies?.exit ?? row.strategy_exit },
      ],
    },
    metrics: {
      columns: [
        { key: 'metric_ps', label: 'P/S', getter: (row) => formatMetric(getMetricValue(row, ['ps', 'price_sales', 'price_to_sales'])) },
        { key: 'metric_pe', label: 'P/E', getter: (row) => formatMetric(getMetricValue(row, ['pe', 'price_earnings', 'price_to_earnings'])) },
        { key: 'metric_pb', label: 'P/B', getter: (row) => formatMetric(getMetricValue(row, ['pb', 'price_book', 'price_to_book'])) },
        { key: 'metric_peg', label: 'PEG', getter: (row) => formatMetric(getMetricValue(row, ['peg'])) },
        { key: 'metric_evebit', label: 'EV/EBIT', getter: (row) => formatMetric(getMetricValue(row, ['ev_ebit', 'evebit'])) },
        { key: 'metric_evebitda', label: 'EV/EBITDA', getter: (row) => formatMetric(getMetricValue(row, ['ev_ebitda', 'evebitda'])) },
      ],
    },
    placeholder1: {
      columns: [
        { key: 'placeholder1_a', label: 'Placeholder 1A', getter: (row) => row.placeholder1?.a ?? row.placeholder1_a },
        { key: 'placeholder1_b', label: 'Placeholder 1B', getter: (row) => row.placeholder1?.b ?? row.placeholder1_b },
      ],
    },
    placeholder2: {
      columns: [
        { key: 'placeholder2_a', label: 'Placeholder 2A', getter: (row) => row.placeholder2?.a ?? row.placeholder2_a },
        { key: 'placeholder2_b', label: 'Placeholder 2B', getter: (row) => row.placeholder2?.b ?? row.placeholder2_b },
      ],
    },
  };
  const modal = $('#modal');
  const mTitle = $('#mTitle');
  const mBody = $('#mBody');
  const mClose = $('#mClose');

  if (!tbody) return;

  initMembershipBridge();

  // Initialize filters from storage
  qInput.value = state.q;

  async function load() {
    state.loading = true;
    state.error = null;
    render();
    const { data, error } = await supabase
      .from('universe')
      .select('*')
      .order('date', { ascending: false });
    if (error) {
      console.warn('universe fetch error', error);
      state.rows = [];
      state.error = error.message || 'Unable to load data.';
    } else {
      state.rows = (data || []).map(normalizeRow);
    }
    state.loading = false;
  }

  function normalizeRow(row) {
    return {
      id: row.id,
      date: row.date || '',
      topic: row.topic || '',
      company: row.company || row.company_name || row.topic || '',
      prompt_used: row.prompt_used || '',
      key_findings: Array.isArray(row.key_findings) ? row.key_findings : [],
      visual_table_md: row.visual_table_md || '',
      conclusion: row.conclusion || '',
      analysis_markdown: row.analysis_markdown || row.analysis_full_md || row.analysis_full || '',
      tags: Array.isArray(row.tags) ? row.tags : Array.isArray(row.tags?.array) ? row.tags.array : [],
      current_price: normalizeNumeric(row.current_price ?? row.price ?? row.currentPrice),
      current_price_raw: row.current_price ?? row.price ?? row.currentPrice ?? '',
      current_price_display: row.current_price_display || row.price_display || '',
      currency: row.currency_symbol || row.currency || row.currencySymbol || '',
      risk_rating: row.risk_rating || row.risk || '',
      strategies: row.strategies || {},
      metrics: row.metrics || {},
      placeholder1: row.placeholder1 || {},
      placeholder2: row.placeholder2 || {},
      financials_markdown: row.financials_markdown || row.financials_md || '',
      created_at: row.created_at || null,
    };
  }

  function render() {
    localStorage.setItem('universe_q', (qInput.value = state.q));
    localStorage.setItem('universe_view_mode', state.viewMode);

    updateViewButtons();

    const dynamicColumns = getDynamicColumns();
    updateHeader(dynamicColumns);
    const totalColumns = BASE_HEADERS.length + dynamicColumns.length;

    if (state.loading) {
      tbody.innerHTML = `<tr><td class="empty" colspan="${totalColumns}">Loading…</td></tr>`;
      return;
    }
    if (state.error) {
      tbody.innerHTML = `<tr><td class="empty" colspan="${totalColumns}">${escapeHtml(state.error)}</td></tr>`;
      return;
    }
    if (!state.rows.length) {
      tbody.innerHTML = `<tr><td class="empty" colspan="${totalColumns}">No data yet.</td></tr>`;
      return;
    }

    const needle = state.q.trim().toLowerCase();
    const matchesQuery = (row) => {
      if (!needle) return true;
      return JSON.stringify(row).toLowerCase().includes(needle);
    };

    state.filtered = state.rows.filter(matchesQuery);

    if (!state.filtered.length) {
      tbody.innerHTML = `<tr><td class="empty" colspan="${totalColumns}">No results. Try clearing filters.</td></tr>`;
      return;
    }

    const visibleRows = getPreviewRows();
    const lockedCount = getLockedCount();
    state.previewCount = visibleRows.length;
    state.lockedCount = lockedCount;

    const rows = [];
    const html = visibleRows.map((row) => buildRow(row, dynamicColumns)).join('');
    if (html) rows.push(html);

    if (lockedCount > 0) {
      const lockedLabel = lockedCount === 1 ? '1 more research brief' : `${lockedCount} more research briefs`;
      const previewLabel = `${visibleRows.length} of ${state.filtered.length}`;
      const message = state.authReady
        ? (state.isSignedIn
            ? `Your account needs an active membership to view the remaining ${lockedLabel}.`
            : `Join FutureFunds.ai to unlock the remaining ${lockedLabel}.`)
        : 'Checking membership status…';
      const secondaryView = state.isSignedIn ? 'profile' : 'signin';
      const secondaryLabel = state.isSignedIn ? 'Manage account' : 'Sign in';
      rows.push(`
        <tr class="locked-row">
          <td colspan="${totalColumns}">
            <div class="locked-paywall">
              <strong>Unlock the full Universe archive</strong>
              <p>${escapeHtml(message)}</p>
              <div class="actions">
                <a class="btn primary" href="/membership.html">View membership plans</a>
                <button class="btn" type="button" data-open-auth="${escapeHtml(secondaryView)}">${escapeHtml(secondaryLabel)}</button>
              </div>
              <p class="locked-note">Preview shows ${escapeHtml(previewLabel)} entries.</p>
            </div>
          </td>
        </tr>`);
    }

    tbody.innerHTML = rows.join('');
  }

  function buildRow(row, dynamicColumns) {
    const rowKey = getRowKey(row);
    const company = row.company || row.topic || '';
    const priceText = formatPrice(row);
    const risk = safeText(row.risk_rating);
    const date = safeText(row.date);
    const hasFinancials = !!(row.visual_table_md || row.financials_markdown);
    const hasAnalysis = !!(row.analysis_markdown || row.conclusion || (row.key_findings || []).length);

    const financialsCell = hasFinancials
      ? `<button type="button" class="link-btn" data-action="financials" data-row-id="${escapeHtml(rowKey)}">View</button>`
      : '<span style="color:var(--muted,#94a3b8)">No data</span>';
    const analysisCell = hasAnalysis
      ? `<button type="button" class="link-btn" data-action="analysis" data-row-id="${escapeHtml(rowKey)}">Open</button>`
      : '<span style="color:var(--muted,#94a3b8)">No data</span>';

    const dynamicCells = dynamicColumns
      .map((col) => {
        const value = safeText(col.getter ? col.getter(row) : undefined);
        const className = col.className ? ` class="${col.className}"` : '';
        return `<td${className}>${escapeHtml(value)}</td>`;
      })
      .join('');

    return `
      <tr data-id="${escapeHtml(rowKey)}">
        <td class="company-cell">${escapeHtml(company)}</td>
        <td class="metric-cell">${escapeHtml(priceText)}</td>
        <td>${escapeHtml(risk)}</td>
        <td>${escapeHtml(date)}</td>
        <td>${financialsCell}</td>
        <td>${analysisCell}</td>
        ${dynamicCells}
      </tr>`;
  }

  function getRowKey(row) {
    if (!row) return '';
    if (row.id !== undefined && row.id !== null && row.id !== '') return String(row.id);
    const topic = row.topic || row.company || '';
    return `${row.date || ''}|${topic}`;
  }

  function updateHeader(dynamicColumns) {
    if (!headerRow) return;
    const headerHtml = [
      ...BASE_HEADERS.map((col) => `<th${col.style ? ` style="${col.style}"` : ''}>${col.label}</th>`),
      ...dynamicColumns.map((col) => `<th>${col.label}</th>`),
    ].join('');
    headerRow.innerHTML = headerHtml;
  }

  function updateViewButtons() {
    viewButtons.forEach((btn) => {
      const mode = btn.dataset.mode;
      const isActive = mode === state.viewMode;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function getDynamicColumns() {
    const config = VIEW_CONFIG[state.viewMode];
    return config && Array.isArray(config.columns) ? config.columns : [];
  }

  function findTagMatch(tags, keywords = []) {
    if (!Array.isArray(tags) || !tags.length) return '—';
    if (!keywords?.length) return safeText(tags[0]);
    const normalizedTags = tags.map((tag) => String(tag));
    for (const keyword of keywords) {
      const needle = String(keyword || '').toLowerCase();
      if (!needle) continue;
      const match = normalizedTags.find((tag) => tag.toLowerCase().includes(needle));
      if (match) return match;
    }
    return '—';
  }

  function safeText(value) {
    if (value === null || value === undefined) return '—';
    const str = String(value).trim();
    return str ? str : '—';
  }

  function formatPrice(row) {
    if (!row) return '—';
    if (row.current_price_display) return safeText(row.current_price_display);
    const currencyRaw = row.currency ?? '';
    const currency = safeText(currencyRaw);
    const currencyLabel = currency === '—' ? '' : currency;

    const value = row.current_price;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return currencyLabel ? formatCurrencyLabel(currencyLabel, formatNumber(value)) : formatNumber(value);
    }
    if (value !== null && value !== undefined && value !== '') {
      const num = Number(value);
      if (Number.isFinite(num)) {
        return currencyLabel ? formatCurrencyLabel(currencyLabel, formatNumber(num)) : formatNumber(num);
      }
      return safeText(value);
    }
    if (row.current_price_raw) {
      return safeText(row.current_price_raw);
    }
    return '—';
  }

  function formatCurrencyLabel(currency, value) {
    const symbol = currency.trim();
    if (!symbol) return value;
    if (/^[A-Za-z]{3}$/.test(symbol)) return `${symbol.toUpperCase()} ${value}`;
    return `${symbol}${value}`;
  }

  function formatNumber(num) {
    const abs = Math.abs(num);
    let maximumFractionDigits = 2;
    if (abs >= 1000) maximumFractionDigits = 0;
    else if (abs >= 100) maximumFractionDigits = 1;
    else if (abs < 1) maximumFractionDigits = 4;
    return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits });
  }

  function formatMetric(value) {
    if (value === null || value === undefined || value === '') return '—';
    const num = Number(value);
    if (Number.isFinite(num)) {
      const abs = Math.abs(num);
      let maximumFractionDigits = 2;
      if (abs >= 1000) maximumFractionDigits = 0;
      else if (abs >= 100) maximumFractionDigits = 1;
      else if (abs < 1) maximumFractionDigits = 4;
      return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits });
    }
    return safeText(value);
  }

  function getMetricValue(row, keys = []) {
    if (!row || !keys?.length) return null;
    const sources = [row.metrics || {}, row];
    for (const key of keys) {
      const variants = buildMetricKeyVariants(key);
      for (const variant of variants) {
        for (const source of sources) {
          if (source && source[variant] !== undefined && source[variant] !== null && source[variant] !== '') {
            return source[variant];
          }
        }
      }
    }
    return null;
  }

  function buildMetricKeyVariants(key) {
    const base = String(key || '');
    const variants = new Set([base]);
    variants.add(base.toLowerCase());
    variants.add(base.toUpperCase());
    variants.add(base.replace(/\//g, '_'));
    variants.add(base.replace(/[_\s]/g, ''));
    variants.add(base.replace(/\//g, ''));
    variants.add(`metric_${base}`);
    variants.add(`metric_${base}`.toLowerCase());
    variants.add(`metric${base}`);
    variants.add(`metric${base}`.toLowerCase());
    variants.add(`ratio_${base}`);
    variants.add(`ratio${base}`);
    return [...variants];
  }

  function normalizeNumeric(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const str = String(value).trim();
    if (!str) return null;
    const cleaned = str.replace(/[^0-9.+-]/g, '');
    if (!cleaned) return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }

  function openModal(row, mode = 'analysis') {
    if (!row) return;

    if (mode === 'financials') {
      const markdown = row.financials_markdown || row.visual_table_md || '';
      mTitle.textContent = `${row.company || row.topic || 'Financials'} — Financials`;
      if (markdown) {
        mBody.innerHTML = `
          <div style="display:grid;gap:12px">
            <div><strong>Date:</strong> ${escapeHtml(row.date || '')}</div>
            <pre style="white-space:pre-wrap;margin:0">${escapeHtml(markdown)}</pre>
            <div class="modal-actions">
              <button id="copyFinancials" class="btn" type="button" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--panel)">Copy markdown</button>
            </div>
          </div>`;
        const copyFinancials = $('#copyFinancials');
        if (copyFinancials) {
          copyFinancials.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(markdown);
              toast('Markdown copied');
            } catch (err) {
              console.warn('Clipboard error', err);
              toast('Unable to copy', true);
            }
          });
        }
      } else {
        mBody.innerHTML = '<p style="margin:0">Financial details are not available for this entry.</p>';
      }
      modal.style.display = 'flex';
      return;
    }

    if (mode === 'full' && row.analysis_markdown) {
      mTitle.textContent = `${row.company || row.topic || 'Analysis'} — Full analysis`;
      mBody.innerHTML = renderFullAnalysis(row);
      modal.style.display = 'flex';
      const copyFull = $('#copyFull');
      if (copyFull) {
        copyFull.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(row.analysis_markdown || '');
            toast('Analysis copied');
          } catch (err) {
            console.warn('Clipboard error', err);
            toast('Unable to copy', true);
          }
        });
      }
      const backBtn = $('#backToSummary');
      if (backBtn) {
        backBtn.addEventListener('click', () => openModal(row, 'analysis'));
      }
      return;
    }

    const findings = (row.key_findings || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    const risk = safeText(row.risk_rating);
    const riskBlock = risk !== '—' ? `<div><strong>Risk rating:</strong> ${escapeHtml(risk)}</div>` : '';
    const tags = (row.tags || []).filter(Boolean);
    const tagsBlock = tags.length ? `<div><strong>Tags:</strong> ${escapeHtml(tags.join(', '))}</div>` : '';

    mTitle.textContent = `${row.company || row.topic || 'Analysis'} — Summary`;
    mBody.innerHTML = `
      <div style="display:grid;gap:12px">
        <div><strong>Date:</strong> ${escapeHtml(row.date || '')}</div>
        ${riskBlock}
        ${findings ? `<div><strong>Key findings:</strong><ul style="margin:6px 0 0;padding-left:18px">${findings}</ul></div>` : ''}
        ${row.conclusion ? `<div><strong>Conclusion:</strong><br>${escapeHtml(row.conclusion)}</div>` : ''}
        ${tagsBlock}
        ${row.analysis_markdown ? '<div class="modal-actions"><button id="viewFullAnalysis" class="btn ghost" type="button">Read full analysis</button></div>' : ''}
      </div>`;
    modal.style.display = 'flex';
    const viewFullBtn = $('#viewFullAnalysis');
    if (viewFullBtn) {
      viewFullBtn.addEventListener('click', () => openModal(row, 'full'));
    }
  }

  function renderFullAnalysis(row) {
    return `
      <div class="analysis-full">
        <div class="analysis-full__meta"><strong>${escapeHtml(row.company || row.topic || 'Analysis')}</strong> — ${escapeHtml(row.date || '')}</div>
        ${row.risk_rating ? `<div class="analysis-full__meta"><strong>Risk rating:</strong> ${escapeHtml(row.risk_rating)}</div>` : ''}
        <pre class="analysis-full__body">${escapeHtml(row.analysis_markdown || '')}</pre>
        <div class="modal-actions">
          <button id="copyFull" class="btn" type="button" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--panel)">Copy analysis</button>
          <button id="backToSummary" class="btn ghost" type="button">Back to summary</button>
        </div>
      </div>`;
  }

  function closeModal() {
    modal.style.display = 'none';
  }
  mClose.addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });

  qInput.addEventListener('input', () => { state.q = qInput.value; render(); });
  viewButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === state.viewMode) return;
      state.viewMode = mode;
      localStorage.setItem('universe_view_mode', state.viewMode);
      render();
    });
  });

  $('#btnRefresh').addEventListener('click', async () => {
    await load();
    render();
    toast('Data refreshed');
  });

  $('#btnExportCsv').addEventListener('click', () => {
    const rows = getPreviewRows();
    if (!rows.length) return toast('Nothing to export', true);
    exportCsv(rows);
    if (!state.isMember && state.lockedCount > 0) {
      toast('Preview export generated — join membership for the full dataset.');
    } else {
      toast('CSV exported');
    }
  });

  $('#btnCopyJson').addEventListener('click', async () => {
    const rows = getPreviewRows();
    if (!rows.length) {
      toast('Nothing to copy', true);
      return;
    }
    await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
    if (!state.isMember && state.lockedCount > 0) {
      toast('Preview copied — join membership for the full dataset.');
    } else {
      toast('JSON copied');
    }
  });

  tbody.addEventListener('click', (event) => {
    const target = event.target.closest('button[data-action]');
    if (!target) return;
    event.stopPropagation();
    const action = target.getAttribute('data-action');
    const id = target.getAttribute('data-row-id');
    if (!id) return;
    const row = state.filtered.find((r) => getRowKey(r) === id);
    if (!row) return;
    if (action === 'financials') {
      openModal(row, 'financials');
    } else if (action === 'analysis') {
      openModal(row, 'analysis');
    } else if (action === 'full') {
      openModal(row, 'full');
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== qInput) {
      event.preventDefault();
      qInput.focus();
    }
    if (event.key === 'Escape' && modal.style.display === 'flex') closeModal();
  });

  function toast(message, isError = false) {
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--border);padding:10px 12px;border-radius:12px;box-shadow:var(--shadow);z-index:120';
    if (isError) el.style.borderColor = 'var(--danger,#ff6b6b)';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  function exportCsv(rows) {
    if (!rows?.length) return toast('Nothing to export', true);
    const dynamicColumns = getDynamicColumns();
    const header = [
      'company',
      'current_price',
      'risk_rating',
      'date',
      'conclusion',
      'financials_markdown',
      'analysis_markdown',
      'tags',
      ...dynamicColumns.map((col) => toSlug(col.label)),
    ];
    const csv = [
      header.join(','),
      ...rows.map((row) => {
        const dynamicValues = dynamicColumns.map((col) => csvValue(col.getter ? col.getter(row) : ''));
        const vals = [
          csvValue(row.company || row.topic || ''),
          csvValue(formatPrice(row)),
          csvValue(row.risk_rating),
          csvValue(row.date),
          csvValue(row.conclusion),
          csvValue(row.financials_markdown || row.visual_table_md || ''),
          csvValue(row.analysis_markdown || ''),
          csvValue((row.tags || []).join('|')),
          ...dynamicValues,
        ].map(csvEscape);
        return vals.join(',');
      })
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `universe_export_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function csvEscape(value) {
    const str = String(value ?? '');
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }

  function csvValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const str = String(value).trim();
    if (!str || str === '—') return '';
    return str.replace(/\n/g, '\\n');
  }

  function toSlug(label) {
    const str = String(label || '').toLowerCase();
    const slug = str.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return slug || 'column';
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  }

  function computePreviewLimit(total) {
    if (state.isMember) return total;
    if (!total) return 0;
    const raw = Math.ceil(total * 0.2);
    const limit = Math.max(1, raw);
    return Math.min(total, limit);
  }

  function getPreviewRows() {
    const total = state.filtered.length;
    if (!total) return [];
    const limit = computePreviewLimit(total);
    return state.filtered.slice(0, limit);
  }

  function getLockedCount() {
    if (state.isMember) return 0;
    const total = state.filtered.length;
    if (!total) return 0;
    const limit = computePreviewLimit(total);
    return Math.max(0, total - limit);
  }

  function initMembershipBridge() {
    const updateFromAccount = (payload = {}) => {
      const account = payload && (payload.user !== undefined || payload.membership !== undefined)
        ? payload
        : payload.detail || {};
      const membership = account?.membership || null;
      const isMember = isMembershipActive
        ? isMembershipActive(membership, { profile: account?.profile, user: account?.user })
        : false;
      const isSignedIn = !!account?.user;
      const changed = isMember !== state.isMember || isSignedIn !== state.isSignedIn || !state.authReady;
      state.isMember = isMember;
      state.isSignedIn = isSignedIn;
      state.authReady = true;
      if (changed) render();
    };

    const readCurrent = () => {
      if (window.ffAuth && typeof window.ffAuth.getAccount === 'function') {
        updateFromAccount(window.ffAuth.getAccount());
      } else {
        updateFromAccount({});
      }
    };

    if (window.ffAuth && typeof window.ffAuth.onReady === 'function') {
      window.ffAuth.onReady().then(readCurrent).catch(readCurrent);
    } else {
      document.addEventListener('ffauth:ready', readCurrent, { once: true });
      setTimeout(readCurrent, 1200);
    }

    document.addEventListener('ffauth:change', (event) => {
      updateFromAccount(event.detail || {});
    });

    readCurrent();
  }

  await load();
  render();
}
