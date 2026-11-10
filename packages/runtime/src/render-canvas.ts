import { EFFECT_SECONDS, type GameRuntime, type LiveObject } from "./runtime";

/** Colours for player cursors; the same on every screen so children learn "I am orange". */
export const PLAYER_COLORS: Record<number, string> = { 1: "#ff9f1c", 2: "#3ec5ff", 3: "#7bd389", 4: "#ff6b9d" };

export interface CanvasRenderOptions {
  /** A camera picture to show faintly behind the game, already mirrored or not as `mirror` says. */
  video?: HTMLVideoElement | null;
  mirror?: boolean;
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
  const video = options.video;
  if (video && video.readyState >= 2 && video.videoWidth > 0) {
    // Players see themselves faintly, which makes aiming far easier. The picture is stretched to
    // the scene so that it lines up exactly with the hand cursors, which use the same mapping.
    ctx.save();
    ctx.globalAlpha = 0.28;
    if (options.mirror ?? true) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
  }

  const objects = [...runtime.objects].filter((o) => o.visible && o.type !== "timer").sort((a, b) => a.layer - b.layer);
  for (const o of objects) {
    if (o.type === "sprite") drawSprite(ctx, o);
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

  for (const c of runtime.cursors()) {
    const r = H * 0.035;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = PLAYER_COLORS[c.player] ?? "#fff";
    ctx.fill();
    ctx.lineWidth = r * 0.16;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fillStyle = "#10131c";
    ctx.font = `bold ${r}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(c.player), c.x, c.y + r * 0.06);
  }
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawSprite(ctx: CanvasRenderingContext2D, o: LiveObject): void {
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rotation) ctx.rotate((o.rotation * Math.PI) / 180);
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

function drawText(ctx: CanvasRenderingContext2D, o: LiveObject, text: string): void {
  ctx.font = `bold ${o.size}px system-ui, sans-serif`;
  ctx.textAlign = o.align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = o.size * 0.16;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.strokeText(text, o.x, o.y);
  ctx.fillStyle = o.color;
  ctx.fillText(text, o.x, o.y);
}
