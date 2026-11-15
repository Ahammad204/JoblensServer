"""
JobLens ML service — FastAPI wrapper around the trained CV classifier.

Model: scikit-learn Pipeline (TF-IDF, 5,000 features, word 1-2 grams
-> LinearSVC), trained in JobLens_ML_Training.ipynb on the Kaggle Resume
Dataset (2,484 CVs, 24 categories). Test scores: accuracy 0.7103,
macro F1 0.6672.

Why LinearSVC has no probabilities: an SVM gives decision scores, not
probabilities. This service turns the decision scores into a top-3 list
with a softmax, and says so in every response — the numbers are NOT
calibrated probabilities. Do not present them as "the model is X% sure"
in the UI; present them as relative scores.

Model file: the service loads `joblens_best_model.pkl` from this folder,
or downloads it on first use from the MODEL_URL env var. The .pkl IS
committed in this repo (ml-service/joblens_best_model.pkl, 1,158,856
bytes) — MODEL_URL is only a fallback if the bundled file is absent.
See README.md.
"""

import os
import re
import urllib.request
from pathlib import Path

import joblib
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_FILENAME = "joblens_best_model.pkl"
MODEL_PATH = Path(__file__).resolve().parent / MODEL_FILENAME
MODEL_URL = os.environ.get("MODEL_URL", "").strip()
MAX_CV_CHARS = 20000

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
    """Load the pickle from disk, or download it once from MODEL_URL."""
    global model, model_error
    try:
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
                f"{MODEL_FILENAME} not found in ml-service/ and no "
                "MODEL_URL is set. See ml-service/README.md."
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
        "model": "Linear SVM (TF-IDF, 24 categories)" if model else None,
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
    # These are relative scores, not calibrated probabilities.
    estimator = model.named_steps["model"]
    if hasattr(estimator, "decision_function"):
        scores = np.asarray(model.decision_function([cleaned])[0], dtype=float)
        exp_scores = np.exp(scores - scores.max())
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
        model="Linear SVM (TF-IDF, 24 categories)",
        note=(
            "Probabilities are a softmax of the SVM decision scores, "
            "not calibrated probabilities — treat them as relative scores."
        ),
    )
