# JobLens ML Service

A small FastAPI service that serves the trained CV → job-role classifier
next to JobLens's rule-based matcher. It runs as a **Vercel Python
Function** (FastAPI is served directly by Vercel's Python runtime —
no server to keep running).

- **Model v2:** scikit-learn Pipeline — TF-IDF (10,000 features, word
  1–2 grams, sublinear TF) → Linear SVM (C=1.0). Trained in
  `JobLens_ML_Training_v2.ipynb` on 9,028 CVs in 18 role classes: the old
  Kaggle set (2,484) + HuggingFace CV sets (Karthikeya711 9,544,
  Sahiti99 4,817) + capped synthetic rows (AzharAli05), deduplicated
  across sources, with tech roles split out (Python Developer, Web
  Developer, Data Science & ML, DevOps & Cloud, Mobile, QA, Network &
  Security, ...). v1 was TF-IDF 5,000 features on 2,484 CVs, 24 categories.
- **Test scores v2 (1,324 real held-out CVs):** accuracy **0.9660**,
  macro F1 **0.9459** (v1: 0.7103 / 0.6672). Per-source: old-Kaggle slice
  0.83 accuracy, Karthikeya/Sahiti slices ~1.00 (templated data — read
  them as upper bounds, not real-world accuracy). A 6-CV hand-written
  sanity set, including the owner's own CV (Python/Django), predicts 6/6.
  Worst classes now: Chef 0.75, Healthcare 0.74, Teacher 0.78 (small,
  real-world classes). LogReg (0.9364) and calibrated SVM (0.9373) were
  also tried and lost on both macro F1 and the sanity set — see the v2
  notebook.
- **Scores are relative, not probabilities:** the service applies a
  temperature-scaled softmax (T=0.5) to the SVM decision scores, so
  clear wins read clearly while close calls stay close. Never present
  them as "the model is X% sure".
- **API:** `GET /` (service info), `GET /health`, `POST /predict` with `{"cv_text": "..."}`
  → `{"predicted_category", "confidence", "top_3": [{category, probability}], ...}`

## How it is laid out

- `app.py` — the FastAPI app. The single source of truth for every
  endpoint; nothing about the API is duplicated anywhere else.
- `api/index.py` — a thin Vercel entry point. It adds this folder to
  `sys.path` and re-exports the app from `app.py`. Vercel auto-wraps
  the ASGI app, so no adapter or server process is needed.
- `vercel.json` — rewrites every path to `/api/index` (so `/health`
  and `/predict` reach the FastAPI app), and `includeFiles` makes sure
  `app.py`, `joblens_best_model.pkl` and `joblens_best_model.pkl.b64`
  are bundled into the function.
- `requirements.txt` — runtime dependencies only. No `uvicorn`:
  Vercel serves the app itself.
- `.python-version` — pins Python 3.12 (Vercel's default).

## ✅ The v2 model file ships as base64 text

`joblens_best_model.pkl.b64` (2.4 MB text = the 1.85 MB v2 pickle,
base64-encoded) **is committed here** in `ml-service/`, and `vercel.json`
bundles it into the function via `includeFiles`. The service decodes it
in memory on the first `/predict` call (lazy load — see "Cold-start
caveat" below); no upload step is needed.

Why base64, not the raw `.pkl`? The GitHub connector used to push this
repo can only push UTF-8 text files, never binaries — so the raw pickle
cannot be pushed through it. The old v1 `joblens_best_model.pkl`
(1,158,856 bytes, added by commits `fee2c7c` and `bb3bfdf`) is still in
the repo, superseded: the loader uses the `.b64` (v2) whenever it is
present and falls back to the `.pkl` (v1) only if the `.b64` is absent.
To switch back to a raw `.pkl`, delete the `.b64` file and upload the
raw `.pkl` in its place (GitHub web upload, Option A below) — then the
loader uses the `.pkl`. Pick ONE of these routes only if the bundled
files are ever removed:

### Option A — upload the raw .pkl into the repo
1. On GitHub, open this repo → `ml-service/` folder → **Add file →
   Upload files**.
2. Upload `joblens_best_model.pkl` (the file from the training run).
3. Commit to `main`. Vercel redeploys and the service loads it on the
   first `/predict` call.

### Option B — host the .pkl and set MODEL_URL (fallback only)
1. Put the `.pkl` somewhere with a direct download link (e.g. a GitHub
   Release asset, or any static file host).
2. In the Vercel project (see below), set env var `MODEL_URL` to that
   direct link. The service downloads the file once on the first
   `/predict` call.
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
7. Check `GET /health` — it answers immediately, but on a fresh deploy
   it says `"status": "model_missing"` until the first predict, because
   the model loads lazily. Send one `POST /predict` first, then check
   `/health` again — it must say `"status": "ok"` and
   `"model_loaded": true`. If it still says `model_missing` after a
   predict, the `.pkl` is not in place (see above).

Dependency size: scikit-learn + numpy + scipy + joblib installs to
~294 MB in a clean install (measured 2026-11-14), under Vercel's
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
  The model itself is loaded lazily, on the first `/predict` call —
  so `/` and `/health` answer fast even on a cold start, but the
  **first `/predict` still pays the pickle load** on top of the boot.
  Warm requests after that are fast (< 1 s).
- The Express route gives up after **8 seconds** (`ML_TIMEOUT_MS`,
  default 8000) and returns `502 "ML service timed out (it may be waking
  up — please retry in a few seconds)"`. That is by design: the server
  itself runs on Vercel's free tier, which kills functions after ~10 s,
  so a longer wait would not help.
- **Before a demo or judging session, warm it up:** send one real
  `POST /predict` (any short CV text) and wait for it to answer —
  that loads the model, and the next predict call is fast. Opening
  `/health` alone is **not** enough: it answers without loading the
  model, so it does not warm the prediction path.
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
