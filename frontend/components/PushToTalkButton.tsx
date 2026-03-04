"use client";

import { useRef, useState } from "react";
import { useLiveAgent } from "@/app/hooks/useLiveAgent";
import { Icon } from "@iconify/react";
import { motion } from "framer-motion";

export function PushToTalkButton() {
  const { isRecording, startRecording, stopRecording, agentState, interruptAgent } = useLiveAgent();
  const recognitionRef = useRef<any>(null);
  const transcriptRef = useRef<string>("");
  const [liveText, setLiveText] = useState("");

  const isInterruptable = agentState === "speaking" || agentState === "thinking";

  const handlePressStart = () => {
    if (isInterruptable) {
      interruptAgent();
      return;
    }

    transcriptRef.current = "";
    setLiveText("");
    startRecording();

    const SR =
      typeof window !== "undefined" &&
      ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

    if (!SR) {
      return;
    }

    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          transcriptRef.current += t + " ";
        } else {
          interim += t;
        }
      }
      setLiveText((transcriptRef.current + interim).trim());
    };

    recognition.onend = () => {
      const spokenText = transcriptRef.current.trim();
      setLiveText("");
      stopRecording(spokenText || undefined);
    };

    recognition.onerror = () => {
      setLiveText("");
      stopRecording(transcriptRef.current.trim() || undefined);
    };

    recognitionRef.current = recognition;
    recognition.start();
  };

  const handlePressEnd = () => {
    if (!isRecording) return;

    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    } else {
      setLiveText("");
      stopRecording(undefined);
    }
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

      {/* Live transcript preview */}
      {isRecording && liveText && (
        <p className="mt-3 text-xs text-skeuo-text-muted text-center italic max-w-[200px] leading-snug line-clamp-3">
          &ldquo;{liveText}&rdquo;
        </p>
      )}
      {isRecording && !liveText && (
        <p className="mt-3 text-xs text-skeuo-text-muted text-center animate-pulse">Listening&hellip;</p>
      )}
    </div>
  );
}
