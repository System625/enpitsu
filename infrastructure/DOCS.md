# DevOps / Infrastructure Documentation — Enpitsu

## Overview

Enpitsu's backend is a **FastAPI Python 3.11** service that:
- Accepts PDF/DOCX story uploads
- Manages sessions in memory
- Streams real-time audio + image generation via WebSocket using Gemini Live API
- Generates comic panels using Imagen 4 on Vertex AI

The backend **must** run on **Google Cloud Run** for hackathon compliance.

---

## System Architecture

```
User Browser
    |
    |-- HTTPS --------> Firebase Hosting (Next.js frontend)
    |                       |
    |                       |-- REST (POST /upload, GET /session) ---> Cloud Run (Backend)
    |                                                                       |
    |-- WSS (WebSocket) ------------------------------------------> Cloud Run (Backend)
                                                                           |
                                                          +----------------+----------------+
                                                          |                                 |
                                               Vertex AI (Gemini Live API)       Vertex AI (Imagen 4)
                                               gemini-2.0-flash-live-             imagen-4.0-generate-001
                                               preview-04-09
```

**Auth flow:**
- Frontend authenticates users via **Firebase Auth** (Google Sign-In or Email)
- The Firebase `idToken` should be sent with requests to the backend for identity verification (implement as needed)
- The backend authenticates to Vertex AI using **Application Default Credentials (ADC)** via the Cloud Run service account

---

## Repository Structure (infra-relevant files)

```
enpitsu/
├── backend/
│   ├── main.py               # FastAPI app, WebSocket endpoint, session management
│   ├── agent.py              # GeminiAgent — Gemini Live API connection + streaming
│   ├── image_gen.py          # ImageGenerator — Imagen 4 panel generation
│   ├── processor.py          # StoryProcessor — PDF/DOCX text extraction + scene parsing
│   ├── requirements.txt      # Python dependencies
│   ├── .env                  # Local secrets (never commit)
│   └── .env.example          # Template for required env vars
├── infrastructure/
│   ├── Dockerfile.backend    # Backend container image
│   ├── deployment-scripts/   # Add deploy scripts here (see below)
│   └── DOCS.md               # This file
├── docker-compose.yml        # Local development only
└── .github/workflows/
    └── frontend.yml          # Frontend CI (lint + build)
```

---

## Backend Service — Key Details

### Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Health check |
| POST | `/upload` | Upload PDF/DOCX, returns `session_id` |
| GET | `/session/{id}` | Get session state (scenes, panels, style) |
| GET | `/session/{id}/panels` | Get all generated panels for a session |
| WebSocket | `/ws/session/{id}` | Real-time bidirectional agent stream |

### WebSocket Message Protocol

**Frontend → Backend:**
```json
{ "type": "user_message", "text": "..." }
{ "type": "style_update", "style": "Manga" }
```
Or raw binary: PCM audio bytes (16-bit signed, 16kHz, mono)

**Backend → Frontend:**
```json
{ "type": "agent_response", "text": "...", "status": "speaking" }
{ "type": "agent_audio", "audio": "<base64 PCM>", "mime_type": "audio/pcm;rate=24000" }
{ "type": "panel_generated", "image": "<base64 JPEG>", "prompt": "...", "text": "..." }
{ "type": "status_update", "status": "generating|thinking|idle", "text": "..." }
{ "type": "error", "message": "..." }
```

### Panel Generation Trigger

The Gemini agent outputs `GENERATE_PANEL: <visual description>` in its transcription. The backend detects this string, calls Imagen 4, and sends the `panel_generated` event.

### Session Storage

Sessions are stored **in memory** (`dict`). They are lost on service restart. For production / persistence, migrate to **Firestore** or **Cloud SQL**.

---

## Python Dependencies

```
fastapi
uvicorn[standard]
websockets
google-genai>=1.0.0      # Google GenAI SDK (Vertex AI + Gemini Live API)
python-multipart          # File uploads
pypdf                     # PDF text extraction
python-docx               # DOCX text extraction
python-dotenv             # .env loading
pydantic
```

---

## Dockerfile

Location: `infrastructure/Dockerfile.backend`
Build context: **repo root** (not `./backend`)

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

> For Cloud Run, remove `--reload` from the CMD (it's a dev-only flag). Port must be `8080` on Cloud Run (see deployment section).

---

## Google Cloud Setup

### Step 1 — Enable Required APIs

Run once per GCP project:

```bash
gcloud config set project enpitsu-489418

gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  aiplatform.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com
```

### Step 2 — Create Artifact Registry Repository

```bash
gcloud artifacts repositories create enpitsu \
  --repository-format=docker \
  --location=us-central1 \
  --description="Enpitsu Docker images"
```

### Step 3 — Build and Push the Backend Image

```bash
# Authenticate Docker to GCR
gcloud auth configure-docker us-central1-docker.pkg.dev

# Build from repo root (required — Dockerfile copies backend/ folder)
docker build -f infrastructure/Dockerfile.backend \
  -t us-central1-docker.pkg.dev/enpitsu-489418/enpitsu/backend:latest .

# Push
docker push us-central1-docker.pkg.dev/enpitsu-489418/enpitsu/backend:latest
```

### Step 4 — Create a Service Account for the Backend

```bash
gcloud iam service-accounts create enpitsu-backend \
  --display-name="Enpitsu Backend Service Account"

# Grant Vertex AI access (Gemini + Imagen)
gcloud projects add-iam-policy-binding enpitsu-489418 \
  --member="serviceAccount:enpitsu-backend@enpitsu-489418.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Grant Secret Manager access (for reading env secrets)
gcloud projects add-iam-policy-binding enpitsu-489418 \
  --member="serviceAccount:enpitsu-backend@enpitsu-489418.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### Step 5 — Store Secrets in Secret Manager

Do NOT put secrets in the Docker image. Store them in Secret Manager and inject at runtime:

```bash
# The project ID and location are the primary auth mechanism (ADC via service account)
echo -n "enpitsu-489418" | gcloud secrets create GOOGLE_CLOUD_PROJECT --data-file=-
echo -n "us-central1"    | gcloud secrets create GOOGLE_CLOUD_LOCATION --data-file=-

# Optional Vertex Express key (fallback)
echo -n "AQ.xxx..." | gcloud secrets create VERTEX_EXPRESS_API_KEY --data-file=-
```

### Step 6 — Deploy to Cloud Run

```bash
gcloud run deploy enpitsu-backend \
  --image=us-central1-docker.pkg.dev/enpitsu-489418/enpitsu/backend:latest \
  --platform=managed \
  --region=us-central1 \
  --service-account=enpitsu-backend@enpitsu-489418.iam.gserviceaccount.com \
  --set-secrets=GOOGLE_CLOUD_PROJECT=GOOGLE_CLOUD_PROJECT:latest,GOOGLE_CLOUD_LOCATION=GOOGLE_CLOUD_LOCATION:latest \
  --port=8080 \
  --timeout=300 \
  --concurrency=80 \
  --min-instances=1 \
  --no-cpu-throttling \
  --allow-unauthenticated
```

> `--port=8080` — Cloud Run routes traffic to port 8080 by default. Update the Dockerfile CMD to `--port 8080`.
> `--timeout=300` — 5 min timeout for long WebSocket streaming sessions.
> `--no-cpu-throttling` — Keep CPU active between WebSocket messages (critical for streaming).
> `--min-instances=1` — Avoids cold starts during the demo.

After deploy, Cloud Run gives you a URL like:
```
https://enpitsu-backend-xxxx-uc.a.run.app
```

Give this URL to the frontend team for `NEXT_PUBLIC_BACKEND_URL`.

---

## Dockerfile — Cloud Run Fix

Update `infrastructure/Dockerfile.backend` CMD for Cloud Run (port 8080, no --reload):

```dockerfile
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

---

## Firebase Hosting (Frontend)

The frontend is a Next.js app. Firebase Hosting supports Next.js via **Cloud Functions** or **Cloud Run** (recommended for App Router).

### Step 1 — Install Firebase CLI

```bash
npm install -g firebase-tools
firebase login
```

### Step 2 — Initialize Firebase in the project

```bash
cd frontend
firebase init hosting
```

Select:
- **Use an existing project** → `enpitsu-489418`
- **Public directory** → `.next` (or use the Web Framework option)
- Enable **GitHub Actions** integration when prompted

### Step 3 — Deploy

```bash
firebase deploy --only hosting
```

For App Router / server components, use Firebase's **Next.js framework support**:

```bash
firebase experiments:enable webframeworks
firebase init hosting   # select "Next.js" as the framework
firebase deploy
```

This auto-detects Next.js and deploys via Cloud Run under the hood.

---

## CI/CD — GitHub Actions (Backend Deploy)

Create `.github/workflows/backend.yml`:

```yaml
name: Backend CI/CD

on:
  push:
    branches: [main]
    paths:
      - "backend/**"
      - "infrastructure/Dockerfile.backend"

jobs:
  deploy:
    runs-on: ubuntu-latest

    permissions:
      contents: read
      id-token: write   # required for Workload Identity Federation

    steps:
      - uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: enpitsu-backend@enpitsu-489418.iam.gserviceaccount.com

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker
        run: gcloud auth configure-docker us-central1-docker.pkg.dev

      - name: Build and Push
        run: |
          docker build -f infrastructure/Dockerfile.backend \
            -t us-central1-docker.pkg.dev/enpitsu-489418/enpitsu/backend:${{ github.sha }} \
            -t us-central1-docker.pkg.dev/enpitsu-489418/enpitsu/backend:latest .
          docker push us-central1-docker.pkg.dev/enpitsu-489418/enpitsu/backend:${{ github.sha }}
          docker push us-central1-docker.pkg.dev/enpitsu-489418/enpitsu/backend:latest

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy enpitsu-backend \
            --image=us-central1-docker.pkg.dev/enpitsu-489418/enpitsu/backend:${{ github.sha }} \
            --platform=managed \
            --region=us-central1 \
            --no-traffic-percent \
            && gcloud run services update-traffic enpitsu-backend \
            --to-latest \
            --region=us-central1
```

> For `GCP_WORKLOAD_IDENTITY_PROVIDER`: set up [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation) to avoid storing GCP service account keys as GitHub secrets.

---

## Local Development

```bash
# Start both frontend and backend
docker compose up

# Backend only (with live reload)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Frontend only
cd frontend
npm install
npm run dev
```

**Required for local dev** — create `backend/.env`:
```bash
GOOGLE_CLOUD_PROJECT=enpitsu-489418
GOOGLE_CLOUD_LOCATION=us-central1
# Optional fallback:
# VERTEX_EXPRESS_API_KEY=AQ.xxx
```

And authenticate locally:
```bash
gcloud auth application-default login
```

---

## Environment Variables Reference

### Backend (Cloud Run secrets or .env locally)

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | Yes | GCP project ID — enables ADC auth |
| `GOOGLE_CLOUD_LOCATION` | Yes | Vertex AI region (e.g. `us-central1`) |
| `VERTEX_EXPRESS_API_KEY` | No | Vertex Express key (REST only, fallback) |
| `GOOGLE_API_KEY` | No | AI Studio key (fallback, limited quota) |

Auth priority order: `GOOGLE_CLOUD_PROJECT` (ADC) → `VERTEX_EXPRESS_API_KEY` → `GOOGLE_API_KEY`

### Frontend (.env.local, never committed)

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_BACKEND_URL` | Yes | Cloud Run backend URL |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Yes | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Yes | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Yes | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Yes | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Yes | Firebase web config |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Yes | Firebase web config |
| `POLLINATIONS_API_KEY` | No | Pollinations API (higher rate limits) |

---

## Cloud Run — WebSocket Notes

Cloud Run supports WebSocket natively. The key flags:

- `--timeout=300` — Sessions can stay open up to 5 minutes
- `--no-cpu-throttling` — Without this, CPU is throttled between HTTP requests and WebSocket keep-alive messages get dropped
- `--concurrency=80` — Each instance handles up to 80 concurrent WebSocket connections
- `--min-instances=1` — Prevents cold starts; critical for live demo

CORS is handled in `backend/main.py` — currently allows all origins (`*`). Tighten this to the Firebase Hosting domain before submission.

---

## Deployment Checklist

- [ ] GCP APIs enabled (Cloud Run, Artifact Registry, Vertex AI, Secret Manager)
- [ ] Service account `enpitsu-backend` created with `roles/aiplatform.user`
- [ ] Secrets stored in Secret Manager (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`)
- [ ] Dockerfile updated: port `8080`, no `--reload`
- [ ] Docker image built and pushed to Artifact Registry
- [ ] Cloud Run service deployed with `--timeout=300`, `--no-cpu-throttling`, `--min-instances=1`
- [ ] Backend URL given to frontend team for `NEXT_PUBLIC_BACKEND_URL`
- [ ] Firebase Hosting configured for frontend
- [ ] GitHub Actions workflow for automated backend deploys (bonus points)
- [ ] Screen recording of Cloud Run service in GCP console (required for hackathon proof of deployment)

---

## Hackathon — Proof of Deployment

The judges require **visual proof** that the backend runs on GCP. Record a short screen capture showing either:

1. The **Cloud Run console** (`console.cloud.google.com/run`) with the `enpitsu-backend` service showing as active with recent requests
2. **Cloud Logging** (`console.cloud.google.com/logs`) showing `Connected to Gemini Live API` log lines from the backend

Include this recording as a separate video in the submission (not as part of the 4-minute demo video).
