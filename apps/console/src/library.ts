import { imageMimeType, packGame, validateGame, type GameDefinition, type GamePackage } from "@playloom/sdk";
import moleMayhem from "../../../games/mole-mayhem/game.json";
import sliceParty from "../../../games/slice-party/game.json";

/** The game library: games that ship with Playloom plus games the family has installed. */

export interface LibraryEntry {
  game: GameDefinition;
  source: "bundled" | "installed";
  /** Picture bytes or URLs by package path (`assets/mole.png`). */
  assets: Map<string, Uint8Array | string>;
  bytes: number;
}

interface StoredGame {
  id: string;
  game: unknown;
  assets: Array<{ file: string; bytes: ArrayBuffer }>;
  installedAt: number;
}

const BUNDLED: Array<[folder: string, data: unknown]> = [
  ["mole-mayhem", moleMayhem],
  ["slice-party", sliceParty],
];
const BUNDLED_URLS = Object.fromEntries(
  Object.entries(import.meta.glob("../../../games/*/assets/*.{png,webp,jpg,jpeg}", { eager: true, query: "?url", import: "default" })).map(
    ([path, url]) => [path.split("/games/")[1]!, url as string],
  ),
);

const DB = "playloom";
const STORE = "games";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Storage is not available"));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const request = run(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        t.onerror = t.onabort = () => {
          db.close();
          reject(t.error ?? new Error("Storage failed"));
        };
      }),
  );
}

export function bundledGames(): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  for (const [folder, data] of BUNDLED) {
    // Bundled games pass through the same validator as everyone else's.
    const result = validateGame(data);
    if (!result.ok) {
      console.error(`Bundled game ${folder} is invalid`, result.issues);
      continue;
    }
    const assets = new Map<string, string>();
    for (const asset of result.game.assets ?? []) {
      const url = BUNDLED_URLS[`${folder}/${asset.file}`];
      if (url) assets.set(asset.file, url);
    }
    out.push({ game: result.game, source: "bundled", assets, bytes: 0 });
  }
  return out;
}

/** Installed games. Stored data is validated again on the way out; anything invalid is skipped. */
export async function installedGames(): Promise<LibraryEntry[]> {
  let stored: StoredGame[];
  try {
    stored = await tx("readonly", (s) => s.getAll() as IDBRequest<StoredGame[]>);
  } catch (err) {
    console.warn("Installed games are unavailable", err);
    return [];
  }
  const out: LibraryEntry[] = [];
  for (const item of stored) {
    const result = validateGame(item.game);
    if (!result.ok) continue;
    const assets = new Map<string, Uint8Array>();
    let bytes = 0;
    for (const a of item.assets ?? []) {
      assets.set(a.file, new Uint8Array(a.bytes));
      bytes += a.bytes.byteLength;
    }
    out.push({ game: result.game, source: "installed", assets, bytes });
  }
  return out.sort((a, b) => a.game.meta.name.localeCompare(b.game.meta.name));
}

export async function installGame(pkg: GamePackage): Promise<void> {
  const stored: StoredGame = {
    id: pkg.game.meta.id,
    game: pkg.game,
    assets: [...pkg.assets].map(([file, bytes]) => ({ file, bytes: bytes.slice().buffer })),
    installedAt: Date.now(),
  };
  await tx("readwrite", (s) => s.put(stored));
}

export async function removeGame(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

/** Load an entry's pictures for the renderer. Missing or broken pictures are simply left out. */
export function loadImages(entry: LibraryEntry): { images: Map<string, HTMLImageElement>; release: () => void } {
  const images = new Map<string, HTMLImageElement>();
  const urls: string[] = [];
  for (const asset of entry.game.assets ?? []) {
    const data = entry.assets.get(asset.file);
    if (!data) continue;
    let url: string;
    if (typeof data === "string") url = data;
    else {
      url = URL.createObjectURL(new Blob([data.slice().buffer], { type: imageMimeType(asset.file) }));
      urls.push(url);
    }
    const img = new Image();
    img.onload = () => images.set(asset.id, img);
    img.src = url;
  }
  return { images, release: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

/** Build a `.playloom` file from a library entry, fetching bundled pictures as needed. */
export async function exportGame(entry: LibraryEntry): Promise<Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const [file, data] of entry.assets) {
    if (typeof data !== "string") assets.set(file, data);
    else {
      try {
        const response = await fetch(data);
        if (response.ok) assets.set(file, new Uint8Array(await response.arrayBuffer()));
      } catch {
        // A picture that cannot be read is left out; the game falls back to shapes.
      }
    }
  }
  return packGame({ game: entry.game, assets });
}
