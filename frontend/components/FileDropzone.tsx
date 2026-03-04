"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";

import { useLiveAgent } from "@/app/hooks/useLiveAgent";

export function FileDropzone() {
  const { uploadStory } = useLiveAgent();
  const [isDragOver, setIsDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0];
      setFile(droppedFile);
      uploadStory(droppedFile);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      uploadStory(selectedFile);
    }
  };

  return (
    <div className="flex flex-col p-5 bg-skeuo-surface rounded-2xl shadow-neo border border-skeuo-border">
      <h3 className="text-[10px] text-skeuo-text-muted font-bold mb-4 tracking-[0.2em] uppercase">
        Story Upload
      </h3>

      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative flex flex-col items-center justify-center p-7 rounded-xl border-2 border-dashed transition-all duration-300 ${
          isDragOver
            ? "border-skeuo-primary bg-skeuo-primary/10 shadow-neo-pressed"
            : "border-skeuo-shadow shadow-inner-soft bg-skeuo-base hover:border-skeuo-primary/40 hover:bg-skeuo-surface-raised"
        }`}
      >
        <Icon
          icon={file ? "lucide:file-text" : "lucide:upload-cloud"}
          width="36"
          height="36"
          className={`mb-3 transition-colors duration-200 ${
            isDragOver ? "text-skeuo-primary" : file ? "text-emerald-500" : "text-skeuo-text-muted"
          }`}
        />

        <p className="text-sm font-medium text-skeuo-text-muted text-center pointer-events-none">
          {file ? (
            <span className="text-skeuo-text">{file.name}</span>
          ) : (
            <>
              Drag & Drop story PDF/Word<br/>
              <span className="text-xs text-skeuo-deep-shadow font-normal">or click to browse</span>
            </>
          )}
        </p>
        <input
          type="file"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          onChange={handleFileInput}
          accept=".pdf,.doc,.docx,.txt"
        />
      </div>
    </div>
  );
}
