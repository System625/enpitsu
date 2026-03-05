# DevOps / Infrastructure - Responsibilities & Guide

## Project: Enpitsu - Real-Time AI Comic Book Co-Creator

Enpitsu is a live AI agent that transforms stories into comic books through real-time collaboration. Your job is to get the frontend (Next.js) and backend (Python/Gemini agent) deployed on **Google Cloud** — this is a hard requirement for the hackathon.

---

## Your Core Responsibilities

### 1. Google Cloud Deployment (MANDATORY)
The hackathon **requires** deployment on Google Cloud Services and proof of deployment. This is non-negotiable for submission.

Recommended services:
- **Cloud Run** — Deploy both the frontend and backend as containerized services. Supports WebSocket connections needed for real-time streaming.
- **Vertex AI** — Required for Gemini model access and Gen Media (image generation) capabilities.
- **Cloud Storage** — Store uploaded PDF/Word files and generated comic panel images.
- **Artifact Registry** — Store Docker images for Cloud Run deployments.

### 2. Infrastructure Setup
- Set up a **GCP project** with appropriate APIs enabled:
  - Vertex AI API
  - Cloud Run API
  - Cloud Storage API
  - Generative Language API (for Gemini)
- Configure **IAM / service accounts** with least-privilege access for:
  - Backend service → Vertex AI, Cloud Storage
  - Cloud Run service agent
- Set up **environment variables / Secret Manager** for API keys and configuration.

### 3. CI/CD Pipeline
- Set up automated builds and deployments (Cloud Build or GitHub Actions with GCP integration).
- Pipeline should:
  - Build Docker images for frontend and backend
  - Push to Artifact Registry
  - Deploy to Cloud Run
  - Run on pushes to `main` branch

### 4. Networking & WebSocket Support
- Ensure Cloud Run is configured to support **WebSocket connections** (required for real-time agent streaming).
  - Set request timeout appropriately (streaming sessions may last several minutes).
  - Configure concurrency settings for WebSocket connections.
- Set up **CORS** policies to allow frontend-backend communication.
- Consider using a custom domain or at minimum ensure the Cloud Run URLs are properly configured.

### 5. Storage Architecture
- **Cloud Storage buckets**:
  - `enpitsu-uploads` — User-uploaded story files (PDF/Word)
  - `enpitsu-panels` — Generated comic panel images
- Configure appropriate lifecycle policies and access controls.
- Ensure the backend service account has read/write access to these buckets.

### 6. Monitoring & Logging
- Set up Cloud Logging for both services.
- Configure basic alerting for service failures.
- Ensure logs capture WebSocket connection events and Gemini API usage.

---

## Architecture Overview

```
User Browser
    |
    ├── HTTPS ──→ Cloud Run (Frontend - Next.js)
    |
    └── WSS ───→ Cloud Run (Backend - Python/ADK)
                    |
                    ├──→ Vertex AI (Gemini 1.5 Pro/Flash)
                    ├──→ Vertex AI Creative Studio (Image Gen)
                    └──→ Cloud Storage (uploads & generated panels)
```

---

## Required Tech Stack

| Component | Service |
|-----------|---------|
| Compute | **Google Cloud Run** |
| AI/ML | **Vertex AI** (Gemini + Gen Media) |
| Storage | **Google Cloud Storage** |
| Container Registry | **Artifact Registry** |
| Secrets | **Secret Manager** |
| CI/CD | Cloud Build or GitHub Actions |

---

## Key Resources

### Google Cloud & Deployment
- **Google Cloud Credits Request**: https://forms.gle/rKNPXA1o6XADvQGb7
  - **Apply immediately** — we need credits for Vertex AI and Cloud Run usage
- **Google Developer Groups (GDGs)**: https://developers.google.com/community
  - Active members get bonus points in judging

### Gemini & Vertex AI Setup
- **Live API on Vertex AI**: https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/multimodal-live-api
  - Includes deployment examples for Vertex AI
- **Vertex AI Creative Studio (Gen Media)**: https://github.com/GoogleCloudPlatform/vertex-ai-creative-studio/tree/main/experiments/mcp-genmedia
  - MCP servers for image/video generation — review for infra requirements

### Reference Architectures
- **Gen Media + Live API Sample App**: https://github.com/GoogleCloudPlatform/generative-ai/tree/main/vision/sample-apps/genmedia-live
  - Full sample app combining media generation with streaming — check how it's deployed
- **ADK Demo Repository**: https://github.com/google/adk-samples/tree/main/python/agents/bidi-demo
  - Sample streaming agent — review the Dockerfile and deployment config

### Learning
- **5-Minute ADK Tutorial**: https://www.youtube.com/watch?v=vLUkAGeLR1k
- **Codelabs**: Available on the hackathon resources page for hands-on GCP tutorials

---

## Dockerfiles Needed

### Frontend (Next.js)
```dockerfile
# Needs: Node.js 20+, next build, port 3000
# Output: standalone Next.js build
```

### Backend (Python)
```dockerfile
# Needs: Python 3.11+, pip install dependencies
# Must support: WebSocket connections, Gemini SDK, file processing
# Port: 8080 (Cloud Run default)
```

---

## Cloud Run Configuration Notes

- **WebSocket timeout**: Set `--timeout` to at least 300s (5 min) for streaming sessions
- **Concurrency**: Set `--concurrency` based on expected WebSocket connections per instance
- **CPU always allocated**: Use `--no-cpu-throttling` for WebSocket services (CPU must stay active between requests)
- **Min instances**: Consider `--min-instances=1` to avoid cold starts during demo

---

## Deadline

**March 16, 2026 @ 8:00pm EDT** — Challenge submission deadline. Deployment must be live with proof for submission.
