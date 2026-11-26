# ClaimReady

A pre-submission health-insurance **reimbursement claim checker**. Upload your policy and hospital documents; it reads them with Google Gemini (full resolution, all pages) and tells you — before you submit — what's covered, what documents are missing, and what the insurer is likely to deduct (room-rent cap, non-payable items, co-pay, etc.).

- One user, one journey: **upload → analyze → fix list.**
- Front end: a single static page (`index.html`).
- Back end: one serverless function (`api/analyze.js`) that calls the Gemini API.
- No database, no build step. Deploys to Vercel as-is.

---

## Deploy in ~5 minutes

### 1. Get a free Gemini API key
- Go to **https://aistudio.google.com** → sign in → **Get API key** → **Create API key**.
- Copy it. (Keep it private — you'll paste it into Vercel, not into any file.)

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
- Before (or right after) the first deploy, open **Settings → Environment Variables** and add:
  - `GEMINI_API_KEY` = *your key from step 1*
  - *(optional)* `GEMINI_MODEL` = `gemini-flash-latest`
- Click **Deploy**. When it's live, open the URL.

### 4. Try it
- Tap **Check a claim**, upload a **policy** + your **bills / discharge summary**, and **Analyze**.
- "See a sample claim" shows a demo result without uploading.

---

## Local development (optional)
```bash
npm i -g vercel
# create a file named .env.local with:  GEMINI_API_KEY=your_key_here
vercel dev
```

## Notes & known limits (good to mention in your deck)
- **Privacy:** uploaded files are sent to Google's Gemini API for analysis. On Gemini's **free tier**, Google may use content to improve its products — fine for a demo, but a production medical product would use the **paid tier** (data not used) or an on-prem/enterprise model.
- **Upload size:** a serverless request is capped around **4.5 MB**. Upload the key documents (policy, bills, discharge summary). A production version would use the Gemini **File API** to handle large multi-page scans.
- **Model name:** defaults to `gemini-flash-latest`. If that errors, set `GEMINI_MODEL` to a current Flash model shown in Google AI Studio.
- **Not medical or legal advice.** Estimates only; the insurer decides the final outcome.
