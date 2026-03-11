"use client";

import { ComicPanel as ComicPanelType } from "@/app/hooks/useLiveAgent";
import { ComicPanel } from "./ComicPanel";

interface ComicPageLayoutProps {
  panels: (ComicPanelType | null)[];
  pageIndex: number;
}

// Three irregular layout templates rotated per page.
// Each area key (a–f) maps to one of the 6 panel slots.
const LAYOUTS = [
  {
    // Template 0: Wide establishing shot top-left, tall right column, tall left bottom
    areas: `"a a b" "c d b" "c e f"`,
    rows: "220px 220px 220px",
  },
  {
    // Template 1: Tall left panel, tall right bottom, wide bottom strip
    areas: `"a b c" "a d e" "f f e"`,
    rows: "220px 220px 220px",
  },
  {
    // Template 2: Full-width splash top, three small middle, wide bottom-left
    areas: `"a a a" "b c d" "e e f"`,
    rows: "260px 200px 200px",
  },
] as const;

const AREA_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

export function ComicPageLayout({ panels, pageIndex }: ComicPageLayoutProps) {
  const layout = LAYOUTS[pageIndex % LAYOUTS.length];

  return (
    <div
      className="w-full rounded-2xl overflow-hidden border-[3px] border-gray-900"
      style={{
        display: "grid",
        gridTemplateAreas: layout.areas,
        gridTemplateRows: layout.rows,
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: "3px",
        backgroundColor: "#111",
      }}
    >
      {AREA_KEYS.map((areaKey, i) => {
        const panel = panels[i];
        return (
          <div key={areaKey} style={{ gridArea: areaKey }}>
            {panel ? (
              <ComicPanel panel={panel} />
            ) : (
              <div className="w-full h-full bg-skeuo-surface" />
            )}
          </div>
        );
      })}
    </div>
  );
}
