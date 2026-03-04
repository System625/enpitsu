# enpitsu

> _Project description here — add a one-liner about what enpitsu does._

Built for [Devpost Hackathon](https://devpost.com).

---

## Team

| Role | Name |
|------|------|
| Frontend | @your-handle |
| Backend | @friend1-handle |
| Infrastructure | @friend2-handle |

---

## Project Structure

```
enpitsu/
├── frontend/          # Next.js 14 (App Router, TypeScript, Tailwind)
├── backend/           # Python / Node API
├── infrastructure/    # Dockerfiles & GCP deployment scripts
└── docker-compose.yml # Local dev orchestration
```

---

## Getting Started

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- Python 3.10+ (if backend is Python)

### Run locally

**Frontend only:**
```bash
cd frontend
npm install
npm run dev
# → http://localhost:3000
```

**Full stack (once Dockerfiles are ready):**
```bash
docker-compose up
# → frontend: http://localhost:3000
# → backend:  http://localhost:8000
```

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 14, TypeScript, Tailwind CSS |
| Backend | _TBD_ |
| Infrastructure | Docker, GCP |

---

## License

MIT
