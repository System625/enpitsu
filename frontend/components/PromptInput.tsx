"use client";

import { useState, useRef } from "react";
import { useLiveAgent } from "@/app/hooks/useLiveAgent";

export function PromptInput() {
  const { stopRecording, startRecording, agentState } = useLiveAgent();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const isThinking = agentState === "thinking" || agentState === "speaking";

  const submit = () => {
    const text = value.trim();
    if (!text || isThinking) return;
    setValue("");
    startRecording();
    setTimeout(() => stopRecording(text), 100);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] text-skeuo-text-muted font-bold text-center uppercase tracking-[0.2em]">
        Type your request
      </p>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKey}
          disabled={isThinking}
          placeholder='e.g. "female villain, red hair"'
          className="flex-1 px-3.5 py-2.5 text-sm rounded-xl border border-skeuo-border bg-skeuo-surface-raised text-skeuo-text placeholder:text-skeuo-deep-shadow focus:outline-none focus:ring-2 focus:ring-skeuo-primary/40 focus:border-skeuo-primary/50 disabled:opacity-50 shadow-inner-soft transition-all duration-200"
        />
        <button
          onClick={submit}
          disabled={isThinking || !value.trim()}
          className="px-3.5 py-2.5 rounded-xl bg-skeuo-primary text-white text-sm font-bold hover:bg-skeuo-primary-dark disabled:opacity-30 transition-all duration-200 shadow-neo-btn"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
      </div>
      <p className="text-[10px] text-skeuo-deep-shadow text-center leading-snug">
        Tip: say &ldquo;show 3 panels&rdquo; or &ldquo;female antagonist with silver hair&rdquo;
      </p>
    </div>
  );
}
