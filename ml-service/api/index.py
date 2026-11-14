"""
Vercel entry point for the JobLens ML service.

Vercel's Python runtime runs files under api/ as serverless functions
and auto-wraps an ASGI app exported as `app` — no adapter (Mangum,
uvicorn) is needed. This file is a thin shim: it puts the ml-service/
folder (the Vercel project root) on sys.path and re-exports the FastAPI
app from app.py, which stays the single source of truth for every
endpoint. No endpoint logic lives here.

See ml-service/README.md for the deploy steps.
"""
import sys
from pathlib import Path

# ml-service/ is the Vercel project root; add it so `app.py` is importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import app  # noqa: E402,F401 — Vercel serves this ASGI app
