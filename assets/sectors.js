import {
  supabase,
  ensureProfile,
  hasAdminRole,
  isMembershipActive
} from './supabase.js';

const selectors = {
  createForm: document.getElementById('createForm'),
  sectorInput: document.getElementById('sectorInput'),
  notesInput: document.getElementById('notesInput'),
  createBtn: document.getElementById('createBtn'),
  createStatus: document.getElementById('createStatus'),
  suggestions: document.getElementById('sectorSuggestions'),
  searchInput: document.getElementById('searchInput'),
  promptList: document.getElementById('promptList'),
  emptyState: document.getElementById('emptyState'),
  refreshBtn: document.getElementById('refreshBtn'),
  accessNotice: document.getElementById('accessNotice')
};

const state = {
  prompts: [],
  filter: '',
  auth: {
    ready: false,
    admin: false,
    membershipActive: false
  }
};

let lastAuthState = 'unknown';

function setFormEnabled(enabled) {
  const disabled = !enabled;
  if (selectors.createBtn) selectors.createBtn.disabled = disabled;
  if (selectors.sectorInput) selectors.sectorInput.disabled = disabled;
  if (selectors.notesInput) selectors.notesInput.disabled = disabled;
  if (selectors.searchInput) selectors.searchInput.disabled = disabled;
  if (selectors.refreshBtn) selectors.refreshBtn.disabled = disabled;

  if (selectors.promptList) {
    selectors.promptList.querySelectorAll('textarea,button').forEach((element) => {
      element.disabled = disabled;
    });
  }
}

function setCreateStatus(message, tone = 'muted') {
  if (!selectors.createStatus) return;
  selectors.createStatus.textContent = message;
  selectors.createStatus.dataset.tone = tone;
}

function normalizeSector(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function characterCount(value) {
  return new Intl.NumberFormat('en-US').format((value || '').length);
}

function updateEmptyState(visible) {
  if (!selectors.emptyState || !selectors.promptList) return;
  if (visible) {
    selectors.emptyState.hidden = false;
    selectors.promptList.hidden = true;
  } else {
    selectors.emptyState.hidden = true;
    selectors.promptList.hidden = false;
  }
}

function renderSuggestions(suggestions) {
  if (!selectors.suggestions) return;
  selectors.suggestions.innerHTML = '';
  suggestions.forEach((sector) => {
    const option = document.createElement('option');
    option.value = sector;
    selectors.suggestions.appendChild(option);
  });
}

function buildPromptCard(entry) {
  const card = document.createElement('article');
  card.className = 'prompt-card';
  card.dataset.sector = entry.sector;

  const header = document.createElement('header');
  const title = document.createElement('h3');
  title.textContent = entry.sector;
  header.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `${characterCount(entry.notes)} characters`;
  header.appendChild(meta);

  const textarea = document.createElement('textarea');
  textarea.value = entry.notes || '';
  textarea.spellcheck = true;
  textarea.autocomplete = 'off';
  textarea.dataset.initialValue = textarea.value;

  const footer = document.createElement('footer');
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = 'Saved';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-primary';
  saveBtn.textContent = 'Save changes';
  saveBtn.disabled = true;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn-secondary';
  deleteBtn.textContent = 'Delete';

  actions.appendChild(saveBtn);
  actions.appendChild(deleteBtn);
  footer.appendChild(status);
  footer.appendChild(actions);

  textarea.addEventListener('input', () => {
    const trimmed = textarea.value.trim();
    const initial = textarea.dataset.initialValue ?? '';
    const changed = trimmed !== initial.trim();
    saveBtn.disabled = !changed;
    status.textContent = changed ? 'Unsaved changes' : 'Saved';
    meta.textContent = `${characterCount(textarea.value)} characters`;
  });

  saveBtn.addEventListener('click', async () => {
    const newNotes = textarea.value.trim();
    status.textContent = 'Saving…';
    saveBtn.disabled = true;
    try {
      await supabase
        .from('sector_prompts')
        .upsert({ sector: entry.sector, notes: newNotes }, { onConflict: 'sector' });
      textarea.dataset.initialValue = newNotes;
      status.textContent = 'Saved';
      meta.textContent = `${characterCount(newNotes)} characters`;
      entry.notes = newNotes;
    } catch (error) {
      console.error('Failed to save sector prompt', error);
      status.textContent = 'Save failed — retry';
      saveBtn.disabled = false;
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const confirmation = window.confirm(
      `Remove guidance for ${entry.sector}? This cannot be undone.`
    );
    if (!confirmation) return;

    status.textContent = 'Deleting…';
    saveBtn.disabled = true;
    deleteBtn.disabled = true;

    try {
      const { error } = await supabase
        .from('sector_prompts')
        .delete()
        .eq('sector', entry.sector);
      if (error) throw error;
      card.remove();
      state.prompts = state.prompts.filter((prompt) => prompt.sector !== entry.sector);
      applyFilter();
    } catch (error) {
      console.error('Failed to delete sector prompt', error);
      status.textContent = 'Delete failed';
      saveBtn.disabled = false;
      deleteBtn.disabled = false;
    }
  });

  card.appendChild(header);
  card.appendChild(textarea);
  card.appendChild(footer);

  return card;
}

function renderPrompts(list) {
  if (!selectors.promptList) return;
  selectors.promptList.innerHTML = '';

  if (!list.length) {
    updateEmptyState(true);
    return;
  }

  list.forEach((entry) => {
    selectors.promptList.appendChild(buildPromptCard(entry));
  });

  updateEmptyState(false);
}

function applyFilter() {
  const term = state.filter.trim().toLowerCase();
  const filtered = term
    ? state.prompts.filter((entry) => entry.sector.toLowerCase().includes(term))
    : [...state.prompts];
  renderPrompts(filtered);
}

async function fetchPrompts() {
  if (!state.auth.admin) return;
  try {
    const { data, error } = await supabase
      .from('sector_prompts')
      .select('sector, notes')
      .order('sector', { ascending: true });
    if (error) throw error;
    state.prompts = (data || []).map((entry) => ({
      sector: entry.sector ?? 'Unknown',
      notes: entry.notes ?? ''
    }));
    applyFilter();
  } catch (error) {
    console.error('Failed to fetch sector prompts', error);
  }
}

async function fetchSuggestions() {
  try {
    const { data, error } = await supabase
      .from('tickers')
      .select('sector')
      .not('sector', 'is', null);
    if (error) throw error;
    const sectors = new Set();
    (data || []).forEach((row) => {
      const value = normalizeSector(row.sector);
      if (value) sectors.add(value);
    });
    state.prompts.forEach((entry) => sectors.add(entry.sector));
    renderSuggestions([...sectors].sort((a, b) => a.localeCompare(b)));
  } catch (error) {
    console.error('Failed to fetch sector suggestions', error);
  }
}

async function ensureAccess() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
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
        supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
        supabase.from('memberships').select('*').eq('user_id', user.id).maybeSingle()
      ]);

      if (!profileResult.error) profile = profileResult.data ?? null;
      if (!membershipResult.error) membership = membershipResult.data ?? null;
    }

    const admin = hasAdminRole({ user, profile, membership });
    const active = isMembershipActive(membership, { user, profile, membership });
    state.auth = { ready: true, admin, membershipActive: active };

    const accessState = !user ? 'signed-out' : admin ? 'admin' : 'no-admin';
    if (accessState !== lastAuthState) {
      lastAuthState = accessState;
      if (accessState === 'admin') {
        setCreateStatus('Ready to edit sector guidance', 'success');
        selectors.accessNotice.hidden = true;
        setFormEnabled(true);
        await fetchPrompts();
        await fetchSuggestions();
      } else if (accessState === 'no-admin') {
        setCreateStatus('Admin access required', 'error');
        selectors.accessNotice.hidden = false;
        setFormEnabled(false);
        state.prompts = [];
        applyFilter();
      } else {
        setCreateStatus('Sign in to manage guidance', 'muted');
        selectors.accessNotice.hidden = false;
        setFormEnabled(false);
        state.prompts = [];
        applyFilter();
      }
    } else if (accessState === 'admin') {
      // Refresh prompts if still admin and already initialised
      await fetchPrompts();
      await fetchSuggestions();
    }
  } catch (error) {
    console.error('Failed to determine access rights', error);
    setCreateStatus('Access check failed', 'error');
    selectors.accessNotice.hidden = false;
    setFormEnabled(false);
  }
}

async function handleCreate(event) {
  event.preventDefault();
  if (!state.auth.admin) return;

  const sector = normalizeSector(selectors.sectorInput.value);
  const notes = selectors.notesInput.value.trim();

  if (!sector) {
    setCreateStatus('Enter a sector name', 'error');
    selectors.sectorInput.focus();
    return;
  }

  if (!notes) {
    setCreateStatus('Add guidance before saving', 'error');
    selectors.notesInput.focus();
    return;
  }

  setCreateStatus('Saving…', 'muted');
  selectors.createBtn.disabled = true;

  try {
    const { error } = await supabase
      .from('sector_prompts')
      .upsert({ sector, notes }, { onConflict: 'sector' });
    if (error) throw error;

    const existingIndex = state.prompts.findIndex((entry) => entry.sector === sector);
    if (existingIndex >= 0) {
      state.prompts[existingIndex].notes = notes;
    } else {
      state.prompts.push({ sector, notes });
    }
    state.prompts.sort((a, b) => a.sector.localeCompare(b.sector));

    selectors.sectorInput.value = '';
    selectors.notesInput.value = '';
    setCreateStatus('Saved', 'success');
    applyFilter();
    await fetchSuggestions();
  } catch (error) {
    console.error('Failed to save sector guidance', error);
    setCreateStatus('Save failed — retry', 'error');
  } finally {
    selectors.createBtn.disabled = false;
  }
}

function bindEvents() {
  selectors.createForm?.addEventListener('submit', handleCreate);

  selectors.searchInput?.addEventListener('input', (event) => {
    state.filter = event.target.value || '';
    applyFilter();
  });

  selectors.refreshBtn?.addEventListener('click', async () => {
    setCreateStatus('Refreshing…', 'muted');
    await fetchPrompts();
    await fetchSuggestions();
    setCreateStatus('Ready', 'success');
  });
}

async function init() {
  bindEvents();
  await ensureAccess();
  supabase.auth.onAuthStateChange(async () => {
    await ensureAccess();
  });
}

init();
