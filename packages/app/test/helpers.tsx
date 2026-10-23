import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetch, InputFile } from "@wave-exit/core";
import { render } from "@testing-library/react";
import { App } from "../src/App.tsx";
import type { AppServices } from "../src/app/context.tsx";
import { Engine } from "../src/engine/client.ts";
import { makeHandler } from "../src/engine/handler.ts";
import type { Request, Response } from "../src/engine/protocol.ts";
import { webPlatform } from "../src/platform/web.ts";
import type { Platform } from "../src/platform/types.ts";
import { ProjectStore } from "../src/store/projects.ts";

const SAMPLE = join(import.meta.dirname, "../../core/test/fixtures/synthetic");
export const sampleFile = (name: string): InputFile => ({ path: name, bytes: new Uint8Array(readFileSync(join(SAMPLE, name))) });

/** The books worker, run in-process: same code, no thread. */
export function inProcessEngine(): Engine {
  const fake = {
    onmessage: null as ((ev: MessageEvent<Response>) => void) | null,
    postMessage(req: Request) {
      const handle = (this as typeof fake).handler;
      void handle(structuredClone(req));
    },
    handler: undefined as unknown as (r: Request) => Promise<void>,
    terminate() {},
  };
  fake.handler = makeHandler((m) => queueMicrotask(() => fake.onmessage?.({ data: m } as MessageEvent<Response>)));
  return new Engine(fake as unknown as Worker);
}

export interface TestPlatform extends Platform {
  picks: InputFile[][];
  saved: { name: string; bytes: Uint8Array }[];
  drop(files: InputFile[]): void;
}

export function testPlatform(fetch?: Fetch): TestPlatform {
  const base = webPlatform(fetch ? { fetch } : {});
  let dropHandler: ((f: InputFile[]) => void) | undefined;
  const p: TestPlatform = {
    ...base,
    picks: [],
    saved: [],
    pickInputFiles: async () => p.picks.shift() ?? null,
    onFilesDropped: (h) => {
      dropHandler = h;
      return () => (dropHandler = undefined);
    },
    saveOutputs: async (files) => {
      p.saved.push(...files);
      return { folder: "/Users/test/Outputs", written: files.map((f) => `/Users/test/Outputs/${f.name}`) };
    },
    openExternal: async () => {},
    waveUrl: "https://gql.waveapps.com/graphql/public",
    drop: (files) => dropHandler?.(files),
  };
  return p;
}

export function renderApp(platform: TestPlatform) {
  const services: AppServices = { platform, store: new ProjectStore(platform), engine: inProcessEngine(), today: () => "2026-01-20" };
  return { services, ...render(<App services={services} />) };
}
