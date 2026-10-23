/// <reference lib="webworker" />
import type { Request, Response } from "./protocol.ts";
import { makeHandler } from "./handler.ts";

// The books worker: everything heavy happens here so the window stays responsive.
const scope = self as unknown as DedicatedWorkerGlobalScope;
const handle = makeHandler((m: Response, transfer: Transferable[] = []) => scope.postMessage(m, transfer));
scope.onmessage = (ev: MessageEvent<Request>) => void handle(ev.data);
