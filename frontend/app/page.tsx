import { Suspense } from "react";
import { AgentControlCenter } from "@/components/AgentControlCenter";
import { ComicCanvas } from "@/components/ComicCanvas";
import { ProjectLoader } from "@/components/ProjectLoader";
import { AuthGuard } from "@/components/AuthGuard";

export default function Home() {
  return (
    <AuthGuard>
      <Suspense>
        <ProjectLoader />
      </Suspense>
      <div className="flex h-screen w-full overflow-hidden bg-skeuo-canvas bg-paper font-sans text-skeuo-text">
        <AgentControlCenter />
        <ComicCanvas />
      </div>
    </AuthGuard>
  );
}
