import { Suspense } from "react";
import { AgentControlCenter } from "@/components/AgentControlCenter";
import { ComicCanvas } from "@/components/ComicCanvas";
import { LiveAgentProvider } from "@/app/hooks/useLiveAgent";
import { ProjectLoader } from "@/components/ProjectLoader";

export default function Home() {
  return (
    <LiveAgentProvider>
      <Suspense>
        <ProjectLoader />
      </Suspense>
      <div className="flex h-screen w-full overflow-hidden bg-skeuo-canvas bg-paper font-sans text-skeuo-text">
        <AgentControlCenter />
        <ComicCanvas />
      </div>
    </LiveAgentProvider>
  );
}
