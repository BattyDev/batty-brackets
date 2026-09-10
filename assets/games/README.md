# Game artwork

Drop licensed artwork for a game in `assets/games/<game-id>/`, then name the
files in that game's `assets` block in `brackets/data/themes.js`. The drawn
artwork in `themes.js` is the fallback and stays in use until you do.

```
assets/games/tokon/
  hero.jpg     1600x600 or wider — sits behind the event and wizard banners
  logo.svg     transparent, light-on-dark
  icon.png     square, 128px or larger
```

```js
// brackets/data/themes.js
tokon: {
  assets: {
    hero: 'hero.jpg',
    logo: 'logo.svg',
    icon: null,
    characters: null,
    credit: '© Marvel / PlayStation Studios — used with permission',
  },
}
```

The hero already sits behind a scrim sized for a busy photograph, so nothing
else needs changing.

## Before you put anything here

**This repository ships no publisher artwork, on purpose.**

There is no official Marvel Tōkon fan kit or press kit. Marvel Games and
PlayStation Studios publish screenshots and trailers through their own
channels, but neither offers a downloadable asset pack with usage terms
attached. Marvel character art is Disney IP, and a third-party tournament site
redistributing it is a licensing question — not a fair-use one you can reason
your way into.

Roughly in order of how likely each is to actually be usable:

1. **Ask the publisher.** An organiser asking Marvel Games or PlayStation
   Partners for promotional assets for a community tournament is an ordinary
   request and is sometimes granted in writing. Written permission is the only
   version of this that is genuinely safe. Keep the email.
2. **Check for a press kit.** Publishers often add one after launch. If it
   exists, read the terms rather than assuming: most permit editorial and
   community use with attribution, and some exclude sites that take money —
   which a bracket site charging entry fees may count as.
3. **Commission or draw your own.** No permission needed. It is what the
   current artwork is.

Set `credit` whenever you use someone else's asset; it renders in the corner of
the hero.

Naming a game is a separate matter and is not what any of this is about — using
a game's name to say which game a tournament is for is nominative use.

## Why the directories are empty

Git does not track empty directories, so each carries a `.gitkeep`. The slot is
meant to be obvious even before anything is in it.
