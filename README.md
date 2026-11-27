# ClaimReady

A pre-submission health-insurance **reimbursement claim checker**. Upload your policy and hospital documents; it reads them with Google Gemini (full resolution, all pages) and tells you — before you submit — what's covered, what documents are missing, and what the insurer is likely to deduct (room-rent cap, non-payable items, co-pay, etc.).

- One user, one journey: **upload → analyze → fix list.**
- Front end: a single static page (`index.html`). You can add files one batch at a time (they accumulate, not overwrite), remove any file, and clear everything before starting a new check.
- Back end: one serverless function (`api/analyze.js`) that calls the Gemini API, with an **automatic fallback** from a primary model to a backup model.
- No database, no build step. Deploys to Vercel as-is.

---

## Deploy in ~5 minutes

### 1. Get a Gemini API key
- Go to **https://aistudio.google.com** → sign in → **Get API key** → **Create API key**.
- Copy it. (Keep it private — you'll paste it into Vercel, not into any file.)
- **For best accuracy**, the key's Google Cloud project should have **billing/credits enabled** so it can use a **Pro** model. On the free tier the app still works on a **Flash** model, but accuracy is lower and you get only ~20 requests/day.

### 2. Put this code on GitHub
```bash
git init
git add .
git commit -m "ClaimReady"
git branch -M main
git remote add origin https://github.com/<your-username>/claimready.git
git push -u origin main
```

### 3. Deploy on Vercel
- Go to **https://vercel.com** → **Add New… → Project** → import your `claimready` repo.
- Open **Settings → Environment Variables** and add:
  - `GEMINI_API_KEY` = *your key from step 1* — mark it **Sensitive/Secret**
  - `GEMINI_MODEL` = `gemini-3.1-pro-preview` — the **primary** model (best accuracy; needs billing/credits)
  - `GEMINI_MODEL_BACKUP` = `gemini-3.8-flash` — the **fallback** (used only if the primary is unavailable or rate-limited; works on the free tier)
- The app tries `GEMINI_MODEL` first and automatically falls back to `GEMINI_MODEL_BACKUP` on error. The result screen shows which model actually analysed the claim.
- If `GEMINI_MODEL` is unset, the code defaults to `gemini-3.5-flash`.
- Click **Deploy**. When it's live, open the URL.

> **Model names change.** If a model errors with `NOT_FOUND`, list the exact names your key supports at
> `https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY`
> and use one whose `supportedGenerationMethods` includes `generateContent`.

### 4. Try it
- Upload a **policy** + your **bills / discharge summary** (and optionally a mediclaim card), then **Analyze my claim**.
- "See a sample claim" shows a demo result without uploading.

---

## Local development (optional)
```bash
npm i -g vercel
# create a file named .env.local with:
#   GEMINI_API_KEY=your_key_here
#   GEMINI_MODEL=gemini-3.1-pro-preview
#   GEMINI_MODEL_BACKUP=gemini-3.8-flash
vercel dev
```

## Notes & known limits (good to mention in your deck)
- **Models:** primary `GEMINI_MODEL` (recommended `gemini-3.1-pro-preview`), backup `GEMINI_MODEL_BACKUP` (recommended `gemini-3.8-flash`). Pro gives the best document-reading accuracy but needs billing/credits; Flash runs on the free tier with lower accuracy and a daily request cap.
- **Accuracy:** on a real, already-settled claim, the estimate landed within ~1.3% of the actual insurer payout — on the conservative side.
- **Privacy:** uploaded files are sent to Google's Gemini API. On the **free tier**, Google may use content to improve its products — fine for a demo, but a production medical product would use the **paid tier** (data not used) or an enterprise/on-prem model.
- **Upload size:** a serverless request is capped around **4.5 MB**. The app packs the **claim documents (bills, reports, discharge) first** so none are dropped, then fills the remaining budget with policy pages. A production version would use the Gemini **File API** to handle very large multi-page scans.
- **Not medical or legal advice.** Estimates only; the insurer decides the final outcome.
