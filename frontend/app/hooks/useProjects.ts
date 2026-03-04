import { ComicStyle, ComicPanel } from "./useLiveAgent";

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  style: ComicStyle;
  panels: ComicPanel[];
}

const STORAGE_KEY = "enpitsu_projects";

function readStorage(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeStorage(projects: Project[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

export function loadProjects(): Project[] {
  return readStorage();
}

export function loadProject(id: string): Project | null {
  return readStorage().find(p => p.id === id) ?? null;
}

export function saveProject(project: Project): void {
  const projects = readStorage();
  const idx = projects.findIndex(p => p.id === project.id);
  if (idx >= 0) {
    projects[idx] = project;
  } else {
    projects.unshift(project);
  }
  writeStorage(projects);
}

export function deleteProject(id: string): void {
  writeStorage(readStorage().filter(p => p.id !== id));
}

export function createProject(name: string, style: ComicStyle): Project {
  return {
    id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    style,
    panels: [],
  };
}
