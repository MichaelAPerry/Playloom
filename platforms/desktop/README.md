# Playloom desktop shell

The Windows and Linux application: an [Electron](https://www.electronjs.org) window that shows the
Console full screen. It is kept outside the pnpm workspace so that ordinary development does not
download Electron.

From the repository root, build the Console first:

```bash
pnpm install
```

```bash
pnpm fetch-models
```

```bash
pnpm build
```

Then, in this folder:

```bash
npm ci
```

```bash
npm start
```

`npm run dist` produces installers in `release/` for the operating system it is run on (an installer and
a portable `.exe` on Windows, an AppImage on Linux). The **Desktop release** workflow on GitHub does the
same on both systems and attaches the files to the run.

Keys: `F11` toggles full screen, `Alt+F4` closes. Start with `--windowed` to run in a window.

What the shell enforces is described at the top of `main.cjs`: no Node.js access for the page, camera
permission only, and every network request refused.
