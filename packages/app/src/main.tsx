import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Engine } from "./engine/client.ts";
import { detectPlatform } from "./platform/index.ts";
import { ProjectStore } from "./store/projects.ts";
import "./ui/styles.css";

const platform = await detectPlatform();
const services = { platform, store: new ProjectStore(platform), engine: new Engine(), today: () => new Date().toISOString().slice(0, 10) };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
