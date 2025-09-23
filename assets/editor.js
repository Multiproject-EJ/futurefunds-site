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

  const AI_KEY_STORAGE = 'ff-editor-ai-key';
  const AI_MODEL_STORAGE = 'ff-editor-ai-model';

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
  };

  const loadAiConfig = () => {
    if (aiKey) {
      try {
        const stored = localStorage.getItem(AI_KEY_STORAGE) || localStorage.getItem('api-key-openrouter') || '';
        aiKey.value = stored;
      } catch {
        aiKey.value = '';
      }
    }
    if (aiModel) {
      try {
        const stored = localStorage.getItem(AI_MODEL_STORAGE) || 'openrouter/auto';
        aiModel.value = stored || 'openrouter/auto';
      } catch {
        aiModel.value = 'openrouter/auto';
      }
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
        if (value) localStorage.setItem(AI_MODEL_STORAGE, value);
        else localStorage.removeItem(AI_MODEL_STORAGE);
      }
    } catch (err) {
      console.warn('AI config storage error', err);
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
  loadAiConfig();

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
    ['change', 'blur'].forEach((evt) => aiModel.addEventListener(evt, persistAiConfig));
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
      const model = (aiModel?.value || '').trim() || 'openrouter/auto';

      if (!ticker || !company) {
        setAnalysisStatus('Ticker and company are required for AI generation.', 'error');
        return;
      }
      if (!apiKey) {
        setAnalysisStatus('Provide an AI API key to generate the analysis.', 'error');
        return;
      }

      persistAiConfig();
      const prompt = buildMasterAnalysisPrompt({ ticker, company, exchange, notes });
      setAnalysisStatus('Generating analysis via AI…', 'info');
      aiGenerateBtn.disabled = true;

      try {
        const content = await callOpenRouterCompletion({ apiKey, model, prompt });
        if (!content.trim()) throw new Error('AI returned an empty response.');
        if (analysisRaw) analysisRaw.value = content.trim();
        if (promptInput) promptInput.value = prompt;
        switchAnalysisMode('manual');
        fillFromAnalysis(content.trim(), { forceTags: true, onParsed: (parsed) => {
          if (tagsInput && parsed?.ticker) {
            const existing = tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean);
            if (!existing.includes(parsed.ticker)) {
              existing.unshift(parsed.ticker);
              tagsInput.value = Array.from(new Set(existing)).join(', ');
            }
          }
        }});
        setAnalysisStatus('AI analysis generated. Review the fields before publishing.', 'success');
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
    loadAiConfig();
    switchAnalysisMode('manual');
    setAnalysisStatus('Entry published. Ready for another analysis.', 'success');
    await loadRecent();
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      form.reset();
      if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
      loadAiConfig();
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

function buildMasterAnalysisPrompt({ ticker, company, exchange, notes }) {
  const exchangeLabel = exchange ? `, ${exchange}` : '';
  const guidance = notes ? `\n\nAnalyst guidance to incorporate:\n${notes}` : '';
  return `You are the FutureFunds.ai research analyst. Produce a MASTER STOCK ANALYSIS (Markdown-Table Edition) for ${company} (Ticker: ${ticker}${exchangeLabel}). Match the structure of the reference template exactly.\n\nFollow this order and formatting:\n1. Intro sentence: \\"Below is a MASTER STOCK ANALYSIS (Markdown-Table Edition) for ${company} (Ticker: ${ticker}${exchangeLabel}) — ...\\" with a short rationale.\n2. Insert a line containing only ⸻ between every major section.\n3. Section A. One-Liner Summary — Markdown table with columns Ticker | Risk | Quality | Timing | Composite Score (/10).\n4. Section B. Final Verdicts — One Line — list Risk, Quality, Timing values.\n5. Section C. Standardized Scorecard — One Line — Markdown table with the six specified metrics.\n6. Section D. Valuation Ranges — provide USD bear/base/bull table and paragraph with NOK conversions.\n7. Narrative section — short paragraph plus bullet list of pricing, market cap, revenue, catalysts.\n8. Sections 1 through 5 with the same headings (Downside & Risk Analysis; Business Model & Growth Opportunities; Scenario Analysis (include Markdown table with Bear/Base/Bull rows and valuation ranges); Valuation Analysis; Timing & Market Momentum). Use concise bullet points with data.\n9. Section 6. Final Conclusions — bullet lines for Risk, Quality, Timing plus an \\"Overall Verdict\\" sentence.\n10. Finish with a note paragraph starting with 🚩 Note:.\n\nRequirements:\n- Use realistic figures and ratings based on the latest publicly available information and reasonable assumptions.\n- Keep bullet points sharp and decision-oriented.\n- Ensure Markdown tables use pipes and render cleanly.\n- Maintain the same tone as the template (professional, catalyst-aware).${guidance}\n\nReturn only the Markdown content.`;
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
