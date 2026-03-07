import {
  collection, doc, setDoc, getDoc, getDocs, deleteDoc, query, orderBy,
} from "firebase/firestore";
import {
  ref, uploadString, getDownloadURL, deleteObject, listAll,
} from "firebase/storage";
import { db, storage } from "@/lib/firebase";
import { ComicStyle, ComicPanel } from "./useLiveAgent";

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  style: ComicStyle;
  panels: ComicPanel[];
}

// Firestore doc shape (no image data — just URLs + metadata)
interface PanelRecord {
  id: string;
  imageUrl: string;
  text: string;
  index: number;
}

interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  style: ComicStyle;
  panels: PanelRecord[];
}

function projectsCol(uid: string) {
  return collection(db, "users", uid, "projects");
}

function projectDoc(uid: string, projectId: string) {
  return doc(db, "users", uid, "projects", projectId);
}

/** Upload a base64 image to Firebase Storage, return its download URL. */
async function uploadPanelImage(uid: string, projectId: string, panelId: string, base64Url: string): Promise<string> {
  // base64Url is "data:image/jpeg;base64,<data>" or already a https URL
  if (base64Url.startsWith("http")) return base64Url;
  const storageRef = ref(storage, `users/${uid}/projects/${projectId}/panels/${panelId}.jpg`);
  await uploadString(storageRef, base64Url, "data_url");
  return getDownloadURL(storageRef);
}

export async function loadProjects(uid: string): Promise<Project[]> {
  const q = query(projectsCol(uid), orderBy("updatedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data() as Project);
}

export async function loadProject(uid: string, id: string): Promise<Project | null> {
  const snap = await getDoc(projectDoc(uid, id));
  return snap.exists() ? (snap.data() as Project) : null;
}

/** Save project to Firestore. Uploads any base64 panel images to Storage first. */
export async function saveProject(uid: string, project: Project): Promise<void> {
  const uploadedPanels: PanelRecord[] = await Promise.all(
    project.panels.map(async (panel) => {
      const imageUrl = await uploadPanelImage(uid, project.id, panel.id, panel.imageUrl);
      return { id: panel.id, imageUrl, text: panel.text, index: panel.index };
    })
  );

  const record: ProjectRecord = {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: Date.now(),
    style: project.style,
    panels: uploadedPanels,
  };

  await setDoc(projectDoc(uid, project.id), record, { merge: true });
}

export async function deleteProject(uid: string, id: string): Promise<void> {
  // Delete all panel images from Storage
  const folderRef = ref(storage, `users/${uid}/projects/${id}/panels`);
  try {
    const list = await listAll(folderRef);
    await Promise.all(list.items.map(item => deleteObject(item)));
  } catch {
    // Folder may not exist yet
  }
  await deleteDoc(projectDoc(uid, id));
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
