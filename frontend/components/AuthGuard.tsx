"use client";

import { useAuth } from "@/app/hooks/useAuth";
import { SignInPage } from "./SignInPage";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-skeuo-canvas bg-paper">
        <div className="w-8 h-8 rounded-full border-2 border-skeuo-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <SignInPage />;
  }

  return <>{children}</>;
}
