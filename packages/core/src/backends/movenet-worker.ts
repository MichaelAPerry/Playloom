/// <reference lib="webworker" />
/**
 * MoveNet pose estimation in a worker. Same protocol as pose-worker.ts: the page sends one camera
 * frame at a time and waits for the answer before sending the next.
 */
import { MoveNetRunner, type MoveNetRunnerOptions } from "./movenet-runner";
import type { RawPerson } from "../types";

export interface MoveNetWorkerInit extends MoveNetRunnerOptions {
  type: "init";
}
export interface MoveNetWorkerFrame {
  type: "frame";
  bitmap: ImageBitmap;
  time: number;
}
export type MoveNetWorkerReply =
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "result"; time: number; people: RawPerson[] };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const reply = (message: MoveNetWorkerReply): void => scope.postMessage(message);
let runner: MoveNetRunner | null = null;

scope.onmessage = (event: MessageEvent<MoveNetWorkerInit | MoveNetWorkerFrame>) => {
  const message = event.data;
  if (message.type === "init") {
    MoveNetRunner.create(message).then(
      (r) => {
        runner = r;
        reply({ type: "ready" });
      },
      (err) => reply({ type: "error", message: (err as Error)?.message ?? String(err) }),
    );
    return;
  }
  const { bitmap, time } = message;
  const width = bitmap.width;
  const height = bitmap.height;
  void (async () => {
    try {
      if (!runner) throw new Error("MoveNet worker used before it was ready");
      reply({ type: "result", time, people: await runner.run(bitmap, width, height) });
    } catch (err) {
      reply({ type: "error", message: (err as Error)?.message ?? String(err) });
    } finally {
      bitmap.close();
    }
  })();
};
