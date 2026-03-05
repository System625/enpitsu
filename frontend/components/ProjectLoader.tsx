"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useLiveAgent } from "@/app/hooks/useLiveAgent";

/** Reads ?project=<id> from the URL and loads that project into the agent context. */
export function ProjectLoader() {
  const searchParams = useSearchParams();
  const { loadProjectById } = useLiveAgent();

  useEffect(() => {
    const id = searchParams.get("project");
    if (id) {
      loadProjectById(id);
    }
  // Run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
