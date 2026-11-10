import type { KeypointName, MotionApi, PlayerState } from "@playloom/core";

export const PLAYER_COLORS: Record<number, string> = { 1: "#ff9f1c", 2: "#3ec5ff", 3: "#7bd389", 4: "#ff6b9d" };

const BONES: Array<[KeypointName, KeypointName]> = [
  ["leftShoulder", "rightShoulder"],
  ["leftShoulder", "leftElbow"],
  ["leftElbow", "leftWrist"],
  ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightWrist"],
  ["leftShoulder", "leftHip"],
  ["rightShoulder", "rightHip"],
  ["leftHip", "rightHip"],
  ["leftHip", "leftKnee"],
  ["leftKnee", "leftAnkle"],
  ["rightHip", "rightKnee"],
  ["rightKnee", "rightAnkle"],
];

export interface DrawOptions {
  video: HTMLVideoElement | null;
  mirror: boolean;
  overlay: boolean;
  /** Simulated player the mouse controls, or 0 when the simulator is not in use. */
  selectedSimPlayer: number;
}

export function draw(ctx: CanvasRenderingContext2D, api: MotionApi, o: DrawOptions): void {
  const { width: W, height: H } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  if (o.video && o.video.readyState >= 2) {
    // Fit the camera picture inside the stage, flipped when mirroring.
    const scale = Math.min(W / o.video.videoWidth, H / o.video.videoHeight);
    const w = o.video.videoWidth * scale;
    const h = o.video.videoHeight * scale;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    if (o.mirror) ctx.scale(-1, 1);
    ctx.globalAlpha = 0.75;
    ctx.drawImage(o.video, -w / 2, -h / 2, w, h);
    ctx.restore();
    // Player coordinates are relative to the camera picture, not the letterboxed stage.
    ctx.setTransform(w / W, 0, 0, h / H, (W - w) / 2, (H - h) / 2);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#1d2233");
    g.addColorStop(1, "#10131c");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#262c40";
    ctx.fillRect(0, H * 0.96, W, H * 0.04);
  }

  // Centre line: each player's side during setup.
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.setLineDash([10, 14]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const player of api.players.all()) {
    if (!player.present) continue;
    drawPlayer(ctx, player, o, W, H);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerState, o: DrawOptions, W: number, H: number): void {
  const color = PLAYER_COLORS[p.id] ?? "#fff";
  const uncertain = p.identity === "uncertain";
  ctx.globalAlpha = uncertain ? 0.55 : 1;

  if (o.overlay && p.skeleton) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    for (const [a, b] of BONES) {
      const ka = p.skeleton[a];
      const kb = p.skeleton[b];
      if (!ka || !kb) continue;
      ctx.beginPath();
      ctx.moveTo(ka.x * W, ka.y * H);
      ctx.lineTo(kb.x * W, kb.y * H);
      ctx.stroke();
    }
    const nose = p.skeleton.nose;
    const ls = p.skeleton.leftShoulder;
    const rs = p.skeleton.rightShoulder;
    if (nose && ls && rs) {
      ctx.beginPath();
      ctx.arc(nose.x * W, nose.y * H, Math.hypot((ls.x - rs.x) * W, (ls.y - rs.y) * H) * 0.32, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Hand cursors: the Milestone 1 acceptance criterion, one pair per player.
  for (const [hand, label] of [[p.leftHand, "L"], [p.rightHand, "R"]] as const) {
    if (!hand) continue;
    const x = hand.x * W;
    const y = hand.y * H;
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.fillStyle = "#10131c";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${p.id}${label}`, x, y + 1);
  }

  if (p.bodyPosition) {
    const x = p.bodyPosition.x * W;
    const y = Math.max(46, p.bodyPosition.y * H - 150);
    const active = Object.entries(p.gestures).filter(([, on]) => on).map(([name]) => name);
    const tag = `Player ${p.id}${o.selectedSimPlayer === p.id ? " ◂ mouse" : ""}${uncertain ? " ?" : ""}`;
    ctx.font = "bold 24px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(tag).width + 24;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 18, w, 36, 18);
    ctx.fill();
    ctx.fillStyle = "#10131c";
    ctx.fillText(tag, x, y + 1);
    if (active.length > 0) {
      ctx.font = "600 20px system-ui, sans-serif";
      ctx.fillStyle = "#fff";
      ctx.fillText(active.join(" · "), x, y - 34);
    }
    if (Math.abs(p.lean) > 0.05) {
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.fillRect(x - 60, y + 24, 120, 6);
      ctx.fillStyle = color;
      ctx.fillRect(x, y + 24, p.lean * 60, 6);
    }
  }
  ctx.globalAlpha = 1;
}
