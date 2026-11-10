# Playloom game format — version 1

A Playloom game is a JSON document. The runtime interprets it; nothing in it is executed as code.
Studio will edit this same structure, and the Console will play it — there is one format and one runtime.

The authoritative definitions are the TypeScript types in `packages/sdk/src/format.ts` and the validator
in `packages/sdk/src/validate.ts` (both MIT-licensed). The bundled games in `games/` are complete
examples.

Status: implemented with built-in shapes and sounds, plus image assets for sprites and backgrounds.
**Not yet implemented:** audio assets, sprite animation and a published JSON Schema file. Games travel
as [`.playloom` packages](game-packages.md). These are planned and will be additive.

## Pictures

```jsonc
"assets": [{ "id": "mole", "type": "image", "file": "assets/mole.png" }]
```

A sprite uses a picture with `"image": "mole"`; a scene with `"backgroundImage": "background"`. `file`
must be `assets/<name>` with a `.png`, `.webp`, `.jpg` or `.jpeg` ending — a game cannot refer to a web
address or to a file outside its own folder. If a picture is missing or fails to load, the sprite's
`shape` and `color` are drawn instead, so those are always required.

## Shape of a game

```jsonc
{
  "formatVersion": 1,
  "meta": { "id": "org.example.my-game", "name": "My Game", "version": "1.0.0", "mode": "competitive" },
  "requires": { "players": { "min": 2, "max": 2 }, "tracking": "hands" },
  "variables": [{ "id": "goal", "initial": 300 }],
  "startScene": "main",
  "scenes": [
    { "id": "main", "size": [1280, 720], "background": "#232842",
      "objects": [ … ], "templates": [ … ], "rules": [ … ] }
  ]
}
```

- `meta.mode` is `competitive` or `cooperative`. Optional: `description`, `author`, `license`.
- `requires.tracking` is `hands` (works in Lite mode) or `skeleton`. A game that uses body gestures other
  than `swipe` must declare `skeleton`; the validator enforces this.
- Positions and sizes are in scene units. The runtime scales the scene to the screen.

## Objects

Every object has `id`, `type`, `x`, `y`, and optionally `layer`, `visible` and `tags`.

| Type | Properties |
|---|---|
| `sprite` | `width`, `height`, `shape` (`circle`, `rect`, `star`, `diamond`), `color`; optional `glyph` (a few characters drawn on it), `collider`, `vx`, `vy`, `gravity`, `spin`, `rotation` |
| `text` | `text`, `size`, `color`; optional `align`. Text may contain `{score:1}`, `{score:total}`, `{var:name}`, `{timer:id}` |
| `timer` | `seconds`; optional `autostart` (default true). Counts down. |

`templates` are objects that do not exist until a `spawn` action makes copies of them.

## Rules

```jsonc
{ "name": "A player bonks a mole",
  "when": { "type": "hand-touches", "player": "any", "object": { "tag": "mole" } },
  "if":   [ { "type": "compare", "left": { "timer": "clock" }, "op": ">", "right": 0 } ],
  "then": [ { "do": "add-score", "player": "$player", "amount": 10 },
            { "do": "hide", "object": "$object" },
            { "do": "play-sound", "sound": "bonk" } ] }
```

### Triggers (`when`)

| Type | Fires | Provides |
|---|---|---|
| `scene-start` | When the scene begins | |
| `every` | Every `seconds`, optionally varied by `jitter` | |
| `hand-touches` | When a hand of `player` (a number or `any`) moves onto a visible sprite; optional `hand`, and `minSpeed` for slicing | `$player`, `$object` |
| `gesture` | When `player` starts `gesture` (`jump`, `duck`, `handsUp`, `leftHandRaised`, `rightHandRaised`, `leanLeft`, `leanRight`, `swipe`) | `$player` |
| `timer-ends` | When timer `timer` reaches zero | |
| `collision` | When sprites `a` and `b` start to overlap | `$object`, `$other` |
| `leaves-scene` | When a sprite moves out of the scene (spawned sprites are then removed) | `$object` |
| `when-true` | When `condition` becomes true | |

### Conditions (`if`)

`compare` (`left`, `op` one of `== != < <= > >=`, `right`), `all`, `any`, `not`.

### Actions (`then`)

`add-score` · `set-variable` · `change-variable` · `play-sound` · `spawn` · `destroy` · `show`
(optionally `forSeconds`) · `hide` · `set-property` · `set-text` · `effect` · `start-timer` · `stop-timer`
· `go-to-scene` · `end-game` (`highest-score`, `team-win`, `team-lose`).

Built-in sounds: `pop`, `bonk`, `ding`, `buzz`, `whoosh`, `win`, `lose`, `tick`.

### Referring to objects and players

| Reference | Means |
|---|---|
| `"mole-1"` | The object with that id |
| `"$object"`, `"$other"` | The object(s) that set off the rule |
| `{ "tag": "mole" }` | Every object with that tag |
| `{ "random": { "tag": "mole", "state": "hidden" } }` | One such object chosen at random |
| `"$player"` | The player who set off the rule |

### Values

A number, or one of: `{ "var": "goal" }`, `{ "score": 1 }`, `{ "score": "$player" }`,
`{ "score": "total" }`, `{ "timer": "clock" }`, `{ "random": [min, max] }`,
`{ "prop": ["$object", "x"] }`, `{ "op": "+", "args": [a, b] }` (`+ - * / min max`).

## Safety

Game files are untrusted. The validator:

- accepts only the vocabulary above — **any unknown property, trigger or action is an error**;
- checks every reference (scenes, objects, tags, timers, templates, variables) and that `$player` /
  `$object` are only used where the trigger provides them;
- requires colours to be plain hex values and numbers to be finite and in range;
- enforces limits: 2 MB of JSON, 50 scenes, 500 objects and 500 rules per scene, 50 actions per rule,
  expression nesting of 8.

The runtime additionally caps live objects at 300 and has no action that reads files, opens network
connections or evaluates text as code. Division by zero yields 0.

## Versioning

`formatVersion` is an integer. Additions that old games do not need keep version 1. A change that
alters the meaning of existing games will become version 2 and ship with a migration; the runtime
refuses versions it does not know rather than guessing.
