import { EFFECT_SECONDS, type GameRuntime, type LiveObject } from "./runtime";

/** Colours for player cursors; the same on every screen so children learn "I am orange". */
export const PLAYER_COLORS: Record<number, string> = { 1: "#ff9f1c", 2: "#3ec5ff", 3: "#7bd389", 4: "#ff6b9d" };

const BACKDROP_ALPHA = { off: 0, faint: 0.2, strong: 0.5 } as const;
const FONT = 'system-ui, "Segoe UI", Roboto, "Noto Sans", sans-serif';

export interface CanvasRenderOptions {
  /** A camera picture to show faintly behind the game, already mirrored or not as `mirror` says. */
  video?: HTMLVideoElement | null;
  mirror?: boolean;
  /**
   * How strongly the camera picture shows behind the game. "off" skips drawing it altogether.
   * When omitted the picture is drawn at its original strength (used by the developer playground).
   */
  backdrop?: "off" | "faint" | "strong";
  /** Loaded pictures by asset id. Anything missing falls back to the sprite's shape and colour. */
  images?: ReadonlyMap<string, CanvasImageSource>;
}

/**
 * Draw the current state of a game onto a 2D canvas, scaled to fit with the scene's proportions kept.
 * Canvas 2D is the baseline renderer: it works on every device Playloom targets.
 */
export function renderToCanvas(ctx: CanvasRenderingContext2D, runtime: GameRuntime, options: CanvasRenderOptions = {}): void {
  const { width: CW, height: CH } = ctx.canvas;
  const [W, H] = runtime.scene.size;
  const scale = Math.min(CW / W, CH / H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, CW, CH);
  ctx.setTransform(scale, 0, 0, scale, (CW - W * scale) / 2, (CH - H * scale) / 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  ctx.fillStyle = runtime.scene.background;
  ctx.fillRect(0, 0, W, H);
  const backdrop = runtime.scene.backgroundImage && options.images?.get(runtime.scene.backgroundImage);
  if (backdrop) ctx.drawImage(backdrop, 0, 0, W, H);
  const video = options.video;
  const backdropAlpha = options.backdrop ? BACKDROP_ALPHA[options.backdrop] : 0.28;
  if (video && backdropAlpha > 0 && video.readyState >= 2 && video.videoWidth > 0) {
    // Players see themselves faintly, which makes aiming far easier. The picture is stretched to
    // the scene so that it lines up exactly with the hand cursors, which use the same mapping.
    ctx.save();
    ctx.globalAlpha = backdropAlpha;
    if (options.mirror ?? true) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
  }

  const objects = [...runtime.objects].filter((o) => o.visible && o.type !== "timer").sort((a, b) => a.layer - b.layer);
  for (const o of objects) {
    if (o.type === "sprite") drawSprite(ctx, o, o.image ? options.images?.get(o.image) : undefined);
    else drawText(ctx, o, runtime.formatText(o.text));
  }

  for (const e of runtime.effects) {
    const t = e.age / EFFECT_SECONDS;
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = e.color;
    ctx.fillStyle = e.color;
    ctx.lineWidth = 6 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius * (0.6 + 1.2 * t), 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const angle = e.seed * 6.283 + (i * Math.PI) / 4;
      const d = e.radius * (0.5 + 2.2 * t);
      ctx.beginPath();
      ctx.arc(e.x + Math.cos(angle) * d, e.y + Math.sin(angle) * d, 7 * (1 - t) + 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  for (const c of runtime.cursors()) drawCursor(ctx, c, H);
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * A hand cursor that can be found at a glance on any picture: a soft halo in the player's colour, a
 * dark outer ring and a white ring for contrast on both light and dark art, the player's number, and a
 * small L or R tag for which hand it is.
 */
function drawCursor(ctx: CanvasRenderingContext2D, c: { player: number; hand: string; x: number; y: number }, H: number): void {
  const color = PLAYER_COLORS[c.player] ?? "#ffffff";
  const r = H * 0.052;
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r * 2.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
  ctx.lineWidth = r * 0.52;
  ctx.strokeStyle = "rgba(8, 10, 28, 0.9)";
  ctx.stroke();
  ctx.lineWidth = r * 0.26;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 ${r * 1.15}px ${FONT}`;
  ctx.fillStyle = "#10131c";
  ctx.fillText(String(c.player), c.x, c.y + r * 0.06);
  // Which hand: a small white tag at the lower right of the cursor.
  const tr = r * 0.42;
  const tx = c.x + r * 0.95;
  const ty = c.y + r * 0.95;
  ctx.beginPath();
  ctx.arc(tx, ty, tr, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = tr * 0.3;
  ctx.strokeStyle = "rgba(8, 10, 28, 0.9)";
  ctx.stroke();
  ctx.fillStyle = "#10131c";
  ctx.font = `800 ${tr * 1.15}px ${FONT}`;
  ctx.fillText(c.hand === "left" ? "L" : "R", tx, ty + tr * 0.05);
  ctx.restore();
}

function drawSprite(ctx: CanvasRenderingContext2D, o: LiveObject, image?: CanvasImageSource): void {
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rotation) ctx.rotate((o.rotation * Math.PI) / 180);
  if (image) {
    ctx.drawImage(image, -o.width / 2, -o.height / 2, o.width, o.height);
    ctx.restore();
    return;
  }
  ctx.fillStyle = o.color;
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = Math.max(2, Math.min(o.width, o.height) * 0.05);
  const w = o.width / 2;
  const h = o.height / 2;
  ctx.beginPath();
  switch (o.shape) {
    case "circle":
      ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
      break;
    case "rect":
      ctx.roundRect(-w, -h, o.width, o.height, Math.min(w, h) * 0.25);
      break;
    case "diamond":
      ctx.moveTo(0, -h);
      ctx.lineTo(w, 0);
      ctx.lineTo(0, h);
      ctx.lineTo(-w, 0);
      ctx.closePath();
      break;
    case "star":
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 1 : 0.45;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx.lineTo(Math.cos(a) * w * r, Math.sin(a) * h * r);
      }
      ctx.closePath();
      break;
  }
  ctx.fill();
  ctx.stroke();
  if (o.glyph) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.min(o.width, o.height) * 0.5}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(o.glyph, 0, 0);
  }
  ctx.restore();
}

/** Text sits on busy art, so it gets a thick dark outline and a soft shadow as well as its own colour. */
function drawText(ctx: CanvasRenderingContext2D, o: LiveObject, text: string): void {
  ctx.save();
  ctx.font = `800 ${o.size}px ${FONT}`;
  ctx.textAlign = o.align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = o.size * 0.26;
  ctx.strokeStyle = "rgba(8, 10, 28, 0.92)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = o.size * 0.18;
  ctx.shadowOffsetY = o.size * 0.06;
  ctx.strokeText(text, o.x, o.y);
  ctx.shadowColor = "transparent";
  ctx.fillStyle = o.color;
  ctx.fillText(text, o.x, o.y);
  ctx.restore();
}
