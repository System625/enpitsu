"use client";

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import { createProject, saveProject, loadProject } from "./useProjects";
import { useAuth } from "./useAuth";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

/** Play a chunk of base64-encoded PCM audio through the Web Audio API, queued sequentially. */
let _nextPlayTime = 0;
let _activeSources: AudioBufferSourceNode[] = [];

function clearPcmQueue(): void {
  _nextPlayTime = 0;
  const toStop = _activeSources.splice(0);
  for (const src of toStop) {
    try { src.stop(); } catch { /* already stopped */ }
  }
}

function playPcmChunk(base64Data: string, mimeType: string, audioCtx: AudioContext, analyser: AnalyserNode | null): void {
  try {
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const rateMatch = mimeType.match(/rate=(\d+)/);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;

    // Raw PCM is Int16 little-endian
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768.0;

    const buffer = audioCtx.createBuffer(1, float32.length, sampleRate);
    buffer.copyToChannel(float32, 0);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    if (analyser) {
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
    } else {
      source.connect(audioCtx.destination);
    }

    // Schedule this chunk to start after the previous one finishes
    const startAt = Math.max(audioCtx.currentTime, _nextPlayTime);
    source.start(startAt);
    _nextPlayTime = startAt + buffer.duration;
    _activeSources.push(source);
    source.onended = () => {
      _activeSources = _activeSources.filter(s => s !== source);
    };
  } catch (e) {
    console.error("PCM playback error:", e);
  }
}

export type ComicStyle = "american" | "manga" | "franco_belgian" | "manhwa" | "manhua";

export type AgentState = "idle" | "listening" | "thinking" | "speaking";

export interface ComicPanel {
  id: string;
  imageUrl: string;
  text: string;
  index: number;
  loading?: boolean;
}

export type MicMode = "push-to-talk" | "open-mic";

export interface LineUpdate {
  old: string;
  new: string;
}

interface LiveAgentContextType {
  agentState: AgentState;
  panels: ComicPanel[];
  currentStyle: ComicStyle | null;
  isRecording: boolean;
  audioAnalyser: AnalyserNode | null;
  setAudioAnalyser: (analyser: AnalyserNode | null) => void;
  projectName: string;
  currentProjectId: string;
  storyLoaded: boolean;
  storyText: string;
  pendingHighlight: LineUpdate | null;
  connectionStatus: "connected" | "reconnecting" | "disconnected" | null;
  micMode: MicMode;
  isMuted: boolean;
  setMicMode: (mode: MicMode) => void;
  setIsMuted: (muted: boolean) => void;
  setAgentState: (state: AgentState) => void;
  setCurrentStyle: (style: ComicStyle | null) => void;
  setProjectName: (name: string) => void;
  startRecording: () => void;
  stopRecording: (userText?: string) => void;
  sendAudioChunk: (pcmBytes: ArrayBuffer) => void;
  interruptAgent: () => void;
  uploadStory: (file: File) => void;
  saveCurrentProject: () => void;
  loadProjectById: (id: string) => Promise<void>;
  exportProjectAsZip: () => Promise<void>;
}

const LiveAgentContext = createContext<LiveAgentContextType | null>(null);



export function LiveAgentProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [panels, setPanels] = useState<ComicPanel[]>([]);
  const [currentStyle, setCurrentStyle] = useState<ComicStyle | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [audioAnalyser, setAudioAnalyser] = useState<AnalyserNode | null>(null);
  const [projectName, setProjectName] = useState("Untitled Story");
  const playbackAnalyserRef = useRef<AnalyserNode | null>(null);
  const [currentProjectId, setCurrentProjectId] = useState<string>(() =>
    createProject("Untitled Story", "american").id
  );

  const [storyLoaded, setStoryLoaded] = useState(false);
  const [storyText, setStoryText] = useState("");
  const [pendingHighlight, setPendingHighlight] = useState<LineUpdate | null>(null);
  const [micMode, setMicMode] = useState<MicMode>("push-to-talk");
  const [isMuted, setIsMuted] = useState(false);

  // Music refs for play_music tool
  const bgMusicRef = useRef<HTMLAudioElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Lazy-created AudioContext for PCM playback — only created on first agent_audio message
  const audioContextRef = useRef<AudioContext | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUserTextRef = useRef<string>("");
  const reconnectAttemptsRef = useRef<number>(0);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "reconnecting" | "disconnected" | null>(null);

  // Background music during "thinking" state OR while panels are loading
  const thinkingMusicRef = useRef<HTMLAudioElement | null>(null);
  const hasLoadingPanels = panels.some(p => p.loading);
  const shouldPlayMusic = agentState === "thinking" || hasLoadingPanels;

  useEffect(() => {
    if (shouldPlayMusic) {
      if (!thinkingMusicRef.current) {
        thinkingMusicRef.current = new Audio("/thinking-music.wav");
        thinkingMusicRef.current.loop = true;
        thinkingMusicRef.current.volume = 0;
      }
      const music = thinkingMusicRef.current;
      console.debug("[music] shouldPlayMusic=true, playing. paused:", music.paused, "vol:", music.volume);
      music.play().then(() => {
        console.debug("[music] play() succeeded");
      }).catch((e) => {
        console.warn("[music] play() blocked:", e.message);
      });
      // Fade in to 0.4 (audible)
      let vol = music.volume;
      const fadeIn = setInterval(() => {
        vol = Math.min(vol + 0.03, 0.4);
        music.volume = vol;
        if (vol >= 0.4) clearInterval(fadeIn);
      }, 50);
      return () => clearInterval(fadeIn);
    } else if (thinkingMusicRef.current) {
      const music = thinkingMusicRef.current;
      console.debug("[music] shouldPlayMusic=false, fading out");
      // Fade out
      let vol = music.volume;
      const fadeOut = setInterval(() => {
        vol = Math.max(vol - 0.03, 0);
        music.volume = vol;
        if (vol <= 0) {
          clearInterval(fadeOut);
          music.pause();
          music.currentTime = 0;
        }
      }, 50);
      return () => clearInterval(fadeOut);
    }
  }, [shouldPlayMusic]);

  const connectWebSocket = useCallback(async (sessionId: string) => {
    const wsUrl = BACKEND_URL.replace(/^http/, "ws");
    let tokenParam = "";
    if (user) {
      try {
        const idToken = await user.getIdToken();
        tokenParam = `?token=${encodeURIComponent(idToken)}`;
      } catch { /* guest mode */ }
    }
    const ws = new WebSocket(`${wsUrl}/ws/session/${sessionId}${tokenParam}`);
    wsRef.current = ws;
    sessionIdRef.current = sessionId;
    // Reset playback state but KEEP the AudioContext if it's already running —
    // closing it would require a new user gesture to resume (autoplay policy).
    playbackAnalyserRef.current = null;
    setAudioAnalyser(null);
    clearPcmQueue(); // also resets _nextPlayTime

    ws.onopen = () => {
      console.log("WebSocket connected for session:", sessionId);
      const isFirstConnect = reconnectAttemptsRef.current === 0;
      reconnectAttemptsRef.current = 0;
      setConnectionStatus("connected");
      // Sync the current style if user has already picked one
      if (currentStyle) {
        ws.send(JSON.stringify({ type: "style_update", style: currentStyle }));
      }
      // Session is active — show "listening" state (agent is ready for conversation)
      setAgentState("thinking"); // will switch to speaking/listening when greeting arrives
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);

        // Heartbeat — ignore silently
        if (msg.type === "ping") return;

        // Clear thinking timeout on any response from backend
        if (thinkingTimerRef.current) { clearTimeout(thinkingTimerRef.current); thinkingTimerRef.current = null; }

        // Story text pushed from backend on connect
        if (msg.type === "push_story") {
          setStoryText(msg.text ?? "");
        }

        // Gemini updated a line in the story
        if (msg.type === "update_line") {
          setStoryText(prev => {
            if (msg.old && prev.includes(msg.old)) {
              return prev.replace(msg.old, msg.new);
            }
            return prev;
          });
          setPendingHighlight({ old: msg.old, new: msg.new });
          // Clear highlight after editor has had time to flash it
          setTimeout(() => setPendingHighlight(null), 4000);
        }

        // Background music control from Gemini
        if (msg.type === "play_music") {
          try {
            if (!bgMusicRef.current) {
              bgMusicRef.current = new Audio("/thinking-music.wav");
              bgMusicRef.current.loop = true;
            }
            bgMusicRef.current.volume = 0.3;
            bgMusicRef.current.play().catch(() => {});
            console.debug("[music] play_music tool:", msg.music_type);
          } catch (e) {
            console.warn("[music] play error:", e);
          }
        }

        if (msg.type === "stop_music") {
          if (bgMusicRef.current) {
            bgMusicRef.current.pause();
            bgMusicRef.current.currentTime = 0;
          }
        }

        if (msg.type === "panel_loading") {
          // Add a loading skeleton — deduplicate in case backend reconnects and resends
          setPanels(prev => {
            const skeletonId = `loading_panel_${msg.panel_number}`;
            if (prev.some(p => p.id === skeletonId)) return prev;
            return [...prev, {
              id: skeletonId,
              imageUrl: "",
              text: msg.caption ?? "",
              index: prev.length,
              loading: true,
            }];
          });
        }

        if (msg.type === "panel_generated") {
          // Replace the loading skeleton for this panel number, or append if not found
          setPanels(prev => {
            const skeletonId = `loading_panel_${msg.panel_number}`;
            const skeletonIdx = prev.findIndex(p => p.id === skeletonId);
            const newPanel = {
              id: `ws_panel_${Date.now()}_${skeletonIdx >= 0 ? skeletonIdx : prev.length}`,
              imageUrl: `data:image/jpeg;base64,${msg.image}`,
              text: msg.text ?? "",
              index: skeletonIdx >= 0 ? skeletonIdx : prev.length,
              loading: false,
            };
            if (skeletonIdx >= 0) {
              const updated = [...prev];
              updated[skeletonIdx] = newPanel;
              return updated;
            }
            return [...prev, newPanel];
          });
        }

        if (msg.type === "agent_response") {
          // Transcript notification — PCM audio drives actual playback timing
          setAgentState("speaking");
        }

        if (msg.type === "interrupted") {
          // Gemini interrupted — clear the PCM audio queue immediately so old audio doesn't play over new response
          clearPcmQueue();
          window.speechSynthesis?.cancel();
          if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
          setAgentState("listening");
        }

        if (msg.type === "agent_audio") {
          // Agent is speaking — stop background music
          if (bgMusicRef.current && !bgMusicRef.current.paused) {
            bgMusicRef.current.pause();
            bgMusicRef.current.currentTime = 0;
          }
          setAgentState("speaking");
          if (speakingTimerRef.current) clearTimeout(speakingTimerRef.current);
          if (msg.audio) {
            // Lazily create AudioContext on first audio message (avoids autoplay policy issues)
            if (!audioContextRef.current) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
              audioContextRef.current = new AudioCtx();
            }
            const ctx = audioContextRef.current;
            if (ctx.state === "suspended") ctx.resume().catch(() => {});
            // Create playback analyser for visualization
            if (!playbackAnalyserRef.current) {
              playbackAnalyserRef.current = ctx.createAnalyser();
              playbackAnalyserRef.current.fftSize = 256;
              setAudioAnalyser(playbackAnalyserRef.current);
            }
            playPcmChunk(msg.audio, msg.mime_type ?? "audio/pcm;rate=24000", ctx, playbackAnalyserRef.current);
            // After audio finishes playing, go to "listening" (not idle) —
            // the session is still active, agent is waiting for the user's next turn
            speakingTimerRef.current = setTimeout(
              () => setAgentState("listening"),
              Math.max(0, (_nextPlayTime - ctx.currentTime) * 1000) + 300,
            );
          }
        }

        if (msg.type === "status_update") {
          if (msg.status === "generating" || msg.status === "thinking") {
            setAgentState("thinking");
          }
          // Ignore "idle" from backend — we use audio playback state to
          // drive UI transitions (speaking → listening). The agent stays
          // in "listening" between turns, never "idle" during a session.
        }

        // Panel editing: replace an existing panel by panel_number (1-based)
        if (msg.type === "panel_updated") {
          const targetIndex = msg.panel_number - 1; // Convert 1-based to 0-based
          setPanels(prev => prev.map((p, i) => {
            if (i === targetIndex) {
              return {
                ...p,
                imageUrl: `data:image/jpeg;base64,${msg.image}`,
                text: msg.text ?? p.text,
                loading: false,
              };
            }
            return p;
          }));
        }

        // Clear all panels — user wants to start fresh
        if (msg.type === "panels_cleared") {
          setPanels([]);
        }

        // Panel generation failed — remove loading skeleton
        if (msg.type === "panel_failed") {
          setPanels(prev => prev.filter(p => p.id !== `loading_panel_${msg.panel_number}`));
        }

        if (msg.type === "error") {
          console.error("Backend error:", msg.message);
          setAgentState("idle");
        }
      } catch (e) {
        console.error("WS message parse error:", e);
      }
    };

    ws.onerror = (e) => console.error("WebSocket error:", e);

    ws.onclose = (event) => {
      console.log("WebSocket closed for session:", sessionId, "code:", event.code);
      wsRef.current = null;
      // Stop recording to prevent endless "WebSocket not open" warnings
      setIsRecording(false);
      setAgentState("idle");
      // Auto-reconnect with exponential backoff (up to 5 attempts)
      if (!event.wasClean && reconnectAttemptsRef.current < 5) {
        setConnectionStatus("reconnecting");
        const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 16000);
        console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current + 1}/5)...`);
        setTimeout(() => {
          reconnectAttemptsRef.current++;
          connectWebSocket(sessionId);
        }, delay);
      } else if (reconnectAttemptsRef.current >= 5) {
        setConnectionStatus("disconnected");
      }
    };
  }, [user]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      // Dispose thinking music on unmount
      if (thinkingMusicRef.current) {
        thinkingMusicRef.current.pause();
        thinkingMusicRef.current.src = "";
        thinkingMusicRef.current = null;
      }
      // Dispose background music on unmount
      if (bgMusicRef.current) {
        bgMusicRef.current.pause();
        bgMusicRef.current.src = "";
        bgMusicRef.current = null;
      }
      clearPcmQueue();
    };
  }, []);

  // Auto-save to Firestore/Storage on panel changes (debounced)
  useEffect(() => {
    if (!user || panels.length === 0) return;
    // Only save panels that are fully loaded with a real image URL
    const saveable = panels.filter(p => !p.loading && p.imageUrl && p.imageUrl.length > 0);
    if (saveable.length === 0) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      saveProject(user.uid, {
        id: currentProjectId,
        name: projectName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        style: currentStyle ?? "american",
        panels: saveable,
      }).catch(err => console.error("Auto-save failed:", err));
    }, 1000);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels]);

  const clearSpeakingTimer = useCallback(() => {
    if (speakingTimerRef.current) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
  }, []);

  const sendAudioChunk = useCallback((pcmBytes: ArrayBuffer) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(pcmBytes);
    }
    // Silently drop chunks when WS is not open — no need to spam console
  }, []);

  const startRecording = useCallback(() => {
    setIsRecording(true);
    setAgentState("listening");
  }, []);

  const stopRecording = useCallback((userText?: string) => {
    setIsRecording(false);

    const text = userText ?? pendingUserTextRef.current ?? "";
    pendingUserTextRef.current = "";

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setAgentState("idle");
      return;
    }

    setAgentState("thinking");

    // Safety timeout: if backend doesn't respond in 30s, go back to listening
    if (thinkingTimerRef.current) clearTimeout(thinkingTimerRef.current);
    thinkingTimerRef.current = setTimeout(() => setAgentState("listening"), 30000);

    if (text) {
      // Text input path (typed prompt or SpeechRecognition fallback)
      console.debug("[audio] Sending text message:", text.slice(0, 50));
      wsRef.current.send(JSON.stringify({ type: "user_message", text }));
    } else {
      // PCM audio path — signal end of user's audio turn
      console.debug("[audio] Sending audio_turn_complete");
      wsRef.current.send(JSON.stringify({ type: "audio_turn_complete" }));
    }
  }, []);

  const uploadStory = useCallback(async (file: File) => {
    setAgentState("thinking");
    const nameFromFile = file.name.replace(/\.[^.]+$/, "");
    setProjectName(nameFromFile);

    // Pre-create the AudioContext during this user gesture (click/drop) so
    // the browser allows audio playback for the greeting. If we wait until
    // the first agent_audio message, the AudioContext starts suspended and
    // autoplay policy blocks it.
    if (!audioContextRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      audioContextRef.current = new AudioCtx();
    }
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume().catch(() => {});
    }

    // Pre-create thinking music during user gesture to bypass autoplay policy
    if (!thinkingMusicRef.current) {
      thinkingMusicRef.current = new Audio("/thinking-music.wav");
      thinkingMusicRef.current.loop = true;
      thinkingMusicRef.current.volume = 0;
    }
    // Unlock audio element with a silent play during user gesture
    thinkingMusicRef.current.play().catch(() => {});

    try {
      const formData = new FormData();
      formData.append("file", file);
      const headers: Record<string, string> = {};
      if (user) {
        try {
          const idToken = await user.getIdToken();
          headers["Authorization"] = `Bearer ${idToken}`;
        } catch { /* guest mode — no token */ }
      }
      const res = await fetch(`${BACKEND_URL}/upload`, { method: "POST", body: formData, headers });

      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);

      const { session_id, scene_count, filename } = await res.json();

      // Use backend filename to set project name
      const title = (filename as string).replace(/\.[^.]+$/, "");
      setProjectName(title);
      setStoryLoaded(true);

      connectWebSocket(session_id);
      setAgentState("thinking");
    } catch (err) {
      console.error("Upload error:", err);
      setAgentState("idle");
    }
  }, [connectWebSocket, user]);

  const interruptAgent = useCallback(() => {
    clearPcmQueue();
    window.speechSynthesis?.cancel();
    clearSpeakingTimer();
    setAgentState("idle");
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
  }, [clearSpeakingTimer]);

  const saveCurrentProject = useCallback(() => {
    if (!user) return;
    saveProject(user.uid, {
      id: currentProjectId,
      name: projectName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      style: currentStyle ?? "american",
      panels,
    }).catch(err => console.error("Save failed:", err));
  }, [user, currentProjectId, projectName, currentStyle, panels]);

  const loadProjectById = useCallback(async (id: string) => {
    if (!user) return;
    const project = await loadProject(user.uid, id);
    if (!project) return;
    setCurrentProjectId(project.id);
    setProjectName(project.name);
    setCurrentStyle(project.style);
    setPanels(project.panels);
  }, [user]);

  const exportProjectAsZip = useCallback(async () => {
    const { jsPDF } = await import("jspdf");

    const singleCol = currentStyle === "manhwa" || currentStyle === "manga";
    const PAGE_W = 210;
    const PAGE_H = 297;
    const MARGIN = 6;
    const GUTTER = 4;

    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

    const dataUrls: string[] = await Promise.all(
      panels.map(async (panel) => {
        try {
          const res = await fetch(panel.imageUrl);
          const blob = await res.blob();
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        } catch {
          return "";
        }
      })
    );

    const panelW = singleCol
      ? PAGE_W - MARGIN * 2
      : (PAGE_W - MARGIN * 2 - GUTTER) / 2;
    const panelH = singleCol
      ? PAGE_H - MARGIN * 2
      : (PAGE_H - MARGIN * 2 - GUTTER) / 2;

    // Cover page
    pdf.setFillColor(10, 10, 10);
    pdf.rect(0, 0, PAGE_W, PAGE_H, "F");
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(28);
    pdf.setFont("helvetica", "bold");
    const titleLines = pdf.splitTextToSize(projectName, PAGE_W - 20);
    pdf.text(titleLines, PAGE_W / 2, PAGE_H / 2, { align: "center" });
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.text(`${panels.length} panels`, PAGE_W / 2, PAGE_H / 2 + 20, { align: "center" });

    // Helper: draw a speech-bubble caption overlaid on the bottom of a panel
    const drawCaption = (
      caption: string,
      px: number,
      py: number,
      pw: number,
      ph: number,
      fontSize: number,
      maxChars: number,
    ) => {
      if (!caption) return;
      const capped = caption.length > maxChars ? caption.slice(0, maxChars - 3) + "…" : caption;
      pdf.setFontSize(fontSize);
      pdf.setFont("helvetica", "bold");
      const lines: string[] = pdf.splitTextToSize(capped, pw - 10);
      const lineH = fontSize * 0.45;
      const bubbleH = lines.length * lineH + 6;
      const bubbleW = Math.min(pw - 8, pw * 0.85);
      const bubbleX = px + (pw - bubbleW) / 2;
      const bubbleY = py + ph - bubbleH - 6;

      // White rounded bubble with dark border
      pdf.setFillColor(255, 255, 255);
      pdf.setDrawColor(30, 30, 30);
      pdf.setLineWidth(0.6);
      pdf.roundedRect(bubbleX, bubbleY, bubbleW, bubbleH, 3, 3, "FD");

      // Text centered inside bubble
      pdf.setTextColor(20, 20, 20);
      const textX = bubbleX + bubbleW / 2;
      const textY = bubbleY + 4;
      for (let l = 0; l < lines.length; l++) {
        pdf.text(lines[l], textX, textY + l * lineH, { align: "center" });
      }
    };

    if (singleCol) {
      dataUrls.forEach((dataUrl, i) => {
        pdf.addPage();
        pdf.setFillColor(15, 15, 15);
        pdf.rect(0, 0, PAGE_W, PAGE_H, "F");
        if (dataUrl) {
          pdf.addImage(dataUrl, "JPEG", MARGIN, MARGIN, panelW, panelH);
        }
        drawCaption(panels[i]?.text ?? "", MARGIN, MARGIN, panelW, panelH, 9, 120);
      });
    } else {
      const positions = [
        { x: MARGIN, y: MARGIN },
        { x: MARGIN + panelW + GUTTER, y: MARGIN },
        { x: MARGIN, y: MARGIN + panelH + GUTTER },
        { x: MARGIN + panelW + GUTTER, y: MARGIN + panelH + GUTTER },
      ];

      for (let i = 0; i < dataUrls.length; i++) {
        if (i % 4 === 0) {
          pdf.addPage();
          pdf.setFillColor(15, 15, 15);
          pdf.rect(0, 0, PAGE_W, PAGE_H, "F");
        }
        const pos = positions[i % 4];
        if (dataUrls[i]) {
          pdf.addImage(dataUrls[i], "JPEG", pos.x, pos.y, panelW, panelH);
        }
        pdf.setDrawColor(80, 80, 80);
        pdf.setLineWidth(0.5);
        pdf.rect(pos.x, pos.y, panelW, panelH);
        drawCaption(panels[i]?.text ?? "", pos.x, pos.y, panelW, panelH, 7, 80);
      }
    }

    pdf.save(`${projectName}.pdf`);
  }, [panels, projectName, currentStyle]);

  useEffect(() => {
    if (currentStyle && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "style_update", style: currentStyle }));
    }
  }, [currentStyle]);

  return (
    <LiveAgentContext.Provider
      value={{
        agentState,
        panels,
        currentStyle,
        isRecording,
        audioAnalyser,
        setAudioAnalyser,
        projectName,
        currentProjectId,
        storyLoaded,
        storyText,
        pendingHighlight,
        connectionStatus,
        micMode,
        isMuted,
        setMicMode,
        setIsMuted,
        setAgentState,
        setCurrentStyle,
        setProjectName,
        startRecording,
        stopRecording,
        sendAudioChunk,
        interruptAgent,
        uploadStory,
        saveCurrentProject,
        loadProjectById,
        exportProjectAsZip,
      }}
    >
      {children}
    </LiveAgentContext.Provider>
  );
}

export function useLiveAgent() {
  const context = useContext(LiveAgentContext);
  if (!context) {
    throw new Error("useLiveAgent must be used within a LiveAgentProvider");
  }
  return context;
}
