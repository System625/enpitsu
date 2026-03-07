# Frontend Tasks - Olamiposi

## Status Summary

The frontend is ~65% complete. Text input works, audio playback works, panels display correctly, project persistence works. The major gaps are: **no continuous mic streaming**, **no real audio visualization**, **no background music during generation**, and **no WebSocket reconnection**.

---

## Current State: What Works

| Feature | Status |
|---------|--------|
| Push-to-Talk mic recording (16kHz PCM via AudioWorklet) | WORKS |
| Agent audio playback (PCM chunks via Web Audio API) | WORKS |
| Fallback browser TTS | WORKS |
| Panel display with loading skeletons | WORKS |
| Style-aware canvas grid (American, Manga, Manhwa, etc.) | WORKS |
| Interrupt button (sends `interrupt` message) | WORKS |
| Firebase Auth (Google + email/password) | WORKS |
| Project save/load (Firestore + Storage) | WORKS |
| Projects gallery page | WORKS |
| PDF export | WORKS |
| Animated orb (state-based colors) | WORKS (but no real audio data) |

---

## CRITICAL: Tasks to Complete

### 1. Fix Push-to-Talk / Enable Continuous Mic (Priority: CRITICAL)

**Problem:** Audio input doesn't trigger agent responses. Text works fine.

**Files:** `components/PushToTalkButton.tsx`, `app/hooks/useLiveAgent.tsx`

**Debugging steps:**
- Open browser DevTools Console while pressing the mic button
- Check Network tab: does `/pcm-processor.js` load (200 OK)?
- Add `console.log` in `sendAudioChunk()` to confirm binary chunks are being sent
- Add `console.log` before the `audio_turn_complete` JSON send to confirm it fires
- Check if `AudioContext` is created at 16kHz (must match backend expectation)

**Root cause candidates (coordinate with Sola):**
1. `pcm-processor.js` might 404 — verify it's in `frontend/public/`
2. AudioContext may be suspended (browser autoplay policy) — need user gesture first
3. Backend may not be calling `send_audio_end()` when it receives `audio_turn_complete`
4. Gemini may need additional config to accept audio input

**Acceptance criteria:** User holds mic button, speaks, releases — agent responds with voice.

---

### 2. Add Continuous Mic Option (Priority: HIGH)

**Problem:** Currently push-to-talk only. Acceptance criteria says "continuously streams without needing push-to-talk."

**File:** `components/PushToTalkButton.tsx`, `app/hooks/useLiveAgent.tsx`

**What to do:**
- Add a toggle: "Hold to Talk" vs "Open Mic" mode
- In Open Mic mode:
  - Start mic on WebSocket connect, stream PCM continuously
  - Add a mute/unmute toggle button (not hold-to-talk)
  - Gemini Live API handles VAD (voice activity detection) server-side — you don't need to detect silence yourself
  - Do NOT send `audio_turn_complete` in open mic mode — Gemini detects turn boundaries automatically
- Keep push-to-talk as fallback for noisy environments

**Acceptance criteria:** App connects and continuously streams mic audio. Mute toggle available.

---

### 3. Wire Real Audio Visualization (Priority: HIGH)

**Problem:** `useAudioVisualizer.ts` generates mock random data. `audioAnalyser` is always `null`. The orb never reacts to actual audio.

**Files:** `app/hooks/useAudioVisualizer.ts`, `components/AgentVisualizer.tsx`, `components/PushToTalkButton.tsx`, `app/hooks/useLiveAgent.tsx`

**What to do:**

**For mic input (user speaking):**
1. In `PushToTalkButton.tsx`, when creating `AudioContext` and `MediaStreamSource`:
   ```ts
   const analyser = ctx.createAnalyser();
   analyser.fftSize = 256;
   source.connect(analyser);
   analyser.connect(workletNode); // chain: source -> analyser -> worklet
   ```
2. Pass this `analyser` node up to context/state so `AgentVisualizer` can read it

**For agent output (agent speaking):**
1. In `useLiveAgent.tsx` `playPcmChunk()`, route audio through an AnalyserNode before destination:
   ```ts
   const analyser = audioCtx.createAnalyser();
   source.connect(analyser);
   analyser.connect(audioCtx.destination);
   ```
2. Store this analyser and pass it to `AgentVisualizer`

**In `AgentVisualizer.tsx`:**
- Use `analyser.getByteFrequencyData(dataArray)` in a `requestAnimationFrame` loop
- Compute average volume from frequency data
- Drive the orb scale/glow intensity from this real data

**Acceptance criteria:** Orb visually reacts to both user speech and agent speech in real-time.

---

### 4. Add "Working" State Background Music (Priority: MEDIUM)

**Problem:** No audio feedback while agent is generating images. User stares at loading skeleton in silence.

**File:** `app/hooks/useLiveAgent.tsx` (or create a new `useBackgroundAudio.ts` hook)

**What to do:**
1. Add a short looping lo-fi/ambient audio file to `public/` (e.g., `public/thinking-music.mp3`)
2. Create a simple hook or inline logic:
   ```ts
   const musicRef = useRef<HTMLAudioElement | null>(null);

   useEffect(() => {
     if (agentState === "thinking") {
       if (!musicRef.current) {
         musicRef.current = new Audio("/thinking-music.mp3");
         musicRef.current.loop = true;
         musicRef.current.volume = 0.15;
       }
       musicRef.current.play();
     } else {
       if (musicRef.current) {
         musicRef.current.pause();
         musicRef.current.currentTime = 0;
       }
     }
   }, [agentState]);
   ```
3. Fade in/out for polish (optional): ramp volume from 0 to 0.15 over 500ms

**Acceptance criteria:** Soft background music plays when agent is thinking/generating. Fades out when done.

---

### 5. Add WebSocket Reconnection (Priority: MEDIUM)

**Problem:** If WebSocket drops mid-conversation, the app silently breaks. No retry.

**File:** `app/hooks/useLiveAgent.tsx`

**What to do:**
1. In `ws.onclose` handler, implement exponential backoff retry:
   ```ts
   ws.onclose = (event) => {
     if (!event.wasClean && reconnectAttemptsRef.current < 5) {
       const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 16000);
       setTimeout(() => {
         reconnectAttemptsRef.current++;
         connectWebSocket(sessionId);
       }, delay);
     }
   };
   ```
2. Show a toast/banner: "Connection lost. Reconnecting..."
3. On successful reconnect, re-send `style_update` message
4. Reset `reconnectAttemptsRef` on successful open

**Acceptance criteria:** WebSocket auto-reconnects on disconnect with user-visible status.

---

### 6. True Barge-In (Priority: LOW - nice to have)

**Problem:** Current interrupt is a hard stop (button click). True barge-in means user starts speaking and agent stops automatically.

**What to do (if time permits):**
- In continuous mic mode, if agent is in "speaking" state and mic detects voice activity, auto-send `interrupt` message
- This requires the continuous mic (Task 2) to be working first
- Gemini Live API supports this natively — when it receives new audio input while outputting, it stops

**Acceptance criteria:** User speaks over agent, agent stops talking and listens.

---

## File Reference

| File | Purpose |
|------|---------|
| `app/hooks/useLiveAgent.tsx` | Main agent state, WebSocket, audio playback |
| `app/hooks/useAudioVisualizer.ts` | Audio frequency data (currently mock) |
| `app/hooks/useProjects.ts` | Firestore project persistence |
| `app/hooks/useAuth.tsx` | Firebase auth |
| `components/PushToTalkButton.tsx` | Mic capture, AudioWorklet |
| `components/AgentVisualizer.tsx` | Animated orb |
| `components/AgentControlCenter.tsx` | Sidebar layout |
| `components/ComicCanvas.tsx` | Panel grid |
| `components/ComicPanel.tsx` | Single panel display |
| `public/pcm-processor.js` | AudioWorklet PCM processor |

---

## Coordination with Sola (Backend)

- **Audio input bug:** You both need to debug this together. Frontend sends binary PCM + `audio_turn_complete` JSON. Backend should forward to Gemini + call `send_audio_end()`. Add logging on both sides.
- **Panel editing:** Once Sola adds `edit_existing_panel` tool, you'll need to handle a new message type (e.g., `panel_updated`) that replaces an existing panel by `panel_number`.
- **Project loading:** Once Sola adds Firestore backend persistence, you may need to send `projectId` during WebSocket connect so backend can load prior context.
