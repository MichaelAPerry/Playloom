import type { FrameSink, KeypointName, PoseFrame, PoseSource, SourceCapabilities } from "@playloom/core";

/**
 * Pose recordings: a stream of PoseFrames stored as JSON Lines.
 *
 * A recording contains keypoint coordinates only — never camera images — so recordings of real
 * play sessions can be shared as test data without sharing video of anyone.
 */

export interface RecordingHeader {
  playloom: "pose-recording";
  version: 1;
  source: string;
  capabilities: SourceCapabilities;
}

export interface Recording {
  header: RecordingHeader;
  frames: PoseFrame[];
}

const round = (v: number): number => Math.round(v * 10000) / 10000;

export class PoseRecorder {
  readonly frames: PoseFrame[] = [];

  constructor(private header: Omit<RecordingHeader, "playloom" | "version">) {}

  /** Wrap a sink so every frame passing through is also recorded. */
  tap(sink: FrameSink): FrameSink {
    return (frame) => {
      this.record(frame);
      sink(frame);
    };
  }

  record(frame: PoseFrame): void {
    this.frames.push({
      timestamp: round(frame.timestamp),
      aspect: frame.aspect,
      mirrored: frame.mirrored,
      people: frame.people.map((person) => {
        const keypoints: PoseFrame["people"][number]["keypoints"] = {};
        for (const name in person.keypoints) {
          const k = person.keypoints[name as KeypointName]!;
          keypoints[name as KeypointName] = { x: round(k.x), y: round(k.y), score: round(k.score) };
        }
        return {
          keypoints,
          score: round(person.score),
          anchor: person.anchor ? { x: round(person.anchor.x), y: round(person.anchor.y) } : undefined,
          activity: person.activity === undefined ? undefined : round(person.activity),
        };
      }),
    });
  }

  toRecording(): Recording {
    return { header: { playloom: "pose-recording", version: 1, ...this.header }, frames: this.frames };
  }

  toJSONL(): string {
    return serializeRecording(this.toRecording());
  }
}

export function serializeRecording(recording: Recording): string {
  return [JSON.stringify(recording.header), ...recording.frames.map((f) => JSON.stringify(f))].join("\n") + "\n";
}

/** Parse a recording, rejecting anything that is not a well-formed pose recording. */
export function parseRecording(text: string): Recording {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("Recording is empty");
  const header = JSON.parse(lines[0]!) as RecordingHeader;
  if (header?.playloom !== "pose-recording" || header.version !== 1) {
    throw new Error("Not a Playloom pose recording (or an unsupported version)");
  }
  const frames: PoseFrame[] = [];
  let last = -Infinity;
  for (let i = 1; i < lines.length; i++) {
    const frame = JSON.parse(lines[i]!) as PoseFrame;
    if (typeof frame.timestamp !== "number" || !Array.isArray(frame.people)) {
      throw new Error(`Recording line ${i + 1} is not a pose frame`);
    }
    if (frame.timestamp < last) throw new Error(`Recording line ${i + 1} goes back in time`);
    last = frame.timestamp;
    frames.push(frame);
  }
  return { header, frames };
}

export interface PlaybackOptions {
  /** `manual`: call `playAll()` or `next()`. `realtime`: frames are delivered with their original timing. */
  clock: "manual" | "realtime";
  loop: boolean;
}

/** Replays a recording as a PoseSource. */
export class PlaybackSource implements PoseSource {
  readonly id: string;
  readonly capabilities: SourceCapabilities;
  private sink: FrameSink | null = null;
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private offset = 0;
  /** Called when a non-looping realtime playback reaches the end. */
  onEnd: (() => void) | null = null;

  constructor(
    private recording: Recording,
    private options: PlaybackOptions = { clock: "realtime", loop: false },
  ) {
    this.id = `playback:${recording.header.source}`;
    this.capabilities = recording.header.capabilities;
  }

  async start(sink: FrameSink): Promise<void> {
    this.sink = sink;
    this.index = 0;
    if (this.options.clock === "realtime") {
      const first = this.recording.frames[0];
      if (!first) return;
      this.offset = performance.now() - first.timestamp;
      this.schedule();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sink = null;
  }

  /** Manual clock: deliver the next frame. Returns false at the end. */
  next(): boolean {
    const frame = this.recording.frames[this.index];
    if (!frame || !this.sink) return false;
    this.index++;
    this.sink(frame);
    return true;
  }

  /** Manual clock: deliver every remaining frame immediately, with original timestamps. */
  playAll(): void {
    while (this.next());
  }

  private schedule(): void {
    const frame = this.recording.frames[this.index];
    if (!frame) {
      if (this.options.loop && this.recording.frames.length > 1) {
        const frames = this.recording.frames;
        const span = frames[frames.length - 1]!.timestamp - frames[0]!.timestamp;
        this.offset += span + 33;
        this.index = 0;
        this.schedule();
      } else {
        this.onEnd?.();
      }
      return;
    }
    const due = frame.timestamp + this.offset;
    this.timer = setTimeout(() => {
      if (!this.sink) return;
      this.index++;
      // Re-base timestamps onto the live clock so latency figures stay meaningful.
      this.sink({ ...frame, timestamp: due });
      this.schedule();
    }, Math.max(0, due - performance.now()));
  }
}
