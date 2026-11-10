# Art prompts for the bundled games

The games already look for the picture files listed below. Until a file exists, the game draws a plain
coloured shape in its place, so you can add pictures one at a time and see each appear.

**Status:** all pictures are in place except `lime.png` for Slice Party, which is still drawn as a plain
green circle. The supplied pictures were AI-generated (ChatGPT) from these prompts.

## How to use these

1. Start one ChatGPT conversation **per game** and paste the *style brief* first. Keeping every picture
   for a game in one conversation is what keeps them looking like a set.
2. Paste the prompts one at a time. If a picture is off, say what to change ("thicker outline", "more
   centred") rather than starting over.
3. Download each picture as a PNG and name it exactly as shown.
4. Put it in the game's `assets` folder. On GitHub: open the folder, **Add file → Upload files**. Once the
   change is on `main`, the web demo rebuilds itself in a few minutes.

Checks before uploading:

- **Sprites must have a truly transparent background.** Open the file: if you see a grey-and-white
  checkerboard *painted into the picture*, ask again for "a real transparent background (alpha channel)".
- The subject should fill most of the square and be centred, with nothing cut off.
- Keep each file under about 1 MB. Asking for "PNG, 1024×1024" is plenty; backgrounds are 1536×1024.
- No text, letters, logos, watermarks or recognisable characters from films, games or brands.

The games stretch each picture into the box listed under *Drawn at*, so round things should be drawn
round and wide things wide.

## Mole Mayhem

Files go in `games/mole-mayhem/assets/`.

**Style brief (paste first)**

> I am making artwork for a children's motion game called Mole Mayhem, played on a TV by two kids
> waving their hands. I will ask for several pictures, one at a time, and they must all look like one
> matching set. Style: friendly hand-drawn cartoon, chunky rounded shapes, thick dark-brown outlines of
> even weight, flat bright colours with one soft shadow tone, no gradients, no realistic textures, no
> text. Everything must read clearly from across a room. Original characters only — nothing that
> resembles an existing cartoon, game or brand. Do not draw anything yet; just confirm the style.

| File | Drawn at | Prompt |
|---|---|---|
| `background.png` | whole screen, 1280×720 | *Landscape image, 1536×1024. A sunny vegetable garden lawn seen from slightly above, in our style. Plain mid-green grass fills the middle and lower two-thirds and must stay calm and uncluttered, because game pieces sit on top of it. Put the detail only around the edges: a wooden fence and a few carrots and cabbages along the top, a watering can in one bottom corner. Keep the top strip fairly dark and simple so white score numbers show up on it. No animals, no holes, no text.* |
| `hole.png` | 190×70 (a wide, flat oval) | *Transparent background, PNG. A single mole hole in a lawn seen from slightly above, in our style: a wide flat oval of dark brown earth with a slightly lighter rim of loose soil and three or four small tufts of grass at the edge. Much wider than it is tall — roughly three times as wide. Fill the full width of the image, centred. Nothing else in the picture.* |
| `mole.png` | 130×130 | *Transparent background, PNG, square. A cheerful cartoon mole popping up, shown from the chest up and facing the viewer, in our style: round brown head, big pink nose, small friendly eyes, two front paws raised in a cheeky wave, a little crumb of soil on its head. Cute and funny, never scared or hurt. Fills the square, centred. Nothing else in the picture.* |
| `gold-star.png` | 140×140 | *Transparent background, PNG, square. A shiny golden star with five chunky rounded points and a happy smiling face, in our style, with two or three small sparkles close around it. Bright yellow-gold with a darker gold outline. Fills the square, centred. Nothing else in the picture.* |

## Slice Party

Files go in `games/slice-party/assets/`. The fruit and the bomb spin as they fly, so they must look right
at any angle — no faces, and no "up".

**Style brief (paste first)**

> I am making artwork for a children's motion game called Slice Party, played on a TV by two kids
> swiping their hands through flying fruit. I will ask for several pictures, one at a time, and they
> must all look like one matching set. Style: bold glossy cartoon, chunky rounded shapes, thick
> dark-navy outlines of even weight, saturated colours with one highlight and one shadow tone, no
> realistic textures, no faces on the fruit, no text. The objects will spin in the air, so draw each one
> as a single whole object seen straight on, with no ground shadow. Everything must read clearly from
> across a room against a dark background. Original designs only — nothing that resembles an existing
> game or brand. Do not draw anything yet; just confirm the style.

| File | Drawn at | Prompt |
|---|---|---|
| `background.png` | whole screen, 1280×720 | *Landscape image, 1536×1024. A cosy party kitchen at night in our style, deliberately dark and low in contrast so bright fruit stands out in front of it: deep navy and purple walls, a string of softly glowing paper lanterns across the top, the dim outline of shelves and a counter along the bottom edge. The whole middle of the picture must be plain and empty. No people, no fruit, no text.* |
| `melon.png` | 120×120 | *Transparent background, PNG, square. One whole round watermelon in our style: bright green with darker green stripes and a glossy highlight. A perfect circle that fills the square, centred. No slice cut out, no face, no shadow.* |
| `lime.png` | 96×96 | *Transparent background, PNG, square. One whole round lime in our style: bright yellow-green with a dimpled glossy skin and a small highlight. A perfect circle that fills the square, centred. No leaf, no face, no shadow.* |
| `starfruit.png` | 124×124 | *Transparent background, PNG, square. One slice of starfruit seen face-on in our style: a five-pointed star with rounded points, golden yellow with a paler centre and five tiny seeds. Fills the square, centred. No face, no shadow.* |
| `bomb.png` | 104×104 | *Transparent background, PNG, square. A comic "do not touch" party popper bomb in our style, clearly a joke object and not frightening: a round dark-charcoal ball with a short stubby fuse and a small orange spark, and a bold red band around its middle. Must look obviously different from the fruit at a glance. Fills the square, centred. No face, no text, no shadow.* |

## Licence and credit

The bundled games declare their art as CC BY-SA 4.0. Pictures you generate and commit are being
contributed under that licence. Two things to know:

- OpenAI's terms assign you the rights they have in what you generate, but in several countries
  purely AI-generated images may not be protected by copyright at all. That does not stop Playloom
  using them; it means others may be free to reuse them regardless of the licence.
- Please keep a note of which pictures were AI-generated (a line in the commit message is enough), so
  the project can say so honestly.
