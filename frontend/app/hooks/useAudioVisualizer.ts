"use client";

import { useEffect, useState, useRef } from "react";
import { useLiveAgent } from "./useLiveAgent";

export function useAudioVisualizer() {
  const { agentState, audioAnalyser } = useLiveAgent();
  const [audioData, setAudioData] = useState<Uint8Array>(new Uint8Array(0));
  const requestRef = useRef<number | null>(null);

  useEffect(() => {
    if (agentState !== "speaking" && agentState !== "listening") {
      setAudioData(new Uint8Array(0));
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      return;
    }

    // Mock animation if no actual Web Audio Node is connected yet
    if (!audioAnalyser) {
      const updateMockData = () => {
        const mockArray = new Uint8Array(32);
        for (let i = 0; i < mockArray.length; i++) {
          mockArray[i] = Math.random() * 255;
        }
        setAudioData(mockArray);
        requestRef.current = requestAnimationFrame(updateMockData);
      };

      requestRef.current = requestAnimationFrame(updateMockData);
      return () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
      };
    }

    // Actual Web Audio implementation
    const bufferLength = audioAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const updateData = () => {
      audioAnalyser.getByteFrequencyData(dataArray);
      setAudioData(new Uint8Array(dataArray));
      requestRef.current = requestAnimationFrame(updateData);
    };

    requestRef.current = requestAnimationFrame(updateData);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [agentState, audioAnalyser]);

  return audioData;
}
