"use client";

import { ComicStyle, useLiveAgent } from "@/app/hooks/useLiveAgent";

const STYLES: { id: ComicStyle; label: string; icon: string }[] = [
  { id: "american", label: "American", icon: "🦸" },
  { id: "manga", label: "Manga", icon: "⛩️" },
  { id: "franco_belgian", label: "Franco-Belgian", icon: "🎨" },
  { id: "manhwa", label: "Manhwa", icon: "🇰🇷" },
  { id: "manhua", label: "Manhua", icon: "🐉" },
];

export function StyleSelector() {
  const { currentStyle, setCurrentStyle } = useLiveAgent();

  return (
    <div className="flex flex-col p-5 bg-skeuo-surface rounded-2xl shadow-neo border border-skeuo-border">
      <h3 className="text-[10px] text-skeuo-text-muted font-bold mb-4 tracking-[0.2em] uppercase">
        Art Style
      </h3>
      <div className="flex flex-col gap-2.5">
        {STYLES.map((style) => {
          const isActive = currentStyle === style.id;
          return (
            <button
              key={style.id}
              onClick={() => setCurrentStyle(style.id)}
              className={`relative flex items-center gap-3 p-3 rounded-xl text-left transition-all duration-200 font-semibold text-sm ${
                isActive
                  ? "shadow-neo-btn-pressed bg-skeuo-base text-skeuo-primary ring-1 ring-skeuo-primary/30"
                  : "shadow-neo-btn bg-skeuo-surface-raised text-skeuo-text-muted hover:text-skeuo-primary"
              }`}
            >
              {/* Tactile indicator dot */}
              <div
                className={`w-3 h-3 rounded-full border-2 shadow-inner transition-all duration-200 ${
                  isActive
                    ? "bg-skeuo-primary border-skeuo-primary-dark scale-110"
                    : "bg-skeuo-shadow border-skeuo-deep-shadow"
                }`}
              />
              <span className="text-sm mr-1">{style.icon}</span>
              {style.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
