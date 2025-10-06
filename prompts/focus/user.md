Ticker: {{ ticker }}
Question: {{ question }}

Context
=======
Stage 1 summary:
{{ stage1_summary }}

Stage 2 verdict:
{{ stage2_summary }}

Stage 3 thesis:
{{ stage3_summary }}

Retrieved snippets:
{{ retrieval_snippets }}

Instructions
============
- Answer the focus question directly in no more than 6 sentences.
- Cite supporting snippets using the provided reference IDs (e.g., [D2]).
- Highlight actionable next steps or metrics to monitor when relevant.
- Include a one-sentence conclusion with a confidence level (High/Medium/Low).

Respond as JSON with:
{
  "summary": string,
  "key_points": string[],
  "confidence": "High" | "Medium" | "Low",
  "citations": string[]
}
