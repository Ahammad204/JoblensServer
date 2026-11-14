# JobLens ML Service

A small FastAPI service that serves the trained CV → job-role classifier
next to JobLens's rule-based matcher.

- **Model:** scikit-learn Pipeline — TF-IDF (5,000 features, word 1–2 grams)
  → Linear SVM. Trained in `JobLens_ML_Training.ipynb` on the Kaggle
  Resume Dataset (2,484 CVs, 24 categories).
- **Test scores (497 held-out CVs):** accuracy **0.7103**, macro F1
  **0.6672**. Best categories: HR 0.88, DESIGNER 0.88,
  INFORMATION-TECHNOLOGY 0.87. Worst: BPO 0.00 (only 4 test CVs).
- **API:** `GET /health`, `POST /predict` with `{"cv_text": "..."}`
  → `{"predicted_category", "confidence", "top_3": [{category, probability}], ...}`

## ⚠️ The model file is NOT in this repo

`joblens_best_model.pkl` (1.1 MB, binary) cannot be pushed through the
usual connector, so it is **not** committed here. The service refuses to
predict until the file is present. Pick ONE of these two routes:

### Option A — upload the .pkl into the repo (recommended)
1. On GitHub, open this repo → `ml-service/` folder → **Add file →
   Upload files**.
2. Upload `joblens_best_model.pkl` (the file from the Colab run).
3. Commit to `main`. Render redeploys and the service loads it at startup.

### Option B — host the .pkl and set MODEL_URL
1. Put the `.pkl` somewhere with a direct download link (e.g. a GitHub
   Release asset, or any static file host).
2. In Render, set env var `MODEL_URL` to that direct link. The service
   downloads the file once at startup into `ml-service/`.

## Deploy on Render (free tier)

1. Render Dashboard → **New + → Web Service** → pick the
   `JoblensServer` repo.
2. **Root Directory:** `ml-service`
3. **Runtime:** Python 3. **Build Command:**
   `pip install -r requirements.txt`
4. **Start Command:** `uvicorn app:app --host 0.0.0.0 --port $PORT`
5. Free instance type. Deploy.
6. Note the service URL, e.g. `https://joblens-ml.onrender.com`.
7. Check `GET /health` — it must say `"status": "ok"` and
   `"model_loaded": true`. If it says `model_missing`, the `.pkl`
   is not in place yet (see above).

## Connect the Express server

`JoblensServer` already has a `POST /api/ml/predict` route (JWT-protected,
same auth as `/api/cv/analyze`) that forwards CV text to this service.

1. In Vercel, open the `JoblensServer` project → **Settings →
   Environment Variables** → add:
   - `ML_SERVICE_URL` = your Render URL, e.g. `https://joblens-ml.onrender.com`
2. **Redeploy** the server (env changes need a redeploy).
3. The client already calls `/api/ml/predict` from the CV Auto-Analysis
   page (`CVAutoAnalysis.jsx`) and shows the prediction next to the
   rule-based result. No client env change is needed — the client talks
   to the Express server only, never directly to this service.

## Cold-start caveat — read this

- Render's free tier spins the service down after ~15 minutes idle.
  The first request after that takes **30–60 seconds** while it wakes.
- The Express route gives up after **8 seconds** (`ML_TIMEOUT_MS`,
  default 8000) and returns `502 "ML service timed out (it may be waking
  up — please retry in a few seconds)"`. That is by design: the server
  itself runs on Vercel's free tier, which kills functions after ~10 s,
  so a longer wait would not help.
- **Before a demo or judging session, warm it up:** open
  `https://<your-render-url>/health` once in a browser, wait for it to
  answer, and the next predict call is fast (< 1 s).
- If the wake-up wait is unacceptable, Render's paid tier
  ($7/month, always on) removes it.

## Test locally

```bash
cd ml-service
# put joblens_best_model.pkl in this folder first
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
curl http://localhost:8000/health
curl -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{"cv_text": "HR manager, recruitment, onboarding, payroll, 6 years experience"}'
```

## Honest limits (write these in the course report)

- The scores are a **softmax of the SVM decision scores, not calibrated
  probabilities** — they are relative, and usually low (0.05–0.30).
  The API says this in every response.
- The model misclassifies short, generic developer CVs: the sample
  "Python developer, Django, REST APIs, PostgreSQL" is predicted
  **CONSULTANT**, not INFORMATION-TECHNOLOGY. HR, Designer and Chef
  CVs classify correctly. This is a real finding, not a cover-up:
  short CVs give the model little signal, and CONSULTANT resumes in
  this dataset mention similar tech words.
- Some categories have very few CVs (class imbalance), so per-category
  scores are uneven — see the notebook's Step 6 report.
