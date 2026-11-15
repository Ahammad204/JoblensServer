"""
JobLens ML service — FastAPI wrapper around the trained CV classifier.

Model v3: scikit-learn Pipeline (TF-IDF, 10,000 features, word 1-2 grams,
sublinear TF -> LinearSVC, C=2.0), trained in JobLens_ML_Training_v3.ipynb
on 11,697 CVs in 32 role classes — v2's 18 plus Blockchain Developer,
Game Developer, Content Writer, E-commerce Specialist, IT Support,
Robotics Engineer, AR/VR Developer, Advocate, Aviation, Apparel,
Agriculture, Automobile, BPO and Consultant. Thin real classes (BPO,
Automobile, Agriculture, Apparel) were topped up with template-generated
CVs. Test scores on 1,755 held-out CVs: accuracy 0.9385, macro F1 0.9119
(real slice 0.9242 / 0.8106; synthetic slice 1.00 on its own holdout —
template rows are easy, read that as an upper bound). On the hardest
real slice (old Kaggle data only) accuracy 0.69 / macro F1 0.62 — lower
than v2's 0.83 / 0.84 because 32 classes is harder and the new thin
classes are the weakest (Consultant 0.54, Healthcare 0.63); the 18
original classes keep their scores. A 10-CV hand-written sanity set,
including the owner's own CV and 4 new-role CVs, predicts 10/10.

Why LinearSVC has no probabilities: an SVM gives decision scores, not
probabilities. This service turns the decision scores into a top-3 list
with a temperature-scaled softmax (T=0.5 — sharpens clear wins, leaves
genuine close calls close), and says so in every response — the numbers
are NOT calibrated probabilities. Do not present them as "the model is
X% sure" in the UI; present them as relative scores.

Model file: the v3 model ships as `joblens_best_model.pkl.b64` (base64
text, 3.9 MB — the 2.97 MB pickle) because the GitHub connector used to
push this repo cannot push binary files — the service decodes it in
memory on first load. The old
v1 `joblens_best_model.pkl` is still in the repo (superseded; it cannot
be deleted through the same connector) and is used only if the .b64 is
absent. MODEL_URL remains a fallback if neither bundled file exists.
To replace the .b64 with the raw .pkl, delete the .b64 file and upload
the .pkl via GitHub web upload into ml-service/ (see README.md) —
with no .b64 present the loader uses the .pkl.
See README.md.
"""

import base64
import io
import os
import re
import urllib.request
from pathlib import Path

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_FILENAME = "joblens_best_model.pkl"
MODEL_B64_FILENAME = "joblens_best_model.pkl.b64"
MODEL_PATH = Path(__file__).resolve().parent / MODEL_FILENAME
MODEL_B64_PATH = Path(__file__).resolve().parent / MODEL_B64_FILENAME
MODEL_URL = os.environ.get("MODEL_URL", "").strip()
MAX_CV_CHARS = 20000
# Temperature for the softmax of SVM decision scores. T=1 is the plain
# softmax (v1's flat ~0.05 readings); T=0.5 reads clear wins clearly
# while keeping genuinely close calls close. See the v2 training report.
SOFTMAX_TEMPERATURE = 0.5

app = FastAPI(
    title="JobLens ML Service",
    description="Trained CV -> job-role classifier (Linear SVM + TF-IDF).",
    version="1.0.0",
)

model = None
model_error = None


def clean_text(text):
    """Must match the cleaning in JobLens_ML_Training.ipynb exactly —
    the TF-IDF vectorizer was fit on text cleaned this way."""
    text = str(text).lower()
    text = re.sub(r"http\S+|www\.\S+", " ", text)  # links
    text = re.sub(r"[^a-z\s]", " ", text)  # keep letters only
    text = re.sub(r"\s+", " ", text).strip()
    return text


def load_model():
    """Load the model: v2 .b64 first, bundled .pkl next, MODEL_URL last."""
    global model, model_error
    try:
        if MODEL_B64_PATH.exists():
            # v2 model (base64 text — the push connector cannot carry the
            # raw binary). Decoded in memory; nothing is written to disk.
            raw = base64.b64decode(MODEL_B64_PATH.read_bytes())
            model = joblib.load(io.BytesIO(raw))
            return
        path = MODEL_PATH
        if not path.exists() and MODEL_URL:
            # Vercel functions run on a read-only filesystem except /tmp —
            # if the project folder cannot be written, download there.
            try:
                urllib.request.urlretrieve(MODEL_URL, path)
            except OSError:
                path = Path("/tmp") / MODEL_FILENAME
                urllib.request.urlretrieve(MODEL_URL, path)
        if not path.exists():
            model_error = (
                f"Neither {MODEL_B64_FILENAME} nor {MODEL_FILENAME} found "
                "in ml-service/ and no MODEL_URL is set. "
                "See ml-service/README.md."
            )
            return
        model = joblib.load(path)
    except Exception as exc:  # keep the service up so /health can report it
        model_error = f"Failed to load model: {exc}"
        model = None


_model_load_attempted = False


def ensure_model_loaded():
    """Load the model on first use, not at import.

    Loading at import time made every cold start pay the sklearn import
    + pickle load before any request could be served — including / and
    /health probes. The model is now loaded on the first /predict call
    instead; / and /health answer immediately and report
    model_loaded: false until then.
    """
    global _model_load_attempted
    if _model_load_attempted:
        return
    _model_load_attempted = True
    load_model()


class PredictRequest(BaseModel):
    cv_text: str


class TopPrediction(BaseModel):
    category: str
    probability: float


class PredictResponse(BaseModel):
    predicted_category: str
    confidence: float
    top_3: list[TopPrediction]
    model: str
    note: str


@app.get("/")
def root():
    return {
        "service": "JobLens ML Service",
        "model_loaded": model is not None,
        "endpoints": ["GET /health", "POST /predict"],
    }


@app.get("/health")
def health():
    return {
        "status": "ok" if model is not None else "model_missing",
        "model_loaded": model is not None,
        "model": "Linear SVM (TF-IDF, 32 categories)" if model else None,
        "classes": len(model.classes_) if model is not None else 0,
        "error": model_error,
    }


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    ensure_model_loaded()
    if model is None:
        raise HTTPException(
            status_code=503,
            detail=model_error or "Model not loaded.",
        )
    cv_text = (req.cv_text or "").strip()
    if not cv_text:
        raise HTTPException(status_code=400, detail="cv_text is required.")
    if len(cv_text) > MAX_CV_CHARS:
        cv_text = cv_text[:MAX_CV_CHARS]

    cleaned = clean_text(cv_text)
    if not cleaned:
        raise HTTPException(
            status_code=400,
            detail="cv_text has no usable text after cleaning.",
        )

    predicted = str(model.predict([cleaned])[0])

    # LinearSVC has no predict_proba — use decision_function + softmax.
    # These are relative scores, not calibrated probabilities. The
    # softmax is temperature-scaled (T=0.5) so clear wins read clearly
    # while genuinely close calls stay close.
    estimator = model.named_steps["model"]
    if hasattr(estimator, "decision_function"):
        scores = np.asarray(model.decision_function([cleaned])[0], dtype=float)
        scaled = (scores - scores.max()) / SOFTMAX_TEMPERATURE
        exp_scores = np.exp(scaled)
        probs = exp_scores / exp_scores.sum()
    elif hasattr(estimator, "predict_proba"):
        probs = np.asarray(model.predict_proba([cleaned])[0], dtype=float)
    else:
        probs = None

    if probs is None:
        top_3 = [TopPrediction(category=predicted, probability=1.0)]
        confidence = 1.0
    else:
        top_idx = np.argsort(probs)[::-1][:3]
        top_3 = [
            TopPrediction(
                category=str(model.classes_[i]),
                probability=round(float(probs[i]), 4),
            )
            for i in top_idx
        ]
        confidence = top_3[0].probability

    return PredictResponse(
        predicted_category=predicted,
        confidence=confidence,
        top_3=top_3,
        model="Linear SVM (TF-IDF, 32 categories)",
        note=(
            "Scores are a temperature-scaled (T=0.5) softmax of the SVM "
            "decision scores, not calibrated probabilities — treat them "
            "as relative scores."
        ),
    )
