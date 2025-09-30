// /assets/editor.js
import { supabase } from './supabase.js';
import { onAuthReady, getAccountState, hasRole, refreshAuthState } from './auth.js';
import { describeSupabaseError, composePromptSummary } from './editor-support.js';

const PROMPT_TABLE = 'editor_prompts';
const MODEL_TABLE = 'editor_models';

const DEFAULT_PROMPTS = [
  {
    id: 'quick-assessment',
    name: 'Quick assessment',
    description: 'High-level scan to see if the stock merits more work.',
    prompt_text: String.raw`You are the FutureFunds.ai research analyst. Produce a concise INVESTMENT SNAPSHOT for {{company_line}}.

Deliverables:
1. One short paragraph describing the setup, momentum and why the stock is on the radar.
2. Markdown table titled "Fast Verdict" with columns Metric | Score (/10) | Rationale for Risk, Quality and Timing.
3. Bullet list with the three most important catalysts or red flags (mix of positives/negatives as appropriate).
4. Final line starting with "Overall verdict:" that clearly states Interesting / Monitor / Pass.

Stay under 250 words, be decisive and actionable.{{notes_block}}

Return only Markdown.`,
  },
  {
    id: 'deep-research',
    name: 'Deep research master analysis',
    description: 'Full MASTER STOCK ANALYSIS structure with valuation tables.',
    prompt_text: String.raw`You are the FutureFunds.ai research analyst. Produce a MASTER STOCK ANALYSIS (Markdown-Table Edition) for {{company}} (Ticker: {{ticker}}{{exchange_suffix}}). Match the structure of the reference template exactly.

Follow this order and formatting:
1. Intro sentence: "Below is a MASTER STOCK ANALYSIS (Markdown-Table Edition) for {{company}} (Ticker: {{ticker}}{{exchange_suffix}}) — ..." with a short rationale.
2. Insert a line containing only ⸻ between every major section.
3. Section A. One-Liner Summary — Markdown table with columns Ticker | Risk | Quality | Timing | Composite Score (/10).
4. Section B. Final Verdicts — One Line — list Risk, Quality, Timing values.
5. Section C. Standardized Scorecard — One Line — Markdown table with the six specified metrics.
6. Section D. Valuation Ranges — provide USD bear/base/bull table and paragraph with NOK conversions.
7. Narrative section — short paragraph plus bullet list of pricing, market cap, revenue, catalysts.
8. Sections 1 through 5 with the same headings (Downside & Risk Analysis; Business Model & Growth Opportunities; Scenario Analysis (include Markdown table with Bear/Base/Bull rows and valuation ranges); Valuation Analysis; Timing & Market Momentum). Use concise bullet points with data.
9. Section 6. Final Conclusions — bullet lines for Risk, Quality, Timing plus an "Overall Verdict" sentence.
10. Finish with a note paragraph starting with 🚩 Note:.

Requirements:
- Use realistic figures and ratings based on the latest publicly available information and reasonable assumptions.
- Keep bullet points sharp and decision-oriented.
- Ensure Markdown tables use pipes and render cleanly.
- Maintain the same tone as the template (professional, catalyst-aware).{{notes_block}}

Return only the Markdown content.`,
  },
  {
    id: 'company-drilldown',
    name: 'Company deep dive',
    description: 'Emphasises business model, moat and forward roadmap.',
    prompt_text: String.raw`You are the FutureFunds.ai research analyst. Prepare a COMPANY DEEP DIVE briefing on {{company_line}}.

Structure the output in Markdown:
- Opening paragraph summarising the company, current sentiment and why it matters now.
- "Why it wins" section with bullets on moat, product edge and customer adoption.
- "Key numbers" Markdown table with Revenue (latest FY), YoY Growth %, Gross Margin %, EBITDA Margin %, Net Cash/(Debt), Market Cap.
- "Forward roadmap" bullet list covering catalysts in the next 12-24 months (product, regulatory, capital markets).
- "Risks we're tracking" bullet list with mitigation notes.
- Closing line beginning "Investment stance:" that states Buy / Watch / Avoid with a one-sentence justification.{{notes_block}}

Keep it crisp, factual and focused on what an investment committee needs.`,
  },
];

const DEFAULT_MODELS = [
  { value: 'openrouter/auto', label: 'OpenRouter Auto', is_default: true },
  { value: 'openai/gpt-4.1-mini', label: 'OpenAI GPT-4.1 Mini' },
  { value: 'anthropic/claude-3.5-sonnet', label: 'Anthropic Claude 3.5 Sonnet' },
];

const DEFAULT_OPENROUTER_API_KEY = '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';

// Normalise OpenRouter keys that may include "Bearer" prefixes or hidden whitespace when pasted
// from password managers / database consoles.
const normalizeOpenRouterApiKey = (value) => {
  if (!value) return '';
  return value
    .toString()
    .normalize('NFKC')
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .trim()
    .replace(/^bearer\s+/i, '')
    .replace(/\s+/g, '');
};

function setupProcessProgress(listEl) {
  if (!listEl) return null;

  const steps = Array.from(listEl.querySelectorAll('[data-step-id]')).map((element, index) => {
    const icon = element.querySelector('.process-step__icon');
    if (icon && !icon.dataset.step) {
      icon.dataset.step = String(index + 1);
    }

    return {
      id: element.dataset.stepId || `step-${index + 1}`,
      element,
      icon,
    };
  });

  if (!steps.length) return null;

  const allowedStatuses = new Set(['complete', 'active', 'upcoming']);

  const normalizeStatus = (status) => (allowedStatuses.has(status) ? status : 'upcoming');

  const setStatusForIndex = (index, status) => {
    const step = steps[index];
    if (!step) return;
    const normalized = normalizeStatus(status);
    step.element.dataset.status = normalized;
    if (step.icon) {
      step.icon.dataset.state = normalized;
    }
  };

  const resolveIndex = (value) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      return steps.findIndex((step) => step.id === value);
    }
    return -1;
  };

  let currentIndex = steps.findIndex((step) => step.element.dataset.status === 'active');

  const setActiveIndex = (index) => {
    if (index < 0 || index >= steps.length) return;
    currentIndex = index;
    steps.forEach((step, idx) => {
      if (idx < index) {
        setStatusForIndex(idx, 'complete');
      } else if (idx === index) {
        setStatusForIndex(idx, 'active');
      } else {
        setStatusForIndex(idx, 'upcoming');
      }
    });
  };

  const markCompleteIndex = (index) => {
    if (index < 0 || index >= steps.length) return;
    setStatusForIndex(index, 'complete');
    if (index === currentIndex) {
      if (index < steps.length - 1) {
        setActiveIndex(index + 1);
      } else {
        currentIndex = steps.length;
      }
    }
  };

  if (currentIndex >= 0) {
    setActiveIndex(currentIndex);
  } else {
    const nextIndex = steps.findIndex((step) => step.element.dataset.status !== 'complete');
    if (nextIndex === -1) {
      steps.forEach((_, idx) => setStatusForIndex(idx, 'complete'));
      currentIndex = steps.length;
    } else {
      setActiveIndex(nextIndex);
    }
  }

  const controller = {
    list: listEl,
    steps: steps.map((step) => step.id),
    get currentIndex() {
      return currentIndex;
    },
    setActive(target) {
      const index = resolveIndex(target);
      if (index < 0 || index >= steps.length) return;
      setActiveIndex(index);
    },
    markComplete(target) {
      const index = resolveIndex(target);
      if (index < 0 || index >= steps.length) return;
      markCompleteIndex(index);
    },
    advance() {
      if (currentIndex < 0 || currentIndex >= steps.length) return;
      markCompleteIndex(currentIndex);
    },
    reset() {
      if (!steps.length) return;
      currentIndex = 0;
      steps.forEach((_, idx) => {
        setStatusForIndex(idx, idx === 0 ? 'active' : 'upcoming');
      });
    },
  };

  listEl.ffEditorProgress = controller;
  if (typeof window !== 'undefined') {
    window.ffEditorProgress = controller;
  }

  if (listEl.dataset.autoCycle === 'true') {
    controller.reset();
    const intervalValue = Number(listEl.dataset.demoInterval);
    const isFiniteNumber = typeof Number.isFinite === 'function' ? Number.isFinite(intervalValue) : isFinite(intervalValue);
    const interval = isFiniteNumber && intervalValue > 0 ? intervalValue : 2400;
    let pointer = 0;

    const runDemo = () => {
      if (pointer >= steps.length) return;
      setTimeout(() => {
        controller.markComplete(pointer);
        pointer += 1;
        runDemo();
      }, interval);
    };

    runDemo();
  }

  return controller;
}

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
  const topicInput = document.getElementById('analysisTopic');
  const conclusionInput = document.getElementById('analysisConclusion');
  const findingsInput = document.getElementById('analysisFindings');
  const visualInput = document.getElementById('analysisVisual');
  const tagsInput = document.getElementById('analysisTags');
  const promptInput = document.getElementById('analysisPrompt');
  const analysisRaw = document.getElementById('analysisRaw');
  const parseBtn = document.getElementById('parseAnalysis');
  const clearAnalysisBtn = document.getElementById('clearAnalysis');
  const analysisStatus = document.getElementById('analysisStatus');
  const modeButtons = Array.from(document.querySelectorAll('[data-analysis-mode]'));
  const analysisPanels = Array.from(document.querySelectorAll('.analysis-source__panel'));
  const aiGenerateBtn = document.getElementById('generateAnalysis');
  const aiTicker = document.getElementById('aiTicker');
  const aiCompany = document.getElementById('aiCompany');
  const aiExchange = document.getElementById('aiExchange');
  const aiNotes = document.getElementById('aiNotes');
  const aiKey = document.getElementById('aiKey');
  const aiKeyRefreshBtn = document.getElementById('refreshAiKey');
  const aiKeyStatus = document.getElementById('aiKeyStatus');
  const aiKeyPreview = document.getElementById('aiKeyPreview');
  const aiKeyPreviewValue = document.getElementById('aiKeyPreviewValue');
  const aiModel = document.getElementById('aiModel');
  const taskNameInput = document.getElementById('taskName');
  const taskTitle = document.getElementById('analysisTaskTitle');
  const taskLaunchButtons = Array.from(document.querySelectorAll('[data-task-modal-target]'));
  const taskLaunchBtn = document.getElementById('openTaskModal');
  const taskLaunchSubtitle = taskLaunchBtn?.querySelector('.task-launch-card__subtitle');
  const taskModal = document.getElementById('analysisTaskModal');
  const taskModalBackdrop = taskModal?.querySelector('[data-close-task]');
  const taskModalCloseBtn = document.getElementById('closeTaskModal');
  const taskLockedMessage = document.getElementById('taskLockedMessage');
  const taskLockedMessageText = document.getElementById('taskLockedMessageText');
  const taskLockedActionBtn = document.getElementById('taskLockedAction');
  const promptSelectBtn = document.getElementById('promptSelectBtn');
  const promptSelectLabel = document.getElementById('promptSelectLabel');
  const promptMenu = document.getElementById('promptMenu');
  const promptSummary = document.getElementById('promptSummary');
  const promptPreview = document.getElementById('promptPreview');
  const editModelBtn = document.getElementById('editModelList');
  const modelEditorInput = document.getElementById('modelEditorInput');
  const modelEditorStatus = document.getElementById('modelEditorStatus');
  const saveModelBtn = document.getElementById('saveModelList');
  const cancelModelBtn = document.getElementById('cancelModelList');
  const modelEditorModal = document.getElementById('modelEditorModal');
  const modelEditorBackdrop = modelEditorModal?.querySelector('[data-close-model]');
  const modelEditorCloseBtn = document.getElementById('closeModelEditor');
  const promptEditorOpenBtn = document.getElementById('openPromptEditor');
  const promptEditorModal = document.getElementById('promptEditorModal');
  const promptEditorList = document.getElementById('promptEditorList');
  const promptEditorForm = document.getElementById('promptEditorForm');
  const promptEditorStatus = document.getElementById('promptEditorStatus');
  const promptEditorId = document.getElementById('promptEditorId');
  const promptEditorName = document.getElementById('promptEditorName');
  const promptEditorSlug = document.getElementById('promptEditorSlug');
  const promptEditorSlugHelp = document.getElementById('promptEditorSlugHelp');
  const promptEditorDescription = document.getElementById('promptEditorDescription');
  const promptEditorText = document.getElementById('promptEditorText');
  const promptEditorSortOrder = document.getElementById('promptEditorSortOrder');
  const promptEditorDefault = document.getElementById('promptEditorDefault');
  const promptEditorArchived = document.getElementById('promptEditorArchived');
  const promptEditorCloseBtn = document.getElementById('closePromptEditor');
  const promptEditorCancelBtn = document.getElementById('cancelPromptEditor');
  const promptEditorNewBtn = document.getElementById('addPromptTemplate');
  const promptEditorDeleteBtn = document.getElementById('deletePromptEditor');
  const promptEditorBackdrop = promptEditorModal?.querySelector('[data-close-prompt]');
  const promptEditorSaveBtn = document.getElementById('savePromptEditor');
  const analystLastName = document.getElementById('analystLastName');
  const analystDateStamp = document.getElementById('analystDateStamp');
  const aiSettingsModel = document.getElementById('aiSettingsModel');
  const aiSettingsPrompt = document.getElementById('aiSettingsPrompt');
  const aiSettingsKey = document.getElementById('aiSettingsKey');
  const coverageFormCard = document.querySelector('.coverage-meta__form-card');
  const automationLaunchButtons = Array.from(document.querySelectorAll('[data-automation-modal-target="automationSettingsModal"]'));
  const automationModal = document.getElementById('automationSettingsModal');
  const automationModalBackdrop = automationModal?.querySelector('[data-close-automation]');
  const automationModalCloseBtn = document.getElementById('closeAutomationModal');
  const automationModalCancelBtn = document.getElementById('cancelAutomationModal');
  const automationSettingsForm = document.getElementById('automationSettingsForm');
  const automationSequenceGroup = document.getElementById('automationSequenceGroup');
  const automationModeInputs = Array.from(document.querySelectorAll('input[name="automationMode"]'));
  const automationStatsGroups = Array.from(document.querySelectorAll('.automation-stats[data-scheduled]'));
  const costSnapshotButton = document.getElementById('openCostModal');
  const costSnapshotSummary = document.getElementById('costSnapshotSummary');
  const costModal = document.getElementById('costSnapshotModal');
  const costModalBackdrop = costModal?.querySelector('[data-close-cost]');
  const costModalCloseBtn = document.getElementById('closeCostModal');
  const costModalFooterCloseBtn = document.getElementById('closeCostModalFooter');
  const costRefreshBtn = document.getElementById('refreshCostBalance');
  const costCaptureBtn = document.getElementById('captureCostSnapshot');
  const costClearBtn = document.getElementById('clearCostSnapshots');
  const costStatus = document.getElementById('costBalanceStatus');
  const costProviderLabel = document.getElementById('costProviderLabel');
  const costRemainingValue = document.getElementById('costRemainingValue');
  const costUsageValue = document.getElementById('costUsageValue');
  const costManualInput = document.getElementById('costManualUsage');
  const costManualUnit = document.getElementById('costManualUnit');
  const costSnapshotsList = document.getElementById('costSnapshotsList');
  const costSnapshotsEmpty = document.getElementById('costSnapshotsEmpty');

  const syncCoverageOptionalState = () => {
    if (!coverageFormCard) return;
    const hasCompany = !!(aiCompany?.value || '').trim();
    coverageFormCard.classList.toggle('coverage-meta__form-card--has-company', hasCompany);
  };

  syncCoverageOptionalState();

  if (aiCompany) {
    ['input', 'change', 'blur'].forEach((evt) => {
      aiCompany.addEventListener(evt, syncCoverageOptionalState);
    });
  }

  if (form) {
    form.addEventListener('reset', () => {
      requestAnimationFrame(() => syncCoverageOptionalState());
    });
  }

  setupProcessProgress(document.getElementById('analysisProgress'));

  const AI_KEY_STORAGE = 'ff-editor-ai-key';
  const AI_MODEL_STORAGE = 'ff-editor-ai-model';
  const AI_PROMPT_STORAGE = 'ff-editor-ai-prompt';
  const COST_SNAPSHOTS_STORAGE = 'ff-editor-cost-snapshots';
  const MAX_COST_SNAPSHOTS = 20;

  let promptOptions = [];
  let modelOptions = [];
  let selectedPrompt = null;
  let desiredPromptId = null;
  let desiredModelValue = null;
  let supabaseAiKeyCache = null;
  let promptEditorItems = [];
  let promptEditorActiveId = null;
  let promptLoadErrorMessage = '';
  let promptLoadUsedFallback = false;
  let promptSlugColumnSupported = true;
  const promptEditorSlugHelpDefaultText = (promptEditorSlugHelp?.textContent || '').trim();
  const aiSettingsModelDefault = (aiSettingsModel?.textContent || '').trim();
  const aiSettingsPromptDefault = (aiSettingsPrompt?.textContent || '').trim();
  const aiSettingsKeyDefault = (aiSettingsKey?.textContent || '').trim();
  const taskTitleDefault = (taskTitle?.textContent || '').trim();
  let costSnapshots = [];
  let lastCostResult = null;
  let isFetchingCostBalance = false;
  const taskLaunchSubtitleDefault = (taskLaunchSubtitle?.textContent || '').trim();

  const taskLaunchCardStates = taskLaunchButtons.map((btn, index) => {
    const id = Number.parseInt(btn.dataset.taskId || '', 10) || index + 1;
    const titleEl = btn.querySelector('.task-launch-card__title');
    const subtitleEl = btn.querySelector('.task-launch-card__subtitle');
    const defaultTitle = (titleEl?.textContent || '').trim() || `Task ${id}`;
    const defaultSubtitle = (subtitleEl?.textContent || '').trim() || taskLaunchSubtitleDefault || 'Open the task workspace';
    return {
      id,
      btn,
      titleEl,
      subtitleEl,
      defaultTitle,
      defaultSubtitle,
      name: '',
    };
  });

  const taskLaunchCardMap = new Map(taskLaunchCardStates.map((state) => [state.id, state]));
  let activeTaskId = taskLaunchCardStates[0]?.id ?? 1;

  const formatTaskCardLabel = (state) => {
    const prefix = `Task ${state.id}`;
    const name = (state.name || '').trim();
    return name ? `${prefix}: ${name}` : prefix;
  };

  const syncTaskLaunchCards = () => {
    taskLaunchCardStates.forEach((state) => {
      if (state.titleEl) {
        state.titleEl.textContent = formatTaskCardLabel(state);
      }
      const subtitleText = isTaskLaunchLocked
        ? 'Admin sign-in required'
        : state.defaultSubtitle || 'Open the task workspace';
      if (state.subtitleEl) {
        state.subtitleEl.textContent = subtitleText;
      }
      const baseLabel = `Open ${formatTaskCardLabel(state)}`;
      const label = isTaskLaunchLocked ? `${baseLabel} (admin sign-in required)` : baseLabel;
      state.btn.setAttribute('aria-label', label);
    });
  };

  let isTaskLaunchLocked = false;
  let lastTaskLaunchTrigger = null;
  let lastAutomationTrigger = null;
  syncTaskLaunchCards();
  const automationStatsDefaults = new Map();

  automationStatsGroups.forEach((group) => {
    const scheduledMetaEl = group.querySelector('[data-automation-field="scheduled-meta"]');
    const errorMetaEl = group.querySelector('[data-automation-field="error-meta"]');
    automationStatsDefaults.set(group, {
      scheduledMeta: group.dataset.scheduledMeta || (scheduledMetaEl?.textContent || '').trim(),
      errorMeta: group.dataset.errorMeta || (errorMetaEl?.textContent || '').trim(),
    });
  });

  const updateAutomationStatsDisplay = () => {
    automationStatsGroups.forEach((group) => {
      const scheduledRaw = group.dataset.scheduled ?? '';
      const errorsRaw = group.dataset.errors ?? '';
      const scheduled = Number.parseInt(scheduledRaw, 10);
      const errors = Number.parseInt(errorsRaw, 10);
      const scheduledValueEl = group.querySelector('[data-automation-field="scheduled-value"]');
      if (scheduledValueEl) {
        scheduledValueEl.textContent = Number.isFinite(scheduled)
          ? scheduled.toLocaleString()
          : scheduledRaw || '—';
      }
      const scheduledMetaEl = group.querySelector('[data-automation-field="scheduled-meta"]');
      if (scheduledMetaEl) {
        const defaultMeta = automationStatsDefaults.get(group)?.scheduledMeta || '';
        const scheduledMeta = group.dataset.scheduledMeta || defaultMeta;
        scheduledMetaEl.textContent = scheduledMeta;
      }

      const errorIconEl = group.querySelector('[data-automation-field="error-icon"]');
      const errorValueEl = group.querySelector('[data-automation-field="error-value"]');
      const errorMetaEl = group.querySelector('[data-automation-field="error-meta"]');

      if (errorValueEl) {
        if (Number.isFinite(errors)) {
          if (errors > 0) {
            errorValueEl.textContent = `${errors.toLocaleString()} issue${errors === 1 ? '' : 's'}`;
            errorValueEl.classList.add('automation-stats__value--warn');
          } else {
            errorValueEl.textContent = '0 issues';
            errorValueEl.classList.remove('automation-stats__value--warn');
          }
        } else {
          errorValueEl.textContent = errorsRaw || '—';
          errorValueEl.classList.toggle('automation-stats__value--warn', !!errorsRaw && errorsRaw !== '0');
        }
      }

      if (errorIconEl) {
        if (Number.isFinite(errors) && errors > 0) {
          errorIconEl.textContent = '⚠';
          errorIconEl.setAttribute('data-state', 'warn');
        } else {
          errorIconEl.textContent = '✔';
          errorIconEl.removeAttribute('data-state');
        }
      }

      if (errorMetaEl) {
        const defaultMeta = automationStatsDefaults.get(group)?.errorMeta || '';
        if (Number.isFinite(errors) && errors > 0) {
          errorMetaEl.textContent = 'Investigate before next run';
          errorMetaEl.classList.add('automation-stats__meta--warn');
        } else {
          const meta = group.dataset.errorMeta || defaultMeta;
          errorMetaEl.textContent = meta;
          errorMetaEl.classList.remove('automation-stats__meta--warn');
        }
      }
    });
  };

  const toggleAutomationSequence = () => {
    if (!automationSequenceGroup) return;
    const isSequence = automationModeInputs.some((input) => input.checked && input.value === 'sequence');
    automationSequenceGroup.hidden = !isSequence;
    automationStatsGroups.forEach((group) => {
      if (isSequence) {
        group.dataset.scheduledMeta = 'Sequence builder ready';
        group.dataset.errorMeta = group.dataset.errorMeta || automationStatsDefaults.get(group)?.errorMeta || '';
      } else {
        const defaults = automationStatsDefaults.get(group) || {};
        if (defaults.scheduledMeta) {
          group.dataset.scheduledMeta = defaults.scheduledMeta;
        } else {
          delete group.dataset.scheduledMeta;
        }
        if (defaults.errorMeta) {
          group.dataset.errorMeta = defaults.errorMeta;
        } else {
          delete group.dataset.errorMeta;
        }
      }
    });
    updateAutomationStatsDisplay();
  };

  const parseNumericValue = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const normalized = trimmed.replace(/[^0-9.+\-eE]/g, '');
      const parsed = Number.parseFloat(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const pickNumber = (source, paths = []) => {
    if (!source) return null;
    for (const path of paths) {
      const segments = Array.isArray(path) ? path : String(path).split('.');
      let current = source;
      let valid = true;
      for (const segment of segments) {
        if (current == null) {
          valid = false;
          break;
        }
        current = current[segment];
      }
      if (!valid) continue;
      const parsed = parseNumericValue(current);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  const formatCostNumber = (value, unit = null, { sign = false } = {}) => {
    if (!Number.isFinite(value)) return '—';
    const abs = Math.abs(value);
    const maximumFractionDigits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
    const formatted = abs.toLocaleString(undefined, { maximumFractionDigits, minimumFractionDigits: 0 });
    const normalizedUnit = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
    let base = formatted;
    if (normalizedUnit === 'usd' || normalizedUnit === '$') {
      base = `$${formatted}`;
    } else if (normalizedUnit === 'tokens') {
      base = `${formatted} tokens`;
    } else if (normalizedUnit === 'credits') {
      base = `${formatted} credits`;
    } else if (unit) {
      base = `${formatted} ${unit}`;
    }
    if (!sign) {
      return base;
    }
    if (value > 0) return `+${base}`;
    if (value < 0) return `-${base}`;
    return `±${base}`;
  };

  const formatSnapshotTimestamp = (timestamp) => {
    if (!timestamp) return '';
    try {
      return new Date(timestamp).toLocaleString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return new Date(timestamp).toISOString();
    }
  };

  const formatSnapshotRelativeTime = (timestamp) => {
    if (!timestamp) return '';
    try {
      const diff = timestamp - Date.now();
      const units = [
        { unit: 'day', ms: 1000 * 60 * 60 * 24 },
        { unit: 'hour', ms: 1000 * 60 * 60 },
        { unit: 'minute', ms: 1000 * 60 },
      ];
      const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
      for (const { unit, ms } of units) {
        if (Math.abs(diff) >= ms || unit === 'minute') {
          const value = Math.round(diff / ms);
          return formatter.format(value, unit);
        }
      }
      return '';
    } catch {
      return '';
    }
  };

  const getProviderLabel = (provider) => (provider === 'openai' ? 'OpenAI' : 'OpenRouter');

  const detectActiveProvider = () => {
    const value = (aiModel?.value || desiredModelValue || '').toLowerCase();
    if (value.includes('openai') || value.includes('gpt-')) {
      return 'openai';
    }
    if (value.includes('azure/openai')) {
      return 'openai';
    }
    return 'openrouter';
  };

  const syncCostProviderLabel = (providerOverride = null) => {
    if (!costProviderLabel) return;
    const provider = providerOverride || detectActiveProvider();
    costProviderLabel.textContent = getProviderLabel(provider);
    if (costManualUnit && !costSnapshots.length) {
      if (provider === 'openai') {
        costManualUnit.value = 'usd';
      } else if (costManualUnit.value === 'usd') {
        costManualUnit.value = 'credits';
      }
    }
  };

  const setCostStatus = (text, tone = 'info') => {
    if (!costStatus) return;
    costStatus.textContent = text || '';
    costStatus.dataset.tone = text ? tone : '';
  };

  const updateCostDisplay = (data = {}) => {
    const provider = data.provider || detectActiveProvider();
    syncCostProviderLabel(provider);
    if (costRemainingValue) {
      costRemainingValue.textContent = formatCostNumber(
        Number.isFinite(data.remaining) ? data.remaining : Number.isFinite(data.balance) ? data.balance : null,
        data.unit || (provider === 'openai' ? 'USD' : 'credits'),
      );
    }
    if (costUsageValue) {
      costUsageValue.textContent = formatCostNumber(
        Number.isFinite(data.totalUsage) ? data.totalUsage : null,
        data.unit || (provider === 'openai' ? 'USD' : 'credits'),
      );
    }
  };

  const renderCostSummary = () => {
    if (!costSnapshotSummary) return;
    if (costSnapshots.length > 0) {
      const latest = costSnapshots[0];
      const valueText = formatCostNumber(latest.totalUsage, latest.unit);
      const relative = formatSnapshotRelativeTime(latest.timestamp);
      const base = `${latest.providerLabel || getProviderLabel(latest.provider)} usage: ${valueText}`;
      costSnapshotSummary.textContent = relative ? `${base} · ${relative}` : base;
      return;
    }
    if (lastCostResult && Number.isFinite(lastCostResult.totalUsage)) {
      const valueText = formatCostNumber(lastCostResult.totalUsage, lastCostResult.unit);
      const relative = lastCostResult.fetchedAt ? formatSnapshotRelativeTime(lastCostResult.fetchedAt) : '';
      const providerLabel = lastCostResult.providerLabel || getProviderLabel(lastCostResult.provider);
      const base = `${providerLabel} balance ready: ${valueText}`;
      costSnapshotSummary.textContent = relative ? `${base} · ${relative}` : base;
      return;
    }
    costSnapshotSummary.textContent = 'Track API spend with snapshots.';
  };

  const renderCostSnapshots = () => {
    if (!costSnapshotsList) {
      renderCostSummary();
      return;
    }
    costSnapshotsList.innerHTML = '';
    if (!costSnapshots.length) {
      if (costSnapshotsEmpty) costSnapshotsEmpty.hidden = false;
      renderCostSummary();
      return;
    }
    if (costSnapshotsEmpty) costSnapshotsEmpty.hidden = true;
    costSnapshots.forEach((snapshot, index) => {
      const item = document.createElement('li');
      item.className = 'cost-history__item';
      const title = document.createElement('strong');
      title.textContent = `${formatCostNumber(snapshot.totalUsage, snapshot.unit)} total usage`;
      item.appendChild(title);

      const meta = document.createElement('span');
      meta.className = 'cost-history__item-meta';
      meta.textContent = `${snapshot.providerLabel || getProviderLabel(snapshot.provider)} · ${formatSnapshotTimestamp(
        snapshot.timestamp,
      )}`;
      item.appendChild(meta);

      if (Number.isFinite(snapshot.remaining)) {
        const remaining = document.createElement('span');
        remaining.className = 'cost-history__item-meta';
        remaining.textContent = `Remaining: ${formatCostNumber(snapshot.remaining, snapshot.unit)}`;
        item.appendChild(remaining);
      }

      const previous = costSnapshots[index + 1];
      if (
        previous &&
        Number.isFinite(snapshot.totalUsage) &&
        Number.isFinite(previous.totalUsage) &&
        (snapshot.unit || '').toLowerCase() === (previous.unit || '').toLowerCase()
      ) {
        const deltaValue = snapshot.totalUsage - previous.totalUsage;
        const delta = document.createElement('span');
        delta.className = 'cost-history__delta';
        delta.textContent = `Δ ${formatCostNumber(deltaValue, snapshot.unit, { sign: true })}`;
        item.appendChild(delta);
      }

      costSnapshotsList.appendChild(item);
    });
    renderCostSummary();
  };

  const saveCostSnapshots = () => {
    try {
      const payload = costSnapshots.slice(0, MAX_COST_SNAPSHOTS);
      localStorage.setItem(COST_SNAPSHOTS_STORAGE, JSON.stringify(payload));
    } catch (error) {
      console.warn('Cost snapshot storage error', error);
    }
  };

  const loadCostSnapshots = () => {
    let stored = [];
    try {
      const raw = localStorage.getItem(COST_SNAPSHOTS_STORAGE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          stored = parsed.filter((item) => item && typeof item === 'object' && typeof item.timestamp === 'number');
        }
      }
    } catch (error) {
      console.warn('Cost snapshot load error', error);
    }
    costSnapshots = stored.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, MAX_COST_SNAPSHOTS);
    renderCostSnapshots();
    if (costManualUnit && costSnapshots[0]?.unit) {
      const normalized = String(costSnapshots[0].unit || '').toLowerCase();
      if (normalized === 'usd') costManualUnit.value = 'usd';
      else if (normalized === 'tokens') costManualUnit.value = 'tokens';
      else costManualUnit.value = 'credits';
    }
  };

  const getActiveApiKey = () => {
    const direct = normalizeOpenRouterApiKey(aiKey?.value || '');
    if (direct) return direct;
    try {
      const stored = localStorage.getItem(AI_KEY_STORAGE) || '';
      return normalizeOpenRouterApiKey(stored);
    } catch {
      return '';
    }
  };

  const safeFetchJson = async (url, options = {}) => {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      throw new Error(error?.message || 'Network error while requesting balance.');
    }
    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      const snippet = detail ? detail.trim().slice(0, 160) : response.statusText;
      const message = snippet ? `${response.status} ${snippet}` : `Request failed with status ${response.status}`;
      throw new Error(message);
    }
    try {
      const data = await response.json();
      return { data, headers: response.headers };
    } catch {
      throw new Error('Received an unexpected response from the balance endpoint.');
    }
  };

  const parseOpenRouterUsage = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const root = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const totalUsage =
      pickNumber(root, [
        'usage.total',
        'usage.total_usage',
        'usage.total_usd',
        'usage.totalTokens',
        'totals.usage',
        'total_usage',
      ]) ?? null;
    const remaining =
      pickNumber(root, ['usage.remaining', 'quota.remaining', 'credits.remaining', 'balance.remaining', 'remaining']) ?? null;
    const balance = pickNumber(root, ['balance', 'account.balance', 'credits.balance', 'available']) ?? null;
    const granted = pickNumber(root, ['quota.limit', 'quota.total', 'credits.limit', 'limit', 'balance.total']) ?? null;
    let unit =
      root.unit ||
      root.currency ||
      root?.usage?.currency ||
      (root?.usage?.total_usd || root?.total_usd ? 'USD' : '') ||
      (root?.usage?.unit || '');
    if (typeof unit === 'string') {
      const normalized = unit.trim().toLowerCase();
      if (normalized === 'usd' || normalized === '$') unit = 'USD';
      else if (normalized === 'tokens') unit = 'tokens';
      else if (normalized === 'credits') unit = 'credits';
    }
    if (!unit) {
      unit = 'credits';
    }
    return {
      provider: 'openrouter',
      providerLabel: 'OpenRouter',
      totalUsage,
      remaining: remaining ?? balance ?? null,
      balance: balance ?? remaining ?? null,
      granted,
      unit,
    };
  };

  const parseOpenAiUsage = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const totalGranted = pickNumber(payload, ['total_granted', 'grants.total_granted']);
    const totalUsed = pickNumber(payload, ['total_used', 'grants.total_used']);
    const totalAvailable = pickNumber(payload, ['total_available', 'grants.total_available']);
    return {
      provider: 'openai',
      providerLabel: 'OpenAI',
      totalUsage: totalUsed ?? null,
      remaining: totalAvailable ?? null,
      balance: totalAvailable ?? null,
      granted: totalGranted ?? null,
      unit: 'USD',
    };
  };

  const fetchOpenRouterBalance = async (apiKey) => {
    const endpoints = [
      'https://openrouter.ai/api/v1/api_keys/self',
      'https://api.openrouter.ai/v1/usage',
      'https://openrouter.ai/api/v1/dashboard/billing',
    ];
    let lastError = null;
    for (const url of endpoints) {
      try {
        const { data } = await safeFetchJson(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
        const parsed = parseOpenRouterUsage(data);
        if (parsed) {
          parsed.endpoint = url;
          return parsed;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw new Error('Unable to retrieve OpenRouter usage.');
  };

  const fetchOpenAiBalance = async (apiKey) => {
    const { data } = await safeFetchJson('https://api.openai.com/v1/dashboard/billing/credit_grants', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const parsed = parseOpenAiUsage(data);
    if (parsed) return parsed;
    throw new Error('Unable to parse OpenAI billing response.');
  };

  const refreshCostBalance = async () => {
    const provider = detectActiveProvider();
    syncCostProviderLabel(provider);
    const apiKey = getActiveApiKey();
    if (!apiKey) {
      updateCostDisplay({ provider, unit: provider === 'openai' ? 'USD' : 'credits' });
      setCostStatus('Add your API key to refresh usage.', 'error');
      return;
    }
    if (isFetchingCostBalance) return;
    isFetchingCostBalance = true;
    if (costRefreshBtn) costRefreshBtn.disabled = true;
    setCostStatus('Fetching balance…', 'info');
    try {
      const result = provider === 'openai' ? await fetchOpenAiBalance(apiKey) : await fetchOpenRouterBalance(apiKey);
      const fetchedAt = Date.now();
      lastCostResult = {
        ...result,
        provider,
        providerLabel: result.providerLabel || getProviderLabel(provider),
        unit: result.unit || (provider === 'openai' ? 'USD' : 'credits'),
        fetchedAt,
      };
      updateCostDisplay(lastCostResult);
      if (costManualInput && Number.isFinite(lastCostResult.totalUsage)) {
        costManualInput.value = lastCostResult.totalUsage;
      }
      if (costManualUnit && lastCostResult.unit) {
        const unitValue = String(lastCostResult.unit).toLowerCase();
        if (unitValue === 'usd' || unitValue === '$') costManualUnit.value = 'usd';
        else if (unitValue === 'tokens') costManualUnit.value = 'tokens';
        else costManualUnit.value = 'credits';
      }
      const relative = formatSnapshotRelativeTime(fetchedAt) || 'just now';
      setCostStatus(`Balance updated ${relative}.`, 'success');
      renderCostSummary();
    } catch (error) {
      console.warn('Cost balance fetch error', error);
      setCostStatus(
        `${error.message || 'Unable to fetch balance.'} Use the manual override to capture a snapshot.`,
        'error',
      );
      if (!lastCostResult) {
        updateCostDisplay({ provider, unit: provider === 'openai' ? 'USD' : 'credits' });
      }
    } finally {
      if (costRefreshBtn) costRefreshBtn.disabled = false;
      isFetchingCostBalance = false;
    }
  };

  const captureCostSnapshot = () => {
    const provider = lastCostResult?.provider || detectActiveProvider();
    const providerLabel = lastCostResult?.providerLabel || getProviderLabel(provider);
    let unit =
      lastCostResult?.unit ||
      (costManualUnit?.value === 'usd'
        ? 'USD'
        : costManualUnit?.value === 'tokens'
        ? 'tokens'
        : 'credits');
    let totalUsage = Number.isFinite(lastCostResult?.totalUsage) ? lastCostResult.totalUsage : null;
    const remaining = Number.isFinite(lastCostResult?.remaining)
      ? lastCostResult.remaining
      : Number.isFinite(lastCostResult?.balance)
      ? lastCostResult.balance
      : null;

    if (!Number.isFinite(totalUsage)) {
      const manualRaw = (costManualInput?.value || '').trim();
      const manualValue = manualRaw ? Number.parseFloat(manualRaw) : NaN;
      if (!Number.isFinite(manualValue)) {
        setCostStatus('Enter a usage value or refresh the balance before saving a snapshot.', 'error');
        if (costManualInput) costManualInput.focus();
        return;
      }
      totalUsage = manualValue;
    }

    if (!unit) {
      unit = 'credits';
    }

    const snapshot = {
      timestamp: Date.now(),
      provider,
      providerLabel,
      totalUsage,
      remaining,
      balance: remaining,
      unit,
    };

    costSnapshots.unshift(snapshot);
    if (costSnapshots.length > MAX_COST_SNAPSHOTS) {
      costSnapshots = costSnapshots.slice(0, MAX_COST_SNAPSHOTS);
    }
    saveCostSnapshots();
    renderCostSnapshots();
    setCostStatus('Snapshot saved locally.', 'success');
  };

  const openCostModal = () => {
    if (!costModal) return;
    costModal.hidden = false;
    lockBodyScroll();
    updateCostDisplay(lastCostResult || { provider: detectActiveProvider() });
    renderCostSummary();
    if (lastCostResult?.fetchedAt) {
      const relative = formatSnapshotRelativeTime(lastCostResult.fetchedAt) || 'recently';
      setCostStatus(`Balance last fetched ${relative}.`, 'info');
    } else {
      setCostStatus('Add your API key and refresh to load usage.', 'info');
    }
    requestAnimationFrame(() => {
      if (costRefreshBtn && typeof costRefreshBtn.focus === 'function') {
        costRefreshBtn.focus();
      }
    });
    if (!lastCostResult) {
      refreshCostBalance();
    }
  };

  const closeCostModal = () => {
    if (!costModal || costModal.hidden) return;
    costModal.hidden = true;
    unlockBodyScroll();
    if (costSnapshotButton) {
      setTimeout(() => {
        try {
          costSnapshotButton.focus();
        } catch (error) {
          console.warn('Cost button focus failed', error);
        }
      }, 30);
    }
  };

  const openAutomationModal = (triggerBtn = null) => {
    if (!automationModal) return;
    if (triggerBtn) {
      lastAutomationTrigger = triggerBtn;
    }
    automationModal.hidden = false;
    lockBodyScroll();
    requestAnimationFrame(() => {
      const firstField = automationSettingsForm?.querySelector('input, select, textarea, button');
      if (firstField && typeof firstField.focus === 'function') {
        firstField.focus();
      }
    });
  };

  const closeAutomationModal = () => {
    if (!automationModal || automationModal.hidden) return;
    automationModal.hidden = true;
    unlockBodyScroll();
    if (lastAutomationTrigger) {
      setTimeout(() => {
        try {
          lastAutomationTrigger.focus();
        } catch (error) {
          console.warn('Automation trigger focus failed', error);
        }
      }, 30);
    }
  };

  const updateTaskTitle = () => {
    const value = (taskNameInput?.value || '').trim();
    const activeState = taskLaunchCardMap.get(activeTaskId);
    if (activeState) {
      activeState.name = value;
    }
    const defaultDisplay = taskTitleDefault || 'What can I help you with?';
    const display = value ? `${defaultDisplay} - ${value}` : defaultDisplay;
    if (taskTitle) {
      taskTitle.textContent = display;
    }
    syncTaskLaunchCards();
  };

  updateAutomationStatsDisplay();
  toggleAutomationSequence();
  loadCostSnapshots();
  syncCostProviderLabel();

  if (!form || !locked) return;

  setTaskLaunchAvailability(!form.hidden);

  const lockMsg = document.getElementById('editorLockMsg');
  const lockActionBtn = locked?.querySelector('[data-open-auth]');

  const formatDate = (date) => {
    try {
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return date.toISOString().split('T')[0];
    }
  };

  const setAnalystDate = () => {
    if (!analystDateStamp) return;
    const today = new Date();
    analystDateStamp.textContent = formatDate(today);
  };

  const updateAiKeyStatusDisplay = (value) => {
    if (!aiSettingsKey) return;
    const normalized = normalizeOpenRouterApiKey(value);
    if (normalized) {
      aiSettingsKey.textContent = 'Key detected in secure storage';
    } else {
      aiSettingsKey.textContent = aiSettingsKeyDefault || 'Missing — add your OpenRouter key';
    }
  };

  const updateAnalystIdentity = () => {
    const option = aiModel?.selectedOptions?.[0] || null;
    const optionLabel = (option?.textContent || option?.label || '').trim();
    const storedPreference = (desiredModelValue || '').trim();
    const displayName = optionLabel || storedPreference;
    if (analystLastName) analystLastName.textContent = displayName || 'Model';
    if (aiSettingsModel) aiSettingsModel.textContent = displayName || aiSettingsModelDefault || 'Pending selection';
    syncCostProviderLabel();
  };

  let bodyScrollLockCount = 0;
  let bodyScrollPreviousOverflow = '';

  const lockBodyScroll = () => {
    if (typeof document === 'undefined' || !document.body) return;
    if (bodyScrollLockCount === 0) {
      bodyScrollPreviousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    bodyScrollLockCount += 1;
  };

  const unlockBodyScroll = () => {
    if (typeof document === 'undefined' || !document.body) return;
    if (bodyScrollLockCount === 0) return;
    bodyScrollLockCount -= 1;
    if (bodyScrollLockCount === 0) {
      document.body.style.overflow = bodyScrollPreviousOverflow || '';
      bodyScrollPreviousOverflow = '';
    }
  };

  function setTaskLaunchAvailability(enabled) {
    isTaskLaunchLocked = !enabled;
    taskLaunchButtons.forEach((btn) => {
      btn.dataset.state = isTaskLaunchLocked ? 'locked' : 'ready';
      if (isTaskLaunchLocked) {
        btn.setAttribute('aria-describedby', 'editorLockMsg');
      } else {
        btn.removeAttribute('aria-describedby');
      }
    });
    updateTaskTitle();
  }

  const closeTaskModal = () => {
    if (!taskModal) return;
    if (taskModal.hidden) return;
    taskModal.hidden = true;
    unlockBodyScroll();
    if (taskLockedMessage) taskLockedMessage.hidden = true;
    const focusTarget = lastTaskLaunchTrigger || taskLaunchBtn;
    if (focusTarget && !isTaskLaunchLocked) {
      setTimeout(() => focusTarget.focus(), 30);
    }
  };

  async function ensureLatestAccess({ forceAuthRefresh = false } = {}) {
    if (forceAuthRefresh) {
      try {
        await refreshAuthState();
      } catch (error) {
        console.warn('Auth refresh error', error);
      }
    }
    try {
      await applyAccessState();
    } catch (error) {
      console.warn('Access state refresh error', error);
    }
  }

  async function openTaskModal(triggerBtn = null) {
    if (!taskModal) return;
    if (triggerBtn) {
      lastTaskLaunchTrigger = triggerBtn;
      const parsedId = Number.parseInt(triggerBtn.dataset.taskId || '', 10);
      if (!Number.isNaN(parsedId)) {
        activeTaskId = parsedId;
      } else {
        const btnIndex = taskLaunchButtons.indexOf(triggerBtn);
        if (btnIndex >= 0) {
          activeTaskId = taskLaunchCardStates[btnIndex]?.id ?? activeTaskId;
        }
      }
    }
    const activeState = taskLaunchCardMap.get(activeTaskId);
    if (taskNameInput) {
      taskNameInput.value = activeState?.name || '';
    }
    updateTaskTitle();
    const wasLocked = !form || form.hidden;
    await ensureLatestAccess({ forceAuthRefresh: wasLocked });
    const formHidden = !form || form.hidden;
    taskModal.hidden = false;
    lockBodyScroll();
    if (taskLockedMessage) {
      taskLockedMessage.hidden = !formHidden;
      if (!taskLockedMessage.hidden) {
        requestAnimationFrame(() => {
          taskLockedMessage.focus();
        });
      }
    }
    if (!formHidden && form) {
      form.hidden = false;
      setTimeout(() => {
        taskNameInput?.focus();
      }, 60);
    }
  }

  const updatePromptSettingsSummary = () => {
    if (!aiSettingsPrompt) return;
    if (selectedPrompt) {
      aiSettingsPrompt.textContent = selectedPrompt.name;
    } else if (promptOptions.length) {
      aiSettingsPrompt.textContent = 'Select a prompt template';
    } else if (promptLoadErrorMessage) {
      aiSettingsPrompt.textContent = 'Unable to load prompts';
    } else {
      aiSettingsPrompt.textContent = aiSettingsPromptDefault || 'Auto-selected based on last session';
    }
  };

  const setMessage = (text, tone = 'info') => {
    if (!msg) return;
    msg.textContent = text || '';
    msg.dataset.tone = tone;
    msg.style.color = tone === 'error' ? 'var(--danger,#ff6b6b)' : tone === 'success' ? 'var(--ok,#31d0a3)' : 'var(--muted,#64748b)';
  };

  const setAnalysisStatus = (text, tone = 'info') => {
    if (!analysisStatus) return;
    analysisStatus.textContent = text || '';
    analysisStatus.dataset.tone = text ? tone : '';
  };

  const switchAnalysisMode = (mode = 'manual') => {
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.analysisMode === mode);
    });
    analysisPanels.forEach((panel) => {
      const desired = panel.dataset.panel || 'manual';
      panel.hidden = desired !== mode && !(desired === 'manual' && mode !== 'ai');
      if (panel.dataset.panel === 'manual') {
        panel.hidden = mode !== 'manual';
      }
    });
    if (mode !== 'ai') {
      closePromptMenu();
    }
    if (mode === 'ai') {
      ensureSupabaseAiKey().catch((error) => {
        console.warn('AI key preload error', error);
      });
    }
  };

  const setAiKeyStatus = (text, tone = 'info') => {
    if (!aiKeyStatus) return;
    aiKeyStatus.textContent = text || '';
    aiKeyStatus.dataset.tone = text ? tone : '';
    const color =
      tone === 'error'
        ? 'var(--danger,#ff6b6b)'
        : tone === 'success'
        ? 'var(--ok,#31d0a3)'
        : 'var(--muted,#64748b)';
    aiKeyStatus.style.color = text ? color : 'var(--muted,#64748b)';
  };

  const updateAiKeyPreview = (value) => {
    if (!aiKeyPreview || !aiKeyPreviewValue) return;
    const normalized = normalizeOpenRouterApiKey(value);
    if (normalized) {
      aiKeyPreview.hidden = false;
      aiKeyPreviewValue.textContent = normalized;
    } else {
      aiKeyPreview.hidden = true;
      aiKeyPreviewValue.textContent = '';
    }
    updateAiKeyStatusDisplay(normalized);
  };

  const setAiKeyInput = (value) => {
    if (!aiKey) return;
    const normalized = normalizeOpenRouterApiKey(value);
    aiKey.value = normalized;
    updateAiKeyPreview(normalized);
  };

  const loadLocalAiPreferences = () => {
    if (aiKey) {
      try {
        const stored = localStorage.getItem(AI_KEY_STORAGE) || localStorage.getItem('api-key-openrouter') || '';
        setAiKeyInput(stored);
      } catch {
        setAiKeyInput('');
      }
    }
    try {
      desiredModelValue = localStorage.getItem(AI_MODEL_STORAGE) || null;
    } catch {
      desiredModelValue = null;
    }
    if (!desiredModelValue) {
      desiredModelValue = 'openrouter/auto';
    }
    try {
      desiredPromptId = localStorage.getItem(AI_PROMPT_STORAGE) || null;
    } catch {
      desiredPromptId = null;
    }
  };

  const ensureSupabaseAiKey = async ({ force = false, onStatus } = {}) => {
    if (supabaseAiKeyCache && !force) {
      setAiKeyInput(supabaseAiKeyCache);
      if (typeof onStatus === 'function') {
        onStatus({ value: supabaseAiKeyCache, source: 'cache', error: null });
      }
      return supabaseAiKeyCache;
    }
    let fetchedKey = null;
    let fetchError = null;
    const previousValue = supabaseAiKeyCache;
    try {
      const { data, error } = await supabase
        .from('editor_api_credentials')
        .select('id, api_key, provider, is_active, updated_at')
        .eq('provider', 'openrouter')
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      fetchedKey = data?.api_key ? normalizeOpenRouterApiKey(data.api_key) : null;
    } catch (error) {
      fetchError = error;
      console.warn('AI key fetch error', error);
    }
    let source = 'none';
    let usedDefaultFallback = false;
    if (!fetchedKey && DEFAULT_OPENROUTER_API_KEY) {
      fetchedKey = normalizeOpenRouterApiKey(DEFAULT_OPENROUTER_API_KEY);
      usedDefaultFallback = true;
    }
    if (fetchedKey) {
      supabaseAiKeyCache = fetchedKey;
      source = usedDefaultFallback ? 'default' : 'supabase';
    } else if (previousValue) {
      supabaseAiKeyCache = previousValue;
      source = 'cache';
    } else {
      supabaseAiKeyCache = null;
      source = 'none';
    }
    setAiKeyInput(supabaseAiKeyCache);
    if (supabaseAiKeyCache) {
      try {
        localStorage.setItem(AI_KEY_STORAGE, supabaseAiKeyCache);
      } catch {}
    } else {
      try {
        localStorage.removeItem(AI_KEY_STORAGE);
      } catch {}
    }
    if (typeof onStatus === 'function') {
      onStatus({ value: supabaseAiKeyCache, source, error: fetchError });
    }
    return supabaseAiKeyCache;
  };

  const loadAiConfig = async ({ includeRemote = false, forceRemote = false } = {}) => {
    loadLocalAiPreferences();
    setAnalystDate();
    updateAnalystIdentity();
    if (includeRemote) {
      await ensureSupabaseAiKey({ force: forceRemote });
    }
  };

  const persistAiConfig = () => {
    try {
      if (aiKey) {
        const value = normalizeOpenRouterApiKey(aiKey.value);
        setAiKeyInput(value);
        if (value) localStorage.setItem(AI_KEY_STORAGE, value);
        else localStorage.removeItem(AI_KEY_STORAGE);
      }
      if (aiModel) {
        const value = (aiModel.value || '').trim();
        desiredModelValue = value || null;
        if (value) localStorage.setItem(AI_MODEL_STORAGE, value);
        else localStorage.removeItem(AI_MODEL_STORAGE);
      }
      if (selectedPrompt?.id) {
        localStorage.setItem(AI_PROMPT_STORAGE, selectedPrompt.id);
      } else {
        localStorage.removeItem(AI_PROMPT_STORAGE);
      }
    } catch (err) {
      console.warn('AI config storage error', err);
    }
  };

  const setPromptEditorStatus = (text, tone = 'info') => {
    if (!promptEditorStatus) return;
    promptEditorStatus.textContent = text || '';
    promptEditorStatus.dataset.tone = text ? tone : '';
    const color =
      tone === 'error'
        ? 'var(--danger,#ff6b6b)'
        : tone === 'success'
        ? 'var(--ok,#31d0a3)'
        : 'var(--muted,#64748b)';
    promptEditorStatus.style.color = text ? color : 'var(--muted,#64748b)';
  };

  const resolvePromptRecordId = (record) => {
    if (!record) return null;
    const value = record.id || record.slug || '';
    const trimmed = String(value || '').trim();
    return trimmed ? trimmed : null;
  };

  const getPromptEditorItemById = (id) => {
    if (!id) return null;
    return promptEditorItems.find((item) => resolvePromptRecordId(item) === id) || null;
  };

  const getPromptDeletionTarget = (record) => {
    if (!record || typeof record !== 'object') return null;
    const rawId = record.id;
    const rawSlug = record.slug;
    const idValue = typeof rawId === 'string' ? rawId.trim() : rawId ? String(rawId).trim() : '';
    if (idValue) {
      return { column: 'id', value: idValue };
    }
    const slugValue = typeof rawSlug === 'string' ? rawSlug.trim() : rawSlug ? String(rawSlug).trim() : '';
    if (slugValue) {
      return { column: 'slug', value: slugValue };
    }
    return null;
  };

  const updatePromptEditorDeleteState = () => {
    if (!promptEditorDeleteBtn) return;
    const record = getPromptEditorItemById(promptEditorActiveId);
    const target = getPromptDeletionTarget(record);
    promptEditorDeleteBtn.disabled = !target;
  };

  const renderPromptEditorList = () => {
    if (!promptEditorList) return;
    if (!promptEditorItems.length) {
      promptEditorList.innerHTML = '<p class="prompt-editor__empty">No prompts yet.</p>';
      updatePromptEditorDeleteState();
      return;
    }
    promptEditorList.innerHTML = promptEditorItems
      .map((item) => {
        const id = resolvePromptRecordId(item);
        if (!id) return '';
        const active = id === promptEditorActiveId ? 'active' : '';
        const archivedAttr = item.archived ? ' data-archived="true"' : '';
        const metaParts = [];
        if (item.is_default) metaParts.push('Default');
        if (item.archived) metaParts.push('Archived');
        const detailParts = [];
        if (item.description) detailParts.push(item.description);
        if (metaParts.length) detailParts.push(metaParts.join(' • '));
        const details = detailParts.length ? `<span>${escapeHtml(detailParts.join(' — '))}</span>` : '';
        const label = escapeHtml(item.name || item.slug || 'Prompt');
        return `<button type="button" class="${active}" data-editor-prompt="${escapeHtml(id)}"${archivedAttr}><strong>${label}</strong>${details}</button>`;
      })
      .filter(Boolean)
      .join('');
  };

  const isPromptIdTaken = (id, { ignoreId = null } = {}) => {
    const normalized = (id || '').trim();
    if (!normalized) return false;
    return promptEditorItems.some((item) => {
      const recordId = resolvePromptRecordId(item);
      if (ignoreId && recordId === ignoreId) return false;
      return recordId === normalized;
    });
  };

  const isPromptSlugTaken = (slug, { ignoreId = null } = {}) => {
    const normalized = (slug || '').trim();
    if (!normalized) return false;
    return promptEditorItems.some((item) => {
      const recordId = resolvePromptRecordId(item);
      if (ignoreId && recordId === ignoreId) return false;
      const recordSlug = (item?.slug || '').trim();
      return recordSlug === normalized;
    });
  };

  const generatePromptIdentifier = (base, { ignoreId = null } = {}) => {
    let root = slugify(base || 'prompt');
    if (!root) root = 'prompt';
    let candidate = root;
    let attempt = 2;
    while (isPromptIdTaken(candidate, { ignoreId })) {
      candidate = `${root}-${attempt}`;
      attempt += 1;
    }
    return candidate;
  };

  const normalizePromptSlug = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    return slugify(trimmed);
  };

  const applyPromptSlugFieldState = () => {
    if (!promptEditorSlug) return;
    if (promptSlugColumnSupported) {
      promptEditorSlug.disabled = false;
      promptEditorSlug.placeholder = 'deep-research';
      if (promptEditorSlugHelp) {
        promptEditorSlugHelp.textContent = promptEditorSlugHelpDefaultText ||
          'Short identifier with letters, numbers or dashes. Leave blank to auto-generate.';
      }
    } else {
      promptEditorSlug.disabled = true;
      promptEditorSlug.placeholder = 'Not supported by Supabase table';
      if (promptEditorSlugHelp) {
        promptEditorSlugHelp.textContent =
          'Your Supabase table does not include a "slug" column. Leave this blank and FutureFunds will manage identifiers automatically.';
      }
    }
  };

  const markPromptSlugUnsupported = () => {
    if (!promptSlugColumnSupported) return;
    promptSlugColumnSupported = false;
    if (promptEditorSlug) {
      promptEditorSlug.value = '';
    }
    applyPromptSlugFieldState();
  };

  const isMissingPromptSlugColumnError = (error) => {
    if (!error || typeof error !== 'object') return false;
    const err = /** @type {{ message?: string; details?: string; hint?: string; code?: string }} */ (error);
    const parts = [err.message, err.details, err.hint]
      .filter((value) => typeof value === 'string')
      .map((value) => value.toLowerCase());
    if (!parts.length) {
      if (typeof err.code === 'string' && err.code.trim() === '42703') {
        return true;
      }
      return false;
    }
    return parts.some((part) => part.includes('slug') && part.includes('column') &&
      (part.includes('does not exist') || part.includes('could not find') || part.includes('unknown column')));
  };

  applyPromptSlugFieldState();

  const resetPromptEditorForm = () => {
    if (!promptEditorForm) return;
    if (typeof promptEditorForm.reset === 'function') {
      promptEditorForm.reset();
    }
    if (promptEditorId) promptEditorId.value = '';
    if (promptEditorName) promptEditorName.value = '';
    if (promptEditorSlug) promptEditorSlug.value = '';
    if (promptEditorDescription) promptEditorDescription.value = '';
    if (promptEditorText) promptEditorText.value = '';
    if (promptEditorSortOrder) promptEditorSortOrder.value = '';
    if (promptEditorDefault) promptEditorDefault.checked = false;
    if (promptEditorArchived) promptEditorArchived.checked = false;
  };

  const populatePromptEditorForm = (record) => {
    if (!promptEditorForm) return;
    if (typeof promptEditorForm.reset === 'function') {
      promptEditorForm.reset();
    }
    if (promptEditorId) promptEditorId.value = record?.id || '';
    if (promptEditorName) promptEditorName.value = record?.name || '';
    if (promptEditorSlug) promptEditorSlug.value = record?.slug || '';
    if (promptEditorDescription) promptEditorDescription.value = record?.description || '';
    if (promptEditorText) promptEditorText.value = record?.prompt_text || '';
    if (promptEditorSortOrder) {
      const sortValue = record?.sort_order;
      promptEditorSortOrder.value = Number.isFinite(sortValue) ? sortValue : sortValue ?? '';
    }
    if (promptEditorDefault) promptEditorDefault.checked = Boolean(record?.is_default);
    if (promptEditorArchived) promptEditorArchived.checked = Boolean(record?.archived);
  };

  const setPromptEditorSelection = (id) => {
    promptEditorActiveId = id || null;
    renderPromptEditorList();
    const current = getPromptEditorItemById(promptEditorActiveId);
    if (current) {
      populatePromptEditorForm(current);
      setPromptEditorStatus('Editing saved prompt.', 'info');
    } else if (promptEditorItems.length) {
      resetPromptEditorForm();
      setPromptEditorStatus('Select a prompt to edit or create a new template.', 'info');
    } else {
      resetPromptEditorForm();
      setPromptEditorStatus('No prompts found. Create a new template to get started.', 'info');
    }
    updatePromptEditorDeleteState();
  };

  const refreshPromptEditorList = async ({ focusId, fallbackToFirst = true } = {}) => {
    if (!promptEditorList) return;
    promptEditorList.innerHTML = '<p class="prompt-editor__empty">Loading…</p>';
    try {
      const { data, error } = await supabase
        .from(PROMPT_TABLE)
        .select('*')
        .order('archived', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      if (error) throw error;
      promptEditorItems = Array.isArray(data) ? data : [];
      let targetId = focusId || promptEditorActiveId || null;
      if (targetId && !getPromptEditorItemById(targetId)) {
        targetId = null;
      }
      if (!targetId && promptEditorItems.length && fallbackToFirst) {
        targetId = resolvePromptRecordId(promptEditorItems[0]);
      }
      promptEditorActiveId = targetId || null;
      renderPromptEditorList();
      const current = getPromptEditorItemById(promptEditorActiveId);
      if (current) {
        populatePromptEditorForm(current);
        setPromptEditorStatus('Editing saved prompt.', 'info');
      } else if (promptEditorItems.length) {
        resetPromptEditorForm();
        setPromptEditorStatus('Select a prompt to edit or create a new template.', 'info');
      } else {
        resetPromptEditorForm();
        setPromptEditorStatus('No prompts found. Create a new template to get started.', 'info');
      }
      updatePromptEditorDeleteState();
    } catch (error) {
      console.error('Prompt editor load error', error);
      promptEditorItems = [];
      const detail = describeSupabaseError(error);
      const message = detail || error?.message || 'Unable to load prompts.';
      promptEditorList.innerHTML = `<p class="prompt-editor__empty">${escapeHtml(message)}</p>`;
      resetPromptEditorForm();
      setPromptEditorStatus(detail ? `Supabase error: ${detail}` : 'Unable to load prompts from Supabase.', 'error');
      updatePromptEditorDeleteState();
    }
  };

  const openPromptEditor = async () => {
    if (!promptEditorModal) return;
    setPromptEditorStatus('Loading prompts…', 'info');
    promptEditorModal.hidden = false;
    lockBodyScroll();
    await refreshPromptEditorList({ fallbackToFirst: true });
    if (promptEditorName) {
      setTimeout(() => promptEditorName.focus(), 60);
    }
  };

  const closePromptEditor = () => {
    if (!promptEditorModal) return;
    promptEditorModal.hidden = true;
    unlockBodyScroll();
  };

  const startNewPrompt = () => {
    promptEditorActiveId = null;
    renderPromptEditorList();
    resetPromptEditorForm();
    setPromptEditorStatus('Create a new prompt template.', 'info');
    if (promptEditorName) {
      setTimeout(() => promptEditorName.focus(), 30);
    }
    updatePromptEditorDeleteState();
  };

  const readPromptEditorForm = () => {
    const id = (promptEditorId?.value || '').trim();
    const name = (promptEditorName?.value || '').trim();
    const slug = (promptEditorSlug?.value || '').trim();
    const description = (promptEditorDescription?.value || '').trim();
    const promptText = (promptEditorText?.value || '').trim();
    const sortValueRaw = (promptEditorSortOrder?.value || '').trim();
    let sortOrder = null;
    if (sortValueRaw) {
      const parsed = Number.parseInt(sortValueRaw, 10);
      if (Number.isFinite(parsed)) sortOrder = parsed;
    }
    return {
      id: id || null,
      name,
      slug,
      description,
      prompt_text: promptText,
      sort_order: sortOrder,
      is_default: Boolean(promptEditorDefault?.checked),
      archived: Boolean(promptEditorArchived?.checked),
    };
  };

  const savePromptEditor = async () => {
    const values = readPromptEditorForm();
    if (!values.name) {
      setPromptEditorStatus('Add a name for the prompt template.', 'error');
      if (promptEditorName) promptEditorName.focus();
      return;
    }
    if (!values.prompt_text) {
      setPromptEditorStatus('Write the prompt template before saving.', 'error');
      if (promptEditorText) promptEditorText.focus();
      return;
    }

    const currentId = values.id ? values.id.trim() : '';
    const editingExisting = Boolean(currentId);
    let slugValue = '';
    if (values.slug) {
      slugValue = normalizePromptSlug(values.slug);
    } else if (!editingExisting) {
      slugValue = normalizePromptSlug(values.name || `prompt-${Date.now()}`);
    }
    let recordId = currentId;
    if (!recordId) {
      recordId = generatePromptIdentifier(slugValue || values.name || `prompt-${Date.now()}`);
    }
    if (!editingExisting && !slugValue && recordId) {
      slugValue = recordId;
    }

    if (promptEditorId) promptEditorId.value = recordId;
    if (promptEditorSlug) promptEditorSlug.value = slugValue || '';

    if (!editingExisting && isPromptIdTaken(recordId)) {
      setPromptEditorStatus('Prompt identifier already exists. Adjust the name or slug.', 'error');
      if (promptEditorSlug) promptEditorSlug.focus();
      return;
    }
    if (slugValue && isPromptSlugTaken(slugValue, { ignoreId: recordId })) {
      setPromptEditorStatus('Prompt slug already exists. Try a different slug.', 'error');
      if (promptEditorSlug) promptEditorSlug.focus();
      return;
    }

    setPromptEditorStatus('Saving…', 'info');
    if (promptEditorSaveBtn) promptEditorSaveBtn.disabled = true;
    const basePayload = {
      name: values.name,
      description: values.description || null,
      prompt_text: values.prompt_text,
      sort_order: Number.isFinite(values.sort_order) ? values.sort_order : null,
      is_default: values.is_default,
      archived: values.archived,
    };
    let slugFallbackUsed = false;

    const attemptUpsert = async ({ includeId = true, includeSlug = promptSlugColumnSupported && Boolean(slugValue) } = {}) => {
      const payload = { ...basePayload };
      const options = {};
      if (includeSlug && slugValue) {
        payload.slug = slugValue || null;
      }
      if (includeId && recordId) {
        payload.id = recordId;
        options.onConflict = 'id';
      } else if (editingExisting && currentId) {
        payload.id = currentId;
        options.onConflict = 'id';
      } else if (includeSlug && slugValue) {
        options.onConflict = 'slug';
      }
      const query = supabase.from(PROMPT_TABLE).upsert(payload, options);
      const { data, error } = await query.select().maybeSingle();
      if (error) throw error;
      return data || null;
    };

    try {
      let saved = null;
      let includeSlug = promptSlugColumnSupported && Boolean(slugValue);
      let includeId = true;
      while (true) {
        try {
          saved = await attemptUpsert({ includeId, includeSlug });
          break;
        } catch (error) {
          if (includeSlug && isMissingPromptSlugColumnError(error)) {
            console.warn('Prompt save retry without slug column', error);
            slugValue = '';
            includeSlug = false;
            slugFallbackUsed = true;
            markPromptSlugUnsupported();
            continue;
          }
          if (includeId && !editingExisting && recordId && isUuidSyntaxError(error)) {
            console.warn('Prompt save fallback without explicit id', error);
            includeId = false;
            continue;
          }
          throw error;
        }
      }

      const savedId = resolvePromptRecordId(saved) || slugValue || recordId || values.slug || values.id || null;
      const savedPrimaryId = saved?.id || null;
      if (promptEditorId) {
        promptEditorId.value = savedId || '';
      }
      if (values.is_default) {
        const resetQuery = savedPrimaryId
          ? supabase.from(PROMPT_TABLE).update({ is_default: false }).neq('id', savedPrimaryId)
          : savedId
          ? supabase.from(PROMPT_TABLE).update({ is_default: false }).neq('slug', savedId)
          : null;
        if (resetQuery) {
          try {
            await resetQuery;
          } catch (err) {
            console.warn('Prompt default reset error', err);
          }
        }
      }
      await refreshPromptOptions();
      await refreshPromptEditorList({ focusId: savedId || null, fallbackToFirst: !savedId });
      if (savedId) {
        setSelectedPrompt(savedId, { persist: false });
        desiredPromptId = savedId;
        persistAiConfig();
      }
      if (slugFallbackUsed) {
        setPromptEditorStatus('Prompt saved. Supabase is missing the "slug" column so the identifier was generated automatically.', 'success');
      } else {
        setPromptEditorStatus('Prompt saved.', 'success');
      }
    } catch (error) {
      console.error('Prompt save error', error);
      const detail = describeSupabaseError(error);
      setPromptEditorStatus(detail || error.message || 'Unable to save prompt.', 'error');
    } finally {
      if (promptEditorSaveBtn) promptEditorSaveBtn.disabled = false;
    }
  };

  const deletePromptEditor = async () => {
    if (!promptEditorDeleteBtn) return;
    const record = getPromptEditorItemById(promptEditorActiveId);
    if (!record) {
      setPromptEditorStatus('Select a saved prompt before deleting.', 'error');
      updatePromptEditorDeleteState();
      return;
    }
    const recordId = resolvePromptRecordId(record);
    const target = getPromptDeletionTarget(record);
    if (!target) {
      setPromptEditorStatus('Unable to determine which prompt to delete.', 'error');
      updatePromptEditorDeleteState();
      return;
    }
    const label = record.name || record.slug || record.id || recordId || 'prompt';
    let confirmed = true;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      confirmed = window.confirm(`Delete prompt "${label}"? This cannot be undone.`);
    }
    if (!confirmed) return;
    setPromptEditorStatus('Deleting prompt…', 'info');
    promptEditorDeleteBtn.disabled = true;
    if (promptEditorSaveBtn) promptEditorSaveBtn.disabled = true;
    try {
      const query = supabase.from(PROMPT_TABLE).delete().eq(target.column, target.value);
      const { error } = await query;
      if (error) throw error;
      if (recordId) {
        promptEditorItems = promptEditorItems.filter((item) => resolvePromptRecordId(item) !== recordId);
      }
      promptEditorActiveId = null;
      await refreshPromptOptions();
      await refreshPromptEditorList({ fallbackToFirst: true });
      setPromptEditorStatus('Prompt deleted.', 'success');
    } catch (error) {
      console.error('Prompt delete error', error);
      const detail = describeSupabaseError(error);
      setPromptEditorStatus(detail || error.message || 'Unable to delete prompt.', 'error');
    } finally {
      if (promptEditorSaveBtn) promptEditorSaveBtn.disabled = false;
      promptEditorDeleteBtn.disabled = false;
      updatePromptEditorDeleteState();
    }
  };

  const renderPromptMenu = () => {
    if (!promptMenu) return;
    if (!promptOptions.length) {
      promptMenu.innerHTML = '<p class="muted-small" style="margin:4px 8px;">No prompts configured.</p>';
      return;
    }
    promptMenu.innerHTML = promptOptions
      .map((opt) => {
        const active = selectedPrompt?.id === opt.id ? 'active' : '';
        const description = opt.description ? `<span>${escapeHtml(opt.description)}</span>` : '';
        const label = escapeHtml(opt.name || 'Prompt');
        const id = escapeHtml(opt.id || '');
        return `<button type="button" data-prompt-id="${id}" class="${active}"><strong>${label}</strong>${description}</button>`;
      })
      .join('');
  };

  const updatePromptUI = () => {
    if (promptSelectLabel) {
      promptSelectLabel.textContent = selectedPrompt ? selectedPrompt.name : 'Select prompt';
    } else if (promptSelectBtn) {
      promptSelectBtn.textContent = selectedPrompt ? `${selectedPrompt.name} ▾` : 'Select prompt ▾';
    }
    if (promptSummary) {
      const summaryText = composePromptSummary({
        promptOptions,
        selectedPrompt,
        fallbackUsed: promptLoadUsedFallback,
        errorMessage: promptLoadErrorMessage,
      });
      promptSummary.textContent = summaryText;
    }
    if (promptPreview) {
      if (selectedPrompt?.prompt_text) {
        promptPreview.hidden = false;
        promptPreview.textContent = selectedPrompt.prompt_text.trim();
      } else {
        promptPreview.hidden = true;
        promptPreview.textContent = '';
      }
    }
    updatePromptSettingsSummary();
    renderPromptMenu();
  };

  const closePromptMenu = () => {
    if (promptMenu) promptMenu.hidden = true;
    if (promptSelectBtn) promptSelectBtn.setAttribute('aria-expanded', 'false');
  };

  const openPromptMenu = () => {
    if (!promptMenu) return;
    renderPromptMenu();
    promptMenu.hidden = false;
    if (promptSelectBtn) promptSelectBtn.setAttribute('aria-expanded', 'true');
  };

  const setSelectedPrompt = (id, { persist = true } = {}) => {
    const next = promptOptions.find((opt) => opt.id === id) || null;
    selectedPrompt = next;
    desiredPromptId = next?.id || null;
    updatePromptUI();
    if (persist) persistAiConfig();
  };

  const fetchPromptTemplates = async () => {
    try {
      const { data, error } = await supabase.from(PROMPT_TABLE).select('*');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const items = rows
        .map((row) => {
          const promptId =
            resolvePromptRecordId(row) ||
            slugify(row.name || row.title || row.slug || `prompt-${Math.random().toString(36).slice(2)}`);
          const promptText = row.prompt_text || row.template || row.body || '';
          const archived = row.archived ?? row.disabled ?? false;
          return {
            id: promptId,
            slug: row.slug || null,
            name: row.name || row.title || row.slug || 'Prompt',
            description: row.description || row.summary || '',
            prompt_text: promptText,
            sort_order: Number.isFinite(row.sort_order) ? row.sort_order : Number.parseInt(row.sort_order, 10),
            is_default: Boolean(row.is_default || row.default_prompt),
            archived: Boolean(archived),
          };
        })
        .filter((item) => (item.prompt_text || '').trim());
      const active = items.filter((item) => !item.archived);
      active.sort((a, b) => {
        const orderA = Number.isFinite(a.sort_order) ? a.sort_order : 999;
        const orderB = Number.isFinite(b.sort_order) ? b.sort_order : 999;
        if (orderA !== orderB) return orderA - orderB;
        return (a.name || '').localeCompare(b.name || '');
      });
      if (active.length) {
        return { items: active, error: null, usedDefault: false };
      }
    } catch (error) {
      console.warn('Prompt load error', error);
      return { items: DEFAULT_PROMPTS, error, usedDefault: true };
    }
    return { items: DEFAULT_PROMPTS, error: null, usedDefault: true };
  };

  const applyPromptOptions = (options = []) => {
    const list = Array.isArray(options) ? options : [];
    promptOptions = list.map((opt, index) => {
      const source = opt || {};
      const rawId = source.id ?? source.slug ?? null;
      const id = String(rawId ?? '').trim() || slugify(source.name || `prompt-${index + 1}`);
      return { ...source, id };
    });
    if (!promptOptions.length) {
      selectedPrompt = null;
      updatePromptUI();
      return;
    }
    const preferred =
      promptOptions.find((opt) => opt.id === desiredPromptId) ||
      promptOptions.find((opt) => opt.is_default) ||
      promptOptions[0];
    if (preferred) {
      setSelectedPrompt(preferred.id, { persist: false });
    } else {
      selectedPrompt = null;
      updatePromptUI();
    }
  };

  const refreshPromptOptions = async () => {
    if (promptSummary) promptSummary.textContent = 'Loading prompts…';
    const { items, error, usedDefault } = await fetchPromptTemplates();
    promptLoadErrorMessage = error ? describeSupabaseError(error) : '';
    promptLoadUsedFallback = Boolean(usedDefault);
    applyPromptOptions(items);
  };

  const fetchModelOptions = async () => {
    try {
      const { data, error } = await supabase.from(MODEL_TABLE).select('*');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const items = rows
        .map((row) => {
          const value = (row.value || row.id || '').toString().trim();
          const archived = row.archived ?? row.disabled ?? false;
          return {
            id: row.id || value,
            value,
            label: row.label || row.name || value,
            sort_order: Number.isFinite(row.sort_order) ? row.sort_order : Number.parseInt(row.sort_order, 10),
            is_default: Boolean(row.is_default || row.default_model),
            archived: Boolean(archived),
          };
        })
        .filter((item) => item.value);
      const active = items.filter((item) => !item.archived);
      active.sort((a, b) => {
        const orderA = Number.isFinite(a.sort_order) ? a.sort_order : 999;
        const orderB = Number.isFinite(b.sort_order) ? b.sort_order : 999;
        if (orderA !== orderB) return orderA - orderB;
        return (a.label || '').localeCompare(b.label || '');
      });
      if (active.length) return active;
    } catch (error) {
      console.warn('Model load error', error);
    }
    return DEFAULT_MODELS;
  };

  const applyModelOptions = (options = []) => {
    modelOptions = options;
    if (!aiModel) return;
    aiModel.innerHTML = '';
    if (!options.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models available';
      aiModel.appendChild(opt);
      aiModel.disabled = true;
      return;
    }
    aiModel.disabled = false;
    options.forEach((option) => {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label || option.value;
      aiModel.appendChild(opt);
    });
    const fallback =
      (desiredModelValue && options.find((opt) => opt.value === desiredModelValue)?.value) ||
      options.find((opt) => opt.is_default)?.value ||
      options[0]?.value || '';
    if (fallback) {
      aiModel.value = fallback;
      desiredModelValue = fallback;
    }
    updateAnalystIdentity();
  };

  const refreshModelOptions = async () => {
    if (aiModel) {
      aiModel.innerHTML = '<option value="">Loading…</option>';
      aiModel.disabled = true;
    }
    const options = await fetchModelOptions();
    applyModelOptions(options);
  };

  const openModelEditor = () => {
    if (!modelEditorModal || !modelEditorInput) return;
    if (!modelOptions.length) modelOptions = DEFAULT_MODELS.slice();
    modelEditorModal.hidden = false;
    modelEditorInput.value = modelOptions.map((opt) => `${opt.value} | ${opt.label}`).join('\n');
    if (modelEditorStatus) {
      modelEditorStatus.textContent = '';
      modelEditorStatus.dataset.tone = '';
    }
    setTimeout(() => {
      modelEditorInput?.focus();
    }, 50);
  };

  const closeModelEditor = () => {
    if (modelEditorModal) modelEditorModal.hidden = true;
    if (modelEditorStatus) {
      modelEditorStatus.textContent = '';
      modelEditorStatus.dataset.tone = '';
    }
  };

  const parseModelListInput = () => {
    if (!modelEditorInput) return [];
    const lines = (modelEditorInput.value || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) throw new Error('Add at least one model option.');
    return lines.map((line, index) => {
      const [valuePart, labelPart] = line.split('|');
      const value = (valuePart || '').trim();
      const label = (labelPart || '').trim() || value;
      if (!value) throw new Error(`Missing model identifier on line ${index + 1}.`);
      return { value, label, sort_order: index + 1, is_default: index === 0 };
    });
  };

  const syncModelOptions = async (list) => {
    try {
      const { data: existing } = await supabase.from(MODEL_TABLE).select('value');
      const existingValues = Array.isArray(existing) ? existing.map((item) => item.value) : [];
      const newValues = list.map((item) => item.value);
      const toArchive = existingValues.filter((value) => !newValues.includes(value));
      if (toArchive.length) {
        try {
          await supabase.from(MODEL_TABLE).update({ archived: true }).in('value', toArchive);
        } catch (archiveError) {
          console.warn('Model archive error', archiveError);
        }
      }
      const payload = list.map((item, index) => ({
        value: item.value,
        label: item.label,
        sort_order: index + 1,
        is_default: index === 0,
        archived: false,
      }));
      const { error } = await supabase.from(MODEL_TABLE).upsert(payload, { onConflict: 'value' });
      if (error) throw error;
      return payload;
    } catch (error) {
      throw error;
    }
  };

  const saveModelList = async () => {
    let parsed;
    try {
      parsed = parseModelListInput();
    } catch (err) {
      if (modelEditorStatus) {
        modelEditorStatus.textContent = err.message || 'Unable to parse models.';
        modelEditorStatus.dataset.tone = 'error';
      }
      return;
    }
    if (modelEditorStatus) {
      modelEditorStatus.textContent = 'Saving…';
      modelEditorStatus.dataset.tone = 'info';
    }
    try {
      await syncModelOptions(parsed);
      modelOptions = parsed;
      applyModelOptions(modelOptions);
      persistAiConfig();
      if (modelEditorStatus) {
        modelEditorStatus.textContent = 'Model list updated.';
        modelEditorStatus.dataset.tone = 'success';
      }
      setTimeout(() => closeModelEditor(), 800);
    } catch (error) {
      console.error('Model save error', error);
      if (modelEditorStatus) {
        modelEditorStatus.textContent = error.message || 'Unable to save models.';
        modelEditorStatus.dataset.tone = 'error';
      }
    }
  };

  const fillFromAnalysis = (text, options = {}) => {
    if (!text) {
      setAnalysisStatus('Add the analysis markdown first.', 'error');
      return;
    }
    try {
      const parsed = parseMasterAnalysis(text);
      if (parsed.topic && topicInput) topicInput.value = parsed.topic;
      if (parsed.conclusion && conclusionInput) conclusionInput.value = parsed.conclusion;
      if (findingsInput) findingsInput.value = (parsed.findings || []).join('\n');
      if (visualInput) visualInput.value = parsed.visual || '';
      if (tagsInput && (!tagsInput.value.trim() || options.forceTags)) {
        const tags = (parsed.tags || []).filter(Boolean);
        if (tags.length) tagsInput.value = tags.join(', ');
      }
      if (options.onParsed) options.onParsed(parsed);
      setAnalysisStatus('Analysis parsed. Review the generated fields below.', 'success');
    } catch (err) {
      console.warn('parseMasterAnalysis error', err);
      setAnalysisStatus(err.message || 'Unable to parse the analysis input.', 'error');
    }
  };

  switchAnalysisMode('manual');
  await loadAiConfig({ includeRemote: true });
  updateTaskTitle();

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.analysisMode || 'manual';
      switchAnalysisMode(mode);
    });
  });

  if (aiKey) {
    ['change', 'blur'].forEach((evt) => aiKey.addEventListener(evt, persistAiConfig));
  }
  if (aiModel) {
    aiModel.addEventListener('change', () => {
      persistAiConfig();
      updateAnalystIdentity();
    });
  }

  if (costSnapshotButton) {
    costSnapshotButton.addEventListener('click', () => {
      openCostModal();
    });
  }

  if (costModalBackdrop) {
    costModalBackdrop.addEventListener('click', () => {
      closeCostModal();
    });
  }

  if (costModalCloseBtn) {
    costModalCloseBtn.addEventListener('click', () => {
      closeCostModal();
    });
  }

  if (costModalFooterCloseBtn) {
    costModalFooterCloseBtn.addEventListener('click', () => {
      closeCostModal();
    });
  }

  if (costRefreshBtn) {
    costRefreshBtn.addEventListener('click', () => {
      refreshCostBalance();
    });
  }

  if (costCaptureBtn) {
    costCaptureBtn.addEventListener('click', () => {
      captureCostSnapshot();
    });
  }

  if (costClearBtn) {
    costClearBtn.addEventListener('click', () => {
      if (!costSnapshots.length) {
        setCostStatus('No snapshots to clear.', 'info');
        return;
      }
      let confirmed = true;
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        confirmed = window.confirm('Clear all saved cost snapshots?');
      }
      if (!confirmed) return;
      costSnapshots = [];
      saveCostSnapshots();
      renderCostSnapshots();
      setCostStatus('Cleared saved snapshots.', 'success');
    });
  }

  if (taskNameInput) {
    ['input', 'change'].forEach((evt) => taskNameInput.addEventListener(evt, updateTaskTitle));
  }

  if (lockActionBtn) {
    lockActionBtn.addEventListener('click', () => {
      ensureLatestAccess({ forceAuthRefresh: true });
    });
  }

  automationLaunchButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      openAutomationModal(btn);
    });
  });

  automationModeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      toggleAutomationSequence();
    });
  });

  if (automationModalBackdrop) {
    automationModalBackdrop.addEventListener('click', () => {
      closeAutomationModal();
    });
  }

  if (automationModalCloseBtn) {
    automationModalCloseBtn.addEventListener('click', () => {
      closeAutomationModal();
    });
  }

  if (automationModalCancelBtn) {
    automationModalCancelBtn.addEventListener('click', () => {
      closeAutomationModal();
    });
  }

  if (automationSettingsForm) {
    automationSettingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      updateAutomationStatsDisplay();
      closeAutomationModal();
    });
  }

  taskLaunchButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      openTaskModal(btn);
    });
  });

  if (taskLockedActionBtn) {
    taskLockedActionBtn.addEventListener('click', () => {
      ensureLatestAccess({ forceAuthRefresh: true });
      closeTaskModal();
    });
  }

  if (taskModalBackdrop) {
    taskModalBackdrop.addEventListener('click', () => {
      closeTaskModal();
    });
  }

  if (taskModalCloseBtn) {
    taskModalCloseBtn.addEventListener('click', () => {
      closeTaskModal();
    });
  }

  if (promptSelectBtn) {
    promptSelectBtn.addEventListener('click', async () => {
      if (!promptOptions.length) {
        await refreshPromptOptions();
      }
      const hidden = promptMenu?.hidden ?? true;
      if (hidden) openPromptMenu();
      else closePromptMenu();
    });
  }

  if (promptMenu) {
    promptMenu.addEventListener('click', (event) => {
      const target = event.target.closest('[data-prompt-id]');
      if (!target) return;
      event.preventDefault();
      const id = target.getAttribute('data-prompt-id');
      if (id) setSelectedPrompt(id);
      closePromptMenu();
    });
  }

  document.addEventListener('click', (event) => {
    if (!promptMenu || promptMenu.hidden) return;
    if (promptSelectBtn && (promptSelectBtn === event.target || promptSelectBtn.contains(event.target))) return;
    if (promptMenu.contains(event.target)) return;
    closePromptMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePromptMenu();
      if (!costModal?.hidden) {
        closeCostModal();
        return;
      }
      if (!promptEditorModal?.hidden) {
        closePromptEditor();
        return;
      }
      if (!modelEditorModal?.hidden) {
        closeModelEditor();
        return;
      }
      if (!automationModal?.hidden) {
        closeAutomationModal();
        return;
      }
      if (!taskModal?.hidden) {
        closeTaskModal();
      }
    }
  });

  if (promptEditorOpenBtn) {
    promptEditorOpenBtn.addEventListener('click', async () => {
      await openPromptEditor();
    });
  }

  if (promptEditorCloseBtn) {
    promptEditorCloseBtn.addEventListener('click', () => {
      closePromptEditor();
    });
  }

  if (promptEditorCancelBtn) {
    promptEditorCancelBtn.addEventListener('click', () => {
      closePromptEditor();
    });
  }

  if (promptEditorBackdrop) {
    promptEditorBackdrop.addEventListener('click', () => {
      closePromptEditor();
    });
  }

  if (promptEditorNewBtn) {
    promptEditorNewBtn.addEventListener('click', () => {
      startNewPrompt();
    });
  }

  if (promptEditorDeleteBtn) {
    promptEditorDeleteBtn.addEventListener('click', async () => {
      await deletePromptEditor();
    });
  }

  if (promptEditorList) {
    promptEditorList.addEventListener('click', (event) => {
      const target = event.target.closest('[data-editor-prompt]');
      if (!target) return;
      event.preventDefault();
      const id = target.getAttribute('data-editor-prompt');
      if (id) setPromptEditorSelection(id);
    });
  }

  if (promptEditorForm) {
    promptEditorForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await savePromptEditor();
    });
  }

  if (editModelBtn) {
    editModelBtn.addEventListener('click', () => {
      if (modelEditorModal?.hidden) openModelEditor();
      else closeModelEditor();
    });
  }

  if (modelEditorCloseBtn) {
    modelEditorCloseBtn.addEventListener('click', () => {
      closeModelEditor();
    });
  }

  if (modelEditorBackdrop) {
    modelEditorBackdrop.addEventListener('click', () => {
      closeModelEditor();
    });
  }

  if (cancelModelBtn) {
    cancelModelBtn.addEventListener('click', () => {
      closeModelEditor();
    });
  }

  if (saveModelBtn) {
    saveModelBtn.addEventListener('click', () => {
      saveModelList();
    });
  }

  if (parseBtn && analysisRaw) {
    parseBtn.addEventListener('click', () => {
      const raw = (analysisRaw.value || '').trim();
      if (!raw) {
        setAnalysisStatus('Add the analysis markdown first.', 'error');
        return;
      }
      setAnalysisStatus('Parsing analysis…', 'info');
      setTimeout(() => fillFromAnalysis(raw), 30);
    });
  }

  if (clearAnalysisBtn && analysisRaw) {
    clearAnalysisBtn.addEventListener('click', () => {
      analysisRaw.value = '';
      setAnalysisStatus('Analysis input cleared.', 'info');
    });
  }

  if (aiGenerateBtn) {
    aiGenerateBtn.addEventListener('click', async () => {
      const ticker = (aiTicker?.value || '').trim();
      const company = (aiCompany?.value || '').trim();
      const exchange = (aiExchange?.value || '').trim();
      const notes = (aiNotes?.value || '').trim();
      const apiKey = normalizeOpenRouterApiKey(aiKey?.value);
      const model = (aiModel?.value || '').trim() || desiredModelValue || 'openrouter/auto';

      if (!company) {
        setAnalysisStatus('Company name is required for AI generation.', 'error');
        return;
      }
      if (!apiKey) {
        setAnalysisStatus('Provide an AI API key to generate the analysis.', 'error');
        return;
      }
      if (!model) {
        setAnalysisStatus('Select an AI model before generating.', 'error');
        return;
      }

      if (!promptOptions.length) {
        await refreshPromptOptions();
      }
      const promptConfig = selectedPrompt || promptOptions[0];
      if (!promptConfig) {
        setAnalysisStatus('Add an AI prompt template in Supabase before generating.', 'error');
        return;
      }

      if (aiModel) {
        aiModel.value = model;
      }
      desiredModelValue = model;
      persistAiConfig();
      closePromptMenu();

      const prompt = buildPromptFromSelection(promptConfig, { ticker, company, exchange, notes });
      if (!prompt.trim()) {
        setAnalysisStatus('Selected prompt template is empty. Update it in Supabase.', 'error');
        return;
      }

      setAnalysisStatus('Generating analysis via AI…', 'info');
      aiGenerateBtn.disabled = true;

      try {
        const content = await callOpenRouterCompletion({ apiKey, model, prompt });
        if (!content.trim()) throw new Error('AI returned an empty response.');
        if (analysisRaw) analysisRaw.value = content.trim();
        if (promptInput) {
          const meta = promptConfig?.name ? `Template: ${promptConfig.name}` : 'Template: (fallback master analysis)';
          promptInput.value = `${meta}\n\n${prompt}`;
        }
        switchAnalysisMode('manual');
        fillFromAnalysis(content.trim(), {
          forceTags: true,
          onParsed: (parsed) => {
            if (tagsInput && parsed?.ticker) {
              const existing = tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean);
              if (!existing.includes(parsed.ticker)) {
                existing.unshift(parsed.ticker);
                tagsInput.value = Array.from(new Set(existing)).join(', ');
              }
            }
          },
        });
        const promptLabel = promptConfig?.name || 'Master Stock Analysis';
        setAnalysisStatus(`AI analysis generated with "${promptLabel}". Review the fields before publishing.`, 'success');
      } catch (error) {
        console.error('AI generation error', error);
        setAnalysisStatus(error.message || 'AI generation failed.', 'error');
      } finally {
        aiGenerateBtn.disabled = false;
      }
    });
  }

  const updateLockButton = (action, label) => {
    if (!lockActionBtn) return;
    if (!action) {
      lockActionBtn.hidden = true;
      return;
    }
    lockActionBtn.hidden = false;
    lockActionBtn.setAttribute('data-open-auth', action);
    if (label) {
      lockActionBtn.textContent = label;
    } else {
      lockActionBtn.textContent = action === 'profile' ? 'Manage account' : 'Sign in';
    }
  };

  const showLocked = (message, { action = 'signin', actionLabel } = {}) => {
    locked.hidden = false;
    if (form) form.hidden = true;
    if (recentSection) recentSection.hidden = true;
    if (lockMsg) {
      lockMsg.textContent = ` ${message}`;
    }
    updateLockButton(action, actionLabel);
    closePromptMenu();
    closePromptEditor();
    setTaskLaunchAvailability(false);
    if (taskLockedMessageText) taskLockedMessageText.textContent = message;
    if (taskLockedActionBtn) {
      if (!action) {
        taskLockedActionBtn.hidden = true;
      } else {
        taskLockedActionBtn.hidden = false;
        taskLockedActionBtn.setAttribute('data-open-auth', action);
        taskLockedActionBtn.textContent = actionLabel || (action === 'profile' ? 'Manage account' : 'Sign in');
      }
    }
    closeTaskModal();
  };

  const hideLocked = () => {
    locked.hidden = true;
    if (lockMsg) {
      lockMsg.textContent = '';
    }
    updateLockButton(null);
    if (taskLockedMessage) taskLockedMessage.hidden = true;
    if (taskLockedActionBtn) taskLockedActionBtn.hidden = false;
  };

  let adminBootstrapReady = false;
  let adminBootstrapPromise = null;

  const runAdminBootstrap = async () => {
    if (adminBootstrapReady) return;
    if (!adminBootstrapPromise) {
      adminBootstrapPromise = (async () => {
        await loadAiConfig({ includeRemote: true });
        await refreshModelOptions();
        await refreshPromptOptions();
        await loadRecent();
        adminBootstrapReady = true;
      })()
        .catch((error) => {
          console.error('Editor bootstrap error', error);
          throw error;
        })
        .finally(() => {
          adminBootstrapPromise = null;
        });
    }
    try {
      await adminBootstrapPromise;
    } catch (error) {
      adminBootstrapReady = false;
    }
  };

  const applyAccessState = async () => {
    const account = getAccountState();
    const signedIn = !!account.user;
    if (!signedIn) {
      showLocked('Please sign in with an admin account to continue.', {
        action: 'signin',
        actionLabel: 'Sign in',
      });
      return;
    }
    if (!hasRole('admin')) {
      showLocked('Your account is signed in but does not have admin permissions.', {
        action: 'profile',
        actionLabel: 'Manage account',
      });
      return;
    }
    hideLocked();
    if (form) form.hidden = false;
    if (recentSection) recentSection.hidden = false;
    setTaskLaunchAvailability(true);
    await runAdminBootstrap();
  };

  const handleAuthChange = () => {
    applyAccessState().catch((error) => console.warn('Editor access state error', error));
  };

  if (dateInput) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  if (aiKey) {
    aiKey.addEventListener('input', () => {
      const value = normalizeOpenRouterApiKey(aiKey.value);
      updateAiKeyPreview(value);
      setAiKeyStatus('', 'info');
    });
  }

  if (aiKeyRefreshBtn) {
    aiKeyRefreshBtn.addEventListener('click', async () => {
      aiKeyRefreshBtn.disabled = true;
      setAiKeyStatus('Refreshing key from Supabase…');
      await ensureSupabaseAiKey({
        force: true,
        onStatus: ({ value, source, error }) => {
          if (error) {
            if (value && source === 'cache') {
              setAiKeyStatus('Supabase request failed. Using cached key.', 'error');
            } else if (value && source === 'default') {
              setAiKeyStatus('Supabase request failed. Using default OpenRouter key.', 'error');
            } else {
              setAiKeyStatus('Unable to load key from Supabase.', 'error');
            }
            return;
          }
          if (source === 'supabase') {
            setAiKeyStatus('Loaded active OpenRouter key from Supabase.', 'success');
          } else if (value && source === 'cache') {
            setAiKeyStatus('Using previously cached key. No newer Supabase key found.', 'info');
          } else if (value && source === 'default') {
            setAiKeyStatus('Using default OpenRouter key configured for this workspace.', 'info');
          } else {
            setAiKeyStatus('No OpenRouter key available. Add one locally or in Supabase.', 'error');
          }
        },
      });
      aiKeyRefreshBtn.disabled = false;
    });
  }

  await onAuthReady();
  await applyAccessState();
  document.addEventListener('ffauth:change', handleAuthChange);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensureLatestAccess({ forceAuthRefresh: true });
    }
  });

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
      analysis_markdown: (formData.get('analysis_raw') || '').trim(),
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
    await loadAiConfig();
    switchAnalysisMode('manual');
    setAnalysisStatus('Entry published. Ready for another analysis.', 'success');
    await loadRecent();
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      form.reset();
      if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
      await loadAiConfig();
      switchAnalysisMode('manual');
      setMessage('Form reset.');
      setAnalysisStatus('Form reset.', 'info');
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

function isUuidSyntaxError(error) {
  if (!error) return false;
  const code = error.code || error?.cause?.code;
  if (code && String(code) === '22P02') return true;
  const message = String(error.message || error.details || '').toLowerCase();
  return message.includes('invalid input syntax for type uuid');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/--+/g, '-') || 'item';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

function parseMasterAnalysis(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('Add the analysis markdown before parsing.');

  const lines = text.split('\n');
  const firstLine = lines.find((line) => line.trim()) || '';
  const { company, ticker } = extractCompanyTicker(firstLine);
  const topic = deriveTopic(firstLine, company, ticker) || firstLine.slice(0, 160);
  const conclusion = extractOverallVerdict(text);
  const findings = extractKeyFindings(text);
  const visual = extractPrimaryTable(text);
  const tags = [];
  if (ticker) tags.push(ticker);
  tags.push('Master Analysis');

  return {
    topic: topic.trim(),
    conclusion: conclusion.trim(),
    findings,
    visual,
    tags: Array.from(new Set(tags.filter(Boolean))),
    ticker,
  };
}

function extractCompanyTicker(line) {
  const cleaned = String(line || '');
  const match = cleaned.match(/for\s+(.+?)\s*\(Ticker:\s*([A-Z0-9.\- ]+?)(?:,|\))/i);
  if (match) {
    return {
      company: match[1].trim(),
      ticker: match[2].replace(/[^A-Z0-9.\-]/gi, '').trim(),
    };
  }
  const fallbackTicker = cleaned.match(/\(Ticker:\s*([A-Z0-9.\- ]+)\)/i);
  return {
    company: '',
    ticker: fallbackTicker ? fallbackTicker[1].replace(/[^A-Z0-9.\-]/gi, '').trim() : '',
  };
}

function deriveTopic(firstLine, company, ticker) {
  if (company && ticker) return `${company} (${ticker}) — Master Stock Analysis`;
  if (company) return `${company} — Master Stock Analysis`;
  if (ticker) return `${ticker} — Master Stock Analysis`;
  return firstLine.trim();
}

function extractOverallVerdict(text) {
  const lower = text.toLowerCase();
  const idx = lower.indexOf('overall verdict');
  if (idx !== -1) {
    const segment = text
      .slice(idx)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (segment.length) {
      const first = segment[0].replace(/overall verdict[:\-]*/i, '').trim();
      if (first) return first;
      if (segment[1]) return segment[1];
    }
  }
  const finalSection = text.split(/6\.\s*Final Conclusions/i)[1];
  if (finalSection) {
    const lines = finalSection
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const match = lines.find((line) => line.toLowerCase().startsWith('overall verdict'));
    if (match) return match.replace(/overall verdict[:\-]*/i, '').trim();
    if (lines.length) {
      const first = lines[0].replace(/^[-*•]\s*/, '').trim();
      if (first) return first;
    }
  }
  return '';
}

function extractKeyFindings(text) {
  const findings = [];
  const finalSection = text.split(/6\.\s*Final Conclusions/i)[1];
  if (finalSection) {
    const lines = finalSection.split('\n');
    let capturing = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        if (capturing) break;
        continue;
      }
      if (/^[-*•]/.test(line)) {
        findings.push(line.replace(/^[-*•]\s*/, '').trim());
        capturing = true;
      } else if (/^Overall Verdict/i.test(line)) {
        findings.push(line.replace(/^Overall Verdict[:\-]*/i, '').trim());
        capturing = true;
      } else if (capturing && findings.length) {
        findings[findings.length - 1] = `${findings[findings.length - 1]} ${line}`.trim();
      }
      if (findings.length >= 6) break;
    }
  }
  if (!findings.length) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[-*•]/.test(line))
      .map((line) => line.replace(/^[-*•]\s*/, '').trim())
      .slice(0, 6);
  }
  return findings.slice(0, 6);
}

function extractPrimaryTable(text) {
  const lines = text.split('\n');
  const tables = [];
  let current = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/\|/.test(line) && !/^⸻/.test(line)) {
      current.push(line);
    } else if (current.length) {
      tables.push(current.join('\n').trim());
      current = [];
    }
  }
  if (current.length) tables.push(current.join('\n').trim());
  if (!tables.length) return '';
  tables.sort((a, b) => b.length - a.length);
  return tables[0];
}

function buildPromptFromSelection(promptConfig, context) {
  if (promptConfig?.prompt_text) {
    return renderPromptTemplate(promptConfig.prompt_text, {
      ticker: context.ticker,
      company: context.company,
      exchange: context.exchange,
      notes: context.notes,
      promptName: promptConfig?.name || '',
    });
  }
  return buildMasterAnalysisPrompt(context);
}

function renderPromptTemplate(template, context) {
  if (!template) return '';
  const company = context.company || '';
  const ticker = context.ticker || '';
  const exchange = context.exchange || '';
  const notes = context.notes || '';
  const promptName = context.promptName || '';
  const companyLine = buildCompanyLine(company, ticker, exchange);
  const tickerLine = ticker ? `Ticker: ${ticker}` : '';
  const exchangeLine = exchange ? `Exchange: ${exchange}` : '';
  const exchangeSuffix = exchange ? `, ${exchange}` : '';
  const notesBlock = notes ? `\n\nAnalyst guidance to incorporate:\n${notes}` : '';
  const replacements = {
    company,
    ticker,
    exchange,
    company_line: companyLine,
    company_or_ticker: company || ticker,
    ticker_line: tickerLine,
    exchange_line: exchangeLine,
    exchange_suffix: exchangeSuffix,
    notes,
    notes_block: notesBlock,
    prompt_name: promptName,
  };
  return template.replace(/{{\s*([a-z0-9_]+)\s*}}/gi, (_, key) => replacements[key.toLowerCase()] ?? '').trim();
}

function buildCompanyLine(company, ticker, exchange) {
  const name = company || ticker || '';
  if (!name) return '';
  const details = [];
  if (ticker) details.push(`Ticker: ${ticker}`);
  if (exchange) details.push(exchange);
  return details.length ? `${name} (${details.join(', ')})` : name;
}

function buildMasterAnalysisPrompt({ ticker, company, exchange, notes }) {
  const template = DEFAULT_PROMPTS.find((item) => item.id === 'deep-research')?.prompt_text;
  if (template) {
    return renderPromptTemplate(template, { ticker, company, exchange, notes });
  }
  const companyLine = buildCompanyLine(company, ticker, exchange);
  const fallbackName = companyLine || company || ticker || 'the company';
  const tickerLabel = ticker ? `Ticker: ${ticker}${exchange ? `, ${exchange}` : ''}` : '';
  const descriptor = tickerLabel ? `${fallbackName} (${tickerLabel})` : fallbackName;
  const guidance = notes ? `\n\nAnalyst guidance to incorporate:\n${notes}` : '';
  return `You are the FutureFunds.ai research analyst. Produce a MASTER STOCK ANALYSIS (Markdown-Table Edition) for ${descriptor}. Match the structure of the reference template exactly.\n\nFollow this order and formatting:\n1. Intro sentence: "Below is a MASTER STOCK ANALYSIS (Markdown-Table Edition) for ${descriptor} — ..." with a short rationale.\n2. Insert a line containing only ⸻ between every major section.\n3. Section A. One-Liner Summary — Markdown table with columns Ticker | Risk | Quality | Timing | Composite Score (/10).\n4. Section B. Final Verdicts — One Line — list Risk, Quality, Timing values.\n5. Section C. Standardized Scorecard — One Line — Markdown table with the six specified metrics.\n6. Section D. Valuation Ranges — provide USD bear/base/bull table and paragraph with NOK conversions.\n7. Narrative section — short paragraph plus bullet list of pricing, market cap, revenue, catalysts.\n8. Sections 1 through 5 with the same headings (Downside & Risk Analysis; Business Model & Growth Opportunities; Scenario Analysis (include Markdown table with Bear/Base/Bull rows and valuation ranges); Valuation Analysis; Timing & Market Momentum). Use concise bullet points with data.\n9. Section 6. Final Conclusions — bullet lines for Risk, Quality, Timing plus an "Overall Verdict" sentence.\n10. Finish with a note paragraph starting with 🚩 Note:.\n\nRequirements:\n- Use realistic figures and ratings based on the latest publicly available information and reasonable assumptions.\n- Keep bullet points sharp and decision-oriented.\n- Ensure Markdown tables use pipes and render cleanly.\n- Maintain the same tone as the template (professional, catalyst-aware).${guidance}\n\nReturn only the Markdown content.`;
}

function sanitizeHeaderValue(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  let sanitized = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code <= 0xff && char !== '\r' && char !== '\n') {
      sanitized += char;
    }
  }
  sanitized = sanitized.trim();
  return sanitized || fallback;
}

async function callOpenRouterCompletion({ apiKey, model, prompt }) {
  const token = normalizeOpenRouterApiKey(apiKey);
  if (!token) throw new Error('Provide a valid OpenRouter API key.');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  const body = {
    model,
    temperature: 0.35,
    max_tokens: 1800,
    messages: [
      {
        role: 'system',
        content: 'You are a financial analyst who writes structured research in Markdown with tables and bullet points.',
      },
      { role: 'user', content: prompt },
    ],
  };

  const requestHeaders = { ...headers, 'X-Title': 'FutureFunds Universe Editor' };
  if (typeof window !== 'undefined') {
    const { location, document } = window;
    const referer = location?.href || location?.origin || '';
    if (referer && /^https?:/i.test(referer)) {
      requestHeaders['HTTP-Referer'] = sanitizeHeaderValue(referer, referer);
    }
    const title = document?.title?.trim();
    if (title) {
      requestHeaders['X-Title'] = sanitizeHeaderValue(title, 'FutureFunds Universe Editor');
    } else {
      requestHeaders['X-Title'] = 'FutureFunds Universe Editor';
    }
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    let parsedDetail = null;
    try {
      detail = (await res.text()) || '';
      try {
        parsedDetail = detail ? JSON.parse(detail) : null;
      } catch {
        parsedDetail = null;
      }
    } catch {
      detail = '';
    }
    if (parsedDetail?.error?.message) {
      const message = parsedDetail.error.message;
      if (res.status === 401) {
        throw new Error(`OpenRouter rejected the API key: ${message}. Check that the key is valid and permitted for this domain.`);
      }
      throw new Error(`OpenRouter error ${res.status}: ${message}`);
    }
    const reason = detail ? `${res.status} ${detail.slice(0, 160)}` : `${res.status}`;
    throw new Error(`OpenRouter error ${reason}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content.');
  return String(content);
}
