"use client";

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import { createProject, saveProject, loadProject } from "./useProjects";
import { useAuth } from "./useAuth";
import {
  LiveKitRoom,
  useVoiceAssistant,
  useDataChannel,
  useRoomContext,
  useLocalParticipant,
  RoomAudioRenderer,
} from "@livekit/components-react";
import { Track } from "livekit-client";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "wss://enpitsu-livekit.example.livekit.cloud";

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

export interface ChatMessage {
  role: "user" | "agent";
  text: string;
  timestamp: number;
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
  messages: ChatMessage[];
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
  startSession: () => void;
  saveCurrentProject: () => void;
  loadProjectById: (id: string) => Promise<void>;
  exportProjectAsZip: () => Promise<void>;
}

const LiveAgentContext = createContext<LiveAgentContextType | null>(null);

export function LiveAgentProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [token, setToken] = useState<string>("");
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [panels, setPanels] = useState<ComicPanel[]>([]);
  const [currentStyle, setCurrentStyle] = useState<ComicStyle | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [audioAnalyser, setAudioAnalyser] = useState<AnalyserNode | null>(null);
  const [projectName, setProjectName] = useState("Untitled Story");
  
  const [currentProjectId, setCurrentProjectId] = useState<string>(() =>
    createProject("Untitled Story", "american").id
  );

  const [storyLoaded, setStoryLoaded] = useState(false);
  const [storyText, setStoryText] = useState("");
  const [pendingHighlight, setPendingHighlight] = useState<LineUpdate | null>(null);
  const [micMode, setMicMode] = useState<MicMode>("push-to-talk");
  const [isMuted, setIsMuted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<"connected" | "reconnecting" | "disconnected" | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const sendDataRef = useRef<(data: any) => void>(() => {});

  // Expose these methods to inner component
  const syncState = {
    setAgentState,
    setStoryText,
    setPendingHighlight,
    setCurrentStyle,
    setPanels,
    setMessages,
    setConnectionStatus,
    setIsRecording,
  };

  const startSession = useCallback(async () => {
    try {
      setAgentState("thinking");
      const headers: Record<string, string> = {};
      if (user) {
        try {
          const idToken = await user.getIdToken();
          headers["Authorization"] = `Bearer ${idToken}`;
        } catch { /* guest */ }
      }
      const res = await fetch(`${BACKEND_URL}/session/new`, { method: "POST", headers });
      if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
      const { session_id } = await res.json();
      sessionIdRef.current = session_id;
      
      const tokenRes = await fetch(`${BACKEND_URL}/livekit/token?session_id=${session_id}`, { method: "POST", headers });
      if (!tokenRes.ok) throw new Error("Failed to get LiveKit token");
      const { token } = await tokenRes.json();
      setToken(token);
    } catch (err) {
      console.error("startSession error:", err);
      setAgentState("idle");
    }
  }, [user]);

  const uploadStory = useCallback(async (file: File) => {
    setAgentState("thinking");
    const nameFromFile = file.name.replace(/\.[^.]+$/, "");
    setProjectName(nameFromFile);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const headers: Record<string, string> = {};
      if (user) {
        try {
          const idToken = await user.getIdToken();
          headers["Authorization"] = `Bearer ${idToken}`;
        } catch {}
      }
      if (sessionIdRef.current) {
        headers["X-Session-Id"] = sessionIdRef.current;
      }
      const res = await fetch(`${BACKEND_URL}/upload`, { method: "POST", body: formData, headers });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const { session_id, filename, reused_session } = await res.json();
      
      const title = (filename as string).replace(/\.[^.]+$/, "");
      setProjectName(title);
      setStoryLoaded(true);

      if (!reused_session) {
        sessionIdRef.current = session_id;
        const tokenRes = await fetch(`${BACKEND_URL}/livekit/token?session_id=${session_id}`, { method: "POST", headers });
        if (!tokenRes.ok) throw new Error("Failed to get LiveKit token");
        const { token } = await tokenRes.json();
        setToken(token);
      } else {
        // If reusing session, trigger an update manually if needed (not supported easily over livekit yet)
      }
    } catch (err) {
      console.error("Upload error:", err);
      setAgentState("idle");
    }
  }, [user]);

  // Methods passed as stub because LiveKit handles actual mic
  const startRecording = useCallback(() => setIsRecording(true), []);
  const stopRecording = useCallback((userText?: string) => {
    setIsRecording(false);
    if (userText) {
      sendDataRef.current({ type: "user_message", text: userText });
      setMessages(prev => [...prev, { role: "user", text: userText, timestamp: Date.now() }]);
    }
  }, []);
  
  const sendAudioChunk = useCallback(() => {}, []);
  const interruptAgent = useCallback(() => {
    // Basic interrupt: send an empty message or explicit interrupt to the backend if supported,
    // though LiveKit agents natively interrupt on user speech.
    sendDataRef.current({ type: "interrupt" });
  }, []); 

  const handleSetCurrentStyle = useCallback((style: ComicStyle | null) => {
    setCurrentStyle(style);
    if (style) {
      sendDataRef.current({ type: "style_update", style });
    }
  }, []);

  const saveCurrentProject = useCallback(() => {}, []);
  const loadProjectById = useCallback(async (id: string) => {}, []);
  const exportProjectAsZip = useCallback(async () => {}, []);

  return (
    <LiveAgentContext.Provider
      value={{
        agentState, panels, currentStyle, isRecording, audioAnalyser, setAudioAnalyser,
        projectName, currentProjectId, storyLoaded, storyText, pendingHighlight,
        connectionStatus, micMode, isMuted, messages,
        setMicMode, setIsMuted, setAgentState, setCurrentStyle: handleSetCurrentStyle, setProjectName,
        startRecording, stopRecording, sendAudioChunk, interruptAgent, uploadStory,
        startSession, saveCurrentProject, loadProjectById, exportProjectAsZip,
      }}
    >
      <LiveKitRoom
        serverUrl={LIVEKIT_URL}
        token={token}
        connect={!!token}
        audio={true}
      >
        {token && <LiveKitManager sync={syncState} isMuted={isMuted} micMode={micMode} isRecording={isRecording} sendDataRef={sendDataRef} />}
        <RoomAudioRenderer />
        {children}
      </LiveKitRoom>
    </LiveAgentContext.Provider>
  );
}

// Internal component to use LiveKit hooks and sync state to context
function LiveKitManager({ sync, isMuted, micMode, isRecording, sendDataRef }: any) {
  const room = useRoomContext();
  const { state: vaState, audioTrack } = useVoiceAssistant();
  const { localParticipant } = useLocalParticipant();

  // Map LiveKit VA state to our AgentState
  useEffect(() => {
    switch (vaState) {
      case "listening": sync.setAgentState("listening"); break;
      case "speaking": sync.setAgentState("speaking"); break;
      case "thinking": sync.setAgentState("thinking"); break;
      default: sync.setAgentState("idle"); break;
    }
  }, [vaState, sync]);

  useEffect(() => {
    sync.setConnectionStatus(room ? "connected" : "disconnected");
  }, [room, sync]);

  // Control local mic based on micMode and isMuted/isRecording
  useEffect(() => {
    if (!room) return;
    const shouldMicBeOn = micMode === "open-mic" ? !isMuted : isRecording;
    room.localParticipant.setMicrophoneEnabled(shouldMicBeOn);
  }, [room, isMuted, isRecording, micMode]);

  // Listen to Data Channel messages
  const { send } = useDataChannel((msg) => {
    const payload = new TextDecoder().decode(msg.payload);
    try {
      const data = JSON.parse(payload);
      if (data.type === "push_story") {
        sync.setStoryText(data.text);
      } else if (data.type === "update_line") {
        sync.setStoryText((prev: string) => prev.includes(data.old) ? prev.replace(data.old, data.new) : prev);
        sync.setPendingHighlight({ old: data.old, new: data.new });
        setTimeout(() => sync.setPendingHighlight(null), 4000);
      } else if (data.type === "style_update") {
        sync.setCurrentStyle(data.style);
      } else if (data.type === "panel_loading") {
        sync.setPanels((prev: ComicPanel[]) => {
          const id = `loading_panel_${data.panel_number}`;
          if (prev.some(p => p.id === id)) return prev;
          return [...prev, { id, imageUrl: "", text: data.caption ?? "", index: prev.length, loading: true }];
        });
      } else if (data.type === "panel_generated") {
        sync.setPanels((prev: ComicPanel[]) => {
          const loadingId = `loading_panel_${data.panel_number}`;
          const loadingIdx = prev.findIndex(p => p.id === loadingId);
          const newPanel = {
            id: `ws_panel_${Date.now()}`,
            imageUrl: `data:image/jpeg;base64,${data.image}`,
            text: data.text ?? "",
            index: loadingIdx >= 0 ? loadingIdx : prev.length,
            loading: false,
          };
          if (loadingIdx >= 0) {
            const updated = [...prev];
            updated[loadingIdx] = newPanel;
            return updated;
          }
          return [...prev, newPanel];
        });
      } else if (data.type === "agent_response") {
        sync.setMessages((prev: ChatMessage[]) => [...prev, { role: "agent", text: data.text, timestamp: Date.now() }]);
      } else if (data.type === "panel_updated") {
        sync.setPanels((prev: ComicPanel[]) => prev.map((p, i) => i === data.panel_number - 1 ? {
          ...p, imageUrl: `data:image/jpeg;base64,${data.image}`, text: data.text ?? p.text, loading: false
        } : p));
      } else if (data.type === "panels_cleared") {
        sync.setPanels([]);
      } else if (data.type === "panel_failed") {
        sync.setPanels((prev: ComicPanel[]) => prev.filter(p => p.id !== `loading_panel_${data.panel_number}`));
      }
    } catch (e) {
      console.error("Failed to parse data channel message:", e);
    }
  });

  useEffect(() => {
    sendDataRef.current = (data: any) => {
      const payload = new TextEncoder().encode(JSON.stringify(data));
      // sending over dependable channel
      send(payload, { reliable: true });
    };
  }, [send, sendDataRef]);

  return null;
}

export function useLiveAgent() {
  const context = useContext(LiveAgentContext);
  if (!context) {
    throw new Error("useLiveAgent must be used within a LiveAgentProvider");
  }
  return context;
}
