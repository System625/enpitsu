"use client";

import { useState } from "react";
import { Project, deleteProject } from "@/app/hooks/useProjects";

const STYLE_LABELS: Record<string, string> = {
  american: "American",
  manga: "Manga",
  franco_belgian: "Franco-Belgian",
  manhwa: "Manhwa",
  manhua: "Manhua",
};

interface ProjectCardProps {
  project: Project;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}

export function ProjectCard({ project, onOpen, onDeleted }: ProjectCardProps) {
  const [confirming, setConfirming] = useState(false);

  const thumbnail = project.panels[0]?.imageUrl ?? null;
  const updatedAt = new Date(project.updatedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const handleDelete = () => {
    if (!confirming) { setConfirming(true); return; }
    deleteProject(project.id);
    onDeleted(project.id);
  };

  return (
    <div className="flex flex-col bg-skeuo-surface-raised border border-skeuo-border rounded-2xl overflow-hidden shadow-neo hover:shadow-neo-lg transition-all duration-300 group">
      {/* Thumbnail */}
      <div className="relative h-40 bg-skeuo-base overflow-hidden">
        {thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnail}
            alt={project.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-skeuo-text-muted text-sm bg-gradient-to-br from-skeuo-base to-skeuo-surface">
            No panels yet
          </div>
        )}
        {/* Style badge */}
        <span className="absolute top-2.5 left-2.5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider bg-skeuo-primary text-white rounded-lg shadow-sm">
          {STYLE_LABELS[project.style] ?? project.style}
        </span>
      </div>

      {/* Info */}
      <div className="flex flex-col gap-1 p-4">
        <h3 className="text-sm font-bold text-skeuo-text truncate">{project.name}</h3>
        <p className="text-xs text-skeuo-text-muted">
          {project.panels.length} panel{project.panels.length !== 1 ? "s" : ""} &middot; {updatedAt}
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-2 px-4 pb-4">
        <button
          onClick={() => onOpen(project.id)}
          className="flex-1 py-2 text-xs font-bold bg-skeuo-primary text-white rounded-xl hover:bg-skeuo-primary-dark transition-all duration-200 shadow-neo-btn"
        >
          Open
        </button>
        <button
          onClick={handleDelete}
          className={`px-3 py-2 text-xs font-bold rounded-xl border transition-all duration-200 ${
            confirming
              ? "bg-red-600 text-white border-red-600 hover:bg-red-700 shadow-sm"
              : "bg-skeuo-surface text-skeuo-text-muted border-skeuo-border hover:border-red-300 hover:text-red-500 shadow-neo-btn"
          }`}
        >
          {confirming ? "Sure?" : "Delete"}
        </button>
      </div>
    </div>
  );
}
