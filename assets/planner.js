import { supabase, ensureProfile, hasAdminRole, isMembershipActive, SUPABASE_URL } from './supabase.js';

const STORAGE_KEY = 'ff-planner-settings-v1';
const PRICES = {
  '5': { in: 1.25, out: 10.0 },
  '5-mini': { in: 0.25, out: 2.0 },
  '4o-mini': { in: 0.15, out: 0.60 }
};

const defaults = {
  universe: 40000,
  surviveStage2: 15,
  surviveStage3: 12,
  stage1: { model: '4o-mini', inTokens: 3000, outTokens: 600 },
  stage2: { model: '5-mini', inTokens: 30000, outTokens: 6000 },
  stage3: { model: '5', inTokens: 100000, outTokens: 20000 }
};

const $ = (id) => document.getElementById(id);

const inputs = {
  universe: $('universeInput'),
  stage2Slider: $('stage2Slider'),
  stage3Slider: $('stage3Slider'),
  stage1Model: $('modelStage1'),
  stage2Model: $('modelStage2'),
  stage3Model: $('modelStage3'),
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
  stage2Value: $('stage2Value'),
  stage3Value: $('stage3Value'),
  startBtn: $('startRunBtn'),
  resetBtn: $('resetDefaultsBtn')
};

const FUNCTIONS_BASE = SUPABASE_URL.replace(/\.supabase\.co$/, '.functions.supabase.co');
const RUNS_CREATE_ENDPOINT = `${FUNCTIONS_BASE}/runs-create`;

let authContext = {
  user: null,
  profile: null,
  membership: null,
  token: null,
  isAdmin: false,
  membershipActive: false
};
let lastAccessState = 'unknown';

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
      stage3: { ...defaults.stage3, ...saved.stage3 }
    };
  } catch (error) {
    console.warn('Unable to parse saved planner settings', error);
    return { ...defaults };
  }
}

function persistSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function getSettingsFromInputs() {
  return {
    universe: Number(inputs.universe?.value) || 0,
    surviveStage2: Number(inputs.stage2Slider?.value) || 0,
    surviveStage3: Number(inputs.stage3Slider?.value) || 0,
    stage1: {
      model: inputs.stage1Model?.value || defaults.stage1.model,
      inTokens: Number(inputs.stage1In?.value) || 0,
      outTokens: Number(inputs.stage1Out?.value) || 0
    },
    stage2: {
      model: inputs.stage2Model?.value || defaults.stage2.model,
      inTokens: Number(inputs.stage2In?.value) || 0,
      outTokens: Number(inputs.stage2Out?.value) || 0
    },
    stage3: {
      model: inputs.stage3Model?.value || defaults.stage3.model,
      inTokens: Number(inputs.stage3In?.value) || 0,
      outTokens: Number(inputs.stage3Out?.value) || 0
    }
  };
}

function applySettings(settings) {
  if (!inputs.startBtn) return;
  inputs.universe.value = settings.universe;
  inputs.stage2Slider.value = settings.surviveStage2;
  inputs.stage3Slider.value = settings.surviveStage3;
  inputs.stage2Value.textContent = `${settings.surviveStage2}%`;
  inputs.stage3Value.textContent = `${settings.surviveStage3}%`;
  inputs.stage1Model.value = settings.stage1.model;
  inputs.stage1In.value = settings.stage1.inTokens;
  inputs.stage1Out.value = settings.stage1.outTokens;
  inputs.stage2Model.value = settings.stage2.model;
  inputs.stage2In.value = settings.stage2.inTokens;
  inputs.stage2Out.value = settings.stage2.outTokens;
  inputs.stage3Model.value = settings.stage3.model;
  inputs.stage3In.value = settings.stage3.inTokens;
  inputs.stage3Out.value = settings.stage3.outTokens;
}

function stageCost(n, inTok, outTok, modelKey) {
  const model = PRICES[modelKey];
  if (!model || !n) return { total: 0, inCost: 0, outCost: 0 };
  const inCost = (n * inTok / 1_000_000) * model.in;
  const outCost = (n * outTok / 1_000_000) * model.out;
  return { total: inCost + outCost, inCost, outCost };
}

function formatCurrency(amount) {
  return `$${amount.toFixed(2)}`;
}

function updateCostOutput() {
  if (!inputs.costOut) return;
  const settings = getSettingsFromInputs();
  persistSettings(settings);

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
}

function logStatus(message) {
  if (!inputs.log) return;
  const now = new Date();
  const timestamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  inputs.log.textContent = `[${timestamp}] ${message}\n\n${inputs.log.textContent}`.trim();
}

function applyAccessState({ preserveStatus = false } = {}) {
  if (!inputs.startBtn || !inputs.status) return;
  const state = !authContext.user
    ? 'signed-out'
    : authContext.isAdmin
      ? 'admin-ok'
      : 'no-admin';

  if (state === 'admin-ok') {
    inputs.startBtn.disabled = false;
  } else {
    inputs.startBtn.disabled = true;
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
    inputs.status.textContent = `Run created: ${data.run_id || 'unknown id'}`;
    const total = typeof data.total_items === 'number' ? data.total_items : 'n/a';
    logStatus(`Run created successfully with ${total} tickers queued.`);
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
  if (!inputs.startBtn) return;
  const watchedInputs = [
    inputs.universe,
    inputs.stage2Slider,
    inputs.stage3Slider,
    inputs.stage1Model,
    inputs.stage2Model,
    inputs.stage3Model,
    inputs.stage1In,
    inputs.stage1Out,
    inputs.stage2In,
    inputs.stage2Out,
    inputs.stage3In,
    inputs.stage3Out
  ].filter(Boolean);

  watchedInputs.forEach((element) => {
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

  inputs.startBtn.addEventListener('click', startRun);
  inputs.resetBtn?.addEventListener('click', resetDefaults);
}

async function bootstrap() {
  if (!inputs.startBtn || !inputs.log) {
    console.warn('Planner controls missing. Skipping initialisation.');
    return;
  }

  const initialSettings = loadSettings();
  applySettings(initialSettings);
  bindEvents();
  updateCostOutput();
  logStatus('Planner ready. Configure and launch when models are wired.');
  inputs.status.textContent = 'Checking access…';

  await syncAccess();

  supabase.auth.onAuthStateChange(async () => {
    await syncAccess();
  });
}

bootstrap();
