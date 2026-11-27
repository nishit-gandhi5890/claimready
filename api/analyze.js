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
  // Models come from env vars (set them in Vercel):
  //   GEMINI_MODEL         — main model (default gemini-3.5-flash if unset)
  //   GEMINI_MODEL_BACKUP  — used only if the main model fails or is overloaded
  const MODELS = [...new Set([
    process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    process.env.GEMINI_MODEL_BACKUP
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
        await sleep(700); continue;
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
          data._model = model; // the model that produced this result
          res.status(200).json(data);
          return;
        } catch (e) {
          last = { status: 502, raw: 'Could not parse analysis' }; break;
        }
      }

      last = { status: r.status, raw };
      if (r.status === 503 || r.status === 429) { await sleep(800 * (attempt + 1)); continue; } // overloaded: retry same model, then fall back
      break; // other error (e.g. wrong model name): stop this model, try the backup
    }
  }

  const tried = MODELS.join(' , ');
  if (last.status === 429) {
    res.status(502).json({ error: 'Free-tier limit reached', detail: 'Rate limit hit on: ' + tried + '. This is Gemini’s free-tier quota (per-minute or per-day) from heavy use — not your code. Wait a bit, or set GEMINI_MODEL / GEMINI_MODEL_BACKUP to a different model.' });
  } else if (last.status === 503) {
    res.status(502).json({ error: 'The AI is busy right now', detail: 'Model overloaded (' + tried + '). Wait a minute and try again.' });
  } else {
    res.status(502).json({ error: 'Analysis failed', detail: 'Models tried: ' + tried + '. ' + safe(last.raw) });
  }
}

function safe(s) { return String(s || '').slice(0, 600); }

function buildPrompt(manifest) {
  return `You are ClaimReady, an assistant that pre-checks an Indian health-insurance REIMBURSEMENT claim BEFORE the patient submits it, so they can fix problems and avoid rejections or insurer queries.

You are given the patient's POLICY and CLAIM DOCUMENTS as attached files (PDFs and/or photos). Read EVERY page of EVERY file carefully and at full detail.

Return ONLY a JSON object matching exactly this schema:
{"insured":string,"age":string,"insurer":string,"plan":string,"sumInsured":number|null,"policyStart":string,"admission":string,"discharge":string,"hospital":string,"billTotal":number|null,"claimForm":number|null,"coverage":[F],"documents":[F],"amounts":[F],"payout":{"billTotal":number|null,"nonPayable":number,"nonPayableItems":[{"item":string,"amount":number}],"otherDeductions":number,"copayPercent":number|null,"deductible":number}}
where F = {"s":"ok"|"warn"|"bad","t":short title,"amt":number|null,"dir":"ok"|"bad","p":one plain sentence a layperson understands,"basis":the exact policy clause/section or bill line it is based on,"conf":"High confidence"|"Estimate — verify with insurer"}

FILES PROVIDED (these are ALL the documents the patient attached — treat every one as ATTACHED):
${manifest}

GENERAL RULES
- Read all pages of all files. There may be MORE THAN ONE hospital bill and more than one payment receipt — find and use every one of them.
- Only raise an issue you can actually SEE evidence for in the documents. If something (a diagnosis, a charge, an itemised line, a policy limit, a date) is genuinely not visible, do NOT invent a problem — omit it, or mark s:"warn" with an honest "couldn't read this from the uploaded files". NEVER assert ineligibility, a mismatch, or a deduction you cannot substantiate.

documents
- Go through the standard reimbursement set ONE BY ONE and return a finding for each: (1) signed claim form, (2) photo ID / KYC, (3) discharge summary, (4) final hospital bill(s) with break-up, (5) pharmacy bills / prescription, (6) investigation & lab reports, (7) hospital registration certificate.
- For each, check whether ANY attached file is that document (judge by content, else by filename). If yes, mark it s:"ok". If NONE of the attached files is that document, mark it s:"bad" (missing) with a short note telling the user to attach it. You MUST still flag the hospital registration certificate, the signed claim form and the KYC/photo ID when they are absent — these are commonly forgotten and are a frequent reason claims get queried, so do not skip them.
- Never mark a document missing when a matching file IS in the attached list — flag only genuine absences.
- Also flag a specific report s:"bad" (referenced-but-missing) ONLY when a bill explicitly charges for a named test AND, after scanning EVERY page of EVERY attached file, that test's report is genuinely nowhere to be found. Before flagging any imaging/lab report (2D Echo, ECG, X-Ray, USG, CT, MRI, blood/pathology panels, etc.) as missing, you MUST first look through all attached pages for it. These reports appear in many visual forms — a radiology/scan printout, a typed result sheet, a lab letterhead page, a page showing the test name with findings/impression, or a photographed report. A page that carries the test's name together with readings, findings, an impression, or a doctor's signature IS that report — match it and mark the finding s:"ok", even if its layout differs from the bill. A referenced report is "bad" only if no such page exists anywhere in the upload. When in doubt whether a present page is the report, treat it as present, not missing.

eligibility
- Inpatient hospitalisation needs >=24 hours of admission. Read admission and discharge date/time from the discharge summary / bill; if >=24h, it qualifies (s:"ok"). A dependent parent / parent-in-law covered on the policy is eligible. Do not flag eligibility you can't substantiate.

coverage
- Is the treatment covered? Any waiting period — and is it cleared or waived (many group/corporate policies waive waiting periods and cover pre-existing from day 1; check the policy and say so)? Any exclusion? Cite the clause in "basis".

amounts & money
- billTotal = the SUM of ALL hospital bills (the final payable amount after discount/round-off). If there are multiple bills/receipts, sum them and say so.
- Compare the claim-form amount and the payment receipts against the bill total; flag a mismatch only if the numbers genuinely differ.
- Room rent: compare the per-day room charge on the bill with the room-rent limit stated in the policy. If the charge is AT OR BELOW the limit, it is completely fine — mark that finding s:"ok" (NOT a warning) and add NOTHING to otherDeductions for room rent. Flag s:"warn" and add only the excess to otherDeductions ONLY when the per-day charge genuinely EXCEEDS the stated limit (e.g. ₹8,000/day against a ₹6,500/day cap). If either figure isn't visible, do not flag it. Never warn about room rent that is within the cap. Room / bed charges are NEVER a non-payable item — never put them in nonPayableItems; room is only ever handled through otherDeductions, and only the excess over the cap.
- Co-pay: if the policy states any co-pay (including a parental co-pay for a parent's claim), apply the percentage to the admissible amount and show the rupee figure the patient will bear. This is often the biggest surprise — surface it clearly.
- Non-payables: read the itemised bill carefully, LINE BY LINE, and list EVERY non-medical / consumable / administrative item you find — for example gloves, gowns, caps, masks, under-pads, bed/bath wipes, cotton and other consumables; admission, registration, record-keeping or service charges; food, toiletries and comfort items. Name the items and SUM ALL of them — do not stop at the first one. Do NOT answer "not checkable" when an itemised bill is provided; if part of the bill is not legible, say so honestly rather than skipping it.
- Any amount that depends on insurer adjudication must have conf:"Estimate — verify with insurer".

payout (NUMBERS ONLY — do NOT compute the final payable yourself; the app does the arithmetic)
- billTotal: the SUM of ALL hospital bills (the final payable amount after discount/round-off).
- nonPayableItems: an array listing each NON-PAYABLE / non-medical line item, as {"item": short name, "amount": rupees}.
  DEFAULT TO PAYABLE. An item goes in this list ONLY if it clearly belongs to the non-payable categories below. When in ANY doubt, treat the item as PAYABLE and leave it OUT of this list.
  ALWAYS PAYABLE — these must NEVER appear here: medicines and drugs; implants and devices (stents, MESH, plates, screws); investigations, lab tests and imaging; procedures and surgery charges; doctor / surgeon / anaesthetist / consultation fees; OT, ICU and room / bed charges.
  NON-PAYABLE — list these: gloves, gowns, caps, masks, under-pads, bed/bath wipes, cotton and similar disposables/consumables; admission, registration, record-keeping, documentation or service charges; food, toiletries, attendant/comfort items.
  MANDATORY: the ADMISSION FEE, REGISTRATION FEE and any MEDICAL-RECORD / DOCUMENTATION / SERVICE charges are the single most commonly deducted items. Whenever the bill contains them — even listed under an "Others", "Miscellaneous", "Service charges" or similar section — you MUST include them with their exact amount. But do NOT invent them: only list them if they actually appear on the bill.
- nonPayable: the SUM of the amounts in nonPayableItems (0 if the list is empty).
- otherDeductions: any other amount that will be deducted, such as room rent charged above the policy cap (0 if none).
- copayPercent: the co-pay percentage that applies to THIS claim, as a plain number, e.g. 20 (null if there is genuinely no co-pay). A parent's / parent-in-law's claim often carries a parental co-pay — put that percentage here.
- deductible: any fixed rupee deductible under the policy (0 if none).
Do not leave payout out. If a figure is unknown, use 0 for the amounts and null for copayPercent.

- Use the mediclaim card (if provided) to read insurer, TPA, member name and policy number.
- Keep every "p" under 40 words. Amounts are Indian rupees. Return ONLY the JSON object.`;
}
