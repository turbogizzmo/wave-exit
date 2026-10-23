import { createContext, useContext } from "react";
import type { Engine } from "../engine/client.ts";
import type { Platform } from "../platform/types.ts";
import type { ProjectStore } from "../store/projects.ts";

export interface AppServices {
  platform: Platform;
  store: ProjectStore;
  engine: Engine;
  /** Today's date (ISO); fixed in tests. */
  today: () => string;
}

export const Services = createContext<AppServices | null>(null);

export function useServices(): AppServices {
  const s = useContext(Services);
  if (!s) throw new Error("services missing");
  return s;
}
