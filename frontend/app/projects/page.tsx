"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Project, loadProjects } from "@/app/hooks/useProjects";
import { ProjectCard } from "@/components/ProjectCard";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    setProjects(loadProjects());
  }, []);

  const handleOpen = (id: string) => {
    router.push(`/?project=${id}`);
  };

  const handleDeleted = (id: string) => {
    setProjects(prev => prev.filter(p => p.id !== id));
  };

  return (
    <div className="min-h-screen bg-skeuo-canvas bg-paper font-sans text-skeuo-text">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-skeuo-sidebar backdrop-blur-xl border-b border-skeuo-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-skeuo-text-muted hover:text-skeuo-primary transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div>
            <h1 className="text-lg font-extrabold text-skeuo-text leading-none">My Projects</h1>
            <p className="text-[10px] text-skeuo-text-muted mt-0.5 tracking-wider font-semibold uppercase">Your saved comic stories</p>
          </div>
        </div>
        <Link
          href="/"
          className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold bg-skeuo-primary text-white rounded-xl hover:bg-skeuo-primary-dark transition-all duration-200 shadow-neo-btn"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Project
        </Link>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-6 py-10">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-skeuo-text-muted gap-4">
            <div className="w-16 h-16 rounded-full bg-skeuo-surface shadow-neo flex items-center justify-center">
              <svg className="w-7 h-7 text-skeuo-primary/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
              </svg>
            </div>
            <p className="text-lg font-bold text-skeuo-text">No projects yet</p>
            <p className="text-sm">Start a conversation on the canvas and your work will auto-save here.</p>
            <Link
              href="/"
              className="mt-2 px-5 py-2.5 text-sm font-bold bg-skeuo-primary text-white rounded-xl hover:bg-skeuo-primary-dark transition-all duration-200 shadow-neo-btn"
            >
              Start creating
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={handleOpen}
                onDeleted={handleDeleted}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
