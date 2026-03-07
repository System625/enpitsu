"use client";

import { useRef, useState } from "react";
import { useLiveAgent } from "@/app/hooks/useLiveAgent";
import { Icon } from "@iconify/react";
import { motion } from "framer-motion";

export function PushToTalkButton() {
  const { isRecording, startRecording, stopRecording, agentState, interruptAgent, sendAudioChunk, setAudioAnalyser } = useLiveAgent();
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const [liveText, setLiveText] = useState("");

  const isInterruptable = agentState === "speaking" || agentState === "thinking";

  const handlePressStart = async () => {
    if (isInterruptable) {
      interruptAgent();
      return;
    }

    setLiveText("");
    startRecording();

    try {
      console.debug("[mic] Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      console.debug("[mic] Microphone access granted");
      streamRef.current = stream;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      // Request 16kHz so the worklet output is already at the right rate for Gemini
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

      // Create analyser for mic input visualization
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(workletNode);
      setAudioAnalyser(analyser);
      // Don't connect worklet to destination — we only want to capture, not play back
    } catch (err) {
      console.error("[mic] Failed to start recording:", err);
      stopRecording(undefined);
      setLiveText("Mic unavailable");
      setTimeout(() => setLiveText(""), 2000);
    }
  };

  const handlePressEnd = () => {
    if (!isRecording) return;

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    workletNodeRef.current?.disconnect();
    workletNodeRef.current?.port.close();
    workletNodeRef.current = null;

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setAudioAnalyser(null);

    setLiveText("");
    stopRecording(undefined);
  };

  return (
    <div className="flex flex-col items-center justify-center p-6 bg-skeuo-surface rounded-2xl shadow-neo border border-skeuo-border">
      <p className="text-[10px] text-skeuo-text-muted font-bold mb-4 text-center tracking-[0.2em] uppercase">
        {isInterruptable ? "Press to Interrupt" : "Push to Talk"}
      </p>

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

      {isRecording && (
        <p className="mt-3 text-xs text-skeuo-text-muted text-center animate-pulse">
          {liveText || "Listening\u2026"}
        </p>
      )}
    </div>
  );
}
