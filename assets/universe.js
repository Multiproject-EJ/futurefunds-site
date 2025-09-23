// /assets/universe.js
import { supabase, isMembershipActive } from './supabase.js';

const state = {
  rows: [],
  filtered: [],
  q: localStorage.getItem('universe_q') || '',
  tag: localStorage.getItem('universe_tag') || '',
  from: localStorage.getItem('universe_from') || '',
  to: localStorage.getItem('universe_to') || '',
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
  const qInput = $('#q');
  const tagSel = $('#tagSel');
  const fromInput = $('#from');
  const toInput = $('#to');
  const chips = $('#chips');
  const modal = $('#modal');
  const mTitle = $('#mTitle');
  const mBody = $('#mBody');
  const mClose = $('#mClose');

  if (!tbody) return;

  initMembershipBridge();

  // Initialize filters from storage
  qInput.value = state.q;
  tagSel.value = state.tag;
  fromInput.value = state.from;
  toInput.value = state.to;

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
      prompt_used: row.prompt_used || '',
      key_findings: Array.isArray(row.key_findings) ? row.key_findings : [],
      visual_table_md: row.visual_table_md || '',
      conclusion: row.conclusion || '',
      analysis_markdown: row.analysis_markdown || row.analysis_full_md || row.analysis_full || '',
      tags: Array.isArray(row.tags) ? row.tags : Array.isArray(row.tags?.array) ? row.tags.array : [],
      created_at: row.created_at || null,
    };
  }

  function buildTags() {
    const counts = new Map();
    state.rows.forEach((row) => {
      (row.tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1));
    });

    const options = ['<option value="">All tags</option>'];
    [...counts.keys()].sort().forEach((tag) => {
      options.push(`<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`);
    });
    tagSel.innerHTML = options.join('');
    tagSel.value = state.tag;

    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    chips.innerHTML = top
      .map(([tag, count]) => `<button class="chip ${state.tag === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)} · ${count}</button>`)
      .join('');
    chips.querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.tag;
        state.tag = state.tag === value ? '' : value;
        localStorage.setItem('universe_tag', state.tag);
        render();
        buildTags();
      });
    });
  }

  function render() {
    localStorage.setItem('universe_q', (qInput.value = state.q));
    localStorage.setItem('universe_from', (fromInput.value = state.from));
    localStorage.setItem('universe_to', (toInput.value = state.to));

    if (state.loading) {
      tbody.innerHTML = '<tr><td class="empty" colspan="6">Loading…</td></tr>';
      return;
    }
    if (state.error) {
      tbody.innerHTML = `<tr><td class="empty" colspan="6">${escapeHtml(state.error)}</td></tr>`;
      return;
    }
    if (!state.rows.length) {
      tbody.innerHTML = '<tr><td class="empty" colspan="6">No data yet.</td></tr>';
      return;
    }

    const inRange = (iso) => {
      if (!iso) return false;
      if (state.from && iso < state.from) return false;
      if (state.to && iso > state.to) return false;
      return true;
    };

    const needle = state.q.trim().toLowerCase();
    const matchesQuery = (row) => {
      if (!needle) return true;
      return JSON.stringify(row).toLowerCase().includes(needle);
    };

    state.filtered = state.rows
      .filter((row) => !state.tag || (row.tags || []).includes(state.tag))
      .filter((row) => (!state.from && !state.to) || inRange(row.date))
      .filter(matchesQuery);

    if (!state.filtered.length) {
      tbody.innerHTML = '<tr><td class="empty" colspan="6">No results. Try clearing filters.</td></tr>';
      return;
    }

    const visibleRows = getPreviewRows();
    const lockedCount = getLockedCount();
    state.previewCount = visibleRows.length;
    state.lockedCount = lockedCount;

    const html = visibleRows
      .map((row) => {
        const findings = (row.key_findings || []).slice(0, 6).map((item) => `• ${escapeHtml(item)}`).join('<br>');
        const tags = (row.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
        const rowKey = row.date + '|' + row.topic;
        const readLink = row.analysis_markdown
          ? `<button type="button" class="link-btn" data-action="full" data-row-id="${escapeHtml(rowKey)}">Read full analysis</button>`
          : '';
        return `
          <tr data-id="${escapeHtml(rowKey)}">
            <td>${escapeHtml(row.date)}</td>
            <td>
              <div class="topic-cell">
                <div class="topic-cell__title">${escapeHtml(row.topic)}</div>
                ${readLink}
              </div>
            </td>
            <td>${findings}</td>
            <td><pre style="white-space:pre-wrap;margin:0">${escapeHtml(row.visual_table_md || '')}</pre></td>
            <td>${escapeHtml(row.conclusion || '')}</td>
            <td class="tags">${tags}</td>
          </tr>`;
      })
      .join('');

    const rows = [];
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
          <td colspan="6">
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

    tbody.querySelectorAll('button[data-action="full"]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const id = btn.getAttribute('data-row-id');
        const row = state.filtered.find((r) => r.date + '|' + r.topic === id);
        if (!row) return;
        openModal(row, 'full');
      });
    });

    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const id = tr.getAttribute('data-id');
        const row = state.filtered.find((r) => r.date + '|' + r.topic === id);
        if (!row) return;
        openModal(row, 'summary');
      });
    });
  }

  function openModal(row, mode = 'summary') {
    if (mode === 'full' && row.analysis_markdown) {
      mTitle.textContent = `${row.topic || 'Details'} — Full analysis`;
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
        backBtn.addEventListener('click', () => openModal(row, 'summary'));
      }
      return;
    }

    mTitle.textContent = row.topic || 'Details';
    mBody.innerHTML = `
      <div style="display:grid;gap:12px">
        <div><strong>Date:</strong> ${escapeHtml(row.date || '')}</div>
        <div><strong>Conclusion:</strong><br>${escapeHtml(row.conclusion || '')}</div>
        <div><strong>Key Findings:</strong><br>${(row.key_findings || []).map((item) => `• ${escapeHtml(item)}`).join('<br>')}</div>
        <div><strong>Visual/Table (markdown):</strong>
          <pre style="white-space:pre-wrap">${escapeHtml(row.visual_table_md || '')}</pre>
          <div class="modal-actions">
            <button id="copyMd" class="btn" style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--panel)">Copy markdown</button>
            ${row.analysis_markdown ? '<button id="viewFullAnalysis" class="btn ghost" type="button">Read full analysis</button>' : ''}
          </div>
        </div>
        <details>
          <summary class="kbd">Prompt used (debug)</summary>
          <pre style="white-space:pre-wrap">${escapeHtml(row.prompt_used || '')}</pre>
        </details>
      </div>`;
    modal.style.display = 'flex';
    const copyBtn = $('#copyMd');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(row.visual_table_md || '');
          toast('Markdown copied');
        } catch (err) {
          console.warn('Clipboard error', err);
          toast('Unable to copy', true);
        }
      });
    }
    const viewFullBtn = $('#viewFullAnalysis');
    if (viewFullBtn) {
      viewFullBtn.addEventListener('click', () => openModal(row, 'full'));
    }
  }

  function renderFullAnalysis(row) {
    return `
      <div class="analysis-full">
        <div class="analysis-full__meta"><strong>Date:</strong> ${escapeHtml(row.date || '')}</div>
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
  tagSel.addEventListener('change', () => { state.tag = tagSel.value; localStorage.setItem('universe_tag', state.tag); render(); });
  fromInput.addEventListener('change', () => { state.from = fromInput.value; render(); });
  toInput.addEventListener('change', () => { state.to = toInput.value; render(); });

  $('#btnRefresh').addEventListener('click', async () => {
    await load();
    buildTags();
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
    const header = ['date', 'topic', 'key_findings', 'visual_table_md', 'conclusion', 'tags'];
    const csv = [
      header.join(','),
      ...rows.map((row) => {
        const vals = [
          row.date || '',
          row.topic || '',
          (row.key_findings || []).join(' | '),
          (row.visual_table_md || '').replace(/\n/g, '\\n'),
          row.conclusion || '',
          (row.tags || []).join('|')
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
      const isMember = isMembershipActive ? isMembershipActive(membership) : false;
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
  buildTags();
  render();
}
