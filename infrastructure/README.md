# Infrastructure

This directory contains Docker and GCP deployment configuration for enpitsu.

## Expected Structure

```
infrastructure/
├── Dockerfile.frontend          # Docker image for Next.js frontend
├── Dockerfile.backend           # Docker image for backend service
└── deployment-scripts/          # GCP deployment scripts
```

## Usage

Build images individually or use `docker-compose.yml` at the repo root for local dev.
