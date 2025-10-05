import { supabase, ensureProfile, hasAdminRole, isMembershipActive, SUPABASE_URL } from './supabase.js';
import {
  fetchActiveModels,
  fetchActiveCredentials,
  buildModelMap,
  buildPriceMap,
  formatModelOption,
  formatCredentialOption,
  parseScopes
} from './ai-registry.js';
import { DEFAULT_STAGE_MODELS, getPlannerFallbackModels } from './model-defaults.js';

const STORAGE_KEY = 'ff-planner-settings-v2';

const defaults = {
  universe: 40000,
  surviveStage2: 15,
  surviveStage3: 12,
  stage1: { model: DEFAULT_STAGE_MODELS.stage1, credentialId: null, inTokens: 3000, outTokens: 600 },
  stage2: { model: DEFAULT_STAGE_MODELS.stage2, credentialId: null, inTokens: 30000, outTokens: 6000 },
  stage3: { model: DEFAULT_STAGE_MODELS.stage3, credentialId: null, inTokens: 100000, outTokens: 20000 },
  budgetUsd: 0
};

const $ = (id) => document.getElementById(id);

const inputs = {
  universe: $('universeInput'),
  stage2Slider: $('stage2Slider'),
  stage3Slider: $('stage3Slider'),
  stage1Model: $('modelStage1'),
  stage2Model: $('modelStage2'),
  stage3Model: $('modelStage3'),
  stage1Credential: $('credentialStage1'),
  stage2Credential: $('credentialStage2'),
  stage3Credential: $('credentialStage3'),
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
  budgetInput: $('budgetInput'),
  budgetDelta: $('budgetDelta'),
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
  runBudget: $('runBudgetValue'),
  runSpend: $('runSpendValue'),
  runRemaining: $('runRemainingValue'),
  runRemainingStat: $('runRemainingStat'),
  runMetaStatus: $('runMetaStatus'),
  stageSpendSection: $('stageSpendSection'),
  stageSpendChart: $('stageSpendChart'),
  stageSpendTotal: $('stageSpendTotal'),
  stageSpendStage1: $('stageSpendStage1'),
  stageSpendStage2: $('stageSpendStage2'),
  stageSpendStage3: $('stageSpendStage3'),
  stageSpendEmpty: $('stageSpendEmpty'),
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
  sectorNotesEmpty: $('sectorNotesEmpty'),
  refreshRegistryBtn: $('refreshRegistryBtn')
};

const notices = {
  modelFallback: $('modelFallbackNotice'),
  credentialEmpty: $('credentialEmptyNotice')
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
let modelOptions = [];
let modelMap = new Map();
let priceMap = new Map();
let credentialOptions = [];
let credentialMap = new Map();
let modelFallbackActive = false;
const STAGE_LABELS = {
  1: 'Stage 1 · Triage',
  2: 'Stage 2 · Scoring',
  3: 'Stage 3 · Deep dive'
};

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
      stage3: { ...defaults.stage3, ...saved.stage3 },
      budgetUsd: Number(saved.budgetUsd ?? saved.budget_usd) || defaults.budgetUsd
    };
  } catch (error) {
    console.warn('Unable to parse saved planner settings', error);
    return { ...defaults };
  }
}

function ensureModelSlug(stageKey, slug) {
  const requested = typeof slug === 'string' ? slug.trim() : '';
  if (modelMap.size === 0) {
    return requested || DEFAULT_STAGE_MODELS[stageKey] || '';
  }
  if (requested && modelMap.has(requested)) {
    return requested;
  }
  const fallback = DEFAULT_STAGE_MODELS[stageKey] || '';
  if (fallback && modelMap.has(fallback)) {
    return fallback;
  }
  const firstOption = modelOptions.length ? modelOptions[0].slug : '';
  if (firstOption && modelMap.has(firstOption)) {
    return firstOption;
  }
  return requested || fallback || '';
}

function normalizeCredentialId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseRunNotes(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (error) {
      console.warn('Failed to parse run notes JSON', error);
      return {};
    }
  }
  if (typeof raw === 'object') {
    return raw ?? {};
  }
  return {};
}

function populateModelSelect(select, stageKey) {
  if (!select) return;
  const previousValue = select.value;
  select.innerHTML = '';

  if (!modelOptions.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No models available';
    select.appendChild(option);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  const providers = new Map();
  modelOptions.forEach((model) => {
    const provider = model.provider || 'other';
    if (!providers.has(provider)) providers.set(provider, []);
    providers.get(provider).push(model);
  });

  if (providers.size > 1) {
    Array.from(providers.keys())
      .sort((a, b) => a.localeCompare(b))
      .forEach((provider) => {
        const group = document.createElement('optgroup');
        group.label = provider.toUpperCase();
        providers.get(provider)
          .slice()
          .sort((a, b) => a.label.localeCompare(b.label))
          .forEach((model) => {
            const option = document.createElement('option');
            option.value = model.slug;
            option.textContent = formatModelOption(model);
            option.dataset.provider = model.provider;
            group.appendChild(option);
          });
        select.appendChild(group);
      });
  } else {
    modelOptions
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .forEach((model) => {
        const option = document.createElement('option');
        option.value = model.slug;
        option.textContent = formatModelOption(model);
        option.dataset.provider = model.provider;
        select.appendChild(option);
      });
  }

  const desired = ensureModelSlug(stageKey, previousValue);
  if (desired && modelMap.has(desired)) {
    select.value = desired;
  } else {
    select.selectedIndex = 0;
  }
}

function populateCredentialSelect(select) {
  if (!select) return;
  const previousValue = select.value;
  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Auto-select for provider';
  select.appendChild(placeholder);

  if (!credentialOptions.length) {
    select.disabled = true;
    return;
  }

  select.disabled = false;
  credentialOptions.forEach((credential) => {
    const option = document.createElement('option');
    option.value = credential.id;
    option.textContent = formatCredentialOption(credential);
    option.dataset.provider = credential.provider ?? '';
    select.appendChild(option);
  });

  if (previousValue && credentialMap.has(previousValue)) {
    select.value = previousValue;
  } else {
    select.value = '';
  }
}

function populateModelControls() {
  populateModelSelect(inputs.stage1Model, 'stage1');
  populateModelSelect(inputs.stage2Model, 'stage2');
  populateModelSelect(inputs.stage3Model, 'stage3');
}

function populateCredentialControls() {
  populateCredentialSelect(inputs.stage1Credential);
  populateCredentialSelect(inputs.stage2Credential);
  populateCredentialSelect(inputs.stage3Credential);
}

function toggleNotice(element, show) {
  if (!element) return;
  if (show) {
    element.hidden = false;
    element.removeAttribute('hidden');
  } else {
    element.hidden = true;
    element.setAttribute('hidden', '');
  }
}

function updateModelNotice() {
  toggleNotice(notices.modelFallback, modelFallbackActive);
}

function updateCredentialNotice() {
  const empty = credentialOptions.length === 0;
  toggleNotice(notices.credentialEmpty, empty);
}

function initCredentialManager() {
  const modal = document.getElementById('credentialModal');
  const triggers = Array.from(document.querySelectorAll('[data-open-credential-manager]'));

  if (!modal || !triggers.length) return null;

  const statusEl = modal.querySelector('#credentialStatus');
  const lockedEl = modal.querySelector('#credentialLocked');
  const formEl = modal.querySelector('#credentialForm');
  const listEl = modal.querySelector('#credentialList');
  const idInput = modal.querySelector('#credentialId');
  const providerInput = modal.querySelector('#credentialProvider');
  const labelInput = modal.querySelector('#credentialLabel');
  const tierInput = modal.querySelector('#credentialTier');
  const scopesInput = modal.querySelector('#credentialScopes');
  const keyInput = modal.querySelector('#credentialKey');
  const activeInput = modal.querySelector('#credentialActive');
  const updatedEl = modal.querySelector('#credentialUpdated');
  const copyBtn = modal.querySelector('#credentialCopy');
  const discardBtn = modal.querySelector('#credentialDiscard');
  const saveBtn = modal.querySelector('#credentialSave');
  const newBtn = modal.querySelector('#credentialNew');
  const refreshBtn = modal.querySelector('#credentialRefresh');
  const closeButtons = Array.from(modal.querySelectorAll('[data-credential-close]'));

  let credentials = [];
  let activeId = null;
  let isOpen = false;
  let isLoading = false;
  let isSaving = false;
  let isDirty = false;
  let suppressDirty = false;
  let lastTrigger = null;

  const formatTimestamp = (value) => {
    if (!value) return '—';
    try {
      const timestamp = new Date(value);
      if (Number.isNaN(timestamp.getTime())) return '—';
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
    } catch (error) {
      return '—';
    }
  };

  const setStatus = (text, tone = 'info') => {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.dataset.tone = text ? tone : '';
  };

  const toggleLocked = (locked) => {
    if (lockedEl) lockedEl.hidden = !locked;
    if (formEl) formEl.hidden = locked;
  };

  const renderEmptyList = (message) => {
    if (!listEl) return;
    listEl.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'credential-list__empty';
    li.textContent = message;
    listEl.appendChild(li);
  };

  const renderList = () => {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!credentials.length) {
      renderEmptyList(isLoading ? 'Loading credentials…' : 'No credentials yet.');
      return;
    }

    credentials.forEach((record) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'credential-list__item';
      button.dataset.credentialId = record.id;
      if (record.id === activeId) {
        button.setAttribute('aria-current', 'true');
      }
      const title = document.createElement('strong');
      title.textContent = record.label || record.provider || 'Unnamed credential';
      const meta = document.createElement('span');
      const parts = [];
      if (record.provider) parts.push(record.provider.toUpperCase());
      if (record.tier) parts.push(record.tier);
      if (record.scopes?.length) parts.push(record.scopes.join(', '));
      if (!record.is_active) parts.push('inactive');
      meta.textContent = parts.join(' • ') || '—';
      button.append(title, meta);
      li.appendChild(button);
      listEl.appendChild(li);
    });
  };

  const resetForm = () => {
    if (!formEl) return;
    suppressDirty = true;
    formEl.reset();
    if (idInput) idInput.value = '';
    if (providerInput) providerInput.value = '';
    if (labelInput) labelInput.value = '';
    if (tierInput) tierInput.value = '';
    if (scopesInput) scopesInput.value = 'automation';
    if (keyInput) keyInput.value = '';
    if (activeInput) activeInput.checked = true;
    if (updatedEl) updatedEl.textContent = '—';
    suppressDirty = false;
    isDirty = false;
  };

  const populateForm = (record) => {
    if (!formEl) return;
    suppressDirty = true;
    if (idInput) idInput.value = record.id || '';
    if (providerInput) providerInput.value = record.provider || '';
    if (labelInput) labelInput.value = record.label || '';
    if (tierInput) tierInput.value = record.tier || '';
    if (scopesInput) {
      const scopesText = (record.scopes && record.scopes.length ? record.scopes : ['automation']).join(', ');
      scopesInput.value = scopesText;
    }
    if (keyInput) keyInput.value = record.api_key || '';
    if (activeInput) activeInput.checked = record.is_active !== false;
    if (updatedEl) updatedEl.textContent = formatTimestamp(record.updated_at);
    suppressDirty = false;
    isDirty = false;
  };

  const ensureAdmin = async () => {
    await refreshAuthContext();
    if (!authContext.user) {
      toggleLocked(true);
      setStatus('Sign in to manage API credentials.', 'error');
      return false;
    }
    if (!authContext.isAdmin) {
      toggleLocked(true);
      setStatus('Admin access required to manage API credentials.', 'error');
      return false;
    }
    toggleLocked(false);
    return true;
  };

  const setActiveCredential = (id) => {
    if (isDirty && id !== activeId) {
      const proceed = window.confirm('Discard unsaved changes?');
      if (!proceed) return;
    }
    isDirty = false;
    activeId = id || null;
    if (activeId) {
      const record = credentials.find((entry) => entry.id === activeId);
      if (record) {
        populateForm(record);
        setStatus('Credential ready to edit.', 'info');
        if (formEl) formEl.hidden = false;
      } else {
        activeId = null;
        resetForm();
      }
    } else {
      resetForm();
      setStatus('Add details for the new credential, then save to store it.', 'info');
      if (formEl) formEl.hidden = false;
    }
    renderList();
    if (keyInput) keyInput.scrollTop = 0;
  };

  const normalizeScopes = (value) => {
    const parsed = parseScopes(value || '');
    const normalized = Array.from(
      new Set(parsed.map((entry) => entry.trim().toLowerCase()).filter(Boolean))
    );
    if (!normalized.length) normalized.push('automation');
    return normalized;
  };

  const collectFormValues = () => {
    const provider = (providerInput?.value || '').trim().toLowerCase();
    const label = (labelInput?.value || '').trim();
    const tier = (tierInput?.value || '').trim();
    const scopes = normalizeScopes(scopesInput?.value ?? '');
    const apiKey = (keyInput?.value || '').trim();
    const isActive = !!activeInput?.checked;
    const id = (idInput?.value || '').trim();
    return {
      id: id || null,
      provider,
      label: label || null,
      tier: tier || null,
      scopes,
      apiKey,
      isActive
    };
  };

  const loadCredentials = async ({ preserveSelection = true } = {}) => {
    const allowed = await ensureAdmin();
    if (!allowed) {
      credentials = [];
      renderList();
      resetForm();
      return;
    }

    isLoading = true;
    renderList();
    setStatus('Loading credentials…', 'info');

    try {
      const { data, error } = await supabase
        .from('editor_api_credentials')
        .select('id, provider, label, tier, scopes, api_key, is_active, updated_at')
        .order('updated_at', { ascending: false });
      if (error) throw error;

      credentials = (data ?? []).map((row) => {
        const parsedScopes = Array.isArray(row.scopes)
          ? row.scopes.filter(Boolean)
          : parseScopes(row.scopes);
        return {
          id: row.id,
          provider: row.provider ?? '',
          label: row.label ?? '',
          tier: row.tier ?? '',
          scopes: parsedScopes.map((entry) => entry.trim()).filter(Boolean),
          api_key: row.api_key ?? '',
          is_active: row.is_active !== false,
          updated_at: row.updated_at ?? null
        };
      });

      credentials.sort((a, b) => {
        const providerOrder = (a.provider || '').localeCompare(b.provider || '');
        if (providerOrder !== 0) return providerOrder;
        return (a.label || '').localeCompare(b.label || '');
      });

      renderList();

      if (!credentials.length) {
        resetForm();
        setStatus('No credentials yet. Use “New credential” to add one.', 'info');
        activeId = null;
        return;
      }

      const nextId =
        preserveSelection && activeId && credentials.some((entry) => entry.id === activeId)
          ? activeId
          : credentials[0].id;

      setActiveCredential(nextId);
      setStatus('Select a credential to review or edit.', 'info');
    } catch (error) {
      console.error('Credential registry load error', error);
      setStatus(`Unable to load credentials: ${error.message}`, 'error');
      credentials = [];
      renderList();
      resetForm();
    } finally {
      isLoading = false;
    }
  };

  const closeModal = () => {
    if (!isOpen) return;
    modal.classList.remove('is-visible');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    const handleTransitionEnd = () => {
      modal.hidden = true;
      credentials = [];
      renderList();
      resetForm();
      setStatus('', '');
      isOpen = false;
      if (lastTrigger) {
        try {
          lastTrigger.focus();
        } catch (error) {
          // ignore
        }
        lastTrigger = null;
      }
    };
    modal.addEventListener('transitionend', handleTransitionEnd, { once: true });
  };

  const openModal = async (event) => {
    if (event) {
      event.preventDefault();
      lastTrigger = event.currentTarget || event.target || null;
    }
    if (isOpen) return;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-visible'));
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    isOpen = true;
    setStatus('', '');
    await loadCredentials({ preserveSelection: true });
  };

  const saveCredential = async (event) => {
    event.preventDefault();
    if (isSaving) return;
    const allowed = await ensureAdmin();
    if (!allowed) return;

    const { id, provider, label, tier, scopes, apiKey, isActive } = collectFormValues();

    if (!provider) {
      setStatus('Provider is required.', 'error');
      providerInput?.focus();
      return;
    }

    if (!apiKey) {
      setStatus('API key is required.', 'error');
      keyInput?.focus();
      return;
    }

    isSaving = true;
    saveBtn?.setAttribute('disabled', 'true');
    setStatus('Saving credential…', 'info');

    try {
      const payload = {
        provider,
        label,
        tier,
        scopes,
        api_key: apiKey,
        is_active: isActive
      };

      let result = null;
      if (id) {
        const { data, error } = await supabase
          .from('editor_api_credentials')
          .update(payload)
          .eq('id', id)
          .select()
          .maybeSingle();
        if (error) throw error;
        result = data;
      } else {
        const { data, error } = await supabase
          .from('editor_api_credentials')
          .insert([payload])
          .select()
          .maybeSingle();
        if (error) throw error;
        result = data;
      }

      const storedId = result?.id || id;
      if (storedId) {
        activeId = storedId;
      }

      isDirty = false;
      setStatus('Credential saved. Refreshing registry…', 'success');
      logStatus(`Credential saved for provider ${provider}.`);

      const snapshot = getSettingsFromInputs();
      await loadCredentials({ preserveSelection: true });
      await loadCatalogs({ silent: true });
      applySettings(snapshot);
      updateCostOutput();
      if (inputs.status) {
        inputs.status.textContent = 'Credential registry updated';
      }
    } catch (error) {
      console.error('Credential save error', error);
      setStatus(`Save failed: ${error.message}`, 'error');
    } finally {
      isSaving = false;
      saveBtn?.removeAttribute('disabled');
    }
  };

  const discardChanges = () => {
    if (activeId) {
      const record = credentials.find((entry) => entry.id === activeId);
      if (record) {
        populateForm(record);
        setStatus('Changes discarded.', 'info');
        return;
      }
    }
    resetForm();
    setStatus('Ready to add a new credential.', 'info');
  };

  const copyKey = async () => {
    const value = keyInput?.value?.trim() || '';
    if (!value) {
      setStatus('Add an API key before copying.', 'error');
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setStatus('API key copied to clipboard.', 'success');
    } catch (error) {
      try {
        keyInput?.focus();
        keyInput?.select();
        const succeeded = document.execCommand('copy');
        if (!succeeded) throw new Error('Copy command failed');
        setStatus('API key copied to clipboard.', 'success');
      } catch (copyError) {
        setStatus('Copy failed. Select the key and copy manually.', 'error');
      } finally {
        keyInput?.blur();
      }
    }
  };

  const handleListClick = (event) => {
    const button = event.target.closest('[data-credential-id]');
    if (!button || isSaving) return;
    const { credentialId } = button.dataset;
    if (!credentialId) return;
    setActiveCredential(credentialId);
  };

  const handleOverlayClick = (event) => {
    if (event.target === modal) {
      closeModal();
    }
  };

  const handleKeydown = (event) => {
    if (event.key === 'Escape' && isOpen) {
      closeModal();
    }
  };

  formEl?.addEventListener('submit', saveCredential);
  formEl?.addEventListener('input', () => {
    if (suppressDirty) return;
    isDirty = true;
  });
  copyBtn?.addEventListener('click', copyKey);
  discardBtn?.addEventListener('click', discardChanges);
  newBtn?.addEventListener('click', async () => {
    const allowed = await ensureAdmin();
    if (!allowed) return;
    if (isDirty) {
      const proceed = window.confirm('Discard unsaved changes?');
      if (!proceed) return;
    }
    activeId = null;
    toggleLocked(false);
    resetForm();
    if (formEl) formEl.hidden = false;
    setStatus('Add details for the new credential, then save to store it.', 'info');
    renderList();
  });
  refreshBtn?.addEventListener('click', () => {
    loadCredentials({ preserveSelection: true });
  });
  listEl?.addEventListener('click', handleListClick);
  modal.addEventListener('click', handleOverlayClick);
  document.addEventListener('keydown', handleKeydown);
  closeButtons.forEach((button) => button.addEventListener('click', closeModal));
  triggers.forEach((trigger) => trigger.addEventListener('click', openModal));

  const manager = {
    open: openModal,
    refresh: () => loadCredentials({ preserveSelection: true })
  };

  modal.ffCredentialManager = manager;
  if (typeof window !== 'undefined') {
    window.ffCredentialManager = manager;
  }

  return manager;
}

async function loadCatalogs({ silent = false } = {}) {
  let fetchedModels = [];
  modelFallbackActive = false;
  try {
    fetchedModels = await fetchActiveModels({});
  } catch (error) {
    console.error('Failed to load AI models', error);
    if (!silent) logStatus(`Model registry error: ${error.message}`);
  }

  const fallbackModels = getPlannerFallbackModels();
  if (!fetchedModels.length) {
    if (!silent) logStatus('Using default AI model catalogue.');
    modelOptions = fallbackModels;
    modelFallbackActive = true;
  } else {
    const seen = new Set(fetchedModels.map((model) => model.slug));
    const extras = fallbackModels.filter((model) => !seen.has(model.slug));
    if (extras.length) {
      modelOptions = [...fetchedModels, ...extras];
      modelFallbackActive = true;
    } else {
      modelOptions = fetchedModels;
    }
  }

  modelMap = buildModelMap(modelOptions);
  priceMap = buildPriceMap(modelOptions);
  populateModelControls();
  updateModelNotice();

  try {
    credentialOptions = await fetchActiveCredentials({ scope: 'automation' });
    if (!credentialOptions.length) {
      credentialOptions = await fetchActiveCredentials({ scope: null });
    }
    credentialMap = new Map();
    credentialOptions.forEach((credential) => {
      credentialMap.set(credential.id, credential);
    });
    populateCredentialControls();
    updateCredentialNotice();
  } catch (error) {
    console.error('Failed to load API credentials', error);
    if (!silent) logStatus(`Credential registry error: ${error.message}`);
    updateCredentialNotice();
  }
}

function persistSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function getSettingsFromInputs() {
  const stage1Model = ensureModelSlug('stage1', inputs.stage1Model?.value || defaults.stage1.model);
  const stage2Model = ensureModelSlug('stage2', inputs.stage2Model?.value || defaults.stage2.model);
  const stage3Model = ensureModelSlug('stage3', inputs.stage3Model?.value || defaults.stage3.model);
  const stage1Credential = normalizeCredentialId(inputs.stage1Credential?.value ?? null);
  const stage2Credential = normalizeCredentialId(inputs.stage2Credential?.value ?? null);
  const stage3Credential = normalizeCredentialId(inputs.stage3Credential?.value ?? null);

  return {
    universe: Number(inputs.universe?.value) || 0,
    surviveStage2: Number(inputs.stage2Slider?.value) || 0,
    surviveStage3: Number(inputs.stage3Slider?.value) || 0,
    stage1: {
      model: stage1Model,
      credentialId: stage1Credential,
      inTokens: Number(inputs.stage1In?.value) || 0,
      outTokens: Number(inputs.stage1Out?.value) || 0
    },
    stage2: {
      model: stage2Model,
      credentialId: stage2Credential,
      inTokens: Number(inputs.stage2In?.value) || 0,
      outTokens: Number(inputs.stage2Out?.value) || 0
    },
    stage3: {
      model: stage3Model,
      credentialId: stage3Credential,
      inTokens: Number(inputs.stage3In?.value) || 0,
      outTokens: Number(inputs.stage3Out?.value) || 0
    },
    budgetUsd: Math.max(0, Number(inputs.budgetInput?.value) || 0)
  };
}

function applySettings(settings) {
  if (!inputs.startBtn) return;
  const stage1Model = ensureModelSlug('stage1', settings.stage1?.model ?? defaults.stage1.model);
  const stage2Model = ensureModelSlug('stage2', settings.stage2?.model ?? defaults.stage2.model);
  const stage3Model = ensureModelSlug('stage3', settings.stage3?.model ?? defaults.stage3.model);
  const stage1Credential = normalizeCredentialId(settings.stage1?.credentialId ?? null);
  const stage2Credential = normalizeCredentialId(settings.stage2?.credentialId ?? null);
  const stage3Credential = normalizeCredentialId(settings.stage3?.credentialId ?? null);

  settings.stage1 = {
    ...settings.stage1,
    model: stage1Model,
    credentialId: stage1Credential && credentialMap.has(stage1Credential) ? stage1Credential : null
  };
  settings.stage2 = {
    ...settings.stage2,
    model: stage2Model,
    credentialId: stage2Credential && credentialMap.has(stage2Credential) ? stage2Credential : null
  };
  settings.stage3 = {
    ...settings.stage3,
    model: stage3Model,
    credentialId: stage3Credential && credentialMap.has(stage3Credential) ? stage3Credential : null
  };

  inputs.universe.value = settings.universe;
  inputs.stage2Slider.value = settings.surviveStage2;
  inputs.stage3Slider.value = settings.surviveStage3;
  inputs.stage2Value.textContent = `${settings.surviveStage2}%`;
  inputs.stage3Value.textContent = `${settings.surviveStage3}%`;
  if (inputs.stage1Model) inputs.stage1Model.value = settings.stage1.model;
  inputs.stage1In.value = settings.stage1.inTokens;
  inputs.stage1Out.value = settings.stage1.outTokens;
  if (inputs.stage2Model) inputs.stage2Model.value = settings.stage2.model;
  inputs.stage2In.value = settings.stage2.inTokens;
  inputs.stage2Out.value = settings.stage2.outTokens;
  if (inputs.stage3Model) inputs.stage3Model.value = settings.stage3.model;
  inputs.stage3In.value = settings.stage3.inTokens;
  inputs.stage3Out.value = settings.stage3.outTokens;
  if (inputs.stage1Credential) {
    inputs.stage1Credential.value = settings.stage1.credentialId ?? '';
  }
  if (inputs.stage2Credential) {
    inputs.stage2Credential.value = settings.stage2.credentialId ?? '';
  }
  if (inputs.stage3Credential) {
    inputs.stage3Credential.value = settings.stage3.credentialId ?? '';
  }
  const budgetValue = Math.max(0, Number(settings.budgetUsd ?? defaults.budgetUsd) || 0);
  if (inputs.budgetInput) {
    inputs.budgetInput.value = budgetValue ? String(budgetValue) : '0';
  }
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

function updateStageSpendChart(breakdown = []) {
  const section = inputs.stageSpendSection;
  const chart = inputs.stageSpendChart;
  const totalEl = inputs.stageSpendTotal;
  const emptyEl = inputs.stageSpendEmpty;
  const stageEls = {
    1: inputs.stageSpendStage1,
    2: inputs.stageSpendStage2,
    3: inputs.stageSpendStage3
  };

  if (!section || !chart || !totalEl) {
    return;
  }

  if (!activeRunId) {
    section.hidden = true;
    chart.innerHTML = '';
    totalEl.textContent = '—';
    Object.values(stageEls).forEach((el) => {
      if (el) el.textContent = '—';
    });
    if (emptyEl) emptyEl.hidden = true;
    return;
  }

  section.hidden = false;

  const stageTotals = [1, 2, 3].map((stage) => {
    const total = breakdown
      .filter((row) => Number(row.stage) === stage)
      .reduce((acc, row) => acc + Number(row.cost_usd ?? 0), 0);
    return { stage, total: total > 0 ? total : 0 };
  });

  const totalSpend = stageTotals.reduce((acc, item) => acc + item.total, 0);
  const hasSpend = stageTotals.some((item) => item.total > 0.0005);
  const maxSpend = stageTotals.reduce((max, item) => (item.total > max ? item.total : max), 0);

  totalEl.textContent = hasSpend ? formatCurrency(totalSpend) : '—';

  stageTotals.forEach(({ stage, total }) => {
    const target = stageEls[stage];
    if (target) {
      target.textContent = total > 0 ? formatCurrency(total) : '—';
    }
  });

  if (emptyEl) {
    emptyEl.hidden = hasSpend;
  }

  chart.innerHTML = '';
  chart.setAttribute('aria-hidden', hasSpend ? 'false' : 'true');

  stageTotals.forEach(({ stage, total }) => {
    const bar = document.createElement('div');
    bar.className = 'stage-spend__bar';
    bar.dataset.stage = String(stage);
    bar.setAttribute('role', 'listitem');

    const ratio = maxSpend > 0 ? total / maxSpend : 0;
    const height = hasSpend ? Math.max(12, Math.round(ratio * 56)) : 6;
    bar.style.height = `${height}px`;

    const label = `${STAGE_LABELS[stage] ?? `Stage ${stage}`} — ${total > 0 ? formatCurrency(total) : 'No spend yet'}`;
    bar.setAttribute('aria-label', label);

    chart.appendChild(bar);
  });
}

function updateRunMeta(meta = null, { message, totalCost = null, budgetUsd = null, budgetExceeded = null, breakdown = null } = {}) {
  const previousMeta = currentRunMeta;

  let resolvedBudget = Number.isFinite(budgetUsd) && budgetUsd > 0 ? Number(budgetUsd) : null;
  let resolvedSpend = Number.isFinite(totalCost) ? Math.max(Number(totalCost), 0) : null;
  let estimatedTotal = null;

  if (meta) {
    const metaBudget = Number(meta?.budget_usd ?? meta?.budgetUsd ?? NaN);
    if (!resolvedBudget && Number.isFinite(metaBudget) && metaBudget > 0) {
      resolvedBudget = metaBudget;
    }

    const notes = parseRunNotes(meta.notes ?? null);
    const notesBudget = Number(notes?.budget_usd ?? notes?.planner?.budgetUsd ?? NaN);
    if (!resolvedBudget && Number.isFinite(notesBudget) && notesBudget > 0) {
      resolvedBudget = notesBudget;
    }
    const estimatedFromNotes = Number(notes?.estimated_cost?.total ?? notes?.estimated_cost?.total_cost ?? NaN);
    if (Number.isFinite(estimatedFromNotes)) {
      estimatedTotal = Math.max(0, estimatedFromNotes);
    }
  }

  if (resolvedSpend === null && previousMeta && previousMeta.id === meta?.id && Number.isFinite(previousMeta.total_cost)) {
    resolvedSpend = Number(previousMeta.total_cost);
  }

  const budgetHit = typeof budgetExceeded === 'boolean'
    ? budgetExceeded
    : resolvedBudget !== null && resolvedSpend !== null && resolvedSpend >= resolvedBudget - 0.0005;

  currentRunMeta = meta
    ? {
        ...meta,
        budget_usd: resolvedBudget,
        total_cost: resolvedSpend,
        budget_exhausted: budgetHit,
        estimated_total_cost: estimatedTotal
      }
    : null;

  const statusText = meta?.status ? String(meta.status).replace(/_/g, ' ') : null;
  const stopText = meta ? (meta.stop_requested ? 'Yes' : 'No') : null;

  if (inputs.runStatusText) {
    inputs.runStatusText.textContent = statusText ? statusText : '—';
  }

  if (inputs.runStopText) {
    inputs.runStopText.textContent = stopText ?? '—';
  }

  if (inputs.runBudget) {
    inputs.runBudget.textContent = resolvedBudget !== null ? formatCurrency(resolvedBudget) : '—';
  }

  if (inputs.runSpend) {
    inputs.runSpend.textContent = resolvedSpend !== null ? formatCurrency(resolvedSpend) : '—';
  }

  if (inputs.runRemaining) {
    if (resolvedBudget !== null && resolvedSpend !== null) {
      const diffRaw = resolvedBudget - resolvedSpend;
      const diff = Math.abs(diffRaw) < 0.005 ? 0 : diffRaw;
      const formatted = formatCurrency(Math.abs(diff));
      inputs.runRemaining.textContent = diff >= 0 ? formatted : `-${formatted}`;
      if (inputs.runRemainingStat) {
        inputs.runRemainingStat.classList.toggle('run-meta__stat--alert', diff < 0);
      }
    } else {
      inputs.runRemaining.textContent = '—';
      inputs.runRemainingStat?.classList.remove('run-meta__stat--alert');
    }
  }

  const defaultMessage = !activeRunId
    ? 'Select a run to manage stop requests.'
    : meta
      ? budgetHit
        ? 'Budget reached. Increase the guardrail or adjust costs before resuming.'
        : meta.stop_requested
          ? 'Run flagged to stop. Workers finish the active batch and halt new processing.'
          : 'Run active. Flag a stop request to pause new work after current batches.'
      : 'Loading run details…';

  if (inputs.runMetaStatus) {
    inputs.runMetaStatus.textContent = message || defaultMessage;
  }

  if (breakdown !== undefined && breakdown !== null) {
    updateStageSpendChart(Array.isArray(breakdown) ? breakdown : []);
  } else if (!meta) {
    updateStageSpendChart([]);
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
    const [runResult, costResult, breakdownResult] = await Promise.all([
      supabase
        .from('runs')
        .select('id, created_at, status, stop_requested, notes, budget_usd')
        .eq('id', activeRunId)
        .maybeSingle(),
      supabase.rpc('run_cost_summary', { p_run_id: activeRunId }).maybeSingle(),
      supabase.rpc('run_cost_breakdown', { p_run_id: activeRunId })
    ]);

    if (runResult.error) throw runResult.error;

    if (costResult.error) {
      console.warn('Failed to load cost summary for run meta', costResult.error);
    }

    if (breakdownResult.error) {
      console.warn('Failed to load stage spend breakdown for run meta', breakdownResult.error);
    }

    const runData = runResult.data ?? null;
    const totalCost = costResult.error ? null : Number(costResult.data?.total_cost ?? 0);
    const budgetUsd = Number(runData?.budget_usd ?? NaN);
    const budgetExceeded =
      !costResult.error && Number.isFinite(budgetUsd) && budgetUsd > 0 && totalCost !== null && totalCost >= budgetUsd - 0.0005;

    const breakdownData = breakdownResult.error ? [] : Array.isArray(breakdownResult.data) ? breakdownResult.data : [];

    updateRunMeta(runData, {
      totalCost,
      budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : null,
      budgetExceeded,
      breakdown: breakdownData
    });
    return runData;
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

    updateStageSpendChart(breakdown);

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

  if (currentRunMeta?.budget_exhausted) {
    if (inputs.stage1Status) inputs.stage1Status.textContent = 'Run budget reached. Increase the guardrail before processing more triage batches.';
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
    try {
      await fetchRunMeta({ silent: true });
    } catch (error) {
      console.error('Failed to refresh run meta after Stage 1 batch', error);
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

  if (currentRunMeta?.budget_exhausted) {
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Run budget reached. Increase the guardrail before scoring additional survivors.';
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
    try {
      await fetchRunMeta({ silent: true });
    } catch (error) {
      console.error('Failed to refresh run meta after Stage 2 batch', error);
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

  if (currentRunMeta?.budget_exhausted) {
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Run budget reached. Increase the guardrail before running more deep dives.';
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
    try {
      await fetchRunMeta({ silent: true });
    } catch (error) {
      console.error('Failed to refresh run meta after Stage 3 batch', error);
    }
    applyAccessState({ preserveStatus: true });
  }
}

function stageCost(n, inTok, outTok, modelSlug) {
  if (!n) return { total: 0, inCost: 0, outCost: 0 };
  const price = priceMap.get(modelSlug);
  if (!price) return { total: 0, inCost: 0, outCost: 0 };
  const inCost = (n * inTok / 1_000_000) * price.in;
  const outCost = (n * outTok / 1_000_000) * price.out;
  return { total: inCost + outCost, inCost, outCost };
}

function formatCurrency(amount) {
  return `$${amount.toFixed(2)}`;
}

function updateCostOutput() {
  if (!inputs.costOut) return;
  const settings = getSettingsFromInputs();
  persistSettings(settings);

  if (inputs.budgetInput) {
    inputs.budgetInput.value = settings.budgetUsd ? String(settings.budgetUsd) : '0';
  }

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

  if (inputs.budgetDelta) {
    const budgetUsd = Math.max(0, Number(settings.budgetUsd ?? 0) || 0);
    if (budgetUsd > 0) {
      const diffRaw = budgetUsd - total;
      const diff = Math.abs(diffRaw) < 0.005 ? 0 : diffRaw;
      if (diff >= 0) {
        inputs.budgetDelta.textContent = `Budget cushion: ${formatCurrency(diff)} remaining`;
        inputs.budgetDelta.classList.remove('over');
      } else {
        inputs.budgetDelta.textContent = `Over budget by ${formatCurrency(Math.abs(diff))}`;
        inputs.budgetDelta.classList.add('over');
      }
    } else {
      inputs.budgetDelta.textContent = 'No budget guardrail set.';
      inputs.budgetDelta.classList.remove('over');
    }
  }
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

  const haltRequested = (currentRunMeta?.stop_requested ?? false) || (currentRunMeta?.budget_exhausted ?? false);

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
    inputs.stage1Btn.disabled = state !== 'admin-ok' || !activeRunId || haltRequested;
  }

  if (inputs.stage1RefreshBtn) {
    inputs.stage1RefreshBtn.disabled = !activeRunId;
  }

  if (inputs.stage2Btn) {
    inputs.stage2Btn.disabled = state !== 'admin-ok' || !activeRunId || haltRequested;
  }

  if (inputs.stage2RefreshBtn) {
    inputs.stage2RefreshBtn.disabled = !activeRunId;
  }

  if (inputs.stage3Btn) {
    inputs.stage3Btn.disabled = state !== 'admin-ok' || !activeRunId || haltRequested;
  }

  if (inputs.stage3RefreshBtn) {
    inputs.stage3RefreshBtn.disabled = !activeRunId;
  }

  if (inputs.stopRunBtn) {
    inputs.stopRunBtn.disabled = state !== 'admin-ok' || !activeRunId || (currentRunMeta?.stop_requested ?? false);
  }

  if (inputs.resumeRunBtn) {
    inputs.resumeRunBtn.disabled =
      state !== 'admin-ok' || !activeRunId || (!currentRunMeta?.stop_requested && !currentRunMeta?.budget_exhausted);
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
        budget_usd: settings.budgetUsd,
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
    if (typeof data.budget_usd === 'number' && data.budget_usd > 0) {
      logStatus(`Budget guardrail set to ${formatCurrency(data.budget_usd)}.`);
    }
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
  const inputElements = [
    inputs.universe,
    inputs.stage2Slider,
    inputs.stage3Slider,
    inputs.stage1In,
    inputs.stage1Out,
    inputs.stage2In,
    inputs.stage2Out,
    inputs.stage3In,
    inputs.stage3Out,
    inputs.budgetInput
  ].filter(Boolean);

  const selectElements = [
    inputs.stage1Model,
    inputs.stage2Model,
    inputs.stage3Model,
    inputs.stage1Credential,
    inputs.stage2Credential,
    inputs.stage3Credential
  ].filter(Boolean);

  inputElements.forEach((element) => {
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

  selectElements.forEach((element) => {
    element.addEventListener('change', () => {
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

  inputs.refreshRegistryBtn?.addEventListener('click', async () => {
    const before = getSettingsFromInputs();
    inputs.status.textContent = 'Refreshing model & credential registry…';
    await loadCatalogs({ silent: false });
    applySettings(before);
    updateCostOutput();
    logStatus('Registry refreshed.');
    inputs.status.textContent = 'Registry updated';
  });
}

async function bootstrap() {
  if (!inputs.startBtn || !inputs.log) {
    console.warn('Planner controls missing. Skipping initialisation.');
    return;
  }

  inputs.status.textContent = 'Loading model registry…';
  await loadCatalogs({ silent: true });
  const initialSettings = loadSettings();
  applySettings(initialSettings);
  updateCostOutput();
  bindEvents();
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

initCredentialManager();
bootstrap();
