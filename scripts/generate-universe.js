/**
 * FutureFunds.ai — Universe Generator
 * ---------------------------------------------------------
 * Auto-creates 3–4 deep-dive rows and appends to /data/universe.json
 * Run by GitHub Actions on a daily cron.
 *
 * Extras:
 *  - Topic rotation with a 14-day cooldown (data/universe-topics-log.json)
 *  - Strict JSON schema validation + de-fencing (```json ... ```)
 *  - Retries with jitter + graceful degradation
 *  - Idempotent merge (date+topic) + daily snapshot (universe-YYYY-MM-DD.json)
 *  - CSV mirror (universe-latest.csv) for quick exports
 *  - Optional model override via env OPENROUTER_MODEL
 *
 * Env:
 *  OPENROUTER_API_KEY (required)
 *  OPENROUTER_MODEL   (optional, default "openrouter/auto")
 *  TZ                 (set in workflow, e.g., Europe/Oslo)
 */

const fs = require("fs");
const path = require("path");

// ---------- Config ----------
const DATA_DIR = "data";
const UNIVERSE_FILE = path.join(DATA_DIR, "universe.json");
const TOPIC_LOG_FILE = path.join(DATA_DIR, "universe-topics-log.json");
const CSV_MIRROR_FILE = path.join(DATA_DIR, "universe-latest.csv");
const MAX_TOPICS_PER_DAY = 4;
const TOPIC_COOLDOWN_DAYS = 14;

const MODEL = process.env.OPENROUTER_MODEL || "openrouter/auto";
const API_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEMPERATURE = 0.3;
const MAX_TOKENS = 1400;

// ---------- Utilities ----------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function todayYMD(tz = "Europe/Oslo") {
  // Format as YYYY-MM-DD in a specific timezone
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function daysBetween(a, b) {
  const A = new Date(a + "T00:00:00Z").getTime();
  const B = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(Math.round((B - A) / 86400000));
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  const header = ["date", "topic", "key_findings", "visual_table_md", "conclusion", "tags"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const vals = [
      r.date || "",
      r.topic || "",
      (r.key_findings || []).join(" | "),
      (r.visual_table_md || "").replace(/\n/g, "\\n"),
      r.conclusion || "",
      (r.tags || []).join("|"),
    ].map(csvEscape);
    lines.push(vals.join(","));
  }
  return lines.join("\n");
}

function stripFences(s) {
  if (!s) return s;
  // Remove ```json ... ``` or ``` ... ```
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function isValidRow(x) {
  const arrStr = a => Array.isArray(a) && a.every(v => typeof v === "string" && v.length <= 2000);
  return (
    x &&
    typeof x === "object" &&
    typeof x.date === "string" &&
    typeof x.topic === "string" &&
    typeof x.prompt_used === "string" &&
    typeof x.visual_table_md === "string" &&
    typeof x.conclusion === "string" &&
    arrStr(x.key_findings) &&
    arrStr(x.tags)
  );
}

function dedupeByDateTopic(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${(r.date || "").trim()}::${(r.topic || "").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ---------- Topics ----------
/**
 * You can modify/extend the topic pool. The script will pick up to MAX_TOPICS_PER_DAY
 * that haven’t appeared in the last TOPIC_COOLDOWN_DAYS.
 */
const TOPIC_POOL = [
  // Valuation & Reverse DCF
  "Reverse-engineer implied growth from current price — HelloFresh (HFG.DE)",
  "Reverse DCF: what does today’s price imply for Bakkafrost (BAKKA) margins and volume?",
  "DCF triangulation for Pareto Bank (PARB): cost of equity, credit cycle sensitivity",
  "Quality at a fair price: identify Nordic compounders trading below 18x NTM EBIT",
  // Banks & Rates
  "Nordic small-cap banks — NIM sensitivity & refinancing risk heatmap",
  "Scandi mortgage banks stress test: +200 bps vs -200 bps rate scenarios",
  // Energy & Industrials
  "SMR (small modular reactor) supply chain — listed beneficiaries & choke points",
  "Offshore wind supply chain — who profits if orders re-accelerate?",
  // Thematics
  "GLP-1 ripple effects — winners and losers across food, retail, and medtech",
  "AI datacenter power: grid bottlenecks and equipment suppliers in Europe",
  // Special Situations
  "Europe spin-offs watchlist — probability-ranked in next 6–12 months",
  "Net cash tech microcaps — screening for optionality with downside protection",
  // Consumer & E-com
  "Grocery e-commerce unit economics deep dive — who can be sustainably profitable?",
  "Used car retail in Nordics — margin structure and inventory turns (Kamux et al.)",
  // Gaming & Media
  "Gaming publisher M&A landscape if valuations stay muted — likely buyers/targets",
  // Risk maps
  "Refinancing wall map: Nordic small caps with >2.5x net debt / EBITDA & 2026 maturities",
];

/**
 * Load topic log (date → list) and filter topics not used within cooldown window.
 */
function pickTopicsForToday(today, maxCount) {
  const log = readJSON(TOPIC_LOG_FILE, []); // [{date:"YYYY-MM-DD", topics:[...]}]
  const recent = new Set();
  for (const entry of log) {
    if (daysBetween(entry.date, today) <= TOPIC_COOLDOWN_DAYS) {
      for (const t of entry.topics || []) recent.add(t);
    }
  }
  const candidates = TOPIC_POOL.filter(t => !recent.has(t));
  // If not enough candidates, allow reuse (least recently used first)
  const pool = candidates.length >= maxCount ? candidates : TOPIC_POOL;

  // Simple rotation: shuffle and take first N
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, maxCount);
}

function appendTopicLog(today, topics) {
  const log = readJSON(TOPIC_LOG_FILE, []);
  log.push({ date: today, topics });
  // Keep last 60 entries
  while (log.length > 60) log.shift();
  writeJSON(TOPIC_LOG_FILE, log);
}

// ---------- Prompt ----------
const MASTER_PROMPT = (topic) => `
You are the FutureFunds.ai “Universe” researcher.
Produce a deep, structured MINI-REPORT for publication.
Return STRICT JSON, nothing else, with this exact shape:

{
  "date": "YYYY-MM-DD",
  "topic": "string",
  "prompt_used": "string",
  "key_findings": ["string","string","string","string","string"],
  "visual_table_md": "|Col|Col|\\n|--|--|\\n|Row|Row|",
  "conclusion": "one-paragraph conclusion with an investable takeaway",
  "tags": ["tag1","tag2","tag3"]
}

Required analysis coverage:
- Valuation: DCF outline OR reverse DCF (implied growth/margins) + sanity checks.
- Risks: leverage/refinancing, cyclicality, disruptors, customer/concentration.
- Moat: identify (cost, network, brand, switching, scale) + how it could break.
- Comparables: 3–5 peers, one-line contrast.
- Scenarios: bear/base/bull short table (rev CAGR, margin, FCF, EV/EBITDA or P/S).
- Catalysts: 3–5 near-term, each with “what to watch”.

Topic: ${topic}

Output only valid JSON (no markdown fences, no commentary).
`;

// ---------- OpenRouter Call with Retries ----------
async function callOpenRouter(prompt) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
  };

  const headers = {
    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY || ""}`,
    "Content-Type": "application/json",
  };

  if (!headers.Authorization.endsWith(":")) {
    // ok
  }

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${txt.slice(0, 300)}`);
      }
      const j = await res.json();
      let text = j?.choices?.[0]?.message?.content?.trim() ?? "";
      text = stripFences(text);

      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Try to extract last {...} block
        const m = text.match(/\{[\s\S]*\}$/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch {}
        }
      }
      return parsed;
    } catch (err) {
      const backoff = 500 * attempt + Math.floor(Math.random() * 400);
      console.warn(`Attempt ${attempt} failed: ${String(err).slice(0, 200)} — retrying in ${backoff}ms`);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

// ---------- Main ----------
(async function main() {
  ensureDir(DATA_DIR);

  const today = todayYMD("Europe/Oslo");
  const SNAP_FILE = path.join(DATA_DIR, `universe-${today}.json`);

  const existing = readJSON(UNIVERSE_FILE, []);
  const topics = pickTopicsForToday(today, MAX_TOPICS_PER_DAY);

  const results = [];
  for (const t of topics) {
    const prompt = MASTER_PROMPT(t);
    try {
      const payload = await callOpenRouter(prompt);
      if (!payload) continue;

      // Normalize and validate
      payload.date = today;
      payload.topic = String(payload.topic || t).trim();
      payload.prompt_used = prompt.slice(0, 1600);
      if (!Array.isArray(payload.key_findings)) payload.key_findings = [];
      if (!Array.isArray(payload.tags)) payload.tags = [];
      payload.key_findings = payload.key_findings.slice(0, 8).map(s => String(s));
      payload.tags = payload.tags.slice(0, 8).map(s => String(s));
      payload.visual_table_md = String(payload.visual_table_md || "");

      if (isValidRow(payload)) {
        results.push(payload);
      } else {
        console.warn("Invalid payload shape for topic:", t);
      }
    } catch (e) {
      console.warn("Failed topic:", t, String(e).slice(0, 200));
    }
  }

  if (!results.length) {
    console.log("No valid rows generated today. Exiting.");
    process.exit(0);
  }

  // Merge & dedupe
  const merged = dedupeByDateTopic([...existing, ...results]);

  // Write main file, snapshot, CSV mirror
  writeJSON(UNIVERSE_FILE, merged);
  writeJSON(SNAP_FILE, results);
  fs.writeFileSync(CSV_MIRROR_FILE, toCSV(merged));

  // Update topic log
  appendTopicLog(today, topics);

  console.log(`Universe updated: +${results.length} entries today. Total: ${merged.length}`);
})().catch(err => {
  console.error("Universe generation failed:", err);
  process.exit(1);
});
