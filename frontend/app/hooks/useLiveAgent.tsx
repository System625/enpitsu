"use client";

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from "react";
import { createProject, saveProject, loadProject } from "./useProjects";
import {
  ParsedStory,
  StoryScene,
  extractTextFromFile,
  parseStory,
  buildScenePrompt,
  buildSceneCaption,
  buildNegativePrompt,
} from "./useStoryParser";

export type ComicStyle = "american" | "manga" | "franco_belgian" | "manhwa" | "manhua";

export type AgentState = "idle" | "listening" | "thinking" | "speaking";

export interface ComicPanel {
  id: string;
  imageUrl: string;
  text: string;
  index: number;
}

interface LiveAgentContextType {
  agentState: AgentState;
  panels: ComicPanel[];
  currentStyle: ComicStyle;
  isRecording: boolean;
  audioAnalyser: AnalyserNode | null;
  projectName: string;
  currentProjectId: string;
  storyLoaded: boolean;
  setAgentState: (state: AgentState) => void;
  setCurrentStyle: (style: ComicStyle) => void;
  setProjectName: (name: string) => void;
  startRecording: () => void;
  stopRecording: (userText?: string) => void;
  interruptAgent: () => void;
  uploadStory: (file: File) => void;
  saveCurrentProject: () => void;
  loadProjectById: (id: string) => void;
  exportProjectAsZip: () => Promise<void>;
}

const LiveAgentContext = createContext<LiveAgentContextType | null>(null);

const styleModifiers: Record<ComicStyle, string> = {
  american: "classic american superhero comic book style, bold lines, vibrant dynamic colors",
  manga: "japanese manga style, black and white ink drawing, screentone shading",
  franco_belgian: "bande dessinee, ligne claire style, clear line drawing, tintin aesthetic, detailed background",
  manhwa: "korean webtoon manhwa style, high quality digital painting, aesthetic lighting",
  manhua: "chinese manhua style, wuxia fantasy aesthetic, intricate details",
};

interface PromptResult {
  prompt: string;
  negativePrompt: string;
}

/** Parse free-form user text into an image prompt + negative prompt. */
function buildCharacterPrompt(text: string, style: ComicStyle): PromptResult {
  const lower = text.toLowerCase();

  let genderDesc = "a character";
  let negativePrompt = "";

  const isFemale = /\b(female|woman|girl|she|her|lady|ladies|women)\b/.test(lower);
  const isMale   = /\b(male|man|boy|he|his|guy|dude|men)\b/.test(lower);

  const antiPortrait = "close-up, closeup, portrait, headshot, face only, bust shot, shoulders up, cropped, macro, selfie, mugshot";

  if (isFemale) {
    genderDesc = "a woman";
    negativePrompt = `male, man, boy, masculine, beard, mustache, ${antiPortrait}`;
  } else if (isMale) {
    genderDesc = "a man";
    negativePrompt = `female, woman, girl, feminine, ${antiPortrait}`;
  } else {
    negativePrompt = antiPortrait;
  }

  const roleParts: string[] = [];

  if (/\b(antagonist|villain|enemy|rival|evil|dark)\b/.test(lower)) {
    roleParts.push("villain in a dark outfit, menacing stance, dramatic lighting");
  } else if (/\b(friend|companion|sidekick|ally|best friend)\b/.test(lower)) {
    roleParts.push("friendly companion, warm smile, casual outfit, relaxed standing pose");
  } else if (/\b(hero|protagonist|mc|main character)\b/.test(lower)) {
    roleParts.push("heroic protagonist, determined expression, dynamic action pose");
  } else {
    roleParts.push("character in a dynamic pose");
  }

  const colourMatch = lower.match(/\b(red|blue|green|black|white|blonde|silver|purple|pink|orange|golden)\s+hair\b/);
  if (colourMatch) roleParts.push(`with ${colourMatch[0]}`);

  const eyeMatch = lower.match(/\b(red|blue|green|black|golden|silver|purple|pink)\s+eyes\b/);
  if (eyeMatch) roleParts.push(`and ${eyeMatch[0]}`);

  const prompt = [
    `wide shot of ${genderDesc} standing full body from head to feet in a detailed environment`,
    roleParts.join(", "),
    styleModifiers[style],
    "comic book panel, detailed background, dynamic composition, high quality illustration",
  ].filter(Boolean).join(", ");

  return { prompt, negativePrompt };
}

function speak(text: string, onEnd?: () => void): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.pitch = 1.1;

  const voices = window.speechSynthesis.getVoices();

  // Prefer natural / premium voices — these sound far less robotic
  const naturalKeywords = [
    "natural", "premium", "enhanced", "neural",
    "samantha", "karen", "daniel", "fiona", "moira",
    "zira", "david", "mark", "hazel", "susan",
    "google uk english female", "google us english",
  ];

  const preferred =
    // 1. Try to find a natural/premium English voice
    voices.find(v =>
      v.lang.startsWith("en") &&
      naturalKeywords.some(k => v.name.toLowerCase().includes(k))
    ) ||
    // 2. Any remote (cloud) English voice — usually higher quality
    voices.find(v => v.lang.startsWith("en") && !v.localService) ||
    // 3. Fallback to any English voice
    voices.find(v => v.lang.startsWith("en"));

  if (preferred) utterance.voice = preferred;
  if (onEnd) utterance.onend = onEnd;
  window.speechSynthesis.speak(utterance);
}

/** Build panels from parsed story scenes */
function scenesToPanels(
  scenes: StoryScene[],
  parsedStory: ParsedStory,
  style: ComicStyle,
  startIdx: number,
  baseId: number,
): ComicPanel[] {
  return scenes.map((scene, i) => {
    const seed = Math.floor(Math.random() * 10000) + i * 41;
    const prompt = buildScenePrompt(scene, parsedStory.characters, style);
    const caption = buildSceneCaption(scene);
    const negative = buildNegativePrompt(scene, parsedStory.characters);

    const params: Record<string, string> = {
      prompt,
      seed: String(seed),
      width: "1024",
      height: "1024",
    };
    if (negative) params.negative_prompt = negative;

    return {
      id: `panel_${baseId}_${i}`,
      imageUrl: `/api/image?${new URLSearchParams(params)}`,
      text: caption,
      index: startIdx + i,
    };
  });
}

export function LiveAgentProvider({ children }: { children: React.ReactNode }) {
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [panels, setPanels] = useState<ComicPanel[]>([]);
  const [currentStyle, setCurrentStyle] = useState<ComicStyle>("american");
  const [isRecording, setIsRecording] = useState(false);
  const [audioAnalyser] = useState<AnalyserNode | null>(null);
  const [projectName, setProjectName] = useState("Untitled Story");
  const [currentProjectId, setCurrentProjectId] = useState<string>(() =>
    createProject("Untitled Story", "american").id
  );

  // Story state — tracks parsed content and progress
  const parsedStoryRef = useRef<ParsedStory | null>(null);
  const storyProgressRef = useRef<number>(0); // next scene index to generate
  const [storyLoaded, setStoryLoaded] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const speakingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUserTextRef = useRef<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const AudioContext = window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioContextRef.current = new AudioContext();
    }
    return () => { audioContextRef.current?.close(); };
  }, []);

  useEffect(() => {
    console.log("WebSocket would connect here");
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const ws = wsRef.current;
      ws?.close();
    };
  }, []);

  // Auto-save on every panels change (debounced)
  useEffect(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      saveProject({
        id: currentProjectId,
        name: projectName,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        style: currentStyle,
        panels,
      });
    }, 500);
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

  const startRecording = useCallback(() => {
    setIsRecording(true);
    setAgentState("listening");
  }, []);

  const stopRecording = useCallback((userText?: string) => {
    setIsRecording(false);
    setAgentState("thinking");

    const text = userText ?? pendingUserTextRef.current ?? "";
    pendingUserTextRef.current = "";

    const isStoryContinuation = /\b(finish|continue|next|rest|story|chapter|pdf|volume|sequence|what happens|unfold|arc|plot|more|go on|keep going)\b/i.test(text);

    // If we have a parsed story and this is a continuation request, use actual scenes
    const story = parsedStoryRef.current;
    if (story && isStoryContinuation) {
      const progress = storyProgressRef.current;
      const remaining = story.scenes.slice(progress);

      if (remaining.length === 0) {
        // Entire story already generated
        setAgentState("speaking");
        speak("The entire story has been illustrated! You can export it as a PDF.", () => setAgentState("idle"));
        speakingTimerRef.current = setTimeout(() => setAgentState("idle"), 6000);
        return;
      }

      // Generate all remaining scenes
      const baseId = Date.now();
      setPanels(prev => {
        const newPanels = scenesToPanels(remaining, story, currentStyle, prev.length, baseId);
        return [...prev, ...newPanels];
      });

      storyProgressRef.current = story.scenes.length; // mark all as generated

      setAgentState("speaking");
      const msg = remaining.length > 1
        ? `Generating the remaining ${remaining.length} scenes to finish your story!`
        : "Generating the final scene!";
      speak(msg, () => setAgentState("idle"));
      speakingTimerRef.current = setTimeout(() => setAgentState("idle"), 8000);
      return;
    }

    // Non-story request (character prompt, etc.) — original logic
    const wordNums: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      twelve: 12, fifteen: 15, twenty: 20,
    };
    const digitMatch = text.match(/\b(\d+)\s*(panels?|images?|shots?|pages?)?\b/i);
    const wordMatch  = text.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s*(panels?|images?|shots?|pages?)?\b/i);

    let panelCount = 1;
    if (digitMatch) {
      panelCount = Math.min(20, Math.max(1, parseInt(digitMatch[1], 10)));
    } else if (wordMatch) {
      panelCount = wordNums[wordMatch[1].toLowerCase()] ?? 1;
    } else if (/\b(scene|multiple|panels?|sequence|series)\b/i.test(text)) {
      panelCount = 3;
    }

    const baseId = Date.now();

    setPanels(prev => {
      const startIdx = prev.length;
      const placeholders: ComicPanel[] = [];
      for (let i = 0; i < panelCount; i++) {
        const seed = Math.floor(Math.random() * 10000) + i * 37;
        const result = buildCharacterPrompt(text, currentStyle);

        const params: Record<string, string> = {
          prompt: result.prompt,
          seed: String(seed),
          width: "1024",
          height: "768",
        };
        if (result.negativePrompt) params.negative_prompt = result.negativePrompt;
        placeholders.push({
          id: `panel_${baseId}_${i}`,
          imageUrl: `/api/image?${new URLSearchParams(params)}`,
          text: text.trim() || "Here you go!",
          index: startIdx + i,
        });
      }
      return [...prev, ...placeholders];
    });

    setAgentState("speaking");
    const dialogueText = panelCount > 1 ? `Generating ${panelCount} panels!` : "Got it!";
    speak(dialogueText, () => setAgentState("idle"));
    speakingTimerRef.current = setTimeout(() => setAgentState("idle"), 6000);
  }, [currentStyle]);

  const uploadStory = useCallback(async (file: File) => {
    setAgentState("thinking");
    const nameFromFile = file.name.replace(/\.[^.]+$/, "");
    setProjectName(nameFromFile);

    try {
      // 1. Extract text from file
      const rawText = await extractTextFromFile(file);

      // 2. Parse into scenes + characters
      const parsed = parseStory(rawText);
      parsedStoryRef.current = parsed;

      if (parsed.title && parsed.title !== "Untitled Story") {
        setProjectName(parsed.title);
      }

      // 3. Generate initial preview — about half, leaving rest for "continue"
      const previewCount = Math.min(
        Math.max(3, Math.ceil(parsed.scenes.length / 2)),
        parsed.scenes.length,
      );
      const previewScenes = parsed.scenes.slice(0, previewCount);
      storyProgressRef.current = previewCount;
      setStoryLoaded(true);

      const baseId = Date.now();
      setPanels(prev => {
        const newPanels = scenesToPanels(previewScenes, parsed, currentStyle, prev.length, baseId);
        return [...prev, ...newPanels];
      });

      // 4. Announce what we found
      const charNames = parsed.characters.map(c => c.name).slice(0, 3).join(", ");
      const remaining = parsed.scenes.length - previewCount;
      let announcement = `I've read "${parsed.title}".`;
      if (charNames) announcement += ` I found characters: ${charNames}.`;
      announcement += ` Here's a preview of the first ${previewCount} scenes.`;
      if (remaining > 0) announcement += ` Say "continue" or "finish the story" for the remaining ${remaining} scenes!`;

      setAgentState("speaking");
      speak(announcement, () => setAgentState("idle"));
      speakingTimerRef.current = setTimeout(() => setAgentState("idle"), 12000);
    } catch (err) {
      console.error("Upload story error:", err);
      setAgentState("speaking");
      speak("I had trouble reading that file. Please try a different format.", () => setAgentState("idle"));
      speakingTimerRef.current = setTimeout(() => setAgentState("idle"), 6000);
    }
  }, [currentStyle]);

  const interruptAgent = useCallback(() => {
    window.speechSynthesis?.cancel();
    clearSpeakingTimer();
    setAgentState("idle");
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
  }, [clearSpeakingTimer]);

  const saveCurrentProject = useCallback(() => {
    saveProject({
      id: currentProjectId,
      name: projectName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      style: currentStyle,
      panels,
    });
  }, [currentProjectId, projectName, currentStyle, panels]);

  const loadProjectById = useCallback((id: string) => {
    const project = loadProject(id);
    if (!project) return;
    setCurrentProjectId(project.id);
    setProjectName(project.name);
    setCurrentStyle(project.style);
    setPanels(project.panels);
  }, []);

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
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "style_change", style: currentStyle }));
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
        projectName,
        currentProjectId,
        storyLoaded,
        setAgentState,
        setCurrentStyle,
        setProjectName,
        startRecording,
        stopRecording,
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
