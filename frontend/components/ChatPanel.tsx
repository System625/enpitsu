"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { useLiveAgent } from "@/app/hooks/useLiveAgent";
import { Icon } from "@iconify/react";
import { motion } from "framer-motion";

const SILENCE_THRESHOLD = 0.01;
const SILENCE_DELAY_MS = 1500;

export function ChatPanel() {
  const {
    agentState,
    isRecording,
    startRecording,
    stopRecording,
    interruptAgent,
    sendAudioChunk,
    setAudioAnalyser,
    micMode,
    setMicMode,
    isMuted,
    setIsMuted,
    connectionStatus,
    messages,
    startSession,
  } = useLiveAgent();

  const [inputValue, setInputValue] = useState("");
  const [voiceMode, setVoiceMode] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mic refs
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const vadAnalyserRef = useRef<AnalyserNode | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const userSpokeRef = useRef(false);

  const isConnected = connectionStatus === "connected";
  const isInterruptable = agentState === "speaking" || agentState === "thinking";
  const isBusy = agentState === "thinking" || agentState === "speaking";

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // --- Text submit ---
  const submitText = () => {
    const text = inputValue.trim();
    if (!text || isBusy || !isConnected) return;
    setInputValue("");
    startRecording();
    setTimeout(() => stopRecording(text), 100);
    inputRef.current?.focus();
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitText(); }
  };

  // --- Mic setup/teardown ---
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      streamRef.current = stream;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new AudioCtx({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      await ctx.audioWorklet.addModule("/pcm-processor.js");
      const workletNode = new AudioWorkletNode(ctx, "pcm-processor");
      workletNodeRef.current = workletNode;
      workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => sendAudioChunk(e.data);
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const gain = ctx.createGain();
      gain.gain.value = isMuted ? 0 : 1;
      gainRef.current = gain;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      vadAnalyserRef.current = analyser;
      source.connect(gain);
      gain.connect(analyser);
      analyser.connect(workletNode);
      setAudioAnalyser(analyser);
      startRecording();
      return true;
    } catch {
      return false;
    }
  }, [sendAudioChunk, setAudioAnalyser, startRecording, isMuted]);

  const stopMic = useCallback(() => {
    if (vadFrameRef.current) { cancelAnimationFrame(vadFrameRef.current); vadFrameRef.current = null; }
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    vadAnalyserRef.current = null;
    sourceRef.current?.disconnect(); sourceRef.current = null;
    gainRef.current?.disconnect(); gainRef.current = null;
    workletNodeRef.current?.disconnect(); workletNodeRef.current?.port.close(); workletNodeRef.current = null;
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {}); audioCtxRef.current = null;
    setAudioAnalyser(null);
  }, [setAudioAnalyser]);

  const startVad = useCallback(() => {
    const analyser = vadAnalyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    userSpokeRef.current = false;
    const tick = () => {
      if (!vadAnalyserRef.current) return;
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
      if (rms > SILENCE_THRESHOLD) {
        userSpokeRef.current = true;
        if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
      } else if (userSpokeRef.current && !silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => {
          silenceTimerRef.current = null;
          userSpokeRef.current = false;
          stopRecording(undefined);
          setTimeout(() => startRecording(), 100);
        }, SILENCE_DELAY_MS);
      }
      vadFrameRef.current = requestAnimationFrame(tick);
    };
    vadFrameRef.current = requestAnimationFrame(tick);
  }, [stopRecording, startRecording]);

  // Update gain on mute change
  useEffect(() => {
    if (gainRef.current) gainRef.current.gain.value = isMuted ? 0 : 1;
  }, [isMuted]);

  // Open-mic: auto-start when in voice+open-mic mode and connected
  useEffect(() => {
    if (!voiceMode || micMode !== "open-mic" || !isConnected) return;
    let cancelled = false;
    (async () => {
      if (!streamRef.current && !cancelled) {
        const ok = await startMic();
        if (ok && !cancelled) startVad();
      }
    })();
    return () => { cancelled = true; stopMic(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceMode, micMode, isConnected]);

  // Cleanup on unmount
  useEffect(() => () => stopMic(), []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Voice mode PTT handlers ---
  const handlePressStart = async () => {
    if (isInterruptable) { interruptAgent(); return; }
    const ok = await startMic();
    if (!ok) stopRecording(undefined);
  };
  const handlePressEnd = () => {
    if (!isRecording) return;
    stopMic();
    stopRecording(undefined);
  };

  // --- Toggle voice mode ---
  const toggleVoice = () => {
    if (voiceMode) { stopMic(); setVoiceMode(false); }
    else { setVoiceMode(true); }
  };

  // Mic button label
  const micLabel = micMode === "open-mic"
    ? (isMuted ? "Muted" : isInterruptable ? "Interrupt" : "Listening")
    : (isInterruptable ? "Interrupt" : "Hold");

  return (
    <div className="flex flex-col bg-skeuo-surface-raised rounded-2xl shadow-neo border border-skeuo-primary/20 overflow-hidden">
      {/* Header — state indicator + mode toggle */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-skeuo-primary/20 bg-skeuo-base">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full ${
            agentState === "speaking" ? "bg-skeuo-primary animate-pulse" :
            agentState === "listening" ? "bg-red-400 animate-pulse" :
            agentState === "thinking" ? "bg-yellow-400 animate-pulse" :
            "bg-skeuo-shadow"
          }`} />
          <span className="text-[10px] font-bold tracking-[0.15em] uppercase text-skeuo-text-muted">
            {agentState === "idle" ? "Chat" : agentState}
          </span>
        </div>
        {/* Text / Voice toggle */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => { if (voiceMode) { stopMic(); setVoiceMode(false); } }}
            className={`px-2.5 py-1 rounded-lg text-[9px] font-bold tracking-wider uppercase transition-all ${
              !voiceMode
                ? "bg-skeuo-primary/10 border border-skeuo-primary/30 text-skeuo-primary"
                : "text-skeuo-text-muted hover:text-skeuo-primary"
            }`}
          >
            Text
          </button>
          <button
            onClick={() => setVoiceMode(true)}
            className={`px-2.5 py-1 rounded-lg text-[9px] font-bold tracking-wider uppercase transition-all ${
              voiceMode
                ? "bg-skeuo-primary/10 border border-skeuo-primary/30 text-skeuo-primary"
                : "text-skeuo-text-muted hover:text-skeuo-primary"
            }`}
          >
            Voice
          </button>
        </div>
      </div>

      {/* Message history */}
      <div className="flex flex-col gap-2 px-3 py-3 min-h-[120px] max-h-[200px] overflow-y-auto">
        {messages.length === 0 && (
          <p className="text-[11px] text-skeuo-deep-shadow text-center mt-4 italic">
            {isConnected ? "Say hi or type a message…" : "Connect to start chatting"}
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] px-3 py-1.5 rounded-2xl text-xs leading-snug ${
                msg.role === "user"
                  ? "bg-skeuo-primary text-white rounded-br-sm"
                  : "bg-skeuo-surface-raised text-skeuo-text border border-skeuo-border rounded-bl-sm"
              }`}
            >
              <span className="whitespace-pre-wrap">{msg.text}</span>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-skeuo-primary/20 px-3 py-2.5 bg-skeuo-base">
        {!isConnected ? (
          /* Not connected — show Start button */
          <button
            onClick={startSession}
            className="w-full py-2.5 rounded-xl bg-skeuo-primary text-white text-sm font-bold hover:bg-skeuo-primary-dark transition-all duration-200 shadow-neo-btn"
          >
            Start chatting
          </button>
        ) : voiceMode ? (
          /* Voice mode controls */
          <div className="flex flex-col items-center gap-2">
            {/* Mic mode toggle */}
            <div className="flex items-center gap-1.5 w-full">
              <button
                onClick={() => { setMicMode("push-to-talk"); if (micMode === "open-mic") stopMic(); }}
                className={`flex-1 text-[9px] font-bold tracking-wider uppercase py-1 px-2 rounded-lg border transition-all ${
                  micMode === "push-to-talk"
                    ? "bg-skeuo-primary/10 border-skeuo-primary/30 text-skeuo-primary"
                    : "bg-transparent border-skeuo-border text-skeuo-text-muted"
                }`}
              >
                Hold
              </button>
              <button
                onClick={() => setMicMode("open-mic")}
                className={`flex-1 text-[9px] font-bold tracking-wider uppercase py-1 px-2 rounded-lg border transition-all ${
                  micMode === "open-mic"
                    ? "bg-skeuo-primary/10 border-skeuo-primary/30 text-skeuo-primary"
                    : "bg-transparent border-skeuo-border text-skeuo-text-muted"
                }`}
              >
                Open Mic
              </button>
            </div>

            {/* Mic button */}
            {micMode === "push-to-talk" ? (
              <motion.button
                onPointerDown={handlePressStart}
                onPointerUp={handlePressEnd}
                onPointerLeave={handlePressEnd}
                animate={isRecording ? "pressed" : "idle"}
                variants={{ idle: { scale: 1 }, pressed: { scale: 0.93 } }}
                className={`w-16 h-16 rounded-full flex items-center justify-center border-2 select-none cursor-pointer transition-all duration-200 ${
                  isRecording
                    ? "shadow-neo-btn-pressed bg-red-500 border-red-400 text-white"
                    : isInterruptable
                    ? "shadow-neo-btn bg-amber-50 border-amber-200 text-amber-600"
                    : "shadow-neo-btn bg-skeuo-surface-raised border-skeuo-border text-skeuo-primary hover:shadow-purple-glow"
                }`}
              >
                <Icon
                  icon={isInterruptable && !isRecording ? "lucide:stop-circle" : "lucide:mic"}
                  width="22" height="22"
                />
              </motion.button>
            ) : (
              <motion.button
                onClick={() => isInterruptable ? interruptAgent() : setIsMuted(!isMuted)}
                animate={isMuted ? "muted" : "active"}
                variants={{
                  muted: { scale: 1 },
                  active: { scale: [1, 1.03, 1], transition: { repeat: Infinity, duration: 2 } },
                }}
                className={`w-16 h-16 rounded-full flex items-center justify-center border-2 select-none cursor-pointer transition-all duration-200 ${
                  isMuted
                    ? "shadow-neo-btn bg-skeuo-surface-raised border-skeuo-border text-skeuo-text-muted"
                    : isInterruptable
                    ? "shadow-neo-btn bg-amber-50 border-amber-200 text-amber-600"
                    : "shadow-neo-btn bg-green-50 border-green-300 text-green-600"
                }`}
              >
                <Icon
                  icon={isInterruptable ? "lucide:stop-circle" : isMuted ? "lucide:mic-off" : "lucide:mic"}
                  width="22" height="22"
                />
              </motion.button>
            )}
            <p className="text-[10px] text-skeuo-text-muted">{micLabel}</p>
          </div>
        ) : (
          /* Text mode input */
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKey}
              disabled={isBusy}
              placeholder='e.g. "manga style, first scene"'
              className="flex-1 px-3 py-2 text-sm rounded-xl border border-skeuo-border bg-skeuo-surface-raised text-skeuo-text placeholder:text-skeuo-deep-shadow focus:outline-none focus:ring-2 focus:ring-skeuo-primary/40 focus:border-skeuo-primary/50 disabled:opacity-50 shadow-inner-soft transition-all duration-200"
            />
            {/* Voice toggle mic icon */}
            <button
              onClick={toggleVoice}
              title="Switch to voice"
              className="px-2.5 py-2 rounded-xl border border-skeuo-border bg-skeuo-surface-raised text-skeuo-text-muted hover:text-skeuo-primary hover:border-skeuo-primary/30 transition-all duration-200"
            >
              <Icon icon="lucide:mic" width="16" height="16" />
            </button>
            <button
              onClick={submitText}
              disabled={isBusy || !inputValue.trim()}
              className="px-3 py-2 rounded-xl bg-skeuo-primary text-white text-sm font-bold hover:bg-skeuo-primary-dark disabled:opacity-30 transition-all duration-200 shadow-neo-btn"
            >
              <Icon icon="lucide:send" width="16" height="16" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
