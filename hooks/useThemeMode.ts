"use client";

import { useEffect, useState } from "react";
import type { ThemeMode } from "@/lib/theme";

/**
 * Tracks the OS colour-scheme preference.
 *
 * Starts at "dark" on the server and on the very first client render so markup
 * matches across hydration; the real value is read in an effect. Canvas colours
 * are painted from JS, so a one-frame mismatch is invisible — but a hydration
 * warning is not, hence the deferred read.
 */
export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setMode(query.matches ? "light" : "dark");
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return mode;
}
