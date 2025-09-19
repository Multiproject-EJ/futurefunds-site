// /assets/editor.js
import { supabase } from './supabase.js';
import { requireRole, onAuthReady, getAccountState } from './auth.js';

document.addEventListener('DOMContentLoaded', () => {
  initEditor().catch((err) => console.error('Editor init error', err));
});

async function initEditor() {
  const form = document.getElementById('analysisForm');
  const msg = document.getElementById('formMsg');
  const locked = document.getElementById('editorLocked');
  const recentSection = document.getElementById('recentSection');
  const recentList = document.getElementById('recentList');
  const resetBtn = document.getElementById('resetForm');
  const refreshBtn = document.getElementById('refreshRecent');
  const dateInput = document.getElementById('analysisDate');

  if (!form || !locked) return;

  const lockMsg = document.getElementById('editorLockMsg');

  const setMessage = (text, tone = 'info') => {
    if (!msg) return;
    msg.textContent = text || '';
    msg.dataset.tone = tone;
    msg.style.color = tone === 'error' ? 'var(--danger,#ff6b6b)' : tone === 'success' ? 'var(--ok,#31d0a3)' : 'var(--muted,#64748b)';
  };

  const showLocked = (message) => {
    locked.hidden = false;
    if (lockMsg) {
      lockMsg.textContent = ` ${message}`;
    }
  };

  if (dateInput) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  await onAuthReady();

  try {
    await requireRole('admin');
  } catch (err) {
    console.warn('Editor access denied', err);
    const account = getAccountState();
    const signedIn = !!account.user;
    const message = signedIn
      ? 'Your account is signed in but does not have admin permissions.'
      : 'Please sign in with an admin account to continue.';
    showLocked(message);
    if (!signedIn) {
      const btn = locked.querySelector('[data-open-auth]');
      if (btn) btn.setAttribute('data-open-auth', 'signin');
    }
    return;
  }

  locked.hidden = true;
  form.hidden = false;
  if (recentSection) recentSection.hidden = false;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const payload = {
      date: formData.get('date') || new Date().toISOString().slice(0, 10),
      topic: (formData.get('topic') || '').trim(),
      conclusion: (formData.get('conclusion') || '').trim(),
      key_findings: parseLines(formData.get('findings')),
      visual_table_md: (formData.get('visual') || '').trim(),
      prompt_used: (formData.get('prompt') || '').trim(),
      tags: parseTags(formData.get('tags')),
    };

    if (!payload.topic) {
      setMessage('Topic is required.', 'error');
      return;
    }
    if (!payload.conclusion) {
      setMessage('Conclusion is required.', 'error');
      return;
    }

    setMessage('Publishing…');
    const { error } = await supabase.from('universe').insert(payload);
    if (error) {
      console.error('Insert error', error);
      setMessage(`Error: ${error.message}`, 'error');
      return;
    }

    setMessage('Entry published!', 'success');
    form.reset();
    if (dateInput) dateInput.value = payload.date;
    await loadRecent();
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      form.reset();
      if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
      setMessage('Form reset.');
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      setMessage('Refreshing recent entries…');
      await loadRecent();
      setMessage('');
    });
  }

  async function loadRecent() {
    if (!recentList) return;
    recentList.innerHTML = '<p class="muted">Loading…</p>';
    const { data, error } = await supabase
      .from('universe')
      .select('*')
      .order('date', { ascending: false })
      .limit(8);
    if (error) {
      console.error('Recent fetch error', error);
      recentList.innerHTML = `<p class="muted">Error loading recent entries: ${escapeHtml(error.message)}</p>`;
      return;
    }
    if (!data?.length) {
      recentList.innerHTML = '<p class="muted">No entries yet.</p>';
      return;
    }
    recentList.innerHTML = data
      .map((row) => {
        const tags = Array.isArray(row.tags) ? row.tags : [];
        return `
          <article class="recent-card">
            <h3>${escapeHtml(row.topic || '')}</h3>
            <p class="muted-small">${escapeHtml(row.date || '')}</p>
            <p>${escapeHtml(row.conclusion || '')}</p>
            ${tags.length ? `<div class="tags">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
          </article>`;
      })
      .join('');
  }

  await loadRecent();
}

function parseLines(value) {
  if (!value) return [];
  return String(value)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseTags(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}
