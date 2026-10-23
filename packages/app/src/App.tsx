import { useEffect, useState } from "react";
import { Services, type AppServices } from "./app/context.tsx";
import { createSampleProject } from "./app/sample.ts";
import { Home } from "./ui/Home.tsx";
import { ProjectView, type Tab } from "./ui/ProjectView.tsx";

type Route = { view: "home" } | { view: "project"; id: string; tab: Tab };

export function App({ services }: { services: AppServices }) {
  const [route, setRoute] = useState<Route>({ view: "home" });

  useEffect(() => {
    document.title = route.view === "home" ? "Wave Exit" : "Wave Exit – project";
  }, [route]);

  return (
    <Services.Provider value={services}>
      <div className="app">
        <header className="topbar">
          <span className="brand">Wave Exit</span>
          <span className="small muted">Convert Wave Accounting books for any destination</span>
          {services.platform.kind === "browser" ? <span className="badge amber" title="Storage in this build isn't the computer's keychain">Development build</span> : null}
        </header>
        <main>
          {route.view === "home" ? (
            <Home open={(id) => setRoute({ view: "project", id, tab: "inputs" })} onSample={() => createSampleProject(services.store)} />
          ) : (
            <ProjectView key={route.id} id={route.id} tab={route.tab} setTab={(tab) => setRoute({ ...route, tab })} back={() => setRoute({ view: "home" })} />
          )}
        </main>
      </div>
    </Services.Provider>
  );
}
