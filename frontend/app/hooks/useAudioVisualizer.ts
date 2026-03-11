"use client";

import { useTrackVolume, useVoiceAssistant, useLocalParticipant } from "@livekit/components-react";
import { useLiveAgent } from "./useLiveAgent";

export function useAudioVisualizer(): number {
  const { agentState } = useLiveAgent();
  const { audioTrack } = useVoiceAssistant();
  const { microphoneTrack } = useLocalParticipant();

  // If speaking, use the agent's audio track volume.
  // If listening, use the user's mic track volume.
  const speakerVolume = useTrackVolume(audioTrack);
  const micVolume = useTrackVolume(microphoneTrack?.track as import("livekit-client").LocalAudioTrack | undefined);

  if (agentState === "speaking") {
    return speakerVolume * 255;
  }
  if (agentState === "listening") {
    return micVolume * 255;
  }
  return 0;
}
