"use client";

import { useMemo } from "react";
import { useLiveAgent } from "@/app/hooks/useLiveAgent";
import { useAudioVisualizer } from "@/app/hooks/useAudioVisualizer";
import { motion } from "framer-motion";

export function AgentVisualizer() {
  const { agentState } = useLiveAgent();
  const rawAudioVolume = useAudioVisualizer(); // 0 to 255 from LiveKit

  const averageVolume = (agentState === "speaking" || agentState === "listening")
    ? rawAudioVolume
    : 0;

  const scale = agentState === "speaking" ? 1 + (averageVolume / 255) * 0.5 : 1;

  return (
    <div className="flex flex-col items-center justify-center p-7 bg-skeuo-surface rounded-2xl shadow-neo border border-skeuo-border">
      <div className="relative w-32 h-32 flex items-center justify-center">
        {/* Outer glowing ring for thinking state */}
        {agentState === "thinking" && (
          <motion.div
            className="absolute inset-0 rounded-full border-4 border-skeuo-primary/30"
            animate={{
              scale: [1, 1.2, 1],
              opacity: [0.3, 0.8, 0.3],
              rotate: 360,
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: "linear",
            }}
          />
        )}

        {/* Ambient glow behind orb */}
        <div
          className={`absolute w-20 h-20 rounded-full blur-xl transition-all duration-700 ${
            agentState === "speaking"
              ? "bg-skeuo-primary/40 scale-150"
              : agentState === "listening"
              ? "bg-red-500/30 scale-125"
              : agentState === "thinking"
              ? "bg-skeuo-primary-light/30 scale-110"
              : "bg-skeuo-primary/10 scale-100"
          }`}
        />

        {/* Multi-layered Orb */}
        <motion.div
          animate={{ scale }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="relative w-24 h-24 rounded-full shadow-neo bg-gradient-to-br from-skeuo-surface-raised to-skeuo-base flex items-center justify-center"
        >
          {/* Inner colored orb based on state */}
          <div
            className={`w-16 h-16 rounded-full transition-all duration-500 shadow-inner-soft ${
              agentState === "speaking"
                ? "bg-gradient-to-br from-skeuo-primary to-skeuo-primary-dark shadow-purple-glow"
                : agentState === "listening"
                ? "bg-gradient-to-br from-red-400 to-red-600"
                : agentState === "thinking"
                ? "bg-gradient-to-br from-skeuo-primary-light to-skeuo-primary animate-purple-pulse"
                : "bg-gradient-to-br from-skeuo-shadow to-skeuo-deep-shadow"
            }`}
          />
        </motion.div>
      </div>

      <div className={`mt-5 text-xs font-bold tracking-[0.2em] uppercase transition-colors duration-300 ${
        agentState === "idle" ? "text-skeuo-text-muted" : "text-skeuo-primary"
      }`}>
        {agentState}
      </div>
    </div>
  );
}
