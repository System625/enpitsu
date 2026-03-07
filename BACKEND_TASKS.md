# Backend Tasks - Sola

## Status Summary

The backend is ~70% functional. Gemini Live API connects, text input triggers responses, Imagen 4 generates panels, and audio playback to the browser works. The critical blocker is: **audio input from the mic doesn't trigger agent responses**. Beyond that, there's no database persistence, no auth verification, and panel generation uses string-matching instead of proper tool calling.

---

## Current State: What Works

| Feature | Status |
|---------|--------|
| Gemini Live API WebSocket connection (`gemini-2.0-flash-live-preview-04-09`) | WORKS |
| Text input → Gemini → audio response | WORKS |
| Audio output: PCM chunks → base64 → frontend | WORKS |
| Transcription capture (input + output) | WORKS |
| Panel generation trigger via `GENERATE_PANEL:` token | WORKS |
| Imagen 4 image generation with style prompts | WORKS |
| Concurrent panel generation (`asyncio.gather`) | WORKS |
| Story upload + scene extraction | WORKS |
| In-memory session state | WORKS |

---

## CRITICAL: Tasks to Complete

### 1. Fix Audio Input (Priority: CRITICAL)

**Problem:** User speaks into mic, backend receives PCM chunks, but Gemini never responds. Text input works fine.

**Files:** `backend/main.py` (lines 276-286), `backend/agent.py` (lines 92-118)

**Debugging steps:**

1. **Add logging to confirm audio chunks arrive:**
   ```python
   elif "bytes" in message:
       logger.info(f"Received audio chunk: {len(message['bytes'])} bytes")
       await agent.send_audio(message["bytes"])
   ```

2. **Add logging to confirm `audio_turn_complete` is received:**
   ```python
   elif msg_type == "audio_turn_complete":
       logger.info("Audio turn complete — calling send_audio_end()")
       await agent.send_audio_end()
   ```

3. **Check `send_audio_end()` in agent.py:**
   ```python
   async def send_audio_end(self):
       logger.info("Sending ActivityEnd to Gemini")
       await self.session.send_realtime_input(activity_end=types.ActivityEnd())
   ```

4. **Verify Gemini receives audio and responds:**
   - In `on_agent_message()`, log every message type received from Gemini
   - After sending audio + ActivityEnd, Gemini should send back `server_content` with audio

**Likely root causes (in order of probability):**

1. **`send_audio_end()` not called or crashes silently** — The `audio_turn_complete` message handler may have an exception. Wrap in try/except with logging.

2. **PCM format mismatch** — Frontend sends 16kHz Int16 PCM. Verify `send_audio()` sends with correct MIME type:
   ```python
   async def send_audio(self, audio_data: bytes):
       blob = types.Blob(data=audio_data, mime_type="audio/pcm;rate=16000")
       await self.session.send_realtime_input(audio=blob)
   ```
   Make sure the Blob is created correctly (check google-genai SDK docs).

3. **Gemini session not ready** — The `_ready` Event might not be set before audio arrives. Check that `connect()` sets `_ready` after the session is established.

4. **Exception in the receive loop kills the connection** — If `on_agent_message()` throws, the `async for message in session.receive()` loop may exit silently. Wrap the callback in try/except.

**Acceptance criteria:** User speaks into mic → agent responds with voice + generates panels if appropriate.

---

### 2. Implement Proper Tool Calling (Priority: HIGH)

**Problem:** Panel generation uses string-matching on `GENERATE_PANEL:` tokens in transcription text. This is fragile — Gemini's transcription may split/mangle the token across chunks.

**Files:** `backend/agent.py`, `backend/main.py`

**What to do:**

Replace prompt-based token detection with Gemini's native function calling:

1. **Define tools in agent.py:**
   ```python
   from google.genai import types

   tools = [
       types.Tool(function_declarations=[
           types.FunctionDeclaration(
               name="generate_comic_panel",
               description="Generate a comic panel image from a visual description",
               parameters=types.Schema(
                   type="OBJECT",
                   properties={
                       "visual_description": types.Schema(
                           type="STRING",
                           description="Detailed visual description of the panel"
                       ),
                       "caption": types.Schema(
                           type="STRING",
                           description="Speech bubble text or narration for this panel"
                       ),
                   },
                   required=["visual_description", "caption"]
               )
           ),
           types.FunctionDeclaration(
               name="edit_existing_panel",
               description="Edit/regenerate an existing panel with new instructions",
               parameters=types.Schema(
                   type="OBJECT",
                   properties={
                       "panel_number": types.Schema(
                           type="INTEGER",
                           description="The panel number to edit"
                       ),
                       "new_description": types.Schema(
                           type="STRING",
                           description="New visual description for the panel"
                       ),
                   },
                   required=["panel_number", "new_description"]
               )
           ),
       ])
   ]
   ```

2. **Pass tools in LiveConnectConfig:**
   ```python
   config = types.LiveConnectConfig(
       system_instruction=system_instruction,
       response_modalities=["AUDIO"],
       tools=tools,
       ...
   )
   ```

3. **Handle tool calls in `on_agent_message()`:**
   ```python
   tool_call = getattr(sc, 'tool_call', None)
   if tool_call:
       for fc in tool_call.function_calls:
           if fc.name == "generate_comic_panel":
               # trigger image generation
               prompt = fc.args["visual_description"]
               caption = fc.args["caption"]
               # generate panel...
               # send function response back to Gemini:
               await session.send_tool_response(
                   function_responses=[types.FunctionResponse(
                       name="generate_comic_panel",
                       response={"status": "success", "panel_number": N}
                   )]
               )
           elif fc.name == "edit_existing_panel":
               # handle panel editing
   ```

4. **Remove the `GENERATE_PANEL:` string matching** from `flush_transcription()` once tool calling works.

**NOTE:** Check if `tools` param is supported in `LiveConnectConfig` for the live/streaming API. If not, keep the string-matching approach but make it more robust (normalize whitespace, case-insensitive matching — which you already partially do).

**Acceptance criteria:** Gemini calls `generate_comic_panel()` as a structured function call, not via string tokens.

---

### 3. Add Panel Edit Functionality (Priority: HIGH)

**Problem:** Users can't modify panels after generation. Once generated, panels are permanent.

**Files:** `backend/main.py`

**What to do:**

1. Add `edit_existing_panel` tool (see Task 2 above)
2. When Gemini calls `edit_existing_panel(panel_number, new_description)`:
   - Look up panel in `session_data["panels"]` by number
   - Re-generate with Imagen 4 using the new description
   - Send updated panel to frontend:
     ```python
     await websocket.send_json({
         "type": "panel_updated",  # NEW message type
         "panel_number": panel_number,
         "image": new_image_b64,
         "prompt": new_description,
         "text": caption,
     })
     ```
3. Tell Olamiposi about the new `panel_updated` message type so the frontend can replace the panel in the canvas.

**Acceptance criteria:** User says "make the hero's hair red in panel 3" → agent regenerates panel 3 and it updates on the canvas.

---

### 4. Add Firebase/Firestore Backend Persistence (Priority: MEDIUM)

**Problem:** Sessions are in-memory only. If backend restarts, all sessions are lost. Backend can't load previous projects.

**Files:** `backend/main.py` (new: add Firebase Admin SDK)

**What to do:**

1. **Install Firebase Admin SDK:**
   ```
   pip install firebase-admin
   ```

2. **Initialize in main.py:**
   ```python
   import firebase_admin
   from firebase_admin import credentials, firestore

   cred = credentials.ApplicationDefault()  # or cert file
   firebase_admin.initialize_app(cred)
   db = firestore.client()
   ```

3. **Save panels to Firestore as they're generated:**
   ```python
   # After successful image generation:
   db.collection("users").document(user_uid).collection("projects") \
     .document(project_id).collection("panels").document(str(panel_number)) \
     .set({
         "prompt": prompt,
         "caption": caption,
         "panel_number": panel_number,
         "style": style,
         "created_at": firestore.SERVER_TIMESTAMP,
     })
   ```
   (Store actual images in Cloud Storage, save URL in Firestore)

4. **Load project state on WebSocket connect:**
   - Accept `projectId` in WebSocket URL or initial message
   - Load panels from Firestore
   - Inject previous context into system instruction so Gemini knows what panels already exist

**Acceptance criteria:** Backend persists panels to Firestore. User can reconnect and resume a project.

---

### 5. Add Firebase Auth Token Verification (Priority: MEDIUM)

**Problem:** Backend doesn't verify who's connecting. Anyone with a session ID can access it.

**Files:** `backend/main.py`

**What to do:**

1. **Verify Firebase ID token on upload and WebSocket connect:**
   ```python
   from firebase_admin import auth

   async def verify_token(token: str) -> dict:
       decoded = auth.verify_id_token(token)
       return decoded  # contains uid, email, etc.
   ```

2. **Require Authorization header on /upload:**
   ```python
   @app.post("/upload")
   async def upload(file: UploadFile, authorization: str = Header(...)):
       token = authorization.replace("Bearer ", "")
       user = await verify_token(token)
       # use user["uid"] to namespace the session
   ```

3. **Require token in WebSocket handshake:**
   - Frontend sends token as query param: `/ws/session/{id}?token=...`
   - Backend verifies before accepting connection

**Acceptance criteria:** Only authenticated users can create sessions and connect via WebSocket.

---

### 6. Add WebSocket Heartbeat (Priority: LOW)

**Problem:** Long pauses (user thinking, Imagen generating) may cause WebSocket timeout.

**File:** `backend/main.py`

**What to do:**
```python
import asyncio

async def heartbeat(websocket):
    while True:
        await asyncio.sleep(30)
        try:
            await websocket.send_json({"type": "ping"})
        except:
            break

# In websocket handler:
heartbeat_task = asyncio.create_task(heartbeat(websocket))
try:
    # ... main loop ...
finally:
    heartbeat_task.cancel()
```

Frontend should handle `ping` messages silently (or respond with `pong`).

**Acceptance criteria:** WebSocket stays alive during long operations.

---

## File Reference

| File | Purpose |
|------|---------|
| `backend/main.py` | FastAPI app, WebSocket handler, panel trigger logic |
| `backend/agent.py` | GeminiAgent class, Live API connection, send methods |
| `backend/image_gen.py` | Imagen 4 integration, style prompts |
| `backend/processor.py` | PDF/DOCX text extraction, scene splitting |
| `backend/requirements.txt` | Python dependencies |
| `backend/.env` | API keys, project config |

---

## Coordination with Olamiposi (Frontend)

- **Audio input bug:** Debug together. Add logging on both sides. Frontend sends binary PCM + `audio_turn_complete` JSON. Backend should forward to Gemini + call `send_audio_end()`.
- **New message type `panel_updated`:** When you implement panel editing, tell Olamiposi so frontend can handle replacing a panel by `panel_number`.
- **New message type `panel_updated`:** Frontend will need to match on `panel_number` and swap the image.
- **Auth token:** Tell Olamiposi to send Firebase `idToken` in the Authorization header on upload and as a query param on WebSocket connect.
- **Project loading:** Accept `projectId` in WebSocket URL or initial message. Load prior panels from Firestore and inject into system instruction.
