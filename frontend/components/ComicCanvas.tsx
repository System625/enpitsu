"use client";

import { useLiveAgent } from "@/app/hooks/useLiveAgent";
import { ComicPanel } from "./ComicPanel";
import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";

export function ComicCanvas() {
  const { panels, agentState, projectName, exportProjectAsZip } = useLiveAgent();
  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (exporting || panels.length === 0) return;
    setExporting(true);
    try {
      await exportProjectAsZip();
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="flex-1 h-full overflow-y-auto bg-skeuo-canvas bg-paper p-6 md:p-12">
      {/* Toolbar */}
      {panels.length > 0 && (
        <div className="flex items-center justify-between mb-6">
          <p className="text-sm font-bold text-skeuo-text-muted truncate">{projectName}</p>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold bg-skeuo-primary text-white rounded-xl hover:bg-skeuo-primary-dark disabled:opacity-50 transition-all duration-200 shadow-neo-btn"
          >
            {exporting ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Exporting&hellip;
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
                </svg>
                Export PDF
              </>
            )}
          </button>
        </div>
      )}

      {/* Empty State */}
      {panels.length === 0 && agentState === "idle" && (
        <div className="h-full w-full flex flex-col items-center justify-center text-skeuo-text-muted gap-3">
          <div className="w-20 h-20 rounded-full bg-skeuo-surface shadow-neo flex items-center justify-center mb-2">
            <svg className="w-9 h-9 text-skeuo-primary/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </div>
          <p className="text-lg font-bold text-skeuo-text">Upload a story or Push to Talk</p>
          <p className="text-sm">Your AI co-creator is ready to start drawing.</p>
        </div>
      )}

      {/* Comic Pages — 2 per row */}
      <div className="grid grid-cols-2 gap-6 w-full">
        <AnimatePresence>
          {panels.map((panel, i) => (
            <div key={panel.id} className="flex flex-col gap-2">
              <p className="text-xs font-bold text-skeuo-text-muted tracking-widest uppercase">
                Page {i + 1}
              </p>
              <div className="w-full aspect-[4/3]">
                <ComicPanel panel={panel} />
              </div>
            </div>
          ))}
        </AnimatePresence>
      </div>

      {/* Loading state indicator */}
      {agentState === "speaking" && panels.length > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="w-full flex justify-center mt-12 mb-8"
        >
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-skeuo-primary animate-bounce [animation-delay:0ms]" />
            <div className="w-3 h-3 rounded-full bg-skeuo-primary-light animate-bounce [animation-delay:150ms]" />
            <div className="w-3 h-3 rounded-full bg-skeuo-primary animate-bounce [animation-delay:300ms]" />
          </div>
        </motion.div>
      )}
    </main>
  );
}
