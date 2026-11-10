# Game packages (`.playloom`)

A `.playloom` file is how a game travels: one file holding the game definition and its pictures. It
runs unchanged in the browser, the desktop app and, later, on Android.

## Contents

A package is a ZIP archive containing exactly:

```
game.json                 the game definition — see game-format.md
assets/<name>.png         pictures the game lists in "assets"
assets/<name>.webp|.jpg|.jpeg
```

Version information lives in `game.json` (`formatVersion` for the format, `meta.version` for the game),
along with the game's hardware requirements (`requires`), author and licence. There is no separate
manifest file: one source of truth cannot disagree with itself.

## Making one

- In the Console: **Settings → Games → Save a copy** writes any installed or bundled game as a package.
- By hand: put `game.json` and an `assets` folder into a ZIP and rename it to end in `.playloom`.
- In code: `packGame()` from `@playloom/sdk`.

## What happens on install

A package is treated as hostile until checked. A ZIP is only a container and provides no safety by
itself, so `unpackGame()` verifies all of the following **before anything is stored**:

| Check | Limit |
|---|---|
| Package file size | 40 MB |
| Number of files | 201 |
| One picture, unpacked | 8 MB |
| Everything, unpacked | 80 MB |
| File names | Only `game.json` and `assets/<letters, digits, - _>.<png, webp, jpg, jpeg>` — anything else rejects the whole package, including scripts, HTML, SVG, sub-folders and `..` paths |
| Picture contents | The first bytes must match the type the name claims |
| `game.json` | Must be UTF-8 and pass the full game validator |
| Unlisted files | A picture not named in the game's `assets` rejects the package |

Declared sizes are checked before unpacking and actual sizes after, so an archive that lies about its
contents (a "ZIP bomb") is refused without being expanded.

Pictures listed by the game but missing from the package are allowed; the game draws shapes instead.

Then the Console shows the game's name, version, author, licence and size and asks for permission.
Nothing in a package is ever executed: games are rules interpreted by the runtime, and the format has no
way to express running code, reading files or contacting a server.

## Not yet supported

Sound files, sprite animation, and the advanced JavaScript extension tier with its permission model
(Milestone 6). Packages containing anything of the kind are rejected today rather than partly loaded.
