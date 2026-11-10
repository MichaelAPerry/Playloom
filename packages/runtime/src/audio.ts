import type { SoundId } from "@playloom/sdk";
import type { AudioPlayer } from "./runtime";

/**
 * Built-in sounds, synthesised with Web Audio. Games can make noise without shipping audio files,
 * and every sound here is original to Playloom.
 */

interface Tone {
  wave: OscillatorType | "noise";
  /** Start and end frequency in hertz. */
  from: number;
  to: number;
  seconds: number;
  volume: number;
  /** Seconds after the sound starts. */
  delay?: number;
}

const SOUNDS: Record<SoundId, Tone[]> = {
  pop: [{ wave: "sine", from: 520, to: 880, seconds: 0.09, volume: 0.5 }],
  bonk: [{ wave: "triangle", from: 220, to: 90, seconds: 0.16, volume: 0.7 }],
  ding: [
    { wave: "sine", from: 1320, to: 1320, seconds: 0.35, volume: 0.35 },
    { wave: "sine", from: 1980, to: 1980, seconds: 0.25, volume: 0.15 },
  ],
  buzz: [{ wave: "sawtooth", from: 140, to: 110, seconds: 0.3, volume: 0.35 }],
  whoosh: [{ wave: "noise", from: 2400, to: 500, seconds: 0.18, volume: 0.35 }],
  tick: [{ wave: "square", from: 900, to: 900, seconds: 0.03, volume: 0.2 }],
  win: [
    { wave: "triangle", from: 523, to: 523, seconds: 0.14, volume: 0.45 },
    { wave: "triangle", from: 659, to: 659, seconds: 0.14, volume: 0.45, delay: 0.13 },
    { wave: "triangle", from: 784, to: 784, seconds: 0.14, volume: 0.45, delay: 0.26 },
    { wave: "triangle", from: 1047, to: 1047, seconds: 0.4, volume: 0.45, delay: 0.39 },
  ],
  lose: [
    { wave: "triangle", from: 392, to: 392, seconds: 0.2, volume: 0.4 },
    { wave: "triangle", from: 311, to: 311, seconds: 0.2, volume: 0.4, delay: 0.2 },
    { wave: "triangle", from: 262, to: 196, seconds: 0.45, volume: 0.4, delay: 0.4 },
  ],
};

export class WebAudioPlayer implements AudioPlayer {
  volume = 0.8;
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  /** Browsers only allow sound after the user has interacted with the page; call this from a click or key press. */
  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      void this.ctx.resume();
    } catch {
      this.ctx = null; // No audio device: play silently.
    }
  }

  play(sound: SoundId): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || this.volume <= 0) return;
    for (const tone of SOUNDS[sound]) {
      const start = ctx.currentTime + (tone.delay ?? 0);
      const end = start + tone.seconds;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(tone.volume * this.volume, start);
      gain.gain.exponentialRampToValueAtTime(0.001, end);
      gain.connect(ctx.destination);
      if (tone.wave === "noise") {
        const source = ctx.createBufferSource();
        source.buffer = this.noiseBuffer(ctx);
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass";
        filter.frequency.setValueAtTime(tone.from, start);
        filter.frequency.exponentialRampToValueAtTime(tone.to, end);
        source.connect(filter).connect(gain);
        source.start(start);
        source.stop(end);
      } else {
        const osc = ctx.createOscillator();
        osc.type = tone.wave;
        osc.frequency.setValueAtTime(tone.from, start);
        if (tone.to !== tone.from) osc.frequency.exponentialRampToValueAtTime(tone.to, end);
        osc.connect(gain);
        osc.start(start);
        osc.stop(end);
      }
    }
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      this.noise = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }
}
