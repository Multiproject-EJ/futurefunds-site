import { supabase, ensureProfile, hasAdminRole, isMembershipActive, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';
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
  budgetUsd: 0,
  scope: { mode: 'universe', watchlistId: null, watchlistSlug: null, watchlistCount: null, customTickers: [] }
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
  autoContinueToggle: $('autoContinueToggle'),
  autoContinueInterval: $('autoContinueInterval'),
  autoContinueStatus: $('autoContinueStatus'),
  scopeFieldset: $('runScopeFieldset'),
  scopeStatus: $('scopeStatus'),
  watchlistSelect: $('watchlistSelect'),
  watchlistSummary: $('watchlistSummary'),
  refreshWatchlistsBtn: $('refreshWatchlistsBtn'),
  customTickers: $('customTickersInput'),
  watchlistManager: $('watchlistManager'),
  createWatchlistForm: $('createWatchlistForm'),
  watchlistName: $('watchlistNameInput'),
  watchlistSlug: $('watchlistSlugInput'),
  watchlistDescription: $('watchlistDescriptionInput'),
  createWatchlistStatus: $('createWatchlistStatus'),
  addWatchlistTickerForm: $('addWatchlistTickerForm'),
  watchlistTicker: $('watchlistTickerInput'),
  watchlistTickerName: $('watchlistTickerNameInput'),
  watchlistTickerExchange: $('watchlistTickerExchangeInput'),
  watchlistTickerCountry: $('watchlistTickerCountryInput'),
  watchlistTickerNotes: $('watchlistTickerNotesInput'),
  addWatchlistTickerStatus: $('addWatchlistTickerStatus'),
  watchlistEntriesBody: $('watchlistEntriesBody'),
  refreshWatchlistEntriesBtn: $('refreshWatchlistEntriesBtn'),
  watchlistSelectionLabel: $('watchlistSelectionLabel'),
  schedulerSection: $('schedulerSection'),
  schedulerEnabled: $('schedulerEnabled'),
  schedulerCadence: $('schedulerCadence'),
  schedulerStage1: $('schedulerStage1Limit'),
  schedulerStage2: $('schedulerStage2Limit'),
  schedulerStage3: $('schedulerStage3Limit'),
  schedulerCycles: $('schedulerCycles'),
  schedulerSaveBtn: $('schedulerSaveBtn'),
  schedulerRefreshBtn: $('schedulerRefreshBtn'),
  schedulerStatus: $('schedulerStatus'),
  schedulerToast: $('schedulerToast'),
  schedulerSummary: $('schedulerSummary'),
  notificationsSection: $('notificationsSection'),
  notificationForm: $('notificationForm'),
  notificationType: $('notificationType'),
  notificationLabel: $('notificationLabel'),
  notificationTarget: $('notificationTarget'),
  notificationMinScore: $('notificationMinScore'),
  notificationConvictionVeryHigh: $('notificationConvictionVeryHigh'),
  notificationConvictionHigh: $('notificationConvictionHigh'),
  notificationConvictionMedium: $('notificationConvictionMedium'),
  notificationWatchlist: $('notificationWatchlistSelect'),
  notificationStatus: $('notificationStatus'),
  notificationSaveBtn: $('notificationSaveBtn'),
  notificationList: $('notificationList'),
  notificationEmpty: $('notificationEmpty'),
  notificationEventsBody: $('notificationEventsBody'),
  notificationEventsEmpty: $('notificationEventsEmpty'),
  refreshNotificationsBtn: $('refreshNotificationsBtn'),
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
  stage2ContextHits: $('stage2ContextHits'),
  stage2ContextTokens: $('stage2ContextTokens'),
  stage2RecentBody: $('stage2RecentBody'),
  stage3Btn: $('processStage3Btn'),
  stage3RefreshBtn: $('refreshStage3Btn'),
  stage3Status: $('stage3Status'),
  stage3Finalists: $('stage3Finalists'),
  stage3Pending: $('stage3Pending'),
  stage3Completed: $('stage3Completed'),
  stage3Spend: $('stage3Spend'),
  stage3Failed: $('stage3Failed'),
  stage3ContextHits: $('stage3ContextHits'),
  stage3ContextTokens: $('stage3ContextTokens'),
  stage3RecentBody: $('stage3RecentBody'),
  focusPanel: $('focusPanel'),
  focusPanelStatus: $('focusPanelStatus'),
  focusRefreshBtn: $('refreshFocusBtn'),
  focusForm: $('focusForm'),
  focusTicker: $('focusTicker'),
  focusTemplates: $('focusTemplates'),
  focusCustomQuestion: $('focusCustomQuestion'),
  focusSubmitBtn: $('focusSubmitBtn'),
  focusStatus: $('focusStatus'),
  focusCount: $('focusCount'),
  focusSummary: $('focusSummary'),
  focusTableBody: $('focusTableBody'),
  followupPanel: $('followupPanel'),
  followupForm: $('followupForm'),
  followupTicker: $('followupTicker'),
  followupQuestion: $('followupQuestion'),
  followupStatus: $('followupStatus'),
  followupPanelStatus: $('followupPanelStatus'),
  followupTableBody: $('followupTableBody'),
  followupCount: $('followupCount'),
  followupRefreshBtn: $('refreshFollowupsBtn'),
  submitFollowupBtn: $('submitFollowupBtn'),
  sectorNotesList: $('sectorNotesList'),
  sectorNotesEmpty: $('sectorNotesEmpty'),
  refreshRegistryBtn: $('refreshRegistryBtn'),
  observabilityPanel: $('observabilityPanel'),
  refreshHealthBtn: $('refreshHealthBtn'),
  refreshErrorsBtn: $('refreshErrorsBtn'),
  healthDatabaseCard: $('healthDatabaseCard'),
  healthDatabaseStatus: $('healthDatabaseStatus'),
  healthDatabaseDetail: $('healthDatabaseDetail'),
  healthOpenAICard: $('healthOpenAICard'),
  healthOpenAIStatus: $('healthOpenAIStatus'),
  healthOpenAIDetail: $('healthOpenAIDetail'),
  healthCheckedAt: $('healthCheckedAt'),
  errorLogStatus: $('errorLogStatus'),
  errorLogBody: $('errorLogBody')
};

const notices = {
  modelFallback: $('modelFallbackNotice'),
  credentialEmpty: $('credentialEmptyNotice')
};

const scopeRadios = Array.from(document.querySelectorAll('input[name="runScope"]'));

const FUNCTIONS_BASE = SUPABASE_URL.replace(/\.supabase\.co$/, '.functions.supabase.co');
const RUNS_CREATE_ENDPOINT = `${FUNCTIONS_BASE}/runs-create`;
const STAGE1_CONSUME_ENDPOINT = `${FUNCTIONS_BASE}/stage1-consume`;
const STAGE2_CONSUME_ENDPOINT = `${FUNCTIONS_BASE}/stage2-consume`;
const STAGE3_CONSUME_ENDPOINT = `${FUNCTIONS_BASE}/stage3-consume`;
const RUNS_STOP_ENDPOINT = `${FUNCTIONS_BASE}/runs-stop`;
const RUNS_CONTINUE_ENDPOINT = `${FUNCTIONS_BASE}/runs-continue`;
const RUNS_SCHEDULE_ENDPOINT = `${FUNCTIONS_BASE}/runs-schedule`;
const RUNS_FEEDBACK_ENDPOINT = `${FUNCTIONS_BASE}/runs-feedback`;
const RUNS_FOCUS_ENDPOINT = `${FUNCTIONS_BASE}/runs-focus`;
const HEALTH_ENDPOINT = `${FUNCTIONS_BASE}/health`;
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
let followupRefreshTimer = null;
let focusRefreshTimer = null;

const followupStatusLabels = {
  pending: 'Pending review',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed'
};

const focusStatusLabels = {
  pending: 'Pending',
  queued: 'Queued',
  in_progress: 'In progress',
  answered: 'Answered',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

let followupLoading = false;
let followupTickers = [];
let focusTemplates = [];
let focusRequests = [];
let focusLoading = false;
let sectorNotesChannel = null;
let sectorNotesReady = false;
let modelOptions = [];
let modelMap = new Map();

function buildFunctionHeaders({ json = true } = {}) {
  const headers = {
    apikey: SUPABASE_ANON_KEY
  };
  if (authContext.token) {
    headers.Authorization = `Bearer ${authContext.token}`;
  }
  if (json) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}
let priceMap = new Map();
let credentialOptions = [];
let credentialMap = new Map();
let modelFallbackActive = false;
const STAGE_LABELS = {
  1: 'Stage 1 · Triage',
  2: 'Stage 2 · Scoring',
  3: 'Stage 3 · Deep dive'
};
const AUTO_CONTINUE_LIMITS = { stage1: 8, stage2: 4, stage3: 2 };
const AUTO_CONTINUE_DEFAULT_SECONDS = 30;
const SCHEDULER_DEFAULTS = {
  cadenceSeconds: 3600,
  stage1Limit: 1,
  stage2Limit: 1,
  stage3Limit: 1,
  maxCycles: 1
};
let autoContinueTimer = null;
let autoContinueActive = false;
let autoContinueInFlight = false;
let schedulerLoading = false;
let schedulerDirty = false;
let currentSchedule = null;
const scheduleCache = new Map();
let schedulerToastTimer = null;
let healthLoading = false;
let errorLogLoading = false;
let errorLogRows = [];
let watchlists = [];
let watchlistMap = new Map();
let watchlistEntriesCache = new Map();
let watchlistLoading = false;
let watchlistEntriesLoading = false;
let notificationChannels = [];
let notificationEvents = [];
let notificationsLoading = false;
let notificationEventsLoading = false;
let notificationSubmitting = false;
let plannerScope = { ...defaults.scope };

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return { ...defaults };
    const savedScope = saved.scope && typeof saved.scope === 'object' ? saved.scope : {};
    const scope = {
      ...defaults.scope,
      ...savedScope,
      watchlistCount: typeof savedScope.watchlistCount === 'number' ? savedScope.watchlistCount : null,
      customTickers: Array.isArray(savedScope.customTickers)
        ? savedScope.customTickers.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
        : []
    };
    return {
      universe: Number(saved.universe) || defaults.universe,
      surviveStage2: Number(saved.surviveStage2) || defaults.surviveStage2,
      surviveStage3: Number(saved.surviveStage3) || defaults.surviveStage3,
      stage1: { ...defaults.stage1, ...saved.stage1 },
      stage2: { ...defaults.stage2, ...saved.stage2 },
      stage3: { ...defaults.stage3, ...saved.stage3 },
      budgetUsd: Number(saved.budgetUsd ?? saved.budget_usd) || defaults.budgetUsd,
      scope
    };
  } catch (error) {
    console.warn('Unable to parse saved planner settings', error);
    return { ...defaults };
  }
}

function normalizeTickerInput(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) return null;
  if (!/^[A-Z0-9\-\.]+$/.test(trimmed)) return null;
  return trimmed;
}

function parseCustomTickerInput(value) {
  if (!value) return [];
  return Array.from(
    new Set(
      String(value)
        .split(/[\s,\n]+/)
        .map((entry) => normalizeTickerInput(entry))
        .filter((ticker) => Boolean(ticker))
    )
  );
}

function getSelectedScopeMode() {
  const active = scopeRadios.find((radio) => radio.checked);
  if (active && typeof active.value === 'string') {
    return active.value;
  }
  return plannerScope.mode ?? defaults.scope.mode;
}

function getWatchlistById(id) {
  if (!id) return null;
  return watchlistMap.get(id) ?? null;
}

function collectScopeSettings() {
  const mode = getSelectedScopeMode();
  if (mode === 'watchlist') {
    const watchlistId = inputs.watchlistSelect?.value ? String(inputs.watchlistSelect.value) : null;
    const watchlist = getWatchlistById(watchlistId);
    return {
      mode: 'watchlist',
      watchlistId,
      watchlistSlug: watchlist?.slug ?? null,
      watchlistCount: watchlist?.tickerCount ?? null,
      customTickers: []
    };
  }

  if (mode === 'custom') {
    const tickers = parseCustomTickerInput(inputs.customTickers?.value ?? '');
    return {
      mode: 'custom',
      watchlistId: null,
      watchlistSlug: null,
      watchlistCount: tickers.length,
      customTickers: tickers
    };
  }

  return {
    mode: 'universe',
    watchlistId: null,
    watchlistSlug: null,
    watchlistCount: null,
    customTickers: []
  };
}

function updateScopeStatusMessage(mode, watchlist = null, customTickers = []) {
  if (!inputs.scopeStatus) return;
  if (mode === 'watchlist') {
    if (watchlist) {
      const count = watchlist.tickerCount ?? 0;
      inputs.scopeStatus.textContent = `${count.toLocaleString()} tickers in “${watchlist.name ?? watchlist.slug ?? watchlist.id}”.`;
    } else {
      inputs.scopeStatus.textContent = 'Select a watchlist to populate the run queue.';
    }
    return;
  }

  if (mode === 'custom') {
    if (customTickers.length > 0) {
      inputs.scopeStatus.textContent = `${customTickers.length.toLocaleString()} custom tickers ready (${customTickers.slice(0, 6).join(', ')}${customTickers.length > 6 ? '…' : ''}).`;
    } else {
      inputs.scopeStatus.textContent = 'Add at least one ticker symbol to launch a custom run.';
    }
    return;
  }

  const universeValue = Number(inputs.universe?.value || 0);
  inputs.scopeStatus.textContent = `Processing top ${universeValue.toLocaleString()} tickers from the universe table.`;
}

function renderWatchlistOptions() {
  if (!inputs.watchlistSelect) return;
  const select = inputs.watchlistSelect;
  const previous = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = watchlists.length ? 'Select watchlist…' : 'No watchlists available';
  select.appendChild(placeholder);

  watchlists.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    const count = item.tickerCount ?? 0;
    option.textContent = `${item.name ?? item.slug ?? item.id} (${count})`;
    select.appendChild(option);
  });

  if (plannerScope.watchlistId && watchlistMap.has(plannerScope.watchlistId)) {
    select.value = plannerScope.watchlistId;
  } else if (previous && watchlistMap.has(previous)) {
    select.value = previous;
    plannerScope.watchlistId = previous;
  } else {
    select.value = '';
  }
}

function renderNotificationWatchlistOptions() {
  if (!inputs.notificationWatchlist) return;
  const select = inputs.notificationWatchlist;
  const previous = select.value;
  select.innerHTML = '';
  const baseOption = document.createElement('option');
  baseOption.value = '';
  baseOption.textContent = 'All watchlists';
  select.appendChild(baseOption);

  watchlists.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    const count = item.tickerCount ?? 0;
    option.textContent = `${item.name ?? item.slug ?? item.id} (${count})`;
    select.appendChild(option);
  });

  if (previous && watchlistMap.has(previous)) {
    select.value = previous;
  } else {
    select.value = '';
  }
}

function updateScopeUI({ fromSettings = false } = {}) {
  const mode = plannerScope.mode;
  const watchlist = plannerScope.watchlistId ? getWatchlistById(plannerScope.watchlistId) : null;

  if (inputs.watchlistSelect) {
    inputs.watchlistSelect.disabled = mode !== 'watchlist' || watchlistLoading;
  }
  if (inputs.refreshWatchlistsBtn) {
    inputs.refreshWatchlistsBtn.disabled = watchlistLoading;
  }
  if (inputs.customTickers) {
    const isCustom = mode === 'custom';
    if (isCustom) {
      inputs.customTickers.disabled = false;
      inputs.customTickers.removeAttribute('disabled');
      inputs.customTickers.removeAttribute('aria-disabled');
      if (!fromSettings) {
        try {
          inputs.customTickers.focus({ preventScroll: true });
        } catch (error) {
          inputs.customTickers.focus();
        }
      }
    } else {
      inputs.customTickers.disabled = true;
      inputs.customTickers.setAttribute('disabled', '');
      inputs.customTickers.setAttribute('aria-disabled', 'true');
    }
  }

  if (inputs.universe) {
    if (mode === 'watchlist') {
      const fallbackUniverse = Number(inputs.universe.value) || 0;
      const count = watchlist?.tickerCount ?? plannerScope.watchlistCount ?? fallbackUniverse;
      inputs.universe.value = count;
      inputs.universe.disabled = true;
    } else if (mode === 'custom') {
      inputs.universe.value = plannerScope.customTickers.length;
      inputs.universe.disabled = true;
    } else {
      inputs.universe.disabled = false;
    }
  }

  if (inputs.watchlistSummary) {
    if (mode === 'watchlist') {
      if (watchlist) {
        const count = watchlist.tickerCount ?? 0;
        const visibility = watchlist.isPublic ? 'Public' : 'Private';
        const description = watchlist.description ? ` — ${watchlist.description}` : '';
        inputs.watchlistSummary.textContent = `${count.toLocaleString()} tickers • ${visibility}${description}`;
      } else if (watchlists.length) {
        inputs.watchlistSummary.textContent = 'Choose a watchlist to inspect its membership.';
      } else {
        inputs.watchlistSummary.textContent = 'Create your first watchlist to scope targeted runs.';
      }
    } else {
      inputs.watchlistSummary.textContent = 'Watchlist selection inactive for this scope.';
    }
  }

  updateScopeStatusMessage(mode, watchlist, plannerScope.customTickers);

  if (!fromSettings && mode === 'watchlist' && plannerScope.watchlistId) {
    if (!watchlistEntriesCache.has(plannerScope.watchlistId)) {
      loadWatchlistEntries(plannerScope.watchlistId, { silent: true }).catch((error) => {
        console.warn('Failed to preload watchlist entries', error);
      });
    } else {
      renderWatchlistEntries(plannerScope.watchlistId, watchlistEntriesCache.get(plannerScope.watchlistId) ?? []);
    }
  }
}

function applyScopeSettings(scope, options = {}) {
  plannerScope = { ...defaults.scope, ...scope };
  scopeRadios.forEach((radio) => {
    radio.checked = radio.value === plannerScope.mode;
  });

  if (plannerScope.mode === 'watchlist' && plannerScope.watchlistSlug && !plannerScope.watchlistId) {
    const match = watchlists.find((item) => item.slug === plannerScope.watchlistSlug);
    if (match) {
      plannerScope.watchlistId = match.id;
      plannerScope.watchlistCount = match.tickerCount ?? plannerScope.watchlistCount ?? null;
    }
  }

  if (inputs.watchlistSelect) {
    if (plannerScope.watchlistId && watchlistMap.has(plannerScope.watchlistId)) {
      inputs.watchlistSelect.value = plannerScope.watchlistId;
    } else {
      inputs.watchlistSelect.value = '';
    }
  }

  if (inputs.customTickers) {
    inputs.customTickers.value = plannerScope.mode === 'custom' && plannerScope.customTickers.length
      ? plannerScope.customTickers.join(', ')
      : '';
  }

  updateScopeUI({ fromSettings: Boolean(options.fromSettings) });
}

async function loadWatchlists({ silent = false } = {}) {
  if (!authContext.isAdmin) {
    watchlists = [];
    watchlistMap.clear();
    renderWatchlistOptions();
    renderNotificationWatchlistOptions();
    updateScopeUI();
    return;
  }

  if (watchlistLoading) return;
  watchlistLoading = true;
  if (!silent && inputs.watchlistSummary) {
    inputs.watchlistSummary.textContent = 'Loading watchlists…';
  }

  try {
    const { data, error } = await supabase
      .from('watchlists')
      .select('id, slug, name, description, is_system, is_public, watchlist_entries(count)')
      .order('is_system', { ascending: false })
      .order('name', { ascending: true });

    if (error) throw error;

    watchlists = (data ?? []).map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      isSystem: Boolean(row.is_system),
      isPublic: Boolean(row.is_public),
      tickerCount: Array.isArray(row.watchlist_entries) && row.watchlist_entries.length
        ? Number(row.watchlist_entries[0]?.count ?? 0)
        : 0
    }));
    watchlistMap = new Map(watchlists.map((item) => [item.id, item]));

    renderWatchlistOptions();
    renderNotificationWatchlistOptions();

    if (plannerScope.mode === 'watchlist') {
      if (plannerScope.watchlistId && !watchlistMap.has(plannerScope.watchlistId)) {
        const fallback = watchlists[0] ?? null;
        if (fallback) {
          plannerScope.watchlistId = fallback.id;
          plannerScope.watchlistSlug = fallback.slug ?? null;
          plannerScope.watchlistCount = fallback.tickerCount ?? null;
          inputs.watchlistSelect.value = fallback.id;
        } else {
          plannerScope.watchlistId = null;
          plannerScope.watchlistSlug = null;
          plannerScope.watchlistCount = null;
          if (inputs.watchlistSelect) inputs.watchlistSelect.value = '';
        }
      } else if (plannerScope.watchlistId) {
        plannerScope.watchlistCount = watchlistMap.get(plannerScope.watchlistId)?.tickerCount ?? plannerScope.watchlistCount ?? null;
      }
    }

    updateScopeUI({ fromSettings: true });

    if (plannerScope.mode === 'watchlist' && plannerScope.watchlistId) {
      loadWatchlistEntries(plannerScope.watchlistId, { silent: true }).catch((error) => {
        console.warn('Failed to load watchlist entries after refresh', error);
      });
    }
  } catch (error) {
    console.error('Failed to load watchlists', error);
    if (!silent && inputs.watchlistSummary) {
      inputs.watchlistSummary.textContent = `Failed to load watchlists: ${error.message}`;
    }
  } finally {
    watchlistLoading = false;
    updateScopeUI({ fromSettings: true });
  }
}

function renderWatchlistEntries(watchlistId, entries) {
  if (!inputs.watchlistEntriesBody) return;
  const body = inputs.watchlistEntriesBody;
  body.innerHTML = '';

  if (!entries || entries.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'muted';
    cell.textContent = 'No tickers in this watchlist yet.';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('tr');

    const tickerCell = document.createElement('td');
    tickerCell.textContent = entry.ticker;
    row.appendChild(tickerCell);

    const nameCell = document.createElement('td');
    nameCell.textContent = entry.name || '—';
    row.appendChild(nameCell);

    const exchangeCell = document.createElement('td');
    const exchangeParts = [entry.exchange, entry.country].filter(Boolean);
    exchangeCell.textContent = exchangeParts.length ? exchangeParts.join(' • ') : '—';
    row.appendChild(exchangeCell);

    const lastSeenCell = document.createElement('td');
    lastSeenCell.textContent = entry.last_seen_at ? formatRelativeTimestamp(entry.last_seen_at) : '—';
    row.appendChild(lastSeenCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'watchlist-entry__actions';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'watchlist-remove';
    removeBtn.dataset.action = 'remove-watchlist-ticker';
    removeBtn.dataset.ticker = entry.ticker;
    removeBtn.textContent = 'Remove';
    actionsCell.appendChild(removeBtn);
    row.appendChild(actionsCell);

    body.appendChild(row);
  });
}

async function loadWatchlistEntries(watchlistId, { force = false, silent = false } = {}) {
  if (!watchlistId) return;
  if (watchlistEntriesLoading && !force) return;
  watchlistEntriesLoading = true;

  if (!silent && inputs.watchlistEntriesBody) {
    inputs.watchlistEntriesBody.innerHTML = '<tr><td colspan="5" class="muted">Loading watchlist members…</td></tr>';
  }

  try {
    const { data, error } = await supabase
      .from('watchlist_entries')
      .select('ticker, notes, added_at, tickers (name, exchange, country, status, last_seen_at)')
      .eq('watchlist_id', watchlistId)
      .is('removed_at', null)
      .order('rank', { ascending: true, nullsLast: true })
      .order('ticker', { ascending: true });

    if (error) throw error;

    const entries = (data ?? []).map((row) => ({
      ticker: row.ticker,
      notes: row.notes ?? null,
      added_at: row.added_at ?? null,
      name: row.tickers?.name ?? null,
      exchange: row.tickers?.exchange ?? null,
      country: row.tickers?.country ?? null,
      status: row.tickers?.status ?? null,
      last_seen_at: row.tickers?.last_seen_at ?? null
    }));

    watchlistEntriesCache.set(watchlistId, entries);
    renderWatchlistEntries(watchlistId, entries);
  } catch (error) {
    console.error('Failed to load watchlist entries', error);
    if (!silent && inputs.watchlistEntriesBody) {
      inputs.watchlistEntriesBody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load watchlist entries: ${error.message}</td></tr>`;
    }
  } finally {
    watchlistEntriesLoading = false;
  }
}

function setNotificationStatus(message = '', tone = 'muted') {
  if (!inputs.notificationStatus) return;
  inputs.notificationStatus.textContent = message;
  if (tone === 'error') {
    inputs.notificationStatus.style.color = '#b91c1c';
  } else if (tone === 'success') {
    inputs.notificationStatus.style.color = '#047857';
  } else {
    inputs.notificationStatus.style.color = 'var(--muted,#475569)';
  }
}

function getSelectedConvictionLevels() {
  const selections = [];
  if (inputs.notificationConvictionVeryHigh?.checked) selections.push('very_high');
  if (inputs.notificationConvictionHigh?.checked) selections.push('high');
  if (inputs.notificationConvictionMedium?.checked) selections.push('medium');
  return selections;
}

function normalizeConvictionLabel(value) {
  if (!value) return 'Unknown';
  const normalized = value.toString().toLowerCase();
  if (normalized === 'very_high') return 'Very high';
  if (normalized === 'high') return 'High';
  if (normalized === 'medium') return 'Medium';
  if (normalized === 'low') return 'Low';
  return value.toString();
}

function formatChannelFilters(channel) {
  const parts = [];
  if (channel.minScore != null) {
    parts.push(`Score ≥ ${Math.round(channel.minScore)}`);
  }
  if (channel.convictionLevels?.length) {
    const labels = channel.convictionLevels.map((level) => normalizeConvictionLabel(level));
    parts.push(`Conviction: ${labels.join(', ')}`);
  } else {
    parts.push('Conviction: all');
  }
  if (channel.watchlistIds?.length) {
    const names = channel.watchlistIds
      .map((id) => watchlistMap.get(id)?.name ?? watchlistMap.get(id)?.slug ?? id)
      .filter(Boolean);
    parts.push(`Watchlists: ${names.join(', ')}`);
  } else {
    parts.push('Watchlists: all');
  }
  return parts.join(' · ');
}

function renderNotificationChannels() {
  if (!inputs.notificationList) return;
  const body = inputs.notificationList;
  body.innerHTML = '';

  if (!notificationChannels.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'notification-empty';
    cell.textContent = 'No notification channels configured yet.';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  notificationChannels.forEach((channel) => {
    const row = document.createElement('tr');

    const nameCell = document.createElement('td');
    const label = document.createElement('div');
    label.textContent = channel.label || 'Untitled channel';
    label.style.fontWeight = '600';
    const type = document.createElement('div');
    type.className = 'muted';
    type.textContent = channel.type === 'email' ? 'Email' : 'Slack webhook';
    nameCell.append(label, type);
    row.appendChild(nameCell);

    const targetCell = document.createElement('td');
    targetCell.textContent = channel.target;
    row.appendChild(targetCell);

    const filterCell = document.createElement('td');
    filterCell.textContent = formatChannelFilters(channel);
    row.appendChild(filterCell);

    const statusCell = document.createElement('td');
    statusCell.textContent = channel.isActive ? 'Active' : 'Paused';
    if (!channel.isActive) {
      statusCell.className = 'muted';
    }
    row.appendChild(statusCell);

    const actionsCell = document.createElement('td');
    actionsCell.className = 'notification-actions';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'notification-action';
    toggleBtn.dataset.notifyAction = 'toggle';
    toggleBtn.dataset.notifyId = channel.id;
    toggleBtn.dataset.notifyNext = channel.isActive ? 'pause' : 'activate';
    toggleBtn.textContent = channel.isActive ? 'Pause' : 'Activate';
    actionsCell.appendChild(toggleBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'notification-action danger';
    deleteBtn.dataset.notifyAction = 'delete';
    deleteBtn.dataset.notifyId = channel.id;
    deleteBtn.textContent = 'Delete';
    actionsCell.appendChild(deleteBtn);

    row.appendChild(actionsCell);
    body.appendChild(row);
  });
}

function renderNotificationEvents() {
  if (!inputs.notificationEventsBody) return;
  const body = inputs.notificationEventsBody;
  body.innerHTML = '';

  if (!notificationEvents.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'notification-empty';
    cell.textContent = 'Alerts will appear after the next deep dive.';
    row.appendChild(cell);
    body.appendChild(row);
    return;
  }

  notificationEvents.forEach((event) => {
    const row = document.createElement('tr');

    const timeCell = document.createElement('td');
    timeCell.className = 'notification-datetime';
    const timestamp = event.dispatchedAt || event.createdAt;
    timeCell.textContent = formatRelativeTimestamp(timestamp);
    row.appendChild(timeCell);

    const tickerCell = document.createElement('td');
    if (event.ticker) {
      const link = document.createElement('a');
      const params = new URLSearchParams({ ticker: event.ticker });
      if (event.runId) params.set('run', event.runId);
      link.href = `/ticker.html?${params.toString()}`;
      link.textContent = event.ticker;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      tickerCell.appendChild(link);
    } else {
      tickerCell.textContent = '—';
    }
    row.appendChild(tickerCell);

    const channelCell = document.createElement('td');
    const channelLabel = event.channelLabel || (event.channelType === 'email' ? 'Email channel' : 'Slack webhook');
    channelCell.textContent = channelLabel;
    row.appendChild(channelCell);

    const convictionCell = document.createElement('td');
    convictionCell.className = 'notification-conviction';
    convictionCell.textContent = event.conviction ? normalizeConvictionLabel(event.conviction) : '—';
    row.appendChild(convictionCell);

    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'notification-status-badge';
    const state = event.status || 'pending';
    badge.dataset.state = state;
    badge.textContent = state === 'sent' ? 'Delivered' : state === 'failed' ? 'Failed' : 'Pending';
    statusCell.appendChild(badge);
    row.appendChild(statusCell);

    body.appendChild(row);
  });
}

async function loadNotificationChannels({ silent = false } = {}) {
  if (!authContext.isAdmin) {
    notificationChannels = [];
    renderNotificationChannels();
    return;
  }
  if (notificationsLoading) return;
  notificationsLoading = true;
  if (!silent) {
    setNotificationStatus('Loading notification channels…');
  }
  try {
    const { data, error } = await supabase
      .from('notification_channels')
      .select('id, label, type, target, is_active, min_score, conviction_levels, watchlist_ids, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    notificationChannels = (data ?? []).map((row) => ({
      id: row.id,
      label: row.label ?? 'Notification channel',
      type: row.type === 'slack_webhook' ? 'slack_webhook' : 'email',
      target: row.target ?? '',
      isActive: row.is_active !== false,
      minScore: row.min_score != null ? Number(row.min_score) : null,
      convictionLevels: Array.isArray(row.conviction_levels) ? row.conviction_levels : [],
      watchlistIds: Array.isArray(row.watchlist_ids) ? row.watchlist_ids : [],
      createdAt: row.created_at ?? null
    }));
    renderNotificationChannels();
    if (!silent) {
      setNotificationStatus(notificationChannels.length ? '' : 'Add a channel to start receiving alerts.');
    }
  } catch (error) {
    console.error('Failed to load notification channels', error);
    setNotificationStatus(`Failed to load channels: ${error.message}`, 'error');
  } finally {
    notificationsLoading = false;
  }
}

async function loadNotificationEvents({ silent = false } = {}) {
  if (!authContext.isAdmin) {
    notificationEvents = [];
    renderNotificationEvents();
    return;
  }
  if (notificationEventsLoading) return;
  notificationEventsLoading = true;
  try {
    let query = supabase
      .from('notification_event_summaries')
      .select('id, run_id, ticker, conviction, verdict, ensemble_score, status, created_at, dispatched_at, channel_label, channel_type, channel_target')
      .order('created_at', { ascending: false })
      .limit(activeRunId ? 30 : 20);
    if (activeRunId) {
      query = query.eq('run_id', activeRunId);
    }
    const { data, error } = await query;
    if (error) throw error;
    notificationEvents = (data ?? []).map((row) => ({
      id: row.id,
      runId: row.run_id ?? null,
      ticker: row.ticker ?? null,
      conviction: row.conviction ?? null,
      verdict: row.verdict ?? null,
      ensembleScore: row.ensemble_score != null ? Number(row.ensemble_score) : null,
      status: (row.status ?? 'pending').toLowerCase(),
      createdAt: row.created_at ?? null,
      dispatchedAt: row.dispatched_at ?? null,
      channelLabel: row.channel_label ?? null,
      channelType: row.channel_type ?? null,
      channelTarget: row.channel_target ?? null
    }));
    renderNotificationEvents();
  } catch (error) {
    console.warn('Failed to load notification events', error);
    if (!silent) {
      setNotificationStatus(`Failed to load recent alerts: ${error.message}`, 'error');
    }
  } finally {
    notificationEventsLoading = false;
  }
}

async function refreshNotificationData({ silent = false } = {}) {
  await Promise.all([
    loadNotificationChannels({ silent }),
    loadNotificationEvents({ silent: true })
  ]);
}

async function submitNotificationChannel(event) {
  event.preventDefault();
  if (!authContext.isAdmin) {
    setNotificationStatus('Admin session required to configure alerts.', 'error');
    return;
  }
  if (notificationSubmitting) return;

  const type = inputs.notificationType?.value === 'slack_webhook' ? 'slack_webhook' : 'email';
  const label = (inputs.notificationLabel?.value || '').trim();
  const target = (inputs.notificationTarget?.value || '').trim();
  const minScoreRaw = inputs.notificationMinScore?.value;
  const convictionLevels = getSelectedConvictionLevels();
  const watchlistId = inputs.notificationWatchlist?.value || '';

  if (!label) {
    setNotificationStatus('Add a descriptive label for this channel.', 'error');
    inputs.notificationLabel?.focus();
    return;
  }

  if (!target) {
    setNotificationStatus('Provide an email address or webhook URL.', 'error');
    inputs.notificationTarget?.focus();
    return;
  }

  if (type === 'email' && !/.+@.+\..+/.test(target)) {
    setNotificationStatus('Enter a valid email address.', 'error');
    inputs.notificationTarget?.focus();
    return;
  }

  if (type === 'slack_webhook' && !/^https:\/\//i.test(target)) {
    setNotificationStatus('Slack webhooks must begin with https://', 'error');
    inputs.notificationTarget?.focus();
    return;
  }

  const minScore = Number(minScoreRaw);
  const payload = {
    type,
    label,
    target,
    is_active: true,
    min_score: Number.isFinite(minScore) && minScore >= 0 && minScore <= 100 ? minScore : null,
    conviction_levels: convictionLevels,
    watchlist_ids: watchlistId ? [watchlistId] : [],
    metadata: { source: 'planner' }
  };

  notificationSubmitting = true;
  if (inputs.notificationSaveBtn) inputs.notificationSaveBtn.disabled = true;
  setNotificationStatus('Saving channel…');

  try {
    const { error } = await supabase.from('notification_channels').insert(payload);
    if (error) throw error;
    setNotificationStatus('Channel saved.', 'success');
    inputs.notificationLabel && (inputs.notificationLabel.value = '');
    inputs.notificationTarget && (inputs.notificationTarget.value = '');
    inputs.notificationMinScore && (inputs.notificationMinScore.value = '');
    if (inputs.notificationConvictionVeryHigh) inputs.notificationConvictionVeryHigh.checked = true;
    if (inputs.notificationConvictionHigh) inputs.notificationConvictionHigh.checked = true;
    if (inputs.notificationConvictionMedium) inputs.notificationConvictionMedium.checked = false;
    if (inputs.notificationWatchlist) inputs.notificationWatchlist.value = '';
    await loadNotificationChannels({ silent: true });
  } catch (error) {
    console.error('Failed to create notification channel', error);
    setNotificationStatus(`Failed to save channel: ${error.message}`, 'error');
  } finally {
    notificationSubmitting = false;
    if (inputs.notificationSaveBtn) inputs.notificationSaveBtn.disabled = false;
  }
}

async function toggleNotificationChannel(channelId, nextState) {
  if (!authContext.isAdmin || !channelId) return;
  try {
    const channel = notificationChannels.find((entry) => entry.id === channelId);
    const desired = typeof nextState === 'boolean' ? nextState : !(channel?.isActive ?? true);
    const { error } = await supabase
      .from('notification_channels')
      .update({ is_active: desired })
      .eq('id', channelId);
    if (error) throw error;
    await loadNotificationChannels({ silent: true });
    setNotificationStatus(desired ? 'Channel activated.' : 'Channel paused.', 'success');
  } catch (error) {
    console.error('Failed to toggle notification channel', error);
    setNotificationStatus(`Failed to update channel: ${error.message}`, 'error');
  }
}

async function deleteNotificationChannel(channelId) {
  if (!authContext.isAdmin || !channelId) return;
  const channel = notificationChannels.find((entry) => entry.id === channelId);
  const label = channel?.label ?? 'this channel';
  if (!window.confirm(`Remove ${label}? Alerts will no longer be delivered.`)) {
    return;
  }
  try {
    const { error } = await supabase.from('notification_channels').delete().eq('id', channelId);
    if (error) throw error;
    await loadNotificationChannels({ silent: true });
    setNotificationStatus('Channel deleted.', 'success');
  } catch (error) {
    console.error('Failed to delete notification channel', error);
    setNotificationStatus(`Failed to delete channel: ${error.message}`, 'error');
  }
}

function handleNotificationAction(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const actionButton = target.closest('[data-notify-action]');
  if (!(actionButton instanceof HTMLElement)) return;
  const id = actionButton.dataset.notifyId;
  if (!id) return;
  const action = actionButton.dataset.notifyAction;
  if (action === 'toggle') {
    const next = actionButton.dataset.notifyNext === 'activate';
    toggleNotificationChannel(id, next);
  } else if (action === 'delete') {
    deleteNotificationChannel(id);
  }
}

function handleWatchlistSelect() {
  const settings = getSettingsFromInputs();
  persistSettings(settings);
  plannerScope = { ...defaults.scope, ...settings.scope };
  updateScopeUI();
  if (plannerScope.mode === 'watchlist' && plannerScope.watchlistId) {
    loadWatchlistEntries(plannerScope.watchlistId, { silent: false }).catch((error) => {
      console.warn('Watchlist entry refresh failed', error);
    });
  }
  updateCostOutput();
}

function handleScopeChange() {
  const mode = getSelectedScopeMode();
  plannerScope.mode = mode;
  if (mode === 'watchlist' && !plannerScope.watchlistId && watchlists.length) {
    const first = watchlists[0];
    plannerScope.watchlistId = first.id;
    plannerScope.watchlistSlug = first.slug ?? null;
    plannerScope.watchlistCount = first.tickerCount ?? null;
  }
  if (mode !== 'custom') {
    plannerScope.customTickers = [];
  } else {
    plannerScope.customTickers = parseCustomTickerInput(inputs.customTickers?.value ?? '');
  }
  applyScopeSettings(plannerScope);
  persistSettings(getSettingsFromInputs());
  updateCostOutput();
}

function handleCustomTickerInput() {
  if (plannerScope.mode !== 'custom') return;
  plannerScope.customTickers = parseCustomTickerInput(inputs.customTickers?.value ?? '');
  persistSettings(getSettingsFromInputs());
  updateScopeUI();
  updateCostOutput();
}

async function handleCreateWatchlist(event) {
  event.preventDefault();
  if (!authContext.isAdmin || !authContext.user) {
    if (inputs.createWatchlistStatus) inputs.createWatchlistStatus.textContent = 'Admin session required.';
    return;
  }

  const name = inputs.watchlistName?.value.trim();
  const slug = inputs.watchlistSlug?.value.trim().toLowerCase();
  const description = inputs.watchlistDescription?.value.trim() || null;

  if (!name || !slug) {
    if (inputs.createWatchlistStatus) inputs.createWatchlistStatus.textContent = 'Name and slug are required.';
    return;
  }

  try {
    if (inputs.createWatchlistStatus) inputs.createWatchlistStatus.textContent = 'Creating watchlist…';
    const { error, data } = await supabase
      .from('watchlists')
      .insert({
        name,
        slug,
        description,
        created_by: authContext.user.id,
        created_by_email: authContext.user.email ?? null
      })
      .select('id, slug, name')
      .single();

    if (error) throw error;

    inputs.watchlistName.value = '';
    inputs.watchlistSlug.value = '';
    if (inputs.watchlistDescription) inputs.watchlistDescription.value = '';

    await loadWatchlists({ silent: true });
    if (data?.id) {
      plannerScope.watchlistId = data.id;
      plannerScope.watchlistSlug = data.slug ?? slug;
      plannerScope.mode = 'watchlist';
      applyScopeSettings(plannerScope);
      persistSettings(getSettingsFromInputs());
      loadWatchlistEntries(plannerScope.watchlistId, { silent: false }).catch((error) => {
        console.warn('Failed to load entries for new watchlist', error);
      });
    }
    if (inputs.createWatchlistStatus) inputs.createWatchlistStatus.textContent = 'Watchlist created.';
  } catch (error) {
    console.error('Failed to create watchlist', error);
    if (inputs.createWatchlistStatus) inputs.createWatchlistStatus.textContent = `Error: ${error.message}`;
  }
}

async function handleAddWatchlistTicker(event) {
  event.preventDefault();
  if (!authContext.isAdmin || !authContext.user) {
    if (inputs.addWatchlistTickerStatus) inputs.addWatchlistTickerStatus.textContent = 'Admin session required.';
    return;
  }
  const watchlistId = plannerScope.watchlistId;
  if (!watchlistId) {
    if (inputs.addWatchlistTickerStatus) inputs.addWatchlistTickerStatus.textContent = 'Select a watchlist first.';
    return;
  }

  const ticker = normalizeTickerInput(inputs.watchlistTicker?.value ?? '');
  if (!ticker) {
    if (inputs.addWatchlistTickerStatus) inputs.addWatchlistTickerStatus.textContent = 'Enter a valid ticker symbol.';
    return;
  }

  const name = inputs.watchlistTickerName?.value.trim() || null;
  const exchange = inputs.watchlistTickerExchange?.value.trim().toUpperCase() || null;
  const country = inputs.watchlistTickerCountry?.value.trim().toUpperCase() || null;
  const notes = inputs.watchlistTickerNotes?.value.trim() || null;

  try {
    if (inputs.addWatchlistTickerStatus) inputs.addWatchlistTickerStatus.textContent = 'Saving ticker…';

    const { error: tickerError } = await supabase
      .from('tickers')
      .upsert({
        ticker,
        name,
        exchange,
        country,
        status: 'active',
        source: 'planner:watchlist'
      }, { onConflict: 'ticker' });

    if (tickerError) throw tickerError;

    const { error: entryError } = await supabase
      .from('watchlist_entries')
      .upsert({
        watchlist_id: watchlistId,
        ticker,
        notes,
        removed_at: null
      });

    if (entryError) throw entryError;

    inputs.watchlistTicker.value = '';
    if (inputs.watchlistTickerName) inputs.watchlistTickerName.value = '';
    if (inputs.watchlistTickerExchange) inputs.watchlistTickerExchange.value = '';
    if (inputs.watchlistTickerCountry) inputs.watchlistTickerCountry.value = '';
    if (inputs.watchlistTickerNotes) inputs.watchlistTickerNotes.value = '';

    watchlistEntriesCache.delete(watchlistId);
    await loadWatchlistEntries(watchlistId, { force: true, silent: false });
    await loadWatchlists({ silent: true });

    if (inputs.addWatchlistTickerStatus) inputs.addWatchlistTickerStatus.textContent = 'Ticker added to watchlist.';
  } catch (error) {
    console.error('Failed to add ticker to watchlist', error);
    if (inputs.addWatchlistTickerStatus) inputs.addWatchlistTickerStatus.textContent = `Error: ${error.message}`;
  }
}

async function removeWatchlistTicker(watchlistId, ticker) {
  try {
    const { error } = await supabase
      .from('watchlist_entries')
      .update({ removed_at: new Date().toISOString() })
      .eq('watchlist_id', watchlistId)
      .eq('ticker', ticker);

    if (error) throw error;

    watchlistEntriesCache.delete(watchlistId);
    await loadWatchlistEntries(watchlistId, { force: true, silent: true });
    await loadWatchlists({ silent: true });
  } catch (error) {
    console.error('Failed to remove watchlist ticker', error);
    if (inputs.scopeStatus) {
      inputs.scopeStatus.textContent = `Failed to remove ${ticker}: ${error.message}`;
    }
  }
}

function handleWatchlistEntryClick(event) {
  const target = event.target;
  if (!target) return;
  const button = target.closest('[data-action="remove-watchlist-ticker"]');
  if (!button) return;
  const ticker = button.dataset.ticker;
  if (!ticker || !plannerScope.watchlistId) return;
  removeWatchlistTicker(plannerScope.watchlistId, ticker);
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
  const lockedTitleEl = lockedEl?.querySelector('[data-locked-title]');
  const lockedMessageEl = lockedEl?.querySelector('[data-locked-message]');
  const lockedLoginEl = lockedEl?.querySelector('[data-locked-login]');
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

  const applyLockedContent = (reason) => {
    if (!lockedEl) return;
    const copy = {
      'signed-out': {
        title: 'Sign in required',
        message: 'Sign in with an administrator account to manage API credentials.',
        showLogin: true
      },
      'no-admin': {
        title: 'Admin access required',
        message: 'This account does not have admin permissions. Contact an administrator to manage credentials.',
        showLogin: false
      }
    }[reason] || {
      title: 'Admin access required',
      message: 'Sign in with an administrator account to manage API credentials.',
      showLogin: true
    };

    if (lockedTitleEl) lockedTitleEl.textContent = copy.title;
    if (lockedMessageEl) lockedMessageEl.textContent = copy.message;
    if (lockedLoginEl) {
      lockedLoginEl.hidden = !copy.showLogin;
    }
  };

  const toggleLocked = (locked, reason = 'signed-out') => {
    if (!lockedEl) return;
    if (locked) {
      applyLockedContent(reason);
      lockedEl.hidden = false;
      if (formEl) formEl.hidden = true;
      return;
    }

    lockedEl.hidden = true;
    if (lockedLoginEl) lockedLoginEl.hidden = false;
    if (formEl) formEl.hidden = false;
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
      toggleLocked(true, 'signed-out');
      setStatus('Sign in to manage API credentials.', 'error');
      return false;
    }
    if (!authContext.isAdmin) {
      toggleLocked(true, 'no-admin');
      setStatus('Current account lacks admin permissions for API credentials.', 'error');
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

  const scopeSettings = collectScopeSettings();
  plannerScope = { ...defaults.scope, ...scopeSettings };

  let universeValue = Number(inputs.universe?.value) || 0;
  if (plannerScope.mode === 'watchlist' && typeof plannerScope.watchlistCount === 'number') {
    universeValue = plannerScope.watchlistCount;
  } else if (plannerScope.mode === 'custom') {
    universeValue = plannerScope.customTickers.length;
  }

  return {
    universe: universeValue,
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
    budgetUsd: Math.max(0, Number(inputs.budgetInput?.value) || 0),
    scope: plannerScope
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

  const scopeSettings = { ...defaults.scope, ...(settings.scope ?? {}) };
  applyScopeSettings(scopeSettings, { fromSettings: true });

  if (inputs.universe) {
    if (plannerScope.mode === 'universe') {
      inputs.universe.value = settings.universe;
    } else if (plannerScope.mode === 'watchlist') {
      const count = plannerScope.watchlistCount ?? settings.universe ?? 0;
      inputs.universe.value = count;
    } else if (plannerScope.mode === 'custom') {
      inputs.universe.value = plannerScope.customTickers.length;
    }
  }

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
  clearFollowupRefreshTimer();
  clearFocusRefreshTimer();
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'run_feedback', filter: `run_id=eq.${runId}` }, () => {
      scheduleFollowupRefresh();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'focus_question_requests', filter: `run_id=eq.${runId}` }, () => {
      scheduleFocusRefresh();
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
        scheduleFollowupRefresh({ immediate: true });
        scheduleFocusRefresh({ immediate: true });
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
      headers: buildFunctionHeaders(),
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

function updateAutoContinueStatus(message) {
  if (inputs.autoContinueStatus) {
    inputs.autoContinueStatus.textContent = message;
  }
}

function getAutoContinueIntervalMs() {
  const rawValue = Number(inputs.autoContinueInterval?.value ?? AUTO_CONTINUE_DEFAULT_SECONDS);
  const seconds = Number.isFinite(rawValue) && rawValue > 0 ? rawValue : AUTO_CONTINUE_DEFAULT_SECONDS;
  const clamped = Math.min(Math.max(Math.round(seconds), 5), 600);
  return clamped * 1000;
}

function clearAutoContinueTimer() {
  if (autoContinueTimer) {
    window.clearTimeout(autoContinueTimer);
    autoContinueTimer = null;
  }
}

function disableAutoContinue(message = 'Auto continue paused.') {
  clearAutoContinueTimer();
  autoContinueActive = false;
  autoContinueInFlight = false;
  if (inputs.autoContinueToggle) {
    inputs.autoContinueToggle.checked = false;
  }
  updateAutoContinueStatus(message);
}

function scheduleAutoContinue({ immediate = false } = {}) {
  clearAutoContinueTimer();
  if (!autoContinueActive) return;

  if (immediate) {
    runAutoContinue().catch((error) => {
      console.error('Auto continue execution failed', error);
    });
    return;
  }

  const delay = getAutoContinueIntervalMs();
  autoContinueTimer = window.setTimeout(() => {
    autoContinueTimer = null;
    runAutoContinue().catch((error) => {
      console.error('Auto continue execution failed', error);
    });
  }, delay);
}

function updateAutoContinueAvailability() {
  const toggle = inputs.autoContinueToggle;
  const intervalSelect = inputs.autoContinueInterval;
  const halted = currentRunMeta?.stop_requested
    ? 'stop'
    : currentRunMeta?.budget_exhausted
      ? 'budget'
      : null;
  const hasAuth = Boolean(authContext.user && authContext.isAdmin && authContext.token);
  const ready = Boolean(activeRunId && hasAuth && !halted);

  if (!ready && autoContinueActive) {
    clearAutoContinueTimer();
    autoContinueActive = false;
    autoContinueInFlight = false;
    if (toggle) toggle.checked = false;
    if (halted === 'budget') {
      updateAutoContinueStatus('Auto continue halted — budget reached.');
    } else if (halted === 'stop') {
      updateAutoContinueStatus('Auto continue halted — stop requested.');
    } else if (!authContext.user) {
      updateAutoContinueStatus('Sign in to enable auto continue.');
    } else if (!authContext.isAdmin) {
      updateAutoContinueStatus('Admin access required for auto continue.');
    } else if (!activeRunId) {
      updateAutoContinueStatus('Select a run to enable auto continue.');
    } else {
      updateAutoContinueStatus('Auto continue paused.');
    }
  }

  if (toggle) {
    toggle.disabled = !ready && !autoContinueActive;
  }

  if (intervalSelect) {
    intervalSelect.disabled = !ready || autoContinueInFlight;
  }

  if (!autoContinueActive) {
    if (!activeRunId) {
      updateAutoContinueStatus('Select a run to enable auto continue.');
    } else if (!authContext.user) {
      updateAutoContinueStatus('Sign in to enable auto continue.');
    } else if (!authContext.isAdmin) {
      updateAutoContinueStatus('Admin access required for auto continue.');
    } else if (halted === 'stop') {
      updateAutoContinueStatus('Auto continue halted — stop requested.');
    } else if (halted === 'budget') {
      updateAutoContinueStatus('Auto continue halted — budget reached.');
    } else if (!autoContinueInFlight && (!inputs.autoContinueStatus || !inputs.autoContinueStatus.textContent)) {
      updateAutoContinueStatus('Auto continue idle.');
    }
  }
}

async function runAutoContinue() {
  if (!autoContinueActive || autoContinueInFlight) return;

  if (!activeRunId) {
    disableAutoContinue('Select a run to enable auto continue.');
    updateAutoContinueAvailability();
    return;
  }

  if (!authContext.token) {
    await syncAccess({ preserveStatus: true });
  }

  if (!authContext.token) {
    disableAutoContinue('Session expired. Sign in again to continue.');
    updateAutoContinueAvailability();
    return;
  }

  autoContinueInFlight = true;
  updateAutoContinueStatus('Auto continue running…');

  try {
    const response = await fetch(RUNS_CONTINUE_ENDPOINT, {
      method: 'POST',
      headers: buildFunctionHeaders(),
      body: JSON.stringify({
        run_id: activeRunId,
        stage_limits: AUTO_CONTINUE_LIMITS,
        cycles: 1,
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
        console.warn('Unable to parse runs-continue response JSON', error);
        payload = {};
      }
    }

    if (!response.ok) {
      const message = payload?.error || `Auto continue failed (${response.status})`;
      updateAutoContinueStatus(message);
      logStatus(`[Auto] ${message}`);
      disableAutoContinue('Auto continue stopped due to error.');
      updateAutoContinueAvailability();
      return;
    }

    const message = typeof payload?.message === 'string' ? payload.message : 'Auto continue cycle completed.';
    updateAutoContinueStatus(message);
    logStatus(`[Auto] ${message}`);

    if (Array.isArray(payload?.operations)) {
      payload.operations.forEach((operation) => {
        if (!operation || typeof operation !== 'object') return;
        const stageNumber = Number(operation.stage);
        const stageLabel = STAGE_LABELS[stageNumber] ?? `Stage ${stageNumber}`;
        const opMessage = operation.message || 'Stage call completed.';
        logStatus(`[Auto] ${stageLabel}: ${opMessage}`);
      });
    }

    if (payload?.halted) {
      const haltMessage = typeof payload.halted.message === 'string'
        ? payload.halted.message
        : 'Auto continue halted.';
      logStatus(`[Auto] ${haltMessage}`);
      disableAutoContinue(haltMessage);
    }

    await Promise.all([
      fetchStage1Summary({ silent: true }),
      fetchStage2Summary({ silent: true }),
      fetchStage3Summary({ silent: true }),
      fetchRunMeta({ silent: true })
    ]).catch((error) => {
      console.error('Auto continue refresh failed', error);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Auto continue error', error);
    updateAutoContinueStatus(`Auto continue error: ${message}`);
    logStatus(`Auto continue error: ${message}`);
    disableAutoContinue('Auto continue stopped due to error.');
  } finally {
    autoContinueInFlight = false;
    updateAutoContinueAvailability();
    if (autoContinueActive) {
      scheduleAutoContinue();
    }
  }
}

async function handleAutoContinueToggle(event) {
  const checked = Boolean(event?.target?.checked);

  if (checked) {
    await syncAccess({ preserveStatus: true });

    if (!authContext.user) {
      updateAutoContinueStatus('Sign in to enable auto continue.');
      if (inputs.autoContinueToggle) inputs.autoContinueToggle.checked = false;
      updateAutoContinueAvailability();
      return;
    }

    if (!authContext.isAdmin) {
      updateAutoContinueStatus('Admin access required for auto continue.');
      if (inputs.autoContinueToggle) inputs.autoContinueToggle.checked = false;
      updateAutoContinueAvailability();
      return;
    }

    if (!authContext.token) {
      updateAutoContinueStatus('Session expired. Sign in again to continue.');
      if (inputs.autoContinueToggle) inputs.autoContinueToggle.checked = false;
      updateAutoContinueAvailability();
      return;
    }

    if (!activeRunId) {
      updateAutoContinueStatus('Select a run to enable auto continue.');
      if (inputs.autoContinueToggle) inputs.autoContinueToggle.checked = false;
      updateAutoContinueAvailability();
      return;
    }

    if (currentRunMeta?.stop_requested) {
      updateAutoContinueStatus('Auto continue halted — stop requested.');
      if (inputs.autoContinueToggle) inputs.autoContinueToggle.checked = false;
      updateAutoContinueAvailability();
      return;
    }

    if (currentRunMeta?.budget_exhausted) {
      updateAutoContinueStatus('Auto continue halted — budget reached.');
      if (inputs.autoContinueToggle) inputs.autoContinueToggle.checked = false;
      updateAutoContinueAvailability();
      return;
    }

    autoContinueActive = true;
    logStatus('Auto continue enabled.');
    updateAutoContinueAvailability();
    scheduleAutoContinue({ immediate: true });
  } else {
    disableAutoContinue('Auto continue paused.');
    logStatus('Auto continue paused by operator.');
    updateAutoContinueAvailability();
  }
}

function formatSchedulerCadence(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 'custom interval';
  if (value % 3600 === 0) {
    const hours = Math.round(value / 3600);
    if (hours === 1) return '60 minutes';
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (value % 60 === 0) {
    const minutes = Math.round(value / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${value} seconds`;
}

function formatRelativeFutureTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const delta = date.getTime() - Date.now();
  if (delta <= 0) {
    return formatRelativeTimestamp(value);
  }
  if (delta < 60_000) return 'in under a minute';
  if (delta < 3_600_000) {
    const minutes = Math.round(delta / 60_000);
    return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  if (delta < 86_400_000) {
    const hours = Math.round(delta / 3_600_000);
    return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(delta / 86_400_000);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function markSchedulerDirty(message = 'Unsaved changes. Save schedule to update the background dispatcher.') {
  schedulerDirty = true;
  if (inputs.schedulerStatus) {
    inputs.schedulerStatus.textContent = message;
  }
  hideSchedulerToast();
}

function applySchedulerUI(schedule, { cache = true } = {}) {
  const sanitized = schedule ? { ...schedule } : null;
  const scheduleData = sanitized;
  currentSchedule = scheduleData;
  if (cache && activeRunId) {
    scheduleCache.set(activeRunId, scheduleData ? { ...scheduleData } : null);
  }
  schedulerDirty = false;

  const toggle = inputs.schedulerEnabled;
  const cadenceSelect = inputs.schedulerCadence;
  const stage1Input = inputs.schedulerStage1;
  const stage2Input = inputs.schedulerStage2;
  const stage3Input = inputs.schedulerStage3;
  const cyclesInput = inputs.schedulerCycles;

  const cadenceSeconds = Number(scheduleData?.cadence_seconds ?? SCHEDULER_DEFAULTS.cadenceSeconds);
  const stage1Limit = Number(scheduleData?.stage1_limit ?? SCHEDULER_DEFAULTS.stage1Limit);
  const stage2Limit = Number(scheduleData?.stage2_limit ?? SCHEDULER_DEFAULTS.stage2Limit);
  const stage3Limit = Number(scheduleData?.stage3_limit ?? SCHEDULER_DEFAULTS.stage3Limit);
  const maxCycles = Number(scheduleData?.max_cycles ?? SCHEDULER_DEFAULTS.maxCycles);

  if (toggle) toggle.checked = Boolean(scheduleData?.active);
  if (cadenceSelect) cadenceSelect.value = String(cadenceSeconds);
  if (stage1Input) stage1Input.value = String(stage1Limit);
  if (stage2Input) stage2Input.value = String(stage2Limit);
  if (stage3Input) stage3Input.value = String(stage3Limit);
  if (cyclesInput) cyclesInput.value = String(maxCycles);

  let summary;
  if (!activeRunId) {
    summary = 'Assign a run to enable background automation.';
  } else if (!scheduleData) {
    summary = 'No background schedule saved. Configure cadence and save to dispatch unattended batches.';
  } else if (!scheduleData.active) {
    summary = 'Background dispatcher disabled for this run.';
  } else {
    const cadenceLabel = formatSchedulerCadence(cadenceSeconds);
    summary = `Dispatches every ${cadenceLabel} · Stage 1 ${stage1Limit}, Stage 2 ${stage2Limit}, Stage 3 ${stage3Limit}`;
    if (maxCycles > 1) {
      summary += ` · ${maxCycles} cycles per trigger`;
    }

    const descriptors = [];
    if (scheduleData.next_trigger_at) {
      const relative = formatRelativeFutureTimestamp(scheduleData.next_trigger_at);
      const absolute = new Date(scheduleData.next_trigger_at).toLocaleString();
      descriptors.push(`next run ${relative ?? 'soon'} (${absolute})`);
    }
    if (scheduleData.last_triggered_at) {
      descriptors.push(`last triggered ${formatRelativeTimestamp(scheduleData.last_triggered_at)}`);
    }
    if (descriptors.length) {
      summary += `. ${descriptors.join('; ')}.`;
    } else {
      summary += '.';
    }
  }

  if (inputs.schedulerSummary) {
    inputs.schedulerSummary.textContent = summary;
  }

  if (inputs.schedulerStatus) {
    if (!scheduleData) {
      inputs.schedulerStatus.textContent = '';
    } else if (!scheduleData.active) {
      inputs.schedulerStatus.textContent = 'Scheduler disabled for this run.';
    } else {
      const relative = formatRelativeFutureTimestamp(scheduleData.next_trigger_at);
      inputs.schedulerStatus.textContent = relative ? `Scheduler enabled (${relative}).` : 'Scheduler enabled.';
    }
  }

  applyAccessState({ preserveStatus: true });
}

function hideSchedulerToast() {
  if (!inputs.schedulerToast) return;
  if (schedulerToastTimer) {
    clearTimeout(schedulerToastTimer);
    schedulerToastTimer = null;
  }
  inputs.schedulerToast.hidden = true;
  inputs.schedulerToast.textContent = '';
  inputs.schedulerToast.classList.remove('is-success', 'is-error', 'is-info');
}

function showSchedulerToast(message, variant = 'info') {
  if (!inputs.schedulerToast) return;
  if (schedulerToastTimer) {
    clearTimeout(schedulerToastTimer);
    schedulerToastTimer = null;
  }

  const toast = inputs.schedulerToast;
  const variantClass =
    variant === 'error' ? 'is-error' : variant === 'success' ? 'is-success' : 'is-info';

  toast.hidden = false;
  toast.textContent = message;
  toast.classList.remove('is-success', 'is-error', 'is-info');
  toast.classList.add(variantClass);

  schedulerToastTimer = window.setTimeout(() => {
    toast.hidden = true;
    toast.classList.remove(variantClass);
    toast.textContent = '';
    schedulerToastTimer = null;
  }, 4000);
}

function readSchedulerNumber(input, { min, max, fallback }) {
  if (!input) return fallback;
  const raw = Number(input.value);
  if (!Number.isFinite(raw)) {
    input.value = String(fallback);
    return fallback;
  }
  const clamped = Math.min(Math.max(Math.floor(raw), min), max);
  input.value = String(clamped);
  return clamped;
}

async function fetchRunSchedule({ silent = false } = {}) {
  if (!inputs.schedulerSummary) return;
  if (!silent) hideSchedulerToast();
  if (!activeRunId) {
    applySchedulerUI(null, { cache: false });
    hideSchedulerToast();
    if (!silent && inputs.schedulerStatus) {
      inputs.schedulerStatus.textContent = 'Assign a run to configure background automation.';
    }
    return;
  }

  if (!authContext.token) {
    if (!silent && inputs.schedulerStatus) {
      inputs.schedulerStatus.textContent = 'Sign in to view the background scheduler.';
    }
    return;
  }

  if (schedulerLoading) return;
  schedulerLoading = true;
  applyAccessState({ preserveStatus: true });

  if (!silent && inputs.schedulerStatus) {
    inputs.schedulerStatus.textContent = 'Loading background schedule…';
  }

  try {
    const response = await fetch(`${RUNS_SCHEDULE_ENDPOINT}?run_id=${activeRunId}`, {
      headers: buildFunctionHeaders({ json: false })
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        console.warn('Unable to parse run schedule response', error);
      }
    }

    if (!response.ok) {
      const message = payload?.error || `Schedule endpoint responded ${response.status}`;
      throw new Error(message);
    }

    applySchedulerUI(payload?.schedule ?? null);

    if (!silent && inputs.schedulerStatus) {
      if (payload?.schedule) {
        inputs.schedulerStatus.textContent = payload.schedule.active
          ? 'Background dispatcher enabled.'
          : 'Background dispatcher disabled.';
      } else {
        inputs.schedulerStatus.textContent = 'No background schedule configured.';
      }
    }
  } catch (error) {
    console.error('Failed to fetch run schedule', error);
    if (!silent && inputs.schedulerStatus) {
      inputs.schedulerStatus.textContent = `Failed to load schedule: ${error.message}`;
    }
    if (!silent) {
      showSchedulerToast(`Failed to load schedule: ${error.message}`, 'error');
    }
  } finally {
    schedulerLoading = false;
    applyAccessState({ preserveStatus: true });
  }
}

async function saveRunSchedule() {
  if (!inputs.schedulerStatus) return;

  if (!activeRunId) {
    inputs.schedulerStatus.textContent = 'Assign a run ID before saving the schedule.';
    return;
  }

  await syncAccess({ preserveStatus: true });

  if (!authContext.user) {
    inputs.schedulerStatus.textContent = 'Sign in required to manage the scheduler.';
    return;
  }

  if (!authContext.isAdmin) {
    inputs.schedulerStatus.textContent = 'Admin access required to manage the scheduler.';
    return;
  }

  if (!authContext.token) {
    inputs.schedulerStatus.textContent = 'Session expired. Sign in again to continue.';
    await syncAccess();
    return;
  }

  const active = Boolean(inputs.schedulerEnabled?.checked);
  const cadenceSeconds = readSchedulerNumber(inputs.schedulerCadence, {
    min: 60,
    max: 21_600,
    fallback: SCHEDULER_DEFAULTS.cadenceSeconds
  });
  const stage1Limit = readSchedulerNumber(inputs.schedulerStage1, {
    min: 1,
    max: 25,
    fallback: SCHEDULER_DEFAULTS.stage1Limit
  });
  const stage2Limit = readSchedulerNumber(inputs.schedulerStage2, {
    min: 1,
    max: 25,
    fallback: SCHEDULER_DEFAULTS.stage2Limit
  });
  const stage3Limit = readSchedulerNumber(inputs.schedulerStage3, {
    min: 1,
    max: 25,
    fallback: SCHEDULER_DEFAULTS.stage3Limit
  });
  const maxCycles = readSchedulerNumber(inputs.schedulerCycles, {
    min: 1,
    max: 10,
    fallback: SCHEDULER_DEFAULTS.maxCycles
  });

  schedulerLoading = true;
  applyAccessState({ preserveStatus: true });

  hideSchedulerToast();
  inputs.schedulerStatus.textContent = active ? 'Saving scheduler…' : 'Disabling scheduler…';

  try {
    const response = await fetch(RUNS_SCHEDULE_ENDPOINT, {
      method: 'POST',
      headers: buildFunctionHeaders(),
      body: JSON.stringify({
        run_id: activeRunId,
        cadence_seconds: cadenceSeconds,
        stage_limits: {
          stage1: stage1Limit,
          stage2: stage2Limit,
          stage3: stage3Limit
        },
        max_cycles: maxCycles,
        active
      })
    });

    const raw = await response.text();
    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        console.warn('Unable to parse schedule save response', error);
      }
    }

    if (!response.ok) {
      const message = payload?.error || `Scheduler save failed (${response.status})`;
      throw new Error(message);
    }

    applySchedulerUI(payload?.schedule ?? null);

    if (inputs.schedulerStatus) {
      if (payload?.schedule && payload.schedule.active) {
        const cadenceLabel = formatSchedulerCadence(payload.schedule.cadence_seconds ?? cadenceSeconds);
        inputs.schedulerStatus.textContent = `Background dispatcher enabled (${cadenceLabel}).`;
      } else {
        inputs.schedulerStatus.textContent = 'Background dispatcher saved.';
      }
    }

      if (payload?.schedule?.active) {
        const cadenceLabel = formatSchedulerCadence(payload.schedule.cadence_seconds ?? cadenceSeconds);
        logStatus(`Background scheduler enabled: ${cadenceLabel} cadence.`);
        showSchedulerToast(`Scheduler enabled · ${cadenceLabel} cadence`, 'success');
      } else {
        logStatus('Background scheduler disabled for this run.');
        showSchedulerToast('Scheduler disabled for this run', 'info');
      }
    } catch (error) {
      console.error('Failed to save run schedule', error);
      inputs.schedulerStatus.textContent = `Failed to save schedule: ${error.message}`;
      schedulerDirty = true;
      showSchedulerToast(`Failed to save schedule: ${error.message}`, 'error');
    } finally {
      schedulerLoading = false;
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

function renderCacheBadge(hit) {
  if (!hit) return '';
  return '<span class="cache-badge" title="Served from cached response">Cached</span>';
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
    const cachedBadge = renderCacheBadge(entry.cache_hit);
    const updated = entry.updated_at
      ? new Date(entry.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    row.innerHTML = `
      <td>${entry.ticker ?? '—'}</td>
      <td data-label>${entry.label ?? '—'}</td>
      <td>${safeSummary}${cachedBadge}</td>
      <td>${updated}</td>
    `;
    body.appendChild(row);
  });
}

function updateStage2Metrics(metrics = null, retrieval = null) {
  const formatter = (value) => {
    if (value == null || Number.isNaN(value)) return '—';
    return Number(value).toLocaleString();
  };

  if (inputs.stage2Total) inputs.stage2Total.textContent = formatter(metrics?.total);
  if (inputs.stage2Pending) inputs.stage2Pending.textContent = formatter(metrics?.pending);
  if (inputs.stage2Completed) inputs.stage2Completed.textContent = formatter(metrics?.completed);
  if (inputs.stage2Failed) inputs.stage2Failed.textContent = formatter(metrics?.failed);
  if (inputs.stage2GoDeep) inputs.stage2GoDeep.textContent = formatter(metrics?.goDeep);
  if (inputs.stage2ContextHits) {
    const hits = retrieval?.total_hits ?? retrieval?.hits ?? retrieval?.average_hits ?? null;
    inputs.stage2ContextHits.textContent = formatter(hits);
  }
  if (inputs.stage2ContextTokens) {
    const tokens = retrieval?.embedding_tokens ?? retrieval?.tokens ?? null;
    inputs.stage2ContextTokens.textContent = formatter(tokens);
  }
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
    const summary = entry.summary ? String(entry.summary) : '—';
    const cachedBadge = renderCacheBadge(entry.cache_hit);
    const updated = entry.updated_at
      ? new Date(entry.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    row.innerHTML = `
      <td>${entry.ticker ?? '—'}</td>
      <td data-label>${goDeep}</td>
      <td>${summary}${cachedBadge}</td>
      <td>${updated}</td>
    `;
    body.appendChild(row);
  });
}

function updateStage3Metrics(metrics = null, retrieval = null) {
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
  if (inputs.stage3ContextHits) {
    const hits = retrieval?.total_hits ?? retrieval?.hits ?? null;
    inputs.stage3ContextHits.textContent = formatter(hits);
  }
  if (inputs.stage3ContextTokens) {
    const tokens = retrieval?.embedding_tokens ?? retrieval?.tokens ?? null;
    inputs.stage3ContextTokens.textContent = formatter(tokens);
  }
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
    const cachedBadge = renderCacheBadge(entry.cache_hit);
    const updated = entry.updated_at
      ? new Date(entry.updated_at).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    row.innerHTML = `
      <td>${entry.ticker ?? '—'}</td>
      <td data-label>${verdict}</td>
      <td>${thesis}${cachedBadge}</td>
      <td>${updated}</td>
    `;
    body.appendChild(row);
  });
}

function setFollowupStatus(message, tone = '') {
  if (!inputs.followupStatus) return;
  inputs.followupStatus.textContent = message || '';
  if (tone) {
    inputs.followupStatus.dataset.tone = tone;
  } else {
    delete inputs.followupStatus.dataset.tone;
  }
}

function setFollowupPanelStatus(message) {
  if (!inputs.followupPanelStatus) return;
  inputs.followupPanelStatus.textContent = message || '';
}

function populateFollowupTickers(tickers) {
  const select = inputs.followupTicker;
  if (!select) return;

  const previous = select.value;
  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'General follow-up';
  select.append(defaultOption);

  followupTickers = Array.from(new Set((tickers ?? []).filter(Boolean))).sort();
  followupTickers.forEach((ticker) => {
    const option = document.createElement('option');
    option.value = ticker;
    option.textContent = ticker;
    select.append(option);
  });

  if (previous && followupTickers.includes(previous)) {
    select.value = previous;
  } else {
    select.value = '';
  }

  if (inputs.focusTicker) {
    const focusSelect = inputs.focusTicker;
    const prevFocus = focusSelect.value;
    focusSelect.innerHTML = '';

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select ticker';
    focusSelect.append(placeholder);

    followupTickers.forEach((ticker) => {
      const option = document.createElement('option');
      option.value = ticker;
      option.textContent = ticker;
      focusSelect.append(option);
    });

    if (prevFocus && followupTickers.includes(prevFocus)) {
      focusSelect.value = prevFocus;
    } else {
      focusSelect.value = '';
    }
  }
}

function renderFollowupTable(rows) {
  const tbody = inputs.followupTableBody;
  if (!tbody) return;

  tbody.innerHTML = '';
  const entries = Array.isArray(rows) ? rows : [];
  const total = entries.length;

  if (inputs.followupCount) {
    inputs.followupCount.textContent = String(total);
  }

  if (!total) {
    const emptyRow = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'No feedback logged yet. Start by submitting a question above.';
    emptyRow.append(cell);
    tbody.append(emptyRow);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('tr');

    const createdCell = document.createElement('td');
    if (entry.created_at) {
      createdCell.textContent = formatRelativeTimestamp(entry.created_at);
      createdCell.title = new Date(entry.created_at).toLocaleString();
    } else {
      createdCell.textContent = '—';
    }
    row.append(createdCell);

    const tickerCell = document.createElement('td');
    tickerCell.textContent = entry.ticker ?? '—';
    row.append(tickerCell);

    const questionCell = document.createElement('td');
    const question = document.createElement('div');
    question.className = 'followup-question';
    question.textContent = entry.question_text ?? '—';
    questionCell.append(question);
    row.append(questionCell);

    const statusCell = document.createElement('td');
    const state = typeof entry.status === 'string' ? entry.status.toLowerCase() : 'pending';
    const label = document.createElement('span');
    label.className = 'followup-status-label';
    label.dataset.state = state;
    label.textContent = followupStatusLabels[state] ?? state.replace(/_/g, ' ');
    statusCell.append(label);
    row.append(statusCell);

    const updatedCell = document.createElement('td');
    const updatedAt = entry.updated_at ?? entry.created_at;
    if (updatedAt) {
      updatedCell.textContent = formatRelativeTimestamp(updatedAt);
      updatedCell.title = new Date(updatedAt).toLocaleString();
    } else {
      updatedCell.textContent = '—';
    }
    row.append(updatedCell);

    tbody.append(row);
  });
}

function setFocusPanelStatus(message) {
  if (!inputs.focusPanelStatus) return;
  inputs.focusPanelStatus.textContent = message || '';
}

function setFocusStatus(message, tone = '') {
  if (!inputs.focusStatus) return;
  inputs.focusStatus.textContent = message || '';
  if (tone) {
    inputs.focusStatus.dataset.tone = tone;
  } else {
    delete inputs.focusStatus.dataset.tone;
  }
}

function clearFocusRefreshTimer() {
  if (focusRefreshTimer) {
    window.clearTimeout(focusRefreshTimer);
    focusRefreshTimer = null;
  }
}

function scheduleFocusRefresh({ immediate = false } = {}) {
  clearFocusRefreshTimer();
  if (immediate) {
    fetchFocusData({ silent: true }).catch((error) => {
      console.warn('Focus refresh failed', error);
    });
    return;
  }
  focusRefreshTimer = window.setTimeout(() => {
    focusRefreshTimer = null;
    fetchFocusData({ silent: true }).catch((error) => {
      console.warn('Focus refresh failed', error);
    });
  }, 650);
}

function updateFocusMetrics(metrics = null) {
  if (!inputs.focusSummary) return;
  if (!metrics) {
    inputs.focusSummary.textContent = 'Pending — • Completed — • Failed —';
    return;
  }
  inputs.focusSummary.textContent = `Pending ${Number(metrics.pending ?? 0).toLocaleString()} • Completed ${Number(
    metrics.completed ?? 0
  ).toLocaleString()} • Failed ${Number(metrics.failed ?? 0).toLocaleString()}`;
}

function renderFocusTemplates(templates = []) {
  const container = inputs.focusTemplates;
  if (!container) return;

  container.innerHTML = '';
  const entries = Array.isArray(templates) ? templates : [];

  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'focus-empty';
    empty.textContent = 'No saved focus templates yet. Add questions from the docs admin to reuse them here.';
    container.append(empty);
    return;
  }

  entries.forEach((template) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'focus-template';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = template.slug;
    checkbox.dataset.slug = template.slug;
    checkbox.name = 'focusTemplates';
    checkbox.id = `focus-template-${template.slug}`;

    const title = document.createElement('span');
    title.className = 'focus-template__title';
    title.textContent = template.label ?? template.slug;

    const description = document.createElement('span');
    description.className = 'focus-template__question';
    description.textContent = template.question ?? '';

    wrapper.append(checkbox, title, description);
    container.append(wrapper);
  });
}

function renderFocusTable(rows = []) {
  const body = inputs.focusTableBody;
  if (!body) return;

  body.innerHTML = '';
  const entries = Array.isArray(rows) ? rows : [];
  if (inputs.focusCount) {
    inputs.focusCount.textContent = String(entries.length);
  }

  if (!entries.length) {
    const emptyRow = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = 'No focus questions queued yet. Select templates or add a custom prompt to get started.';
    emptyRow.append(cell);
    body.append(emptyRow);
    return;
  }

  entries.forEach((entry) => {
    const row = document.createElement('tr');

    const createdCell = document.createElement('td');
    if (entry.created_at) {
      createdCell.textContent = formatRelativeTimestamp(entry.created_at);
      createdCell.title = new Date(entry.created_at).toLocaleString();
    } else {
      createdCell.textContent = '—';
    }
    row.append(createdCell);

    const tickerCell = document.createElement('td');
    tickerCell.textContent = entry.ticker ?? '—';
    row.append(tickerCell);

    const questionCell = document.createElement('td');
    questionCell.className = 'focus-question';
    questionCell.textContent = entry.question ?? '—';
    row.append(questionCell);

    const statusCell = document.createElement('td');
    const label = focusStatusLabels[entry.status] ?? entry.status ?? '—';
    statusCell.textContent = label;
    statusCell.dataset.status = entry.status ?? 'unknown';
    row.append(statusCell);

    const summaryCell = document.createElement('td');
    const summary = entry.answer_text ? String(entry.answer_text) : '';
    const truncated = summary.length > 160 ? `${summary.slice(0, 160)}…` : summary || '—';
    const badge = renderCacheBadge(entry.cache_hit);
    summaryCell.innerHTML = `${truncated}${badge}`;
    row.append(summaryCell);

    const updatedCell = document.createElement('td');
    const updatedAt = entry.answered_at ?? entry.updated_at ?? entry.created_at;
    if (updatedAt) {
      updatedCell.textContent = formatRelativeTimestamp(updatedAt);
      updatedCell.title = new Date(updatedAt).toLocaleString();
    } else {
      updatedCell.textContent = '—';
    }
    row.append(updatedCell);

    body.append(row);
  });
}

function resetFocusUI(message = '') {
  focusTemplates = [];
  focusRequests = [];
  renderFocusTemplates([]);
  renderFocusTable([]);
  updateFocusMetrics(null);
  setFocusPanelStatus(message);
  setFocusStatus('');
}

async function fetchFocusData({ silent = false } = {}) {
  if (!inputs.focusPanel) return;

  if (!activeRunId) {
    resetFocusUI('Set a run ID to manage focus questions.');
    return;
  }

  if (!authContext.user || !authContext.isAdmin) {
    resetFocusUI('Admin access required to queue focus questions.');
    return;
  }

  if (!authContext.token) {
    resetFocusUI('Session expired. Sign in again to continue.');
    await syncAccess({ preserveStatus: true });
    return;
  }

  if (!silent) {
    setFocusPanelStatus('Loading focus questions…');
  }

  focusLoading = true;
  applyAccessState({ preserveStatus: true });

  try {
    const url = new URL(RUNS_FOCUS_ENDPOINT);
    url.searchParams.set('run_id', activeRunId);
    const response = await fetch(url.toString(), {
      headers: buildFunctionHeaders({ json: false })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Focus endpoint responded ${response.status}: ${text}`);
    }

    const data = await response.json();
    focusTemplates = Array.isArray(data.templates) ? data.templates : [];
    focusRequests = Array.isArray(data.requests) ? data.requests : [];

    renderFocusTemplates(focusTemplates);
    renderFocusTable(focusRequests);
    updateFocusMetrics(data.metrics ?? null);

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setFocusPanelStatus(`Last updated ${timestamp}`);
  } catch (error) {
    console.error('Failed to load focus questions', error);
    setFocusPanelStatus('Failed to load focus questions.');
  } finally {
    focusLoading = false;
    applyAccessState({ preserveStatus: true });
  }
}

async function submitFocusForm(event) {
  event.preventDefault();
  if (!inputs.focusForm) return;

  if (!activeRunId) {
    setFocusStatus('Set a run ID before queuing focus questions.', 'warn');
    return;
  }

  if (!authContext.user) {
    setFocusStatus('Sign in required.', 'warn');
    return;
  }

  if (!authContext.isAdmin) {
    setFocusStatus('Admin access required.', 'warn');
    return;
  }

  if (!authContext.token) {
    setFocusStatus('Session expired. Sign in again to continue.', 'warn');
    await syncAccess({ preserveStatus: true });
    return;
  }

  const ticker = inputs.focusTicker ? inputs.focusTicker.value.trim() : '';
  if (!ticker) {
    setFocusStatus('Choose a ticker before queuing focus questions.', 'warn');
    return;
  }

  const selectedTemplates = inputs.focusTemplates
    ? Array.from(inputs.focusTemplates.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value)
    : [];

  const customQuestion = inputs.focusCustomQuestion ? inputs.focusCustomQuestion.value.trim() : '';

  if (!selectedTemplates.length && !customQuestion) {
    setFocusStatus('Select at least one template or enter a custom question.', 'warn');
    return;
  }

  focusLoading = true;
  setFocusStatus('Submitting focus questions…');
  applyAccessState({ preserveStatus: true });

  try {
    const body = {
      run_id: activeRunId,
      ticker,
      template_slugs: selectedTemplates,
      custom_questions: customQuestion ? [customQuestion] : []
    };

    const response = await fetch(RUNS_FOCUS_ENDPOINT, {
      method: 'POST',
      headers: buildFunctionHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Focus submit failed (${response.status}): ${text}`);
    }

    if (inputs.focusCustomQuestion) {
      inputs.focusCustomQuestion.value = '';
    }
    if (inputs.focusTemplates) {
      inputs.focusTemplates.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        input.checked = false;
      });
    }

    setFocusStatus('Focus questions queued.', 'success');
    scheduleFocusRefresh({ immediate: true });
  } catch (error) {
    console.error('Focus question submission failed', error);
    setFocusStatus(`Failed to queue focus questions: ${error.message}`, 'warn');
  } finally {
    focusLoading = false;
    applyAccessState({ preserveStatus: true });
  }
}

async function refreshFollowupTickers({ silent = false } = {}) {
  if (!inputs.followupTicker) return;

  if (!activeRunId) {
    populateFollowupTickers([]);
    if (!silent) setFollowupPanelStatus('Select a run to view follow-up questions.');
    return;
  }

  try {
    const { data, error } = await supabase
      .from('run_items')
      .select('ticker')
      .eq('run_id', activeRunId)
      .order('ticker', { ascending: true });
    if (error) throw error;
    const tickers = (data ?? []).map((row) => (row?.ticker ? String(row.ticker).toUpperCase() : null)).filter(Boolean);
    populateFollowupTickers(tickers);
  } catch (error) {
    console.warn('Failed to load follow-up tickers', error);
  }
}

function clearFollowupRefreshTimer() {
  if (followupRefreshTimer) {
    clearTimeout(followupRefreshTimer);
    followupRefreshTimer = null;
  }
}

function scheduleFollowupRefresh({ immediate = false } = {}) {
  if (immediate) {
    clearFollowupRefreshTimer();
    refreshFollowupList({ silent: true }).catch((error) => {
      console.error('Follow-up refresh failed', error);
    });
    return;
  }

  if (followupRefreshTimer) return;
  followupRefreshTimer = window.setTimeout(() => {
    followupRefreshTimer = null;
    refreshFollowupList({ silent: true }).catch((error) => {
      console.error('Follow-up refresh failed', error);
    });
  }, 500);
}

function resetFollowupUI(message = '') {
  populateFollowupTickers([]);
  renderFollowupTable([]);
  setFollowupPanelStatus(message);
  if (!message) {
    setFollowupStatus('');
  }
}

async function refreshFollowupList({ silent = false } = {}) {
  if (!inputs.followupTableBody) return;

  if (!activeRunId) {
    resetFollowupUI('Select a run to view follow-up questions.');
    return;
  }

  if (!authContext.user) {
    resetFollowupUI('Sign in to view follow-up questions.');
    return;
  }

  if (!authContext.isAdmin && !authContext.membershipActive) {
    resetFollowupUI('Membership required to view follow-up questions.');
    return;
  }

  if (!authContext.token) {
    if (!silent) setFollowupPanelStatus('Session expired. Refresh or sign in again to load follow-ups.');
    return;
  }

  if (followupLoading) return;
  followupLoading = true;

  if (!silent) {
    setFollowupPanelStatus('Loading follow-up requests…');
  }

  try {
    const url = new URL(RUNS_FEEDBACK_ENDPOINT);
    url.searchParams.set('run_id', activeRunId);
    const response = await fetch(url.toString(), {
      headers: buildFunctionHeaders({ json: false })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error || `Failed to load follow-up requests (${response.status})`;
      throw new Error(message);
    }
    const items = Array.isArray(payload?.items) ? payload.items : [];
    renderFollowupTable(items);
    if (!silent) {
      setFollowupPanelStatus(items.length ? '' : 'No follow-up questions yet.');
    }
  } catch (error) {
    console.error('Failed to load follow-up requests', error);
    setFollowupPanelStatus(error instanceof Error ? error.message : String(error));
  } finally {
    followupLoading = false;
  }
}

function updateFollowupAccess() {
  const hasRun = Boolean(activeRunId);
  const signedIn = Boolean(authContext.user);
  const hasMembership = authContext.isAdmin || authContext.membershipActive;
  const canSubmit = hasRun && signedIn && hasMembership;

  if (inputs.followupQuestion) {
    inputs.followupQuestion.disabled = !canSubmit;
  }
  if (inputs.followupTicker) {
    inputs.followupTicker.disabled = !canSubmit;
  }
  if (inputs.submitFollowupBtn) {
    inputs.submitFollowupBtn.disabled = !canSubmit;
  }

  if (!signedIn) {
    setFollowupStatus('Sign in to submit follow-up questions.', 'error');
    setFollowupPanelStatus('Sign in to view follow-up questions.');
    return;
  }

  if (!hasRun) {
    setFollowupStatus('Select an active run to submit feedback.');
    setFollowupPanelStatus('Select a run to view follow-up questions.');
    return;
  }

  if (!hasMembership) {
    setFollowupStatus('Activate a membership to send follow-up questions.', 'error');
    setFollowupPanelStatus('Membership required to view follow-up questions.');
    return;
  }

  if (inputs.followupStatus?.dataset.tone !== 'success') {
    setFollowupStatus('');
  }
  setFollowupPanelStatus('');
}

async function submitFollowupRequest(event) {
  event.preventDefault();

  if (!activeRunId) {
    setFollowupStatus('Select an active run first.', 'error');
    return;
  }

  if (!authContext.user) {
    setFollowupStatus('Sign in to submit follow-up questions.', 'error');
    return;
  }

  if (!authContext.isAdmin && !authContext.membershipActive) {
    setFollowupStatus('Membership required to submit follow-up questions.', 'error');
    return;
  }

  if (!authContext.token) {
    setFollowupStatus('Session expired. Refresh and try again.', 'error');
    await syncAccess({ preserveStatus: true });
    return;
  }

  const questionValue = (inputs.followupQuestion?.value ?? '').trim();
  const tickerValue = (inputs.followupTicker?.value ?? '').trim();

  if (questionValue.length < 8) {
    setFollowupStatus('Follow-up question must be at least 8 characters.', 'error');
    return;
  }

  if (inputs.submitFollowupBtn) {
    inputs.submitFollowupBtn.disabled = true;
  }
  if (inputs.followupTicker) {
    inputs.followupTicker.disabled = true;
  }
  if (inputs.followupQuestion) {
    inputs.followupQuestion.disabled = true;
  }

  setFollowupStatus('Submitting follow-up…');

  try {
    const response = await fetch(RUNS_FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: buildFunctionHeaders(),
      body: JSON.stringify({
        run_id: activeRunId,
        ticker: tickerValue || undefined,
        question: questionValue,
        context: {
          origin: window.location.origin,
          pathname: window.location.pathname,
          submitted_at: new Date().toISOString()
        }
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error || `Failed to submit follow-up (${response.status})`;
      throw new Error(message);
    }

    setFollowupStatus('Follow-up logged. Check the table below for updates.', 'success');
    if (inputs.followupQuestion) {
      inputs.followupQuestion.value = '';
    }
    if (inputs.followupTicker) {
      inputs.followupTicker.value = tickerValue && followupTickers.includes(tickerValue) ? tickerValue : '';
    }
    scheduleFollowupRefresh({ immediate: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setFollowupStatus(message, 'error');
  } finally {
    if (inputs.submitFollowupBtn) {
      inputs.submitFollowupBtn.disabled = false;
    }
    if (inputs.followupTicker) {
      inputs.followupTicker.disabled = false;
    }
    if (inputs.followupQuestion) {
      inputs.followupQuestion.disabled = false;
    }
  }
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

  if (changed && autoContinueActive) {
    disableAutoContinue('Auto continue paused while switching runs.');
  }

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
    resetFollowupUI('No active run selected.');
    resetFocusUI('No active run selected.');
    applySchedulerUI(null);
    hideSchedulerToast();
    renderNotificationEvents();
    if (announce && inputs.stage1Status) {
      inputs.stage1Status.textContent = 'Active run cleared. Set a run ID to continue.';
    }
    if (announce) {
      logStatus('Active run cleared.');
    }
    if (inputs.stage2Status) inputs.stage2Status.textContent = 'Active run cleared.';
    if (inputs.stage3Status) inputs.stage3Status.textContent = 'Active run cleared.';
    return changed;
  }

  subscribeToRunChannel(activeRunId);

  hideSchedulerToast();
  const hasCachedSchedule = scheduleCache.has(activeRunId);
  const cachedSchedule = hasCachedSchedule ? scheduleCache.get(activeRunId) : null;
  applySchedulerUI(cachedSchedule ?? null, { cache: hasCachedSchedule });
  if (!hasCachedSchedule && inputs.schedulerStatus) {
    inputs.schedulerStatus.textContent = 'Loading background schedule…';
  }
  if (!hasCachedSchedule && inputs.schedulerSummary) {
    inputs.schedulerSummary.textContent = 'Loading background schedule…';
  }

  fetchRunMeta({ silent }).catch((error) => {
    console.error('Failed to refresh run details', error);
  });

  fetchRunSchedule({ silent: true }).catch((error) => {
    console.error('Failed to refresh run schedule', error);
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

  refreshFollowupTickers({ silent: true }).catch((error) => {
    console.warn('Failed to load follow-up tickers', error);
  });
  refreshFollowupList({ silent }).catch((error) => {
    console.warn('Failed to load follow-up requests', error);
  });
  fetchFocusData({ silent }).catch((error) => {
    console.warn('Failed to load focus questions', error);
  });
  loadNotificationEvents({ silent: true }).catch((error) => {
    console.warn('Failed to refresh notification log', error);
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
      headers: buildFunctionHeaders(),
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

    const cacheNote = payload.cache_hits ? ` (cached ${payload.cache_hits})` : '';
    const message = (payload.message || `Processed ${results.length} ticker${results.length === 1 ? '' : 's'}.`) + cacheNote;
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
      headers: buildFunctionHeaders(),
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
      updateStage2Metrics(
        {
          total: Number(payload.metrics.total_survivors ?? payload.metrics.total ?? 0),
          pending: Number(payload.metrics.pending ?? 0),
          completed: Number(payload.metrics.completed ?? 0),
          failed: Number(payload.metrics.failed ?? 0),
          goDeep: Number(payload.metrics.go_deep ?? payload.metrics.goDeep ?? 0)
        },
        payload.retrieval ?? null
      );
    }

    const cacheNote = payload.cache_hits ? ` (cached ${payload.cache_hits})` : '';
    const message = (payload.message || `Processed ${results.length} ticker${results.length === 1 ? '' : 's'}.`) + cacheNote;
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
      headers: buildFunctionHeaders(),
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
      updateStage3Metrics(
        {
          finalists: Number(payload.metrics.total_finalists ?? payload.metrics.finalists ?? payload.metrics.total ?? 0),
          pending: Number(payload.metrics.pending ?? 0),
          completed: Number(payload.metrics.completed ?? 0),
          failed: Number(payload.metrics.failed ?? 0),
          spend: Number(payload.metrics.spend ?? payload.metrics.total_spend ?? 0)
        },
        payload.retrieval ?? null
      );
    }

    const cacheNote = payload.cache_hits ? ` (cached ${payload.cache_hits})` : '';
    const message = (payload.message || `Processed ${reports.length} finalist${reports.length === 1 ? '' : 's'}.`) + cacheNote;
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

  updateScopeStatusMessage(plannerScope.mode, getWatchlistById(plannerScope.watchlistId), plannerScope.customTickers);
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
      : authContext.membershipActive
        ? 'member'
        : 'no-membership';

  const haltRequested = (currentRunMeta?.stop_requested ?? false) || (currentRunMeta?.budget_exhausted ?? false);

  updateAutoContinueAvailability();
  updateFollowupAccess();

  const schedulerReady = state === 'admin-ok' && Boolean(activeRunId);
  const schedulerDisabled = !schedulerReady || schedulerLoading;
  if (inputs.schedulerEnabled) {
    inputs.schedulerEnabled.disabled = schedulerDisabled;
  }
  [
    inputs.schedulerCadence,
    inputs.schedulerStage1,
    inputs.schedulerStage2,
    inputs.schedulerStage3,
    inputs.schedulerCycles
  ].forEach((input) => {
    if (input) input.disabled = schedulerDisabled;
  });
  if (inputs.schedulerSaveBtn) {
    inputs.schedulerSaveBtn.disabled = schedulerDisabled;
  }
  if (inputs.schedulerRefreshBtn) {
    inputs.schedulerRefreshBtn.disabled = !activeRunId || schedulerLoading;
  }

  if (inputs.observabilityPanel) {
    const shouldShow = state === 'admin-ok';
    inputs.observabilityPanel.hidden = !shouldShow;
    if (shouldShow && previousState !== 'admin-ok') {
      refreshHealthStatus({ silent: true });
      refreshErrorLogs({ silent: true });
    }
    if (!shouldShow) {
      setErrorLogStatus('');
    }
  }

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

  if (inputs.watchlistManager) {
    inputs.watchlistManager.hidden = state !== 'admin-ok';
  }

  if (inputs.focusPanel) {
    inputs.focusPanel.hidden = state !== 'admin-ok';
  }

  if (inputs.notificationsSection) {
    const visible = state === 'admin-ok';
    inputs.notificationsSection.hidden = !visible;
    if (!visible) {
      setNotificationStatus('Admin access required to manage alerts.', 'muted');
    } else if (!notificationChannels.length) {
      setNotificationStatus('Add a channel to start receiving alerts.');
    } else {
      setNotificationStatus('');
    }
  }

  if (inputs.notificationForm) {
    const controls = inputs.notificationForm.querySelectorAll('input, select');
    controls.forEach((element) => {
      element.disabled = state !== 'admin-ok';
    });
  }
  if (inputs.notificationSaveBtn) {
    inputs.notificationSaveBtn.disabled = state !== 'admin-ok' || notificationSubmitting;
  }

  const focusDisabled = state !== 'admin-ok' || !activeRunId || focusLoading;
  if (inputs.focusRefreshBtn) {
    inputs.focusRefreshBtn.disabled = state !== 'admin-ok' || !activeRunId;
  }
  if (inputs.focusSubmitBtn) {
    inputs.focusSubmitBtn.disabled = focusDisabled;
  }
  if (inputs.focusTicker) {
    inputs.focusTicker.disabled = focusDisabled;
  }
  if (inputs.focusCustomQuestion) {
    inputs.focusCustomQuestion.disabled = focusDisabled;
  }
  if (inputs.focusTemplates) {
    inputs.focusTemplates.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.disabled = focusDisabled;
    });
  }

  if (state !== 'admin-ok' && plannerScope.mode === 'watchlist') {
    plannerScope.mode = 'universe';
    applyScopeSettings(plannerScope, { fromSettings: true });
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
      else if (state === 'member') inputs.status.textContent = 'Read-only member access';
      else if (state === 'no-membership') inputs.status.textContent = 'Membership required';
      else inputs.status.textContent = 'Admin access required';
    }

    const logMessage = state === 'admin-ok'
      ? 'Authenticated as admin. Automation ready to launch.'
      : state === 'signed-out'
        ? 'Sign in to launch automated runs.'
        : state === 'member'
          ? 'Read-only mode: membership active. Contact an administrator to run the automation.'
          : state === 'no-membership'
            ? 'Launch blocked: activate a FutureFunds.ai membership to access automation.'
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
  if (authContext.isAdmin) {
    loadWatchlists({ silent: true }).catch((error) => {
      console.error('Failed to refresh watchlists during access sync', error);
    });
    refreshNotificationData({ silent: true }).catch((error) => {
      console.error('Failed to refresh notification channels during access sync', error);
    });
  } else {
    watchlists = [];
    watchlistMap.clear();
    watchlistEntriesCache.clear();
    renderWatchlistOptions();
    renderNotificationWatchlistOptions();
    notificationChannels = [];
    notificationEvents = [];
    renderNotificationChannels();
    renderNotificationEvents();
    updateScopeUI({ fromSettings: true });
  }
  if (activeRunId && authContext.user && (authContext.isAdmin || authContext.membershipActive)) {
    refreshFollowupTickers({ silent: true }).catch((error) => {
      console.warn('Failed to refresh follow-up tickers during access sync', error);
    });
    refreshFollowupList({ silent: true }).catch((error) => {
      console.warn('Failed to refresh follow-up requests during access sync', error);
    });
    if (authContext.isAdmin) {
      fetchFocusData({ silent: true }).catch((error) => {
        console.warn('Failed to refresh focus questions during access sync', error);
      });
    }
  }
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

  if (settings.scope?.mode === 'watchlist' && !settings.scope.watchlistId) {
    inputs.status.textContent = 'Choose a watchlist before launching.';
    logStatus('Launch blocked: no watchlist selected.');
    inputs.startBtn.disabled = false;
    return;
  }

  if (settings.scope?.mode === 'custom' && (!settings.scope.customTickers || settings.scope.customTickers.length === 0)) {
    inputs.status.textContent = 'Add at least one custom ticker before launching.';
    logStatus('Launch blocked: custom ticker list empty.');
    inputs.startBtn.disabled = false;
    return;
  }

  try {
    const response = await fetch(RUNS_CREATE_ENDPOINT, {
      method: 'POST',
      headers: buildFunctionHeaders(),
      body: JSON.stringify({
        planner: settings,
        budget_usd: settings.budgetUsd,
        scope: settings.scope,
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
    console.error('Automated run launch failed', error);
    const message = typeof error?.message === 'string' && error.message.trim().length > 0
      ? error.message
      : 'Launch failed: unexpected error (see console for details).';
    inputs.status.textContent = message;
    logStatus(`Launch failed: ${message}`);
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

function formatRelativeTimestamp(value) {
  if (!value) return 'Just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Just now';
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) {
    const minutes = Math.floor(delta / 60_000);
    return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  }
  if (delta < 86_400_000) {
    const hours = Math.floor(delta / 3_600_000);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return date.toLocaleString();
}

function updateHealthCard(card, statusEl, detailEl, check) {
  if (!card || !statusEl || !detailEl) return;
  const status = check?.status || 'unknown';
  card.dataset.status = status;
  let label = 'Unknown';
  if (status === 'ok') label = 'Operational';
  else if (status === 'degraded') label = 'Degraded';
  else if (status === 'error') label = 'Offline';
  statusEl.textContent = label;
  const latency = typeof check?.latency_ms === 'number' ? ` · ${check.latency_ms} ms` : '';
  detailEl.textContent = check?.message ? `${check.message}${latency}` : `Awaiting check${latency}`;
}

async function refreshHealthStatus({ silent = false } = {}) {
  if (!authContext.isAdmin || !authContext.token) return;
  if (healthLoading) return;
  healthLoading = true;
  if (!silent && inputs.healthCheckedAt) {
    inputs.healthCheckedAt.textContent = 'Checking worker health…';
  }
  try {
    const response = await fetch(HEALTH_ENDPOINT, {
      headers: buildFunctionHeaders({ json: false })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error || `Health check failed (${response.status})`);
    }
    updateHealthCard(
      inputs.healthDatabaseCard,
      inputs.healthDatabaseStatus,
      inputs.healthDatabaseDetail,
      data?.checks?.database
    );
    updateHealthCard(
      inputs.healthOpenAICard,
      inputs.healthOpenAIStatus,
      inputs.healthOpenAIDetail,
      data?.checks?.openai
    );
    if (inputs.healthCheckedAt) {
      inputs.healthCheckedAt.textContent = `Last checked ${formatRelativeTimestamp(data?.timestamp)}`;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateHealthCard(
      inputs.healthDatabaseCard,
      inputs.healthDatabaseStatus,
      inputs.healthDatabaseDetail,
      { status: 'error', message }
    );
    updateHealthCard(
      inputs.healthOpenAICard,
      inputs.healthOpenAIStatus,
      inputs.healthOpenAIDetail,
      { status: 'error', message }
    );
    if (inputs.healthCheckedAt) {
      inputs.healthCheckedAt.textContent = `Health check failed: ${message}`;
    }
  } finally {
    healthLoading = false;
  }
}

function setErrorLogStatus(message) {
  if (inputs.errorLogStatus) {
    inputs.errorLogStatus.textContent = message || '';
  }
}

function renderErrorLogs(rows) {
  const tbody = inputs.errorLogBody;
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!rows.length) {
    const emptyRow = document.createElement('tr');
    emptyRow.className = 'error-log__empty';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = 'No failures recorded in the last 50 entries.';
    emptyRow.append(cell);
    tbody.append(emptyRow);
    return;
  }

  rows.forEach((row) => {
    const tr = document.createElement('tr');

    const whenCell = document.createElement('td');
    const created = row.created_at ? new Date(row.created_at) : null;
    whenCell.textContent = created ? created.toLocaleString() : '—';
    tr.append(whenCell);

    const stageCell = document.createElement('td');
    stageCell.textContent = Number.isFinite(row.stage) ? `Stage ${row.stage}` : row.context || '—';
    tr.append(stageCell);

    const tickerCell = document.createElement('td');
    tickerCell.textContent = row.ticker || '—';
    tr.append(tickerCell);

    const promptCell = document.createElement('td');
    promptCell.textContent = row.prompt_id || row.context || '—';
    tr.append(promptCell);

    const messageCell = document.createElement('td');
    const summary = document.createElement('div');
    summary.className = 'error-log__message';
    summary.textContent = row.message || '—';
    messageCell.append(summary);
    if (row.payload || row.metadata) {
      const details = document.createElement('details');
      details.className = 'error-log__details';
      const summaryEl = document.createElement('summary');
      summaryEl.textContent = 'Payload';
      details.append(summaryEl);
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify({ payload: row.payload, metadata: row.metadata }, null, 2);
      details.append(pre);
      messageCell.append(details);
    }
    tr.append(messageCell);

    const retryCell = document.createElement('td');
    retryCell.textContent = Number.isFinite(row.retry_count) ? String(row.retry_count) : '0';
    tr.append(retryCell);

    tbody.append(tr);
  });
}

async function refreshErrorLogs({ silent = false } = {}) {
  if (!authContext.isAdmin) return;
  if (errorLogLoading) return;
  errorLogLoading = true;
  if (!silent) setErrorLogStatus('Loading error history…');
  try {
    const { data, error } = await supabase
      .from('error_logs')
      .select('id, created_at, stage, ticker, prompt_id, message, retry_count, context, payload, metadata')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    errorLogRows = data || [];
    renderErrorLogs(errorLogRows);
    setErrorLogStatus(`Updated ${formatRelativeTimestamp(new Date().toISOString())}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setErrorLogStatus(`Failed to load error logs: ${message}`);
    renderErrorLogs([]);
  } finally {
    errorLogLoading = false;
  }
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
  scopeRadios.forEach((radio) => radio.addEventListener('change', handleScopeChange));
  inputs.watchlistSelect?.addEventListener('change', handleWatchlistSelect);
  inputs.customTickers?.addEventListener('input', handleCustomTickerInput);
  inputs.refreshWatchlistsBtn?.addEventListener('click', () => {
    loadWatchlists({ silent: false }).catch((error) => {
      console.error('Failed to refresh watchlists', error);
    });
  });
  inputs.createWatchlistForm?.addEventListener('submit', handleCreateWatchlist);
  inputs.addWatchlistTickerForm?.addEventListener('submit', handleAddWatchlistTicker);
  inputs.refreshWatchlistEntriesBtn?.addEventListener('click', () => {
    if (!plannerScope.watchlistId) return;
    loadWatchlistEntries(plannerScope.watchlistId, { force: true, silent: false }).catch((error) => {
      console.error('Failed to refresh watchlist entries', error);
    });
  });
  inputs.watchlistEntriesBody?.addEventListener('click', handleWatchlistEntryClick);
  inputs.refreshHealthBtn?.addEventListener('click', () => refreshHealthStatus());
  inputs.refreshErrorsBtn?.addEventListener('click', () => refreshErrorLogs());
  inputs.autoContinueToggle?.addEventListener('change', handleAutoContinueToggle);
  inputs.autoContinueInterval?.addEventListener('change', () => {
    if (!autoContinueActive) return;
    if (autoContinueInFlight) return;
    scheduleAutoContinue();
    updateAutoContinueStatus(`Auto continue interval set to ${inputs.autoContinueInterval.value || AUTO_CONTINUE_DEFAULT_SECONDS} seconds.`);
  });

  inputs.schedulerSaveBtn?.addEventListener('click', () => {
    saveRunSchedule().catch((error) => {
      console.error('Failed to save schedule', error);
    });
  });
  inputs.schedulerRefreshBtn?.addEventListener('click', () => {
    fetchRunSchedule({ silent: false }).catch((error) => {
      console.error('Failed to refresh schedule', error);
    });
  });
  inputs.schedulerEnabled?.addEventListener('change', () => {
    if (!inputs.schedulerEnabled) return;
    const message = inputs.schedulerEnabled.checked
      ? 'Scheduler enabled. Save changes to activate unattended dispatch.'
      : 'Scheduler disabled. Save changes to pause unattended dispatch.';
    markSchedulerDirty(message);
    applyAccessState({ preserveStatus: true });
  });
  [
    inputs.schedulerCadence,
    inputs.schedulerStage1,
    inputs.schedulerStage2,
    inputs.schedulerStage3,
    inputs.schedulerCycles
  ].forEach((input) => {
    input?.addEventListener('input', () => markSchedulerDirty());
  });

  inputs.notificationForm?.addEventListener('submit', submitNotificationChannel);
  inputs.refreshNotificationsBtn?.addEventListener('click', () => {
    refreshNotificationData({ silent: false }).catch((error) => {
      console.error('Failed to refresh notification channels', error);
    });
  });
  inputs.notificationsSection?.addEventListener('click', handleNotificationAction);

  inputs.followupForm?.addEventListener('submit', submitFollowupRequest);
  inputs.followupRefreshBtn?.addEventListener('click', () => {
    refreshFollowupList({ silent: false }).catch((error) => {
      console.error('Failed to refresh follow-up requests', error);
    });
  });
  inputs.focusForm?.addEventListener('submit', submitFocusForm);
  inputs.focusRefreshBtn?.addEventListener('click', () => {
    fetchFocusData({ silent: false }).catch((error) => {
      console.error('Failed to refresh focus questions', error);
    });
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
    resetFollowupUI('No active run selected.');
  }

  await syncAccess();

  if (activeRunId) {
    fetchRunSchedule({ silent: true }).catch((error) => {
      console.error('Failed to refresh run schedule after access sync', error);
    });
  }

  supabase.auth.onAuthStateChange(async () => {
    await syncAccess();
    if (activeRunId) {
      fetchRunSchedule({ silent: true }).catch((error) => {
        console.error('Failed to refresh run schedule after auth change', error);
      });
      refreshFollowupList({ silent: true }).catch((error) => {
        console.warn('Failed to refresh follow-up requests after auth change', error);
      });
      refreshFollowupTickers({ silent: true }).catch((error) => {
        console.warn('Failed to refresh follow-up tickers after auth change', error);
      });
    }
  });
}

initCredentialManager();
bootstrap();
