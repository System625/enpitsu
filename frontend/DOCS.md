# Frontend Documentation — Enpitsu

## Overview

The frontend is a **Next.js 16 / React 19** app (TypeScript + Tailwind CSS v4). It is a real-time AI comic book co-creator interface. The user uploads a story file, talks to an AI agent via voice, and watches comic panels appear live on a canvas.

**Tech stack:**
- Next.js 16 (App Router)
- React 19
- TypeScript
- Tailwind CSS v4
- Framer Motion (animations)
- jsPDF (PDF export)
- mammoth / pdfjs-dist (client-side file parsing)

---

## Project Structure

```
frontend/
├── app/
│   ├── layout.tsx              # Root layout, wraps with LiveAgentProvider
│   ├── page.tsx                # Main app page (home)
│   ├── globals.css             # Global styles + Tailwind
│   ├── projects/
│   │   └── page.tsx            # Saved projects gallery page
│   ├── hooks/
│   │   ├── useLiveAgent.tsx    # Central state + agent logic (Context + Provider)
│   │   ├── useProjects.ts      # localStorage project save/load
│   │   ├── useStoryParser.ts   # Story text parsing into scenes/characters
│   │   └── useAudioVisualizer.ts # Mic waveform analyser
│   └── api/
│       ├── image/route.ts      # Proxy → Pollinations image generation API
│       ├── caption/route.ts    # Proxy → Pollinations LLM for speech bubble text
│       └── parse-story/route.ts # (reserved) server-side story parsing endpoint
├── components/
│   ├── AgentControlCenter.tsx  # Mic button, interrupt, text input bar
│   ├── AgentVisualizer.tsx     # Animated orb showing agent state
│   ├── ComicCanvas.tsx         # Grid layout rendering all panels
│   ├── ComicPanel.tsx          # Single panel (image + caption bubble)
│   ├── FileDropzone.tsx        # Drag-and-drop file upload zone
│   ├── ProjectCard.tsx         # Card for saved project in gallery
│   ├── ProjectLoader.tsx       # Modal/drawer to browse saved projects
│   ├── PromptInput.tsx         # Text input for typed commands
│   ├── PushToTalkButton.tsx    # Hold-to-record microphone button
│   └── StyleSelector.tsx       # Comic style picker (Manga, Manhwa, etc.)
├── public/                     # Static assets
├── next.config.ts
├── package.json
└── tsconfig.json
```

---

## How the App Works

### 1. State — `useLiveAgent` (the brain)

All app state lives in `app/hooks/useLiveAgent.tsx` via a React Context (`LiveAgentContext`). Wrap your page tree with `<LiveAgentProvider>` (done in `app/layout.tsx`).

**Key state values:**

| State | Type | Description |
|---|---|---|
| `agentState` | `"idle" \| "listening" \| "thinking" \| "speaking"` | Drives all UI animations |
| `panels` | `ComicPanel[]` | All generated panels on the canvas |
| `currentStyle` | `ComicStyle` | Active comic art style |
| `isRecording` | `boolean` | True while mic is held down |
| `storyLoaded` | `boolean` | True after a story file has been parsed |
| `projectName` | `string` | Current project title |

**Key actions (from context):**

| Action | What it does |
|---|---|
| `uploadStory(file)` | Parses PDF/DOCX client-side, splits into scenes, generates preview panels |
| `startRecording()` | Sets state to "listening" |
| `stopRecording(text?)` | Processes voice/text input, generates panels, speaks back |
| `interruptAgent()` | Cancels speech synthesis, resets to idle |
| `setCurrentStyle(style)` | Changes comic style, notifies backend via WebSocket |
| `saveCurrentProject()` | Persists current panels to localStorage |
| `exportProjectAsZip()` | Exports the full comic as a PDF (A4, multi-panel layout) |

---

### 2. Story Pipeline

When the user uploads a file:

```
File (PDF/DOCX)
  → extractTextFromFile()         [client-side, mammoth/pdfjs]
  → parseStory(rawText)           [useStoryParser.ts]
  → ParsedStory { title, characters[], scenes[] }
  → scenesToPanels()              [generates /api/image URLs per scene]
  → setPanels([...])              [renders on ComicCanvas]
  → fetchAiCaption() per scene    [/api/caption → Pollinations LLM]
```

Scenes are split by chapter headings first, then paragraph breaks, then ~500-word chunks as fallback.

The first ~50% of scenes are shown immediately as a preview. The user says "continue" or "finish the story" to generate the rest.

---

### 3. Image Generation — `/api/image`

The route `app/api/image/route.ts` is a **server-side proxy** to [Pollinations.ai](https://pollinations.ai). It accepts these query params:

| Param | Required | Description |
|---|---|---|
| `prompt` | Yes | Scene description |
| `seed` | No | Deterministic seed for reproducibility |
| `width` | No | Default 1024 |
| `height` | No | Default 1024 |
| `negative_prompt` | No | What to avoid in the image |

The proxy adds `model=zimage`, `enhance=true`, `nologo=true` to every request. Images are cached for 24 hours (`Cache-Control: public, max-age=86400`).

**Environment variable:**
```
POLLINATIONS_API_KEY=your_key   # optional, for higher rate limits
```

---

### 4. Caption Generation — `/api/caption`

The route `app/api/caption/route.ts` calls Pollinations's LLM API to generate a short speech bubble line (max 12 words) for each panel. It accepts a POST body:

```json
{
  "narrative": "scene description",
  "action": "what happens",
  "mood": "dramatic",
  "characters": ["Marcus", "Elena"],
  "dialogue": ["existing line if any"],
  "style": "manga"
}
```

Returns: `{ "caption": "We strike at dawn!" }`

---

### 5. Comic Styles

Five styles are supported. Each changes both the image prompt modifier and the caption voice:

| Key | Style | Prompt modifier |
|---|---|---|
| `american` | Classic superhero | Bold lines, vibrant dynamic colors |
| `manga` | Japanese manga | Black and white ink, screentone shading |
| `franco_belgian` | Bande dessinée | Ligne claire, Tintin aesthetic |
| `manhwa` | Korean webtoon | High quality digital painting |
| `manhua` | Chinese manhua | Wuxia fantasy, intricate details |

---

### 6. WebSocket Connection (Backend Integration)

The `wsRef` in `useLiveAgent.tsx` is wired to connect to the backend WebSocket at:

```
ws://<BACKEND_URL>/ws/session/<session_id>
```

**Current state:** The WebSocket ref exists but the connection logic is a `console.log` placeholder. You need to implement it.

**What the backend sends (incoming messages to handle):**

```ts
// Agent is speaking — show text in UI
{ type: "agent_response", text: string, status: "speaking" }

// Raw PCM audio — play it
{ type: "agent_audio", audio: string, mime_type: string }  // audio is base64

// Image panel is ready — add to canvas
{ type: "panel_generated", image: string, prompt: string, text: string }

// Status change
{ type: "status_update", status: "generating" | "thinking" | "idle", text: string }

// Error
{ type: "error", message: string }
```

**What to send to the backend (outgoing messages):**

```ts
// Text message from user
ws.send(JSON.stringify({ type: "user_message", text: "..." }))

// Raw PCM audio from mic (binary)
ws.send(audioChunkBytes)   // ArrayBuffer, not JSON

// Change style
ws.send(JSON.stringify({ type: "style_update", style: "Manga" }))

// Interrupt agent
ws.send(JSON.stringify({ type: "interrupt" }))
```

**To implement the connection, add this inside `useLiveAgent.tsx`:**

```ts
// After upload succeeds and session_id is returned from POST /upload:
const ws = new WebSocket(`${process.env.NEXT_PUBLIC_BACKEND_URL}/ws/session/${sessionId}`)
wsRef.current = ws

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.type === "panel_generated") {
    setPanels(prev => [...prev, {
      id: `panel_${Date.now()}`,
      imageUrl: `data:image/jpeg;base64,${msg.image}`,
      text: msg.text,
      index: prev.length,
    }])
  }
  if (msg.type === "agent_response") {
    // speak(msg.text) or display in chat
  }
  if (msg.type === "status_update") {
    setAgentState(msg.status === "generating" ? "thinking" : msg.status)
  }
}
```

---

### 7. Firebase Authentication

Firebase Auth is not yet wired in. Here is what to do:

**Step 1 — Install Firebase SDK:**
```bash
cd frontend
npm install firebase (already installed)
```

**Step 2 — Create `lib/firebase.ts`:**
```ts
import { initializeApp } from "firebase/app"
import { getAuth } from "firebase/auth"

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
```

**Step 3 — Add a sign-in component and wrap protected routes.** Use `onAuthStateChanged` to detect the current user. The session_id returned from `POST /upload` ties the user's session to the backend agent.

**Required environment variables (Firebase):**
```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

---

### 8. Environment Variables

Create `frontend/.env.local` (never commit this):

```bash
# Backend WebSocket + REST URL (Cloud Run URL after deployment)
NEXT_PUBLIC_BACKEND_URL=https://enpitsu-backend-xxxx-uc.a.run.app

# Pollinations (optional, for higher rate limits)
POLLINATIONS_API_KEY= check frontend env file

# Firebase (see section 7)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

---

### 9. PDF Export

`exportProjectAsZip()` (despite the name, it exports a PDF) uses jsPDF to:
- Render a black cover page with the project title
- Layout panels as 2x2 grid (A4) for most styles
- Layout panels as single full-page for Manga/Manhwa (vertical scroll style)
- Overlay speech bubble captions at the bottom of each panel

---

## Local Development

```bash
cd frontend
npm install
npm run dev        # starts at http://localhost:3000
```

**With backend running locally:**
Set `NEXT_PUBLIC_BACKEND_URL=http://localhost:8000` in `frontend/.env.local`.

---

## CI/CD

`.github/workflows/frontend.yml` runs on every push/PR that touches `frontend/**`:
1. Installs Node 20
2. Runs `npm ci`
3. Lints (`eslint`)
4. Type-checks (`tsc --noEmit`)
5. Builds (`next build`)

This must pass before any merge to `main`.
