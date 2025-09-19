// /assets/universe.js
import { supabase } from './supabase.js';

const state = {
  rows: [],
  filtered: [],
  q: localStorage.getItem('universe_q') || '',
  tag: localStorage.getItem('universe_tag') || '',
  from: localStorage.getItem('universe_from') || '',
  to: localStorage.getItem('universe_to') || '',
  loading: false,
  error: null,
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

    const html = state.filtered
      .map((row) => {
        const findings = (row.key_findings || []).slice(0, 6).map((item) => `• ${escapeHtml(item)}`).join('<br>');
        const tags = (row.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
        return `
          <tr data-id="${escapeHtml(row.date + '|' + row.topic)}">
            <td>${escapeHtml(row.date)}</td>
            <td>${escapeHtml(row.topic)}</td>
            <td>${findings}</td>
            <td><pre style="white-space:pre-wrap;margin:0">${escapeHtml(row.visual_table_md || '')}</pre></td>
            <td>${escapeHtml(row.conclusion || '')}</td>
            <td class="tags">${tags}</td>
          </tr>`;
      })
      .join('');
    tbody.innerHTML = html;

    tbody.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('click', () => {
        const id = tr.getAttribute('data-id');
        const row = state.filtered.find((r) => r.date + '|' + r.topic === id);
        if (!row) return;
        openModal(row);
      });
    });
  }

  function openModal(row) {
    mTitle.textContent = row.topic || 'Details';
    mBody.innerHTML = `
      <div style="display:grid;gap:12px">
        <div><strong>Date:</strong> ${escapeHtml(row.date || '')}</div>
        <div><strong>Conclusion:</strong><br>${escapeHtml(row.conclusion || '')}</div>
        <div><strong>Key Findings:</strong><br>${(row.key_findings || []).map((item) => `• ${escapeHtml(item)}`).join('<br>')}</div>
        <div><strong>Visual/Table (markdown):</strong>
          <pre style="white-space:pre-wrap">${escapeHtml(row.visual_table_md || '')}</pre>
          <button id="copyMd" class="btn" style="margin-top:6px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--panel)">Copy markdown</button>
        </div>
        <details>
          <summary class="kbd">Prompt used (debug)</summary>
          <pre style="white-space:pre-wrap">${escapeHtml(row.prompt_used || '')}</pre>
        </details>
      </div>`;
    modal.style.display = 'flex';
    $('#copyMd').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(row.visual_table_md || '');
        toast('Markdown copied');
      } catch (err) {
        console.warn('Clipboard error', err);
        toast('Unable to copy', true);
      }
    });
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

  $('#btnExportCsv').addEventListener('click', () => exportCsv(state.filtered));
  $('#btnCopyJson').addEventListener('click', async () => {
    await navigator.clipboard.writeText(JSON.stringify(state.filtered, null, 2));
    toast('JSON copied');
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

  await load();
  buildTags();
  render();
}
