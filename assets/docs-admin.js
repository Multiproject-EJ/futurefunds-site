// /assets/docs-admin.js
import { supabase } from './supabase.js';
import { onAuthReady, requireRole, getAccountState, refreshAuthState } from './auth.js';

const els = {
  gate: document.getElementById('docsGate'),
  console: document.getElementById('docsConsole'),
  status: document.getElementById('docsStatus'),
  form: document.getElementById('docsUploadForm'),
  refreshBtn: document.getElementById('docsRefreshBtn'),
  tickerSelect: document.getElementById('docsTicker'),
  tableBody: document.getElementById('docsTableBody')
};

const state = {
  isAdmin: false,
  loading: false,
  token: null,
  docs: []
};

function setConsoleBusy(flag) {
  state.loading = flag;
  if (els.console) {
    els.console.setAttribute('aria-busy', flag ? 'true' : 'false');
  }
}

function setStatus(message, tone = 'default') {
  if (!els.status) return;
  els.status.textContent = message || '';
  els.status.dataset.tone = tone;
}

function slugify(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 80) || 'doc';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelative(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const delta = Date.now() - date.getTime();
  const days = Math.floor(delta / 86_400_000);
  if (days <= 0) {
    const hours = Math.floor(delta / 3_600_000);
    if (hours <= 0) {
      const minutes = Math.floor(delta / 60_000);
      return minutes <= 1 ? 'Just now' : `${minutes}m ago`;
    }
    return `${hours}h ago`;
  }
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

async function refreshSessionToken() {
  const { data } = await supabase.auth.getSession();
  state.token = data?.session?.access_token || null;
  return state.token;
}

function requireAuthorizedUI() {
  if (els.gate) {
    els.gate.hidden = state.isAdmin;
  }
  if (els.console) {
    els.console.hidden = !state.isAdmin;
  }
}

async function populateTickers() {
  if (!els.tickerSelect) return;
  const { data, error } = await supabase
    .from('tickers')
    .select('ticker, name')
    .order('ticker', { ascending: true })
    .limit(500);
  if (error) {
    console.warn('Failed to load tickers', error);
    return;
  }
  const select = els.tickerSelect;
  const existing = new Set(Array.from(select.options).map((option) => option.value));
  if (!existing.has('')) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select ticker';
    select.append(placeholder);
  }
  (data || []).forEach((row) => {
    const ticker = (row.ticker || '').toUpperCase();
    if (!ticker || existing.has(ticker)) return;
    const option = document.createElement('option');
    option.value = ticker;
    option.textContent = row.name ? `${ticker} — ${row.name}` : ticker;
    select.append(option);
  });
}

function renderDocs() {
  if (!els.tableBody) return;
  const tbody = els.tableBody;
  tbody.innerHTML = '';

  if (!state.docs.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.className = 'docs-empty';
    cell.textContent = 'No documents uploaded yet.';
    row.append(cell);
    tbody.append(row);
    return;
  }

  state.docs.forEach((doc) => {
    const row = document.createElement('tr');

    const titleCell = document.createElement('td');
    if (doc.source_url) {
      const link = document.createElement('a');
      link.href = doc.source_url;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.textContent = doc.title || 'Untitled document';
      titleCell.append(link);
    } else {
      titleCell.textContent = doc.title || 'Untitled document';
    }
    row.append(titleCell);

    const tickerCell = document.createElement('td');
    tickerCell.textContent = doc.ticker || '—';
    row.append(tickerCell);

    const typeCell = document.createElement('td');
    typeCell.textContent = doc.source_type || '—';
    row.append(typeCell);

    const publishedCell = document.createElement('td');
    publishedCell.textContent = formatDate(doc.published_at);
    row.append(publishedCell);

    const chunkCell = document.createElement('td');
    const chunks = Number(doc.chunk_count || 0);
    const tokens = Number(doc.token_count || 0);
    chunkCell.textContent = chunks ? `${chunks} · ${tokens.toLocaleString()} tok` : '—';
    row.append(chunkCell);

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    const status = (doc.status || 'pending').toLowerCase();
    badge.className = `badge ${status}`;
    badge.textContent = status;
    statusCell.append(badge);
    row.append(statusCell);

    const uploadedCell = document.createElement('td');
    uploadedCell.textContent = formatRelative(doc.created_at);
    row.append(uploadedCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'actions';
    const processBtn = document.createElement('button');
    processBtn.type = 'button';
    processBtn.className = 'btn ghost';
    processBtn.dataset.action = 'process';
    processBtn.dataset.docId = doc.id;
    processBtn.textContent = 'Process';
    actionsCell.append(processBtn);
    if (doc.status === 'failed' && doc.last_error) {
      const note = document.createElement('span');
      note.className = 'docs-note';
      note.textContent = doc.last_error.slice(0, 140);
      actionsCell.append(note);
    }
    row.append(actionsCell);

    tbody.append(row);
  });
}

async function loadDocs() {
  setConsoleBusy(true);
  try {
    const { data, error } = await supabase
      .from('docs')
      .select(
        'id, title, ticker, source_type, published_at, source_url, storage_path, status, chunk_count, token_count, processed_at, last_error, created_at, updated_at'
      )
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    state.docs = data || [];
    renderDocs();
  } catch (error) {
    console.error('Failed to load docs', error);
    setStatus('Failed to load documents.', 'error');
  } finally {
    setConsoleBusy(false);
  }
}

async function processDoc(docId) {
  if (!docId) return;
  setStatus('Processing document…');
  const { data, error } = await supabase.functions.invoke('docs-process', {
    body: { docId }
  });
  if (error) {
    console.error('docs-process invocation failed', error);
    const serverMessage = (error?.context && typeof error.context === 'object' && error.context.error)
      ? String(error.context.error)
      : error?.message;
    setStatus(serverMessage || 'Processing failed. Check error logs.', 'error');
    return;
  }
  if (data && data.error) {
    setStatus(data.error, 'error');
  } else {
    setStatus('Document processed successfully.', 'success');
  }
  await loadDocs();
}

async function handleUpload(event) {
  event.preventDefault();
  if (!els.form) return;

  const formData = new FormData(els.form);
  const title = String(formData.get('title') || '').trim();
  const tickerRaw = String(formData.get('ticker') || '').trim();
  const ticker = tickerRaw ? tickerRaw.toUpperCase() : null;
  const sourceType = String(formData.get('source_type') || '').trim() || null;
  const sourceUrlRaw = String(formData.get('source_url') || '').trim();
  const sourceUrl = sourceUrlRaw || null;
  const publishedRaw = String(formData.get('published_at') || '').trim();
  const file = formData.get('file');

  if (!title) {
    setStatus('Provide a document title.', 'error');
    return;
  }
  if (!(file instanceof File) || !file.size) {
    setStatus('Attach a document before uploading.', 'error');
    return;
  }

  setConsoleBusy(true);
  setStatus('Uploading file…');

  try {
    await refreshSessionToken();
    const slug = slugify(title);
    const ext = (file.name.split('.').pop() || 'txt').toLowerCase();
    const prefix = ticker ? `${ticker}/` : 'misc/';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const storagePath = `raw/${prefix}${timestamp}-${slug}.${ext}`;

    const { error: uploadError } = await supabase.storage.from('docs').upload(storagePath, file, {
      cacheControl: '86400',
      upsert: false,
      contentType: file.type || undefined
    });
    if (uploadError) throw uploadError;

    const payload = {
      title,
      ticker,
      source_type: sourceType,
      source_url: sourceUrl,
      published_at: publishedRaw ? new Date(publishedRaw).toISOString() : null,
      storage_path: storagePath
    };

    const account = getAccountState();
    const inserted = await supabase
      .from('docs')
      .insert({
        ...payload,
        uploaded_by: account?.user?.id || null
      })
      .select('*')
      .single();

    if (inserted.error) throw inserted.error;

    setStatus('Upload complete. Triggering chunking job…');
    await processDoc(inserted.data.id);
    els.form.reset();
    if (els.tickerSelect) {
      els.tickerSelect.value = ticker || '';
    }
  } catch (error) {
    console.error('Document upload failed', error);
    const message = error?.message || 'Upload failed.';
    setStatus(message, 'error');
  } finally {
    setConsoleBusy(false);
  }
}

function bindEvents() {
  if (els.form) {
    els.form.addEventListener('submit', handleUpload);
  }
  if (els.refreshBtn) {
    els.refreshBtn.addEventListener('click', () => {
      loadDocs();
    });
  }
  if (els.tableBody) {
    els.tableBody.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="process"]');
      if (!button) return;
      const docId = button.getAttribute('data-doc-id');
      if (!docId) return;
      processDoc(docId);
    });
  }
}

async function bootstrap() {
  await onAuthReady();
  try {
    const user = await requireRole('admin');
    state.isAdmin = Boolean(user);
  } catch (error) {
    state.isAdmin = false;
    requireAuthorizedUI();
    setStatus('Admin session required.', 'error');
    return;
  }

  await refreshSessionToken();
  requireAuthorizedUI();
  bindEvents();
  await Promise.all([populateTickers(), loadDocs()]);
  setStatus('Ready. Upload a filing to begin.');
}

window.addEventListener('focus', () => {
  if (!state.isAdmin) return;
  refreshAuthState().catch(() => {});
  refreshSessionToken().catch(() => {});
});

document.addEventListener('DOMContentLoaded', () => {
  bootstrap().catch((error) => {
    console.error('Docs console failed to initialise', error);
    setStatus('Failed to initialise admin console.', 'error');
  });
});
