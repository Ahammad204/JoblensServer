# JobLens ML Service

A small FastAPI service that serves the trained CV → job-role classifier
next to JobLens's rule-based matcher. It runs as a **Vercel Python
Function** (FastAPI is served directly by Vercel's Python runtime —
no server to keep running).

- **Model:** scikit-learn Pipeline — TF-IDF (5,000 features, word 1–2 grams)
  → Linear SVM. Trained in `JobLens_ML_Training.ipynb` on the Kaggle
  Resume Dataset (2,484 CVs, 24 categories).
- **Test scores (497 held-out CVs):** accuracy **0.7103**, macro F1
  **0.6672**. Best categories: HR 0.88, DESIGNER 0.88,
  INFORMATION-TECHNOLOGY 0.87. Worst: BPO 0.00 (only 4 test CVs).
- **API:** `GET /health`, `POST /predict` with `{"cv_text": "..."}`
  → `{"predicted_category", "confidence", "top_3": [{category, probability}], ...}`

## How it is laid out

- `app.py` — the FastAPI app. The single source of truth for every
  endpoint; nothing about the API is duplicated anywhere else.
- `api/index.py` — a thin Vercel entry point. It adds this folder to
  `sys.path` and re-exports the app from `app.py`. Vercel auto-wraps
  the ASGI app, so no adapter or server process is needed.
- `vercel.json` — rewrites every path to `/api/index` (so `/health`
  and `/predict` reach the FastAPI app), and `includeFiles` makes sure
  `app.py` and `joblens_best_model.pkl` are bundled into the function.
- `requirements.txt` — runtime dependencies only. No `uvicorn`:
  Vercel serves the app itself.
- `.python-version` — pins Python 3.12 (Vercel's default).

## ⚠️ The model file is NOT in this repo

`joblens_best_model.pkl` (1.1 MB, binary) cannot be pushed through the
usual connector, so it is **not** committed here. The service refuses to
predict until the file is present. Pick ONE of these two routes:

### Option A — upload the .pkl into the repo (recommended)
1. On GitHub, open this repo → `ml-service/` folder → **Add file →
   Upload files**.
2. Upload `joblens_best_model.pkl` (the file from the Colab run).
3. Commit to `main`. Vercel redeploys and the service loads it at startup.

### Option B — host the .pkl and set MODEL_URL
1. Put the `.pkl` somewhere with a direct download link (e.g. a GitHub
   Release asset, or any static file host).
2. In the Vercel project (see below), set env var `MODEL_URL` to that
   direct link. The service downloads the file once at startup.
   On Vercel the function filesystem is read-only except `/tmp`, so
   the download goes to `/tmp` — that is handled in `app.py`, you do
   not need to do anything extra.

## Deploy on Vercel (free tier)

This is a **separate Vercel project** from the Express server — same
repo, different project and Root Directory.

1. Vercel Dashboard → **Add New… → Project** → import the
   `JoblensServer` repo.
2. **Root Directory:** `ml-service` (use the Edit button next to it).
3. Framework Preset: leave as **Other** (Vercel detects the Python
   function from `api/index.py`); no build command is needed.
4. If you are using Option B above, add the env var now:
   `MODEL_URL` = your direct `.pkl` link. Skip this for Option A.
5. **Deploy.**
6. Note the project URL, e.g. `https://joblens-ml.vercel.app`.
7. Check `GET /health` — it must say `"status": "ok"` and
   `"model_loaded": true`. If it says `model_missing`, the `.pkl`
   is not in place yet (see above).

Dependency size: scikit-learn + numpy + scipy + joblib installs to
≈200 MB in a clean install (measured 2026-11-14), under Vercel's
**500 MB uncompressed bundle limit for Python functions**.

## Connect the Express server

`JoblensServer` already has a `POST /api/ml/predict` route (JWT-protected,
same auth as `/api/cv/analyze`) that forwards CV text to this service.

1. In Vercel, open the **`JoblensServer`** (Express) project →
   **Settings → Environment Variables** → add:
   - `ML_SERVICE_URL` = your new Vercel URL, e.g. `https://joblens-ml.vercel.app`
2. **Redeploy** the server (env changes need a redeploy).
3. The client already calls `/api/ml/predict` from the CV Auto-Analysis
   page (`CVAutoAnalysis.jsx`) and shows the prediction next to the
   rule-based result. No client env change is needed — the client talks
   to the Express server only, never directly to this service.

## Cold-start caveat — read this

- Vercel's free plan spins a function down after ~15 minutes idle.
  The first request after that is a **cold start**: the function boots
  Python and imports scikit-learn, which takes **a few seconds**.
  Warm requests after that are fast (< 1 s).
- The Express route gives up after **8 seconds** (`ML_TIMEOUT_MS`,
  default 8000) and returns `502 "ML service timed out (it may be waking
  up — please retry in a few seconds)"`. That is by design: the server
  itself runs on Vercel's free tier, which kills functions after ~10 s,
  so a longer wait would not help.
- **Before a demo or judging session, warm it up:** open
  `https://<your-vercel-url>/health` once in a browser, wait for it to
  answer, and the next predict call is fast.
- If a cold start ever exceeds the 10-second function limit, the first
  call fails but warms the function — just retry it once.

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

To test the Vercel entry point itself (not just `app.py`), load the
app through `api/index.py` — e.g. with FastAPI's `TestClient`:

```python
from fastapi.testclient import TestClient
from api.index import app  # run from the ml-service/ folder
client = TestClient(app)
print(client.get("/health").json())
print(client.post("/predict", json={"cv_text": "HR manager, recruitment, onboarding"}).json())
```

(That needs `httpx` installed — it is a test-only dependency, not in
`requirements.txt`.)

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
