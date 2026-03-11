"use client";

import Link from "next/link";
import { AgentVisualizer } from "./AgentVisualizer";
import { StyleSelector } from "./StyleSelector";
import { FileDropzone } from "./FileDropzone";
import { ChatPanel } from "./ChatPanel";
import { StoryEditor } from "./StoryEditor";
import { useLiveAgent } from "@/app/hooks/useLiveAgent";

export function AgentControlCenter() {
  const { storyText, pendingHighlight } = useLiveAgent();

  return (
    <aside className="h-full w-full max-w-[320px] flex flex-col bg-skeuo-sidebar border-r border-skeuo-border bg-noise backdrop-blur-xl">
      {/* Scrollable top section */}
      <div className="flex flex-col gap-5 p-5 overflow-y-auto flex-1">
        {/* Brand header */}
        <div className="flex flex-col gap-1 items-center pt-2 pb-1">
          <h1 className="text-2xl font-extrabold bg-gradient-to-r from-skeuo-primary via-skeuo-primary-light to-skeuo-primary bg-clip-text text-transparent drop-shadow-sm tracking-tight">
            Enpitsu
          </h1>
          <p className="text-[10px] font-bold tracking-[0.25em] text-skeuo-text-muted uppercase">
            Live Co-Creator
          </p>
          <Link
            href="/projects"
            className="mt-2.5 flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-skeuo-text-muted bg-skeuo-surface-raised border border-skeuo-border rounded-xl hover:border-skeuo-primary/30 hover:text-skeuo-primary transition-all duration-200 shadow-neo-btn"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h18M3 12h18M3 17h18" />
            </svg>
            My Projects
          </Link>
        </div>

        <FileDropzone />
        <StoryEditor
          storyText={storyText}
          pendingHighlight={pendingHighlight}
        />
        <StyleSelector />
      </div>

      {/* Chat panel — always visible at the bottom */}
      <div className="p-5 pt-0 shrink-0">
        <ChatPanel />
      </div>
    </aside>
  );
}
