"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { ComicPanel as ComicPanelType } from "@/app/hooks/useLiveAgent";

interface ComicPanelProps {
  panel: ComicPanelType;
}

async function downloadImage(url: string, filename: string) {
  const res = await fetch(url);
  const blob = await res.blob();
  const ext = blob.type.includes("png") ? "png" : "jpg";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function ComicPanel({ panel }: ComicPanelProps) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadImage(panel.imageUrl, `panel_${panel.index + 1}`);
    } finally {
      setDownloading(false);
    }
  };

  // Full loading skeleton — backend hasn't generated the image yet
  if (panel.loading) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
        className="relative w-full h-full rounded-xl overflow-hidden border-2 border-skeuo-primary/40 shadow-neo bg-skeuo-base"
      >
        {/* Animated ink-wash shimmer */}
        <div className="absolute inset-0 bg-gradient-to-br from-skeuo-surface via-skeuo-base to-skeuo-surface animate-pulse" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-4">
          {/* Ink drop animation */}
          <div className="relative flex items-center justify-center w-16 h-16">
            <div className="absolute w-16 h-16 rounded-full border-2 border-skeuo-primary/30 animate-ping" />
            <div className="w-8 h-8 rounded-full bg-skeuo-primary/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-skeuo-primary animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            </div>
          </div>
          <p className="text-xs font-bold text-skeuo-primary/80 tracking-widest uppercase animate-pulse">
            Drawing...
          </p>
          {/* Show the caption preview while waiting */}
          {panel.text && (
            <p className="text-[11px] text-skeuo-text-muted text-center italic max-w-[80%] leading-snug line-clamp-2">
              &ldquo;{panel.text}&rdquo;
            </p>
          )}
        </div>
        {/* Halftone overlay */}
        <div className="absolute inset-0 opacity-5 pointer-events-none bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjZmZmIiAvPgo8Y2lyY2xlIGN4PSI0IiBjeT0iNCIgcj0iMyIgZmlsbD0iIzAwMCIgLz4KPC9zdmc+')] bg-repeat" />
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 20, mass: 1 }}
      className="relative w-full h-full bg-skeuo-surface rounded-xl overflow-hidden border-2 border-skeuo-text shadow-neo group"
    >
      {/* Generating shimmer — image URL exists but hasn't loaded yet */}
      {!loaded && !errored && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-skeuo-base">
          <div className="flex gap-1.5">
            <div className="w-2 h-2 rounded-full bg-skeuo-primary animate-bounce [animation-delay:0ms]" />
            <div className="w-2 h-2 rounded-full bg-skeuo-primary-light animate-bounce [animation-delay:150ms]" />
            <div className="w-2 h-2 rounded-full bg-skeuo-primary animate-bounce [animation-delay:300ms]" />
          </div>
          <p className="text-xs text-skeuo-text-muted font-medium">Loading...</p>
        </div>
      )}

      { }
      {!errored && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={retryKey}
          src={panel.imageUrl}
          alt={panel.text}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 group-hover:scale-105 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      )}

      {/* Error fallback with retry */}
      {errored && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-skeuo-base text-skeuo-text-muted text-xs p-4 text-center">
          <p>Image generation failed</p>
          <button
            onClick={() => { setErrored(false); setLoaded(false); setRetryKey(k => k + 1); }}
            className="px-3 py-1.5 text-xs bg-skeuo-surface hover:bg-skeuo-surface-raised rounded-lg border border-skeuo-border transition-colors shadow-neo-btn font-semibold"
          >
            Retry
          </button>
        </div>
      )}

      {/* Download button — shown on hover when image is loaded */}
      {loaded && (
        <button
          onClick={handleDownload}
          title="Download panel"
          className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity bg-white/80 hover:bg-white border border-skeuo-border rounded-lg p-1.5 shadow-sm backdrop-blur-sm"
        >
          {downloading ? (
            <svg className="w-4 h-4 animate-spin text-skeuo-primary" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4 text-skeuo-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
            </svg>
          )}
        </button>
      )}

      {/* Speech Bubble */}
      <div className="absolute bottom-5 left-3 right-3">
        <div className="comic-bubble relative px-4 py-2.5 bg-white border-[2.5px] border-skeuo-text">
          <p className="text-[13px] font-extrabold text-gray-900 leading-snug text-center tracking-tight uppercase">
            {panel.text}
          </p>
        </div>
      </div>

      {/* Comic Book halftone texture overlay */}
      <div className="absolute inset-0 opacity-10 pointer-events-none mix-blend-overlay bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4IiBoZWlnaHQ9IjgiPgo8cmVjdCB3aWR0aD0iOCIgaGVpZ2h0PSI4IiBmaWxsPSIjZmZmIiAvPgo8Y2lyY2xlIGN4PSI0IiBjeT0iNCIgcj0iMyIgZmlsbD0iIzAwMCIgLz4KPC9zdmc+')] bg-repeat" />
    </motion.div>
  );
}
