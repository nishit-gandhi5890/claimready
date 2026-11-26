// ClaimReady — analysis API. Sends the uploaded documents to Google Gemini (full
// resolution, all pages) and returns structured claim-readiness findings as JSON.
// Retries and falls back across Flash models when one is overloaded (503/429).
//
// Env vars (set in Vercel → Settings → Environment Variables):
//   GEMINI_API_KEY   (required)  your key from https://aistudio.google.com
//   GEMINI_MODEL     (optional)  a preferred model; tried first

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) { res.status(500).json({ error: 'Server not configured', detail: 'GEMINI_API_KEY is missing. Add it in Vercel → Settings → Environment Variables.' }); return; }

  // Models tried in order; each retried a couple of times on overload.
  const MODELS = [...new Set([
    process.env.GEMINI_MODEL,
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-2.5-flash',
    'gemini-2.0-flash'
  ].filter(Boolean))];

  let payload;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (e) { res.status(400).json({ error: 'Bad request body' }); return; }

  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!files.length) { res.status(400).json({ error: 'No files provided' }); return; }

  const manifest = files.map((f, i) => `  ${i + 1}. (${f.group || 'document'}) ${f.name || 'file ' + (i + 1)}`).join('\n');
  const parts = [{ text: buildPrompt(manifest) }];
  for (const f of files) {
    if (!f.data) continue;
    parts.push({ text: `\n--- FILE: ${f.name} (${f.group}) ---` });
    parts.push({ inlineData: { mimeType: f.mimeType || 'application/pdf', data: f.data } });
  }
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let last = { status: 0, raw: '' };

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let r, raw;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${KEY}`;
        r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        raw = await r.text();
      } catch (e) {
        last = { status: 502, raw: String((e && e.message) || e) };
        await sleep(600); continue;
      }

      if (r.ok) {
        try {
          const j = JSON.parse(raw);
          const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
          if (!text) { last = { status: 502, raw: 'finishReason: ' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'empty') }; break; }
          let data;
          try { data = JSON.parse(text); }
          catch (e) { const a = text.indexOf('{'), b = text.lastIndexOf('}'); data = JSON.parse(text.slice(a, b + 1)); }
          data.coverage = Array.isArray(data.coverage) ? data.coverage : [];
          data.documents = Array.isArray(data.documents) ? data.documents : [];
          data.amounts = Array.isArray(data.amounts) ? data.amounts : [];
          res.status(200).json(data);
          return;
        } catch (e) {
          last = { status: 502, raw: 'Could not parse analysis' }; break;
        }
      }

      last = { status: r.status, raw };
      if (r.status === 503 || r.status === 429) { await sleep(800 * (attempt + 1)); continue; } // overloaded: retry, then next model
      break; // 404 (bad model) or other: move to next model
    }
  }

  const overloaded = last.status === 503 || last.status === 429;
  res.status(502).json({
    error: overloaded ? 'The AI is busy right now' : 'Analysis failed',
    detail: overloaded ? 'Gemini is temporarily overloaded. Please wait a minute and try again.' : safe(last.raw)
  });
}

function safe(s) { return String(s || '').slice(0, 600); }

function buildPrompt(manifest) {
  return `You are ClaimReady, an assistant that pre-checks an Indian health-insurance REIMBURSEMENT claim BEFORE the patient submits it, so they can fix problems and avoid rejections or insurer queries.

You are given the patient's POLICY and CLAIM DOCUMENTS as attached files (PDFs and/or photos). Read EVERY page of EVERY file carefully and at full detail.

Return ONLY a JSON object matching exactly this schema:
{"insured":string,"age":string,"insurer":string,"plan":string,"sumInsured":number|null,"policyStart":string,"admission":string,"discharge":string,"hospital":string,"billTotal":number|null,"claimForm":number|null,"coverage":[F],"documents":[F],"amounts":[F]}
where F = {"s":"ok"|"warn"|"bad","t":short title,"amt":number|null,"dir":"ok"|"bad","p":one plain sentence a layperson understands,"basis":the exact policy clause/section or bill line it is based on,"conf":"High confidence"|"Estimate — verify with insurer"}

FILES PROVIDED (these are ALL the documents the patient attached — treat every one as ATTACHED):
${manifest}

GENERAL RULES
- Read all pages of all files. There may be MORE THAN ONE hospital bill and more than one payment receipt — find and use every one of them.
- Only raise an issue you can actually SEE evidence for in the documents. If something (a diagnosis, a charge, an itemised line, a policy limit, a date) is genuinely not visible, do NOT invent a problem — omit it, or mark s:"warn" with an honest "couldn't read this from the uploaded files". NEVER assert ineligibility, a mismatch, or a deduction you cannot substantiate.

documents
- Identify what each attached file is. A required document is PRESENT (s:"ok") if ANY attached file is that document. Only mark s:"bad" (missing) when NONE of the files is that document. When unsure, do NOT mark it missing.
- Standard reimbursement set: signed claim form, photo ID / KYC, discharge summary, final hospital bill(s) with break-up, pharmacy bills / prescription, investigation & lab reports, hospital registration certificate (as required by the policy).
- Also flag a report s:"bad" (referenced-but-missing) ONLY if a bill explicitly charges for a specific named test AND no attached file is that report.

eligibility
- Inpatient hospitalisation needs >=24 hours of admission. Read admission and discharge date/time from the discharge summary / bill; if >=24h, it qualifies (s:"ok"). A dependent parent / parent-in-law covered on the policy is eligible. Do not flag eligibility you can't substantiate.

coverage
- Is the treatment covered? Any waiting period — and is it cleared or waived (many group/corporate policies waive waiting periods and cover pre-existing from day 1; check the policy and say so)? Any exclusion? Cite the clause in "basis".

amounts & money
- billTotal = the SUM of ALL hospital bills (the final payable amount after discount/round-off). If there are multiple bills/receipts, sum them and say so.
- Compare the claim-form amount and the payment receipts against the bill total; flag a mismatch only if the numbers genuinely differ.
- Room rent: flag s:"warn" ONLY if a bill shows a per-day room charge that EXCEEDS a room-rent limit stated in the policy. If it is within the stated limit, mark s:"ok". If either figure isn't visible, don't flag it.
- Co-pay: if the policy states any co-pay (including a parental co-pay for a parent's claim), apply the percentage to the admissible amount and show the rupee figure the patient will bear. This is often the biggest surprise — surface it clearly.
- Non-payables: scan the itemised bill against the IRDAI non-payable / non-medical items list (gloves, consumables, admin/registration fees, toiletries, food) and total what applies. Do NOT answer "not checkable" when an itemised bill is provided.
- Any amount that depends on insurer adjudication must have conf:"Estimate — verify with insurer".

- Use the mediclaim card (if provided) to read insurer, TPA, member name and policy number.
- Keep every "p" under 40 words. Amounts are Indian rupees. Return ONLY the JSON object.`;
}
