# ClaimReady

A pre-submission health-insurance **reimbursement claim checker**. You upload your policy and hospital documents, and before you submit, it tells you what's covered, which documents are missing, and what the insurer is likely to deduct (room-rent cap, non-payable items, co-pay).

**Live:** https://claimready-wheat.vercel.app

## How it's built
- One user, one journey: **upload → analyze → fix list.**
- Front end: a single static page (`index.html`).
- Back end: one serverless function (`api/analyze.js`) that reads the documents with Google Gemini (full resolution, all pages) and returns a structured fix-list. It uses a primary model with an automatic fallback to a backup.
- Configuration is via environment variables (the Gemini API key and model names) — nothing sensitive is stored in the repo.
- No database, no build step. Deployed on Vercel.

## Limitations
- **Privacy:** documents are sent to Google's Gemini API for analysis. A production medical product would use a tier where uploaded data is not used for training.
- **Upload size:** a serverless request is capped around 4.5 MB; the claim documents are prioritised so none are dropped.
- **Not medical or legal advice.** Estimates only — the insurer decides the final outcome.
