# Enpitsu Developer Guide

> For the backend developer taking over fullstack. This document covers architecture, known bugs, reference code, and links your AI assistant can use for context.

---

## Table of Contents

1. [What We're Building](#what-were-building)
2. [Architecture Overview](#architecture-overview)
3. [Reference Repo & Docs](#reference-repo--docs)
4. [Current Codebase Map](#current-codebase-map)
5. [Known Bugs (Priority Order)](#known-bugs-priority-order)
6. [How the Audio Pipeline Works (and Why It's Broken)](#how-the-audio-pipeline-works)
7. [How Panel Generation Works](#how-panel-generation-works)
8. [How to Run Locally](#how-to-run-locally)
9. [Key Patterns from Reference Repo](#key-patterns-from-reference-repo)

---

## What We're Building

A live AI comic creator. The user uploads a story (PDF/DOCX), and an AI agent powered by Gemini Live API:
- **Talks** to the user in real-time (voice conversation)
- **Generates comic panels** as images (via Imagen 4) while you talk
- **Supports multiple art styles**: manga, manhwa, american, franco-belgian, manhua
- **Allows interruptions** — user can say "change panel 3's background" mid-conversation
- **Plays background music** while generating images (they take time)
- **Generates multiple panels per page** — a comic page has 4-8 panels, not 1 (see Bug #3)

Think of it as a voice-controlled Canva for comics, powered by Gemini.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (Next.js 16 + React 19 + Tailwind CSS 4)      │
│  Port 3000                                               │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ ComicCanvas  │  │ PushToTalk   │  │ StyleSelector  │  │
│  │ ComicPanel   │  │ Button       │  │                │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                 │                   │           │
│         └────────┬────────┴───────────────────┘           │
│                  │                                        │
│         ┌───────┴────────┐                                │
│         │ useLiveAgent   │  (React Context — all state)   │
│         │ hook           │                                │
│         └───────┬────────┘                                │
│                 │  WebSocket (binary PCM + JSON)          │
└─────────────────┼────────────────────────────────────────┘
                  │
                  │  ws://localhost:8000/ws/session/{id}
                  │
┌─────────────────┼────────────────────────────────────────┐
│  Backend (FastAPI + Python 3.11)                         │
│  Port 8000                                               │
│                 │                                        │
│         ┌───────┴────────┐                                │
│         │ main.py        │  WebSocket handler             │
│         │                │  Routes incoming messages      │
│         └──┬──────────┬──┘                                │
│            │          │                                   │
│   ┌────────┴───┐ ┌────┴──────────┐                       │
│   │ agent.py   │ │ image_gen.py  │                       │
│   │ GeminiAgent│ │ ImageGenerator│                       │
│   │            │ │ (Imagen 4)    │                       │
│   └────────────┘ └───────────────┘                       │
│         │                                                │
│         │  google-genai SDK                              │
│         │  client.aio.live.connect()                     │
│         ▼                                                │
│   Gemini Live API (bidirectional streaming)               │
└──────────────────────────────────────────────────────────┘
```

**Communication flow:**
1. User uploads PDF → `POST /upload` → backend extracts text, creates session
2. Frontend opens WebSocket to `/ws/session/{session_id}`
3. Backend connects to Gemini Live API via `google-genai` SDK
4. User speaks → PCM audio (binary) sent via WebSocket → backend forwards to Gemini
5. Gemini responds with audio → backend base64-encodes → sends as JSON to frontend
6. Gemini calls `generate_comic_panel()` tool → backend generates image via Imagen 4 → sends to frontend
7. Frontend renders panels in a grid layout

---

## Reference Repo & Docs

### Primary Reference: `gemini-live-genai-python-sdk`

**You need to clone this locally first** (it's gitignored — do NOT commit it):

```bash
# Run from the project root
git clone https://github.com/google-gemini/gemini-live-api-examples.git
```

This creates `gemini-live-api-examples/` in the project root. The folder is in `.gitignore` so it won't be tracked.

This is the example we should follow. It uses the **exact same stack** as us:
- FastAPI WebSocket backend
- `google-genai` Python SDK
- Backend proxies between browser and Gemini Live API
- AudioWorklet for browser audio capture/playback

**Key files to study:**

| Reference file | Our equivalent | What to compare |
|---|---|---|
| `gemini-live-genai-python-sdk/gemini_live.py` | `backend/agent.py` | Session lifecycle, audio relay, tool calling, interruption handling |
| `gemini-live-genai-python-sdk/main.py` | `backend/main.py` | WebSocket message routing, queue-based architecture |
| `gemini-live-genai-python-sdk/frontend/media-handler.js` | `frontend/app/hooks/useLiveAgent.tsx` + `frontend/components/PushToTalkButton.tsx` | Audio capture, PCM playback, AudioWorklet usage |
| `gemini-live-genai-python-sdk/frontend/pcm-processor.js` | `frontend/public/pcm-processor.js` | AudioWorklet processor |

### Official Documentation Links

| Topic | URL |
|---|---|
| **Gemini Live API overview** | https://ai.google.dev/gemini-api/docs/live |
| **Live API audio streaming** | https://ai.google.dev/gemini-api/docs/live#audio |
| **Live API tool/function calling** | https://ai.google.dev/gemini-api/docs/live#function-calling |
| **Live API interruptions & turn handling** | https://ai.google.dev/gemini-api/docs/live#interruptions |
| **Python google-genai SDK reference** | https://googleapis.github.io/python-genai/ |
| **Imagen 4 image generation** | https://ai.google.dev/gemini-api/docs/imagen |
| **Web Audio API / AudioWorklet** | https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet |

### Why NOT livekit/agents

LiveKit is a heavy framework for multi-participant video/audio rooms (think Zoom). It has its own transport layer, SFU infrastructure, and room management. Our app is a single-user conversational agent — LiveKit would require rearchitecting everything and we'd fight the framework to do comic-specific things. Skip it.

---

## Current Codebase Map

### Backend (`backend/`)

| File | Purpose | Lines |
|---|---|---|
| `main.py` | FastAPI app, WebSocket endpoint, message routing, panel generation orchestration | ~660 |
| `agent.py` | `GeminiAgent` class — wraps `google-genai` SDK, manages Gemini Live sessions, reconnection, history | ~280 |
| `image_gen.py` | `ImageGenerator` class — calls Imagen 4 via `google-genai` SDK | ~73 |
| `processor.py` | `StoryProcessor` — extracts text from PDF/DOCX, splits into scenes | ~100 |

### Frontend (`frontend/`)

| File | Purpose |
|---|---|
| `app/hooks/useLiveAgent.tsx` | **Central brain** — React Context with all state, WebSocket connection, audio playback, panel management |
| `app/hooks/useAuth.tsx` | Firebase Auth hook |
| `app/hooks/useProjects.ts` | Project persistence (localStorage + Firestore) |
| `components/ComicCanvas.tsx` | Grid layout for panels (varies by style) |
| `components/ComicPanel.tsx` | Individual panel — loading skeleton, image display, error retry |
| `components/PushToTalkButton.tsx` | Mic recording via AudioWorklet, push-to-talk + open-mic modes |
| `components/StyleSelector.tsx` | Comic style picker UI |
| `lib/firebase.ts` | Firebase init (lazy singleton pattern) |
| `public/pcm-processor.js` | AudioWorklet processor for 16kHz PCM capture |

---

## Known Bugs (Priority Order)

### Bug #1: Triple-overlapping voices on first Gemini response (CRITICAL)

**Symptoms:** When the agent first speaks after story upload, you hear 2-3 voices overlapping — sounds garbled.

**Root cause:** Three audio paths fire simultaneously:

1. **Browser TTS fallback** (`speak()` function in `useLiveAgent.tsx:90-121`): When `agent_response` arrives and `receivingPcmRef.current` is `false` (no PCM audio yet), browser TTS plays the text.
2. **PCM audio chunks** (`agent_audio` messages): Gemini sends PCM audio chunks that arrive milliseconds after the text transcription. Once the first `agent_audio` arrives, `receivingPcmRef.current` is set to `true`, but TTS is **already playing**.
3. **Greeting prompt**: On WebSocket connect, we immediately send a `user_message` asking Gemini to greet the user (`useLiveAgent.tsx:221-224`). Gemini responds with both `agent_response` (text transcription) AND `agent_audio` (voice), causing TTS + PCM to overlap.

**Where it happens:**
- `frontend/app/hooks/useLiveAgent.tsx:274-284` — the `agent_response` handler starts TTS
- `frontend/app/hooks/useLiveAgent.tsx:287-307` — the `agent_audio` handler starts PCM playback
- The race: `agent_response` arrives first → TTS starts → `agent_audio` arrives → PCM starts → overlap

**How the reference repo handles it:**
- `gemini-live-genai-python-sdk/gemini_live.py:92-98` — audio chunks are sent directly as binary bytes via `audio_output_callback`, NOT base64-encoded JSON. The frontend plays raw bytes immediately.
- The reference repo has **NO browser TTS fallback at all**. It trusts the Gemini Live API to always send audio when `response_modalities=["AUDIO"]`.

**Fix approach:**
- Remove the browser TTS fallback entirely (`speak()` function). If `response_modalities=["AUDIO"]`, Gemini will always send audio.
- OR: Add a short delay (200-300ms) before starting TTS, cancel it if `agent_audio` arrives first.
- Cancel any in-progress TTS when the first `agent_audio` chunk arrives.

---

### Bug #2: Gemini doesn't respond to user input (text or audio) (CRITICAL)

**Symptoms:** User speaks or types, nothing happens. Agent stays silent. Sometimes works on 2nd or 3rd try.

**Root causes (multiple):**

#### 2a. Session ends after turn_complete, audio sent to dead session

The Gemini Live API session ends naturally after `turn_complete`. Our `agent.py` does NOT auto-reconnect (by design, to prevent duplicate tool calls). But when the user starts speaking, audio chunks hit `send_audio()` which silently drops them because `self._ready.is_set()` is `False`:

```python
# agent.py:224 — silently drops audio when session is dead
async def send_audio(self, audio_data: bytes):
    if not self._ready.is_set() or self.session is None:
        return  # <-- audio is silently lost
```

The session only reconnects when `send_audio_end()` is called (after user releases push-to-talk). But by then, ALL the audio the user just spoke has been dropped. Gemini gets an `ActivityEnd` with no preceding audio, so it has nothing to respond to.

**How the reference repo handles it:**
- `gemini-live-genai-python-sdk/gemini_live.py:49-59` — the session stays alive as a single `async with` block. Audio flows continuously through an `asyncio.Queue`. The session does NOT end on turn_complete — it loops with `async for response in session.receive()`.
- Key difference: the reference keeps ONE persistent session. Our code creates a new session per turn.

**Fix approach:**
- Keep the Gemini session alive persistently (like the reference), don't let it end on turn_complete
- OR: reconnect the session BEFORE audio streaming starts (when user presses the mic button), not after they stop

#### 2b. `send_audio_end()` calls `_ensure_session()` which takes up to 15s

When the user releases push-to-talk, `send_audio_end()` is called. It calls `_ensure_session()` which may need to reconnect, replay history, and wait up to 15 seconds. During this time the frontend shows "thinking" but nothing is happening.

```python
# agent.py:236 — reconnects AFTER all audio was already dropped
async def send_audio_end(self):
    await self._ensure_session()  # <-- can take up to 15s
    if self.session:
        await self.session.send_realtime_input(activity_end=types.ActivityEnd())
```

#### 2c. Text messages work but Gemini doesn't always respond audibly

When sending text via `send_text()`, the reconnection happens correctly. But Gemini sometimes responds with only `output_transcription` (text) and no audio, despite `response_modalities=["AUDIO"]`. This could be a model behavior issue with `gemini-2.0-flash-live-preview-04-09`.

**Fix approach:**
- Consider using the newer model: `gemini-2.5-flash-native-audio-preview-12-2025` (what the reference repo uses)
- The reference repo config also includes `proactivity` and `enable_affective_dialog` which may help

---

### Bug #3: Only generates 1 panel per page, finds too few scenes (MAJOR)

**Symptoms:** When processing a PDF with lots of text, the agent only identifies 4-5 scenes and generates 1 panel each. A proper comic page should have 4-8 panels per page. The result looks nothing like a real comic — compare to the manga/american comic examples shared.

**Root causes:**

#### 3a. Scene splitting is too coarse (`processor.py`)

`StoryProcessor.break_into_scenes()` splits text into large scene-level chunks. The system prompt then asks Gemini to generate panels for each "scene" — but a scene might be 2 pages of text that should become 6-8 panels.

#### 3b. System prompt doesn't instruct multi-panel generation per page

The system prompt in `agent.py:257-278` says:
> "If the user asks for multiple panels or to illustrate the whole story, call generate_comic_panel() multiple times in sequence."

But it doesn't instruct the agent to think in terms of **pages with multiple panels**. A manga page has 4-7 panels with varied sizes. An American comic page has 4-6 panels in a grid. The agent doesn't know this.

#### 3c. Image generation is 1:1 (one call = one panel)

`image_gen.py` generates one image per tool call with aspect ratio `4:3`. This is fine for a single panel, but a comic page needs panels with varying aspect ratios:
- Wide establishing shots (16:9 or wider)
- Tall close-ups (3:4 or 2:3)
- Small action panels (1:1)
- Full-page splash panels

#### 3d. Frontend grid layout is static

`ComicCanvas.tsx` has hardcoded grid templates per style:
- American: 2-3 columns, 300px rows
- Manga: 2-3 columns, 250-300px rows, RTL
- Manhwa: 1 column vertical strip

But real comics have **irregular panel layouts** — panels span multiple rows/columns, have diagonal borders, etc. The current grid can't represent this.

**Fix approach:**

Short-term (get it working):
- Update the system prompt to tell Gemini: "For each scene, generate 4-6 panels that form a comic PAGE. Vary the compositions: establish the setting wide, then close-ups for dialogue, action shots for movement."
- Have Gemini call `generate_comic_panel()` multiple times per scene (it can batch tool calls)
- Group received panels into "pages" on the frontend (every 4-6 panels = 1 page)

Long-term (make it good):
- Add a `page_layout` field to the tool call that specifies panel arrangement
- Support varied aspect ratios in `image_gen.py`
- Build a dynamic panel layout engine on the frontend

---

### Bug #4: Audio playback queue not cleared on interruption

**Symptoms:** When the user interrupts the agent, old audio chunks continue playing over the new response.

**Where it happens:**
- `useLiveAgent.tsx:287-307` — PCM chunks are queued via `_nextPlayTime` scheduling
- `useLiveAgent.tsx:488-494` — `interruptAgent()` cancels browser TTS but does NOT clear the PCM queue
- The global `_nextPlayTime` variable keeps scheduling old chunks into the future

**How the reference repo handles it:**
- `gemini-live-genai-python-sdk/gemini_live.py:109-115` — on `server_content.interrupted`, calls `audio_interrupt_callback()` which can clear the playback buffer
- The reference's frontend uses an AudioWorklet for playback that supports an "interrupt" message to clear its buffer

**Fix approach:**
- When `interrupted` event arrives from Gemini, close and recreate the AudioContext (or disconnect all source nodes)
- Reset `_nextPlayTime = 0`
- The backend should forward `server_content.interrupted` to the frontend as a message type

---

### Bug #5: Backend doesn't forward `interrupted` events to frontend

**Symptoms:** Related to Bug #4. The backend's `on_agent_message()` handler in `main.py` doesn't check for `server_content.interrupted` at all.

**Where it's missing:**
```python
# main.py:531-565 — handles server_content but no interrupted check
sc = getattr(message, "server_content", None)
# ... handles input_transcription, output_transcription, model_turn, turn_complete
# BUT: no check for sc.interrupted!
```

**How the reference repo handles it:**
```python
# gemini_live.py:109-115
if server_content.interrupted:
    if audio_interrupt_callback:
        await audio_interrupt_callback()
    await event_queue.put({"type": "interrupted"})
```

**Fix:** Add this to `on_agent_message()` in `main.py`:
```python
if getattr(sc, "interrupted", False):
    await websocket.send_json({"type": "interrupted"})
```

And handle it in the frontend to clear audio playback.

---

### Bug #6: Reconnection replays history, can trigger duplicate tool calls

**Symptoms:** After the session reconnects, Gemini sometimes re-reads the history and calls `generate_comic_panel()` again for panels that were already generated.

**Where it happens:**
- `agent.py:153-159` — replays `self._history` on reconnect
- `agent.py:275` — system prompt rule #10 says "Never generate panels on your own initiative after a reconnection" but Gemini doesn't always follow this

**Fix approach:**
- The reference repo (`gemini_live.py`) doesn't reconnect at all — it keeps one persistent session
- If we must reconnect, strip tool call/response turns from history before replay
- Or: add a `[CONTEXT_REPLAY]` prefix to replayed history so Gemini knows not to act on it

---

### Minor Issues

| Issue | Location | Description |
|---|---|---|
| Module-level `_nextPlayTime` global | `useLiveAgent.tsx:10` | Persists across React re-renders, not reset on component unmount |
| CORS wide open | `main.py:30` | `allow_origins=["*"]` — restrict in production |
| No max retries on panel image retry | `ComicPanel.tsx:113` | Incrementing `retryKey` loops forever if URL is broken |
| `speak()` TTS fallback can fight PCM | `useLiveAgent.tsx:90-121` | Should be removed entirely if Gemini always sends audio |
| Auto-save only triggers on panel changes | `useLiveAgent.tsx:378-398` | Style/name changes without panels won't save |
| Thinking music not cleaned up on unmount | `useLiveAgent.tsx:155-188` | `thinkingMusicRef.current` never disposed |

---

## How the Audio Pipeline Works

### Recording (User → Gemini)

```
User's Microphone
    │
    ▼
MediaStream (browser native)
    │
    ▼
AudioWorklet (pcm-processor.js)
    │  Converts Float32 → Int16 PCM
    │  Sample rate: 16kHz, mono
    │
    ▼
PushToTalkButton.tsx
    │  Receives PCM via worklet.port.onmessage
    │  Calls sendAudioChunk(pcmBytes)
    │
    ▼
useLiveAgent.tsx → wsRef.current.send(pcmBytes)
    │  Sends as binary WebSocket message
    │
    ▼
Backend main.py (line 638-640)
    │  Receives binary bytes
    │  Calls agent.send_audio(audio_bytes)
    │
    ▼
agent.py → session.send_realtime_input(audio=Blob(...))
    │  Forwards to Gemini Live API
    │  mime_type: "audio/pcm;rate=16000"
    │
    ▼
Gemini Live API
```

### Playback (Gemini → User)

```
Gemini Live API
    │  Sends audio in server_content.model_turn.parts[].inline_data
    │  Format: PCM, 24kHz, 16-bit
    │
    ▼
agent.py → on_agent_message callback
    │
    ▼
main.py (line 548-560)
    │  base64-encodes the PCM bytes
    │  Sends as JSON: { type: "agent_audio", audio: "base64...", mime_type: "audio/pcm;rate=24000" }
    │
    ▼
useLiveAgent.tsx (line 287-307)
    │  Decodes base64 → Int16 → Float32
    │  Creates AudioBuffer at 24kHz
    │  Schedules playback via _nextPlayTime queue
    │
    ▼
Web Audio API → AudioContext.destination → Speakers
```

**Key difference from reference repo:** The reference sends audio as **raw binary bytes** over WebSocket (`await websocket.send_bytes(data)`). We encode to base64 JSON, which adds ~33% overhead and extra encode/decode steps.

---

## How Panel Generation Works

### Primary path: Gemini Function Calling

```
User says: "Generate the first panel"
    │
    ▼
Gemini Live API decides to call generate_comic_panel()
    │  Returns: tool_call { function_calls: [{ name: "generate_comic_panel", args: {...} }] }
    │
    ▼
main.py on_agent_message() (line 385-462)
    │  1. Sends "panel_loading" to frontend (shows skeleton)
    │  2. Calls image_gen.generate_panel(prompt, style)
    │  3. Imagen 4 generates JPEG image
    │  4. Sends "panel_generated" with base64 image to frontend
    │  5. Sends tool_response back to Gemini ("success")
    │  6. Sends "status_update: idle"
    │
    ▼
Frontend replaces loading skeleton with real image
```

### Fallback path: GENERATE_PANEL token parsing

If Gemini doesn't use function calling (outputs text instead), the transcription is parsed for `GENERATE_PANEL:` tokens. This is a fallback and shouldn't be needed if tools are properly configured.

---

## How to Run Locally

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt

# Create .env with at least one of:
# VERTEX_EXPRESS_API_KEY=your-key      (recommended)
# GOOGLE_API_KEY=your-key              (AI Studio)
# GOOGLE_CLOUD_PROJECT=your-project    (ADC)

uvicorn main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
# Create .env.local (see .env.local.example)
npm run dev
```

### Docker

```bash
docker-compose up --build
```

---

## Key Patterns from Reference Repo

### 1. Queue-based architecture (reference) vs Direct relay (ours)

The reference repo uses `asyncio.Queue` for each input type:

```python
# Reference: gemini_live.py — clean separation via queues
audio_input_queue = asyncio.Queue()
video_input_queue = asyncio.Queue()
text_input_queue = asyncio.Queue()

# Concurrent tasks drain queues independently
send_audio_task = asyncio.create_task(send_audio())  # queue → Gemini
send_video_task = asyncio.create_task(send_video())  # queue → Gemini
receive_task = asyncio.create_task(receive_loop())    # Gemini → event_queue
```

Our code calls `agent.send_audio()` directly from the WebSocket receive loop, which means audio sending and message processing share the same coroutine.

### 2. Persistent session (reference) vs Reconnect-per-turn (ours)

```python
# Reference: ONE session, stays alive
async with client.aio.live.connect(model=..., config=...) as session:
    # This block stays alive for the entire conversation
    async for response in session.receive():
        # handles everything

# Ours: session ends on turn_complete, reconnects on next input
async with client.aio.live.connect(...) as session:
    async for message in session.receive():
        ...
    # Session ends here. _ensure_session() reconnects later.
```

### 3. Binary audio (reference) vs Base64 JSON (ours)

```python
# Reference: sends raw bytes — efficient
async def audio_output_callback(data):
    await websocket.send_bytes(data)

# Ours: base64 encodes into JSON — 33% overhead
audio_b64 = base64.b64encode(inline_data.data).decode("utf-8")
await websocket.send_json({"type": "agent_audio", "audio": audio_b64, ...})
```

### 4. Interrupt handling (reference) vs Missing (ours)

```python
# Reference: properly handles interrupts
if server_content.interrupted:
    await audio_interrupt_callback()
    await event_queue.put({"type": "interrupted"})

# Ours: doesn't check server_content.interrupted at all
```

### 5. Tool calling (reference has clean pattern)

```python
# Reference: generic tool mapping, clean response
if tool_call:
    for fc in tool_call.function_calls:
        tool_func = self.tool_mapping[fc.name]
        result = await tool_func(**fc.args)
        function_responses.append(
            types.FunctionResponse(name=fc.name, id=fc.id, response={"result": result})
        )
    await session.send_tool_response(function_responses=function_responses)
```

Our tool handling is inline in `on_agent_message()` with lots of duplicated code for each tool.

---

## Environment Variables

### Backend (`backend/.env`)

```
# Pick ONE auth method:
VERTEX_EXPRESS_API_KEY=your-key          # Recommended
# OR
GOOGLE_API_KEY=your-key                  # AI Studio
# OR
GOOGLE_CLOUD_PROJECT=your-project        # Vertex AI ADC (needs gcloud auth)
```

### Frontend (`frontend/.env.local`)

```
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
```

---

## AI Assistant Quick Reference

If your AI assistant needs more context, point it to:

1. **This file** — `DEVELOPER_GUIDE.md`
2. **Reference repo** — `gemini-live-api-examples/gemini-live-genai-python-sdk/` (cloned locally)
3. **Gemini Live API docs** — https://ai.google.dev/gemini-api/docs/live
4. **Task description** — `task.md`

Key command for the AI: "Read DEVELOPER_GUIDE.md first, then look at the reference repo in gemini-live-api-examples/gemini-live-genai-python-sdk/ for patterns."
