import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOVENET_MAPPING,
  inputToFrame,
  letterbox,
  MOVENET_ROW,
  personsFromMoveNet,
  rgbaToRgbInt32,
} from "../src/backends/movenet-math";
import { KEYPOINT_NAMES } from "../src/types";

/** Build a flattened [6, 56] tensor; each person is 17 (y, x, score) triples plus a person score. */
function tensor(people: Array<{ score: number; at: (k: number) => [number, number, number] }>): Float32Array {
  const out = new Float32Array(6 * MOVENET_ROW);
  people.forEach((p, r) => {
    for (let k = 0; k < 17; k++) {
      const [y, x, s] = p.at(k);
      out.set([y, x, s], r * MOVENET_ROW + k * 3);
    }
    out[r * MOVENET_ROW + 55] = p.score;
  });
  return out;
}

describe("letterbox", () => {
  it("fits a 640x480 camera into 256x192 without padding", () => {
    const lb = letterbox(640, 480, 256);
    expect(lb).toEqual({ inputWidth: 256, inputHeight: 192, drawWidth: 256, drawHeight: 192, padX: 0, padY: 0 });
  });

  it("pads a 16:9 frame to a multiple of 32 and centres it", () => {
    const lb = letterbox(1280, 720, 256);
    expect(lb.drawWidth).toBe(256);
    expect(lb.drawHeight).toBe(144);
    expect(lb.inputHeight).toBe(160);
    expect(lb.padY).toBe(8);
    expect(lb.padX).toBe(0);
  });

  it("always yields multiples of 32 and rounds the long side up", () => {
    for (const [w, h, side] of [[640, 480, 200], [480, 640, 256], [1920, 1080, 320], [100, 100, 33], [1000, 17, 256]] as const) {
      const lb = letterbox(w, h, side);
      expect(lb.inputWidth % 32).toBe(0);
      expect(lb.inputHeight % 32).toBe(0);
      expect(lb.padX + lb.drawWidth).toBeLessThanOrEqual(lb.inputWidth);
      expect(lb.padY + lb.drawHeight).toBeLessThanOrEqual(lb.inputHeight);
    }
    expect(letterbox(640, 480, 200).inputWidth).toBe(224);
  });

  it("handles portrait frames", () => {
    const lb = letterbox(480, 640, 256);
    expect(lb.inputHeight).toBe(256);
    expect(lb.drawWidth).toBe(192);
    expect(lb.inputWidth).toBe(192);
  });

  it("rejects an empty frame", () => {
    expect(() => letterbox(0, 480)).toThrow();
  });
});

describe("inputToFrame", () => {
  it("maps the corners of the picture inside the padding to 0 and 1", () => {
    const lb = letterbox(1280, 720, 256);
    const topLeft = inputToFrame(lb, lb.padX / lb.inputWidth, lb.padY / lb.inputHeight);
    const bottomRight = inputToFrame(lb, (lb.padX + lb.drawWidth) / lb.inputWidth, (lb.padY + lb.drawHeight) / lb.inputHeight);
    expect(topLeft.x).toBeCloseTo(0, 6);
    expect(topLeft.y).toBeCloseTo(0, 6);
    expect(bottomRight.x).toBeCloseTo(1, 6);
    expect(bottomRight.y).toBeCloseTo(1, 6);
  });

  it("maps the centre of the model input to the centre of the frame", () => {
    const c = inputToFrame(letterbox(1280, 720, 256), 0.5, 0.5);
    expect(c.x).toBeCloseTo(0.5, 6);
    expect(c.y).toBeCloseTo(0.5, 6);
  });
});

describe("personsFromMoveNet", () => {
  it("names the 17 keypoints in COCO order and un-letterboxes coordinates", () => {
    const lb = letterbox(1280, 720, 256);
    // Place the nose at frame (0.25, 0.75) by going through the letterbox forwards.
    const inX = (0.25 * lb.drawWidth + lb.padX) / lb.inputWidth;
    const inY = (0.75 * lb.drawHeight + lb.padY) / lb.inputHeight;
    const out = tensor([{ score: 0.9, at: (k) => (k === 0 ? [inY, inX, 0.8] : [0.5, 0.5, 0.6]) }]);
    const people = personsFromMoveNet(out, lb);
    expect(people).toHaveLength(1);
    const p = people[0]!;
    expect(p.score).toBeCloseTo(0.9, 5);
    expect(Object.keys(p.keypoints)).toEqual(KEYPOINT_NAMES.slice(0, 17));
    expect(p.keypoints.nose!.x).toBeCloseTo(0.25, 5);
    expect(p.keypoints.nose!.y).toBeCloseTo(0.75, 5);
    expect(p.keypoints.nose!.score).toBeCloseTo(0.8, 5);
    expect(p.keypoints.rightAnkle!.x).toBeCloseTo(0.5, 5);
  });

  it("drops people below the person-score threshold", () => {
    const lb = letterbox(640, 480);
    const out = tensor([
      { score: 0.9, at: () => [0.5, 0.2, 0.9] },
      { score: DEFAULT_MOVENET_MAPPING.minPersonScore - 0.05, at: () => [0.5, 0.8, 0.9] },
      { score: 0, at: () => [0, 0, 0] },
    ]);
    const people = personsFromMoveNet(out, lb);
    expect(people).toHaveLength(1);
    expect(people[0]!.keypoints.nose!.x).toBeCloseTo(0.2, 5);
    expect(personsFromMoveNet(out, lb, { minPersonScore: 0.01 })).toHaveLength(2);
  });

  it("zeroes the score of weak keypoints and of points inside the padding", () => {
    const lb = letterbox(1280, 720, 256); // 8 px of padding top and bottom of 160
    const out = tensor([{ score: 0.9, at: (k) => (k === 0 ? [4 / 160, 0.5, 0.9] : k === 1 ? [0.5, 0.5, 0.05] : [0.5, 0.5, 0.9]) }]);
    const p = personsFromMoveNet(out, lb)[0]!;
    // nose is 4 px into the 8 px padding: slightly outside the picture but within the tolerance, so it is kept
    expect(p.keypoints.nose!.score).toBeGreaterThan(0);
    expect(p.keypoints.leftEye!.score).toBe(0);
    const far = tensor([{ score: 0.9, at: () => [0.0, 0.5, 0.9] }]);
    // y = 0 is 8 px into the padding, i.e. 8/144 = 5.6 % above the picture: beyond the tolerance
    expect(personsFromMoveNet(far, lb)[0]!.keypoints.nose!.score).toBe(0);
  });

  it("returns nothing for an empty or short tensor", () => {
    expect(personsFromMoveNet(new Float32Array(0), letterbox(640, 480))).toEqual([]);
    expect(personsFromMoveNet(new Float32Array(MOVENET_ROW - 1), letterbox(640, 480))).toEqual([]);
  });
});

describe("rgbaToRgbInt32", () => {
  it("drops alpha and keeps channel order", () => {
    const rgba = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(Array.from(rgbaToRgbInt32(rgba, 2))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reuses a large enough output buffer", () => {
    const buf = new Int32Array(6);
    expect(rgbaToRgbInt32(new Uint8ClampedArray([9, 8, 7, 0, 6, 5, 4, 0]), 2, buf)).toBe(buf);
    expect(Array.from(buf)).toEqual([9, 8, 7, 6, 5, 4]);
  });
});
