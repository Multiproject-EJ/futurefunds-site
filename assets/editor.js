// /assets/editor.js
import { supabase } from './supabase.js';
import { requireRole, onAuthReady, getAccountState } from './auth.js';

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
  const aiModel = document.getElementById('aiModel');
  const promptSelectBtn = document.getElementById('promptSelectBtn');
  const promptSelectLabel = document.getElementById('promptSelectLabel');
  const promptMenu = document.getElementById('promptMenu');
  const promptSummary = document.getElementById('promptSummary');
  const promptPreview = document.getElementById('promptPreview');
  const editModelBtn = document.getElementById('editModelList');
  const modelEditor = document.getElementById('modelEditor');
  const modelEditorInput = document.getElementById('modelEditorInput');
  const modelEditorStatus = document.getElementById('modelEditorStatus');
  const saveModelBtn = document.getElementById('saveModelList');
  const cancelModelBtn = document.getElementById('cancelModelList');
  const promptEditorOpenBtn = document.getElementById('openPromptEditor');
  const promptEditorModal = document.getElementById('promptEditorModal');
  const promptEditorList = document.getElementById('promptEditorList');
  const promptEditorForm = document.getElementById('promptEditorForm');
  const promptEditorStatus = document.getElementById('promptEditorStatus');
  const promptEditorId = document.getElementById('promptEditorId');
  const promptEditorName = document.getElementById('promptEditorName');
  const promptEditorSlug = document.getElementById('promptEditorSlug');
  const promptEditorDescription = document.getElementById('promptEditorDescription');
  const promptEditorText = document.getElementById('promptEditorText');
  const promptEditorSortOrder = document.getElementById('promptEditorSortOrder');
  const promptEditorDefault = document.getElementById('promptEditorDefault');
  const promptEditorArchived = document.getElementById('promptEditorArchived');
  const promptEditorCloseBtn = document.getElementById('closePromptEditor');
  const promptEditorCancelBtn = document.getElementById('cancelPromptEditor');
  const promptEditorNewBtn = document.getElementById('addPromptTemplate');
  const promptEditorBackdrop = promptEditorModal?.querySelector('[data-close-prompt]');
  const promptEditorSaveBtn = document.getElementById('savePromptEditor');

  const AI_KEY_STORAGE = 'ff-editor-ai-key';
  const AI_MODEL_STORAGE = 'ff-editor-ai-model';
  const AI_PROMPT_STORAGE = 'ff-editor-ai-prompt';

  let promptOptions = [];
  let modelOptions = [];
  let selectedPrompt = null;
  let desiredPromptId = null;
  let desiredModelValue = null;
  let supabaseAiKeyCache = null;
  let promptEditorItems = [];
  let promptEditorActiveId = null;

  if (!form || !locked) return;

  const lockMsg = document.getElementById('editorLockMsg');

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
  };

  const setAiKeyInput = (value) => {
    if (!aiKey) return;
    aiKey.value = (value || '').trim();
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

  const ensureSupabaseAiKey = async ({ force = false } = {}) => {
    if (supabaseAiKeyCache && !force) {
      setAiKeyInput(supabaseAiKeyCache);
      return supabaseAiKeyCache;
    }
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
      supabaseAiKeyCache = data?.api_key || null;
      if (supabaseAiKeyCache) {
        setAiKeyInput(supabaseAiKeyCache);
      }
    } catch (error) {
      supabaseAiKeyCache = supabaseAiKeyCache || null;
      console.warn('AI key fetch error', error);
    }
    return supabaseAiKeyCache;
  };

  const loadAiConfig = async ({ includeRemote = false, forceRemote = false } = {}) => {
    loadLocalAiPreferences();
    if (includeRemote) {
      await ensureSupabaseAiKey({ force: forceRemote });
    }
  };

  const persistAiConfig = () => {
    try {
      if (aiKey) {
        const value = (aiKey.value || '').trim();
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

  const renderPromptEditorList = () => {
    if (!promptEditorList) return;
    if (!promptEditorItems.length) {
      promptEditorList.innerHTML = '<p class="prompt-editor__empty">No prompts yet.</p>';
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
    } catch (error) {
      console.error('Prompt editor load error', error);
      promptEditorItems = [];
      promptEditorList.innerHTML = `<p class="prompt-editor__empty">${escapeHtml(error.message || 'Unable to load prompts.')}</p>`;
      resetPromptEditorForm();
      setPromptEditorStatus('Unable to load prompts from Supabase.', 'error');
    }
  };

  let previousBodyOverflow = '';

  const openPromptEditor = async () => {
    if (!promptEditorModal) return;
    setPromptEditorStatus('Loading prompts…', 'info');
    promptEditorModal.hidden = false;
    if (typeof document !== 'undefined' && document.body) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    await refreshPromptEditorList({ fallbackToFirst: true });
    if (promptEditorName) {
      setTimeout(() => promptEditorName.focus(), 60);
    }
  };

  const closePromptEditor = () => {
    if (!promptEditorModal) return;
    promptEditorModal.hidden = true;
    if (typeof document !== 'undefined' && document.body) {
      document.body.style.overflow = previousBodyOverflow || '';
      previousBodyOverflow = '';
    }
  };

  const startNewPrompt = () => {
    promptEditorActiveId = null;
    renderPromptEditorList();
    resetPromptEditorForm();
    setPromptEditorStatus('Create a new prompt template.', 'info');
    if (promptEditorName) {
      setTimeout(() => promptEditorName.focus(), 30);
    }
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
      slug: slug || null,
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
    setPromptEditorStatus('Saving…', 'info');
    if (promptEditorSaveBtn) promptEditorSaveBtn.disabled = true;
    try {
      const payload = {
        name: values.name,
        description: values.description || null,
        prompt_text: values.prompt_text,
        sort_order: Number.isFinite(values.sort_order) ? values.sort_order : null,
        is_default: values.is_default,
        archived: values.archived,
      };
      if (values.slug) payload.slug = values.slug;
      if (values.id) payload.id = values.id;
      const { data, error } = await supabase
        .from(PROMPT_TABLE)
        .upsert(payload, { onConflict: 'id' })
        .select()
        .maybeSingle();
      if (error) throw error;
      const saved = data || null;
      const savedId = resolvePromptRecordId(saved) || values.slug || values.id || null;
      if (values.is_default && saved?.id) {
        try {
          await supabase.from(PROMPT_TABLE).update({ is_default: false }).neq('id', saved.id);
        } catch (err) {
          console.warn('Prompt default reset error', err);
        }
      }
      await refreshPromptOptions();
      await refreshPromptEditorList({ focusId: savedId || null, fallbackToFirst: !savedId });
      if (savedId) {
        setSelectedPrompt(savedId, { persist: false });
        desiredPromptId = savedId;
        persistAiConfig();
      }
      setPromptEditorStatus('Prompt saved.', 'success');
    } catch (error) {
      console.error('Prompt save error', error);
      setPromptEditorStatus(error.message || 'Unable to save prompt.', 'error');
    } finally {
      if (promptEditorSaveBtn) promptEditorSaveBtn.disabled = false;
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
      if (!promptOptions.length) {
        promptSummary.textContent = 'No prompts found. Add templates in Supabase.';
      } else if (selectedPrompt) {
        promptSummary.textContent = selectedPrompt.description || 'Ready to generate with this prompt.';
      } else {
        promptSummary.textContent = 'Choose which template to run when generating analysis.';
      }
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
          const promptId = row.id || row.slug || slugify(row.name || row.title || '');
          const promptText = row.prompt_text || row.template || row.body || '';
          const archived = row.archived ?? row.disabled ?? false;
          return {
            id: promptId || slugify(`prompt-${row.name || row.slug || Math.random()}`),
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
      if (active.length) return active;
    } catch (error) {
      console.warn('Prompt load error', error);
    }
    return DEFAULT_PROMPTS;
  };

  const applyPromptOptions = (options = []) => {
    promptOptions = options;
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
    const options = await fetchPromptTemplates();
    applyPromptOptions(options);
    if (promptSummary && !options.length) {
      promptSummary.textContent = 'No prompts found. Add templates in Supabase.';
    }
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
    if (!modelEditor || !modelEditorInput) return;
    if (!modelOptions.length) modelOptions = DEFAULT_MODELS.slice();
    modelEditor.hidden = false;
    modelEditorInput.value = modelOptions.map((opt) => `${opt.value} | ${opt.label}`).join('\n');
    if (modelEditorStatus) {
      modelEditorStatus.textContent = '';
      modelEditorStatus.dataset.tone = '';
    }
  };

  const closeModelEditor = () => {
    if (modelEditor) modelEditor.hidden = true;
    if (modelEditorStatus) {
      modelEditorStatus.textContent = '';
      modelEditorStatus.dataset.tone = '';
    }
  };

  const parseModelListInput = () => {
    if (!modelEditorInput) return [];
    const lines = (modelEditorInput.value || '')
      .split('
')
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
  await loadAiConfig();

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
      if (!promptEditorModal?.hidden) closePromptEditor();
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
      if (modelEditor?.hidden) openModelEditor();
      else closeModelEditor();
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
      const apiKey = (aiKey?.value || '').trim();
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

  await loadAiConfig({ includeRemote: true });
  await refreshModelOptions();
  await refreshPromptOptions();

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

async function callOpenRouterCompletion({ apiKey, model, prompt }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (typeof window !== 'undefined') {
    headers['HTTP-Referer'] = window.location.origin;
    headers['X-Title'] = 'FutureFunds Universe Editor';
  }

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

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()) || '';
    } catch {
      detail = '';
    }
    const reason = detail ? `${res.status} ${detail.slice(0, 160)}` : `${res.status}`;
    throw new Error(`OpenRouter error ${reason}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content.');
  return String(content);
}
