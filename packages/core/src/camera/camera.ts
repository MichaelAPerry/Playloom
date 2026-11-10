/**
 * Webcam access. Frames stay on this device: nothing here records, stores or transmits video.
 */

export interface CameraRequest {
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
}

export interface CameraInfo {
  deviceId: string;
  label: string;
}

export interface OpenCamera {
  video: HTMLVideoElement;
  stream: MediaStream;
  width: number;
  height: number;
  label: string;
  deviceId?: string;
  stop(): void;
}

export class CameraError extends Error {
  constructor(
    public readonly code: "unsupported" | "denied" | "not-found" | "in-use" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "CameraError";
  }
}

/** List cameras. Labels are empty until the user has granted camera permission once. */
export async function listCameras(): Promise<CameraInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "videoinput")
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

export async function openCamera(request: CameraRequest = {}): Promise<OpenCamera> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError("unsupported", "This browser cannot access cameras (a secure context is required).");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: request.deviceId ? { exact: request.deviceId } : undefined,
        width: { ideal: request.width ?? 640 },
        height: { ideal: request.height ?? 480 },
        frameRate: { ideal: request.frameRate ?? 30 },
      },
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new CameraError("denied", "Camera permission was not granted.");
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new CameraError("not-found", "No camera was found.");
    if (name === "NotReadableError" || name === "AbortError") throw new CameraError("in-use", "The camera is in use by another program or could not be started.");
    throw new CameraError("failed", `The camera could not be opened: ${(err as Error)?.message ?? err}`);
  }

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (video.videoWidth === 0) {
      await new Promise<void>((resolve) => video.addEventListener("loadeddata", () => resolve(), { once: true }));
    }
  } catch (err) {
    stream.getTracks().forEach((tr) => tr.stop());
    throw new CameraError("failed", `The camera stream could not be played: ${(err as Error)?.message ?? err}`);
  }
  const track = stream.getVideoTracks()[0];
  return {
    video,
    stream,
    width: video.videoWidth,
    height: video.videoHeight,
    label: track?.label ?? "Camera",
    deviceId: track?.getSettings().deviceId,
    stop() {
      stream.getTracks().forEach((tr) => tr.stop());
      video.srcObject = null;
    },
  };
}

/**
 * Call `fn` once per new camera frame. Uses requestVideoFrameCallback where available and falls
 * back to polling `currentTime` on animation frames. Returns a function that stops the loop.
 */
export function onVideoFrame(video: HTMLVideoElement, fn: (captureTime: number) => void): () => void {
  let stopped = false;
  type RVFC = (cb: (now: number, meta: { captureTime?: number; expectedDisplayTime: number }) => void) => number;
  const rvfc = (video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(video);
  if (rvfc) {
    const loop = (_now: number, meta: { captureTime?: number }): void => {
      if (stopped) return;
      // When this runs late (a slow model keeps the thread busy) the video element already shows
      // a newer picture than the callback describes, so the metadata is only trusted when fresh.
      // captureTime is also not on the same clock in every browser.
      const start = performance.now();
      const fresh = meta.captureTime !== undefined && meta.captureTime <= start && start - meta.captureTime < 250;
      fn(fresh ? meta.captureTime! : start);
      rvfc(loop);
    };
    rvfc(loop);
  } else {
    let last = -1;
    const loop = (now: number): void => {
      if (stopped) return;
      if (video.currentTime !== last && video.readyState >= 2) {
        last = video.currentTime;
        fn(now);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  return () => {
    stopped = true;
  };
}
