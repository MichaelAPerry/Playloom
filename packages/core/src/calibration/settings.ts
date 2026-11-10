import { DEFAULT_THRESHOLDS, type GestureThresholds } from "../gestures/recognizer";

/**
 * Device-level motion settings that are worth remembering between sessions.
 *
 * Player calibration (who stands where and how tall they are) is deliberately not stored: it
 * describes the people in front of the camera right now, and reusing yesterday's would let the
 * tracker confuse today's players.
 */
export interface MotionSettings {
  version: 1;
  mirror: boolean;
  sensitivity: number;
  thresholds: GestureThresholds;
  cameraId?: string;
  backend?: string;
}

export const DEFAULT_SETTINGS: MotionSettings = {
  version: 1,
  mirror: true,
  sensitivity: 1,
  thresholds: DEFAULT_THRESHOLDS,
};

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = "playloom.motion-settings";

/** Load settings from local storage, falling back to defaults for anything missing or malformed. */
export function loadSettings(store: KeyValueStore): MotionSettings {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const data = JSON.parse(raw) as Partial<MotionSettings>;
    if (data.version !== 1) return structuredClone(DEFAULT_SETTINGS);
    const thresholds = { ...DEFAULT_THRESHOLDS };
    for (const k of Object.keys(thresholds) as (keyof GestureThresholds)[]) {
      const v = data.thresholds?.[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) thresholds[k] = v;
    }
    return {
      version: 1,
      mirror: typeof data.mirror === "boolean" ? data.mirror : true,
      sensitivity:
        typeof data.sensitivity === "number" && data.sensitivity >= 0.25 && data.sensitivity <= 4 ? data.sensitivity : 1,
      thresholds,
      cameraId: typeof data.cameraId === "string" ? data.cameraId : undefined,
      backend: typeof data.backend === "string" ? data.backend : undefined,
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(store: KeyValueStore, settings: MotionSettings): void {
  store.setItem(KEY, JSON.stringify(settings));
}
