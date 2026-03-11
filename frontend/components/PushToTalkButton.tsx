"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useLiveAgent } from "@/app/hooks/useLiveAgent";
import { Icon } from "@iconify/react";
import { motion } from "framer-motion";

export function PushToTalkButton() {
  const {
    isRecording, startRecording, stopRecording, agentState, interruptAgent,
    sendAudioChunk, setAudioAnalyser, micMode, setMicMode, isMuted, setIsMuted,
    connectionStatus,
  } = useLiveAgent();

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const vadAnalyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const [liveText, setLiveText] = useState("");

  const isInterruptable = agentState === "speaking" || agentState === "thinking";

  // Shared mic setup
  const startMic = useCallback(async () => {
    try {
      console.debug("[mic] Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      console.debug("[mic] Microphone access granted");
      streamRef.current = stream;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new AudioCtx({ sampleRate: 16000 });
      audioCtxRef.current = ctx;

      await ctx.audioWorklet.addModule("/pcm-processor.js");
      const workletNode = new AudioWorkletNode(ctx, "pcm-processor");
      workletNodeRef.current = workletNode;

      workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        sendAudioChunk(e.data);
      };

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // Gain node for mute control
      const gain = ctx.createGain();
      gain.gain.value = isMuted ? 0 : 1;
      gainRef.current = gain;

      // Create analyser for mic input visualization + VAD
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      vadAnalyserRef.current = analyser;

      // Chain: source -> gain -> analyser -> worklet
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(workletNode);
      setAudioAnalyser(analyser);

      startRecording();
      return true;
    } catch (err) {
      console.error("[mic] Failed to start recording:", err);
      setLiveText("Mic unavailable");
      setTimeout(() => setLiveText(""), 2000);
      return false;
    }
  }, [sendAudioChunk, setAudioAnalyser, startRecording, isMuted]);

  const stopMic = useCallback(() => {
    // Stop VAD loop
    if (vadFrameRef.current) { cancelAnimationFrame(vadFrameRef.current); vadFrameRef.current = null; }
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    vadAnalyserRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    gainRef.current?.disconnect();
    gainRef.current = null;
    workletNodeRef.current?.disconnect();
    workletNodeRef.current?.port.close();
    workletNodeRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setAudioAnalyser(null);
  }, [setAudioAnalyser]);

  // (no client-side VAD is required; Gemini handles turn detection server-side)

  // Update gain when muted state changes (open mic mode)
  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = isMuted ? 0 : 1;
    }
  }, [isMuted]);

  // Open mic: auto-start when WebSocket is connected, auto-stop when mode changes.
  // In open-mic mode, Gemini's server-side VAD handles turn detection,
  // so we do NOT run client-side VAD or send audio_turn_complete —
  // just stream audio continuously.
  useEffect(() => {
    if (micMode !== "open-mic" || connectionStatus !== "connected") return;

    let cancelled = false;
    (async () => {
      if (!streamRef.current && !cancelled) {
        await startMic();
      }
    })();

    return () => {
      cancelled = true;
      stopMic();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micMode, connectionStatus]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopMic();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Push-to-talk handlers ---
  const handlePressStart = async () => {
    if (micMode === "open-mic") return;

    if (isInterruptable) {
      interruptAgent();
      return;
    }

    setLiveText("");
    const ok = await startMic();
    if (!ok) stopRecording(undefined);
  };

  const handlePressEnd = () => {
    if (micMode === "open-mic") return;
    if (!isRecording) return;

    stopMic();
    setLiveText("");
    stopRecording(undefined);
  };

  // --- Open mic handlers ---
  const handleOpenMicToggle = () => {
    if (isInterruptable) {
      interruptAgent();
      return;
    }
    setIsMuted(!isMuted);
  };

  return (
    <div className="flex flex-col items-center justify-center p-6 bg-skeuo-surface rounded-2xl shadow-neo border border-skeuo-border">
      {/* Mode toggle */}
      <div className="flex items-center gap-2 mb-3 w-full">
        <button
          onClick={() => { setMicMode("push-to-talk"); if (micMode === "open-mic") { stopMic(); stopRecording(undefined); } }}
          className={`flex-1 text-[9px] font-bold tracking-wider uppercase py-1.5 px-2 rounded-lg border transition-all ${
            micMode === "push-to-talk"
              ? "bg-skeuo-primary/10 border-skeuo-primary/30 text-skeuo-primary"
              : "bg-transparent border-skeuo-border text-skeuo-text-muted hover:border-skeuo-primary/20"
          }`}
        >
          Hold to Talk
        </button>
        <button
          onClick={() => setMicMode("open-mic")}
          className={`flex-1 text-[9px] font-bold tracking-wider uppercase py-1.5 px-2 rounded-lg border transition-all ${
            micMode === "open-mic"
              ? "bg-skeuo-primary/10 border-skeuo-primary/30 text-skeuo-primary"
              : "bg-transparent border-skeuo-border text-skeuo-text-muted hover:border-skeuo-primary/20"
          }`}
        >
          Open Mic
        </button>
      </div>

      <p className="text-[10px] text-skeuo-text-muted font-bold mb-4 text-center tracking-[0.2em] uppercase">
        {micMode === "open-mic"
          ? (isMuted ? "Muted" : isInterruptable ? "Press to Interrupt" : "Listening")
          : (isInterruptable ? "Press to Interrupt" : "Push to Talk")}
      </p>

      {micMode === "push-to-talk" ? (
        <motion.button
          onPointerDown={handlePressStart}
          onPointerUp={handlePressEnd}
          onPointerLeave={handlePressEnd}
          animate={isRecording ? "pressed" : "idle"}
          variants={{
            idle: { scale: 1 },
            pressed: { scale: 0.93 },
          }}
          className={`w-[88px] h-[88px] rounded-full flex items-center justify-center transition-all duration-200 border-2 select-none cursor-pointer ${
            isRecording
              ? "shadow-neo-btn-pressed bg-red-500 border-red-400 text-white"
              : isInterruptable
              ? "shadow-neo-btn bg-amber-50 border-amber-200 text-amber-600 hover:bg-amber-100"
              : "shadow-neo-btn bg-skeuo-surface-raised border-skeuo-border text-skeuo-primary hover:shadow-purple-glow"
          }`}
        >
          <Icon
            icon={isInterruptable && !isRecording ? "lucide:stop-circle" : "lucide:mic"}
            width="28"
            height="28"
          />
        </motion.button>
      ) : (
        <motion.button
          onClick={handleOpenMicToggle}
          animate={isMuted ? "muted" : "active"}
          variants={{
            muted: { scale: 1 },
            active: { scale: [1, 1.03, 1], transition: { repeat: Infinity, duration: 2 } },
          }}
          className={`w-[88px] h-[88px] rounded-full flex items-center justify-center transition-all duration-200 border-2 select-none cursor-pointer ${
            isMuted
              ? "shadow-neo-btn bg-skeuo-surface-raised border-skeuo-border text-skeuo-text-muted"
              : isInterruptable
              ? "shadow-neo-btn bg-amber-50 border-amber-200 text-amber-600 hover:bg-amber-100"
              : "shadow-neo-btn bg-green-50 border-green-300 text-green-600 hover:bg-green-100"
          }`}
        >
          <Icon
            icon={isInterruptable ? "lucide:stop-circle" : isMuted ? "lucide:mic-off" : "lucide:mic"}
            width="28"
            height="28"
          />
        </motion.button>
      )}

      {isRecording && micMode === "push-to-talk" && (
        <p className="mt-3 text-xs text-skeuo-text-muted text-center animate-pulse">
          {liveText || "Listening\u2026"}
        </p>
      )}

      {micMode === "open-mic" && isRecording && !isMuted && (
        <p className="mt-3 text-xs text-green-500 text-center animate-pulse">
          Streaming audio...
        </p>
      )}
    </div>
  );
}
