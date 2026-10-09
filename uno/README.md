# UNO Ultra: a 3D tabletop UNO

A 3D UNO game built with Three.js, HTML, CSS and plain JavaScript (ES modules, no build step).
You play against 1–5 AI opponents in **Standard Mode** (classic UNO with house rules you can toggle)
or **Chaos Mode** (chaos cards, random events and HERO cards).

## Run it

The game is static files, but browsers need a local web server for ES modules:

```bash
cd uno
npx http-server -c-1 -p 8080 .    # or: python3 -m http.server 8080
# open http://localhost:8080
```

Three.js 0.160.0 and the fonts load from CDNs, so you need an internet connection.

## Controls

- Click a highlighted card or drag it onto the table to play it. On touch screens, tap once to lift a card and tap again to play it.
- Click the deck (or press **Space**/**D**) to draw. **U** calls UNO, **K** keeps a drawn card, **C** challenges a +4 and **Esc** pauses.
- Out-of-turn buttons appear when they apply: **Catch!** (someone forgot UNO), **MERCY!** (Chaos), and Jump-In (click an identical card).

## Modes

### Standard Mode
Classic UNO: 7 cards each; match by color, number or symbol; draw one card if you can't play.
Skip, Reverse, Draw Two, Wild and Wild Draw Four work as usual, an illegal +4 can be challenged,
you call UNO at one card (or draw 2 if caught), and points are scored.

House rules can be toggled on the setup screen. The default preset turns on the first three:

| Rule | What it does |
|---|---|
| Progressive UNO | Stack +2 on +2 and +4 on +4 (no mixing). Whoever can't or won't stack draws the whole penalty. |
| Jump-In | Play an identical card out of turn. Play continues from you. |
| Seven-O | A 7 swaps hands with a player you choose. A 0 passes every hand along in the direction of play. |
| Draw Until Playable | Keep drawing until you get a playable card. |
| Force Play | A playable drawn card must be played. |
| Jump-In UNO | You may win by jumping in with your last card. |
| Stacking Challenges | The latest +4 in a stack can be challenged. |

### Chaos Mode
- **Chaos Meter**: action cards fill it, and when it's full a random **Chaos Event** fires:
  Draw Apocalypse, Reverse Reality, Color Collapse, Hand Heist, UNO Roulette, Wild Storm,
  Card Explosion, Time Crisis, Hand Swap or Total Anarchy.
- **Chaos cards**: +10, Everyone Draw +4, Ultimate Reverse, Steal Three, Color Lock, Hand Destroyer,
  Chaos Wild, Mirror, Shuffle Hands and Last Stand. Stacks can escalate (+2 → +4 → +10) and a Mirror reflects any stack.
- **Mercy**: when one player has exactly 1 card while another has 20 or more, anyone except the 1-card player
  can call Mercy. Both players are knocked out and their cards are dealt evenly to everyone still in.
- **Overload**: reaching 30 cards knocks you out. Without this rule, simulated Chaos games could run forever.
- **HERO cards**: one copy of each hero is shuffled into the Chaos deck. Heroes are never dealt, so you can
  only find one by drawing. Each player can get and use **one** per match. A HERO plays like a Wild, can't be
  stolen or swapped, and leaves the match after use.
  - **Superman, Super Speed**: take 4 extra turns in a row. Nobody can interrupt.
  - **Captain America, Vibranium Shield**: for one round, draw stacks, Skips and attacks aimed at you
    bounce back to the attacker. You can also play it in response to a draw stack.
  - **Sentry, A Million Exploding Suns**: every opponent draws 15. Your hand is set aside and you hold
    one golden card. If it exactly matches the top card (number and color) when your turn comes round, you win.
    Otherwise your hand comes back.
  - **Thor, Mjolnir's Wrath**: opponents draw +4, +8, +12… in turn order, and each loses their next turn.

  The hero visuals are original procedural designs, not official artwork.

## AI opponents
There are five personalities (Strategist, Aggressor, Trickster, Opportunist, Mastermind) and four
difficulty levels. The AI only uses public information: card counts, the discard pile and what it has
seen happen. Hard and Expert AIs count cards and track which colors each opponent seems to be missing.
The Expert Mastermind also runs Monte Carlo simulations, guessing at hidden hands from that public
information and playing out each candidate move before choosing.

## Code layout

| File | Role |
|---|---|
| `js/cards.js` | Card definitions, deck building, HERO roster |
| `js/engine.js` | Rules engine (no rendering): validates every action and emits events |
| `js/ai.js`, `js/lookahead.js` | AI personalities, opponent modeling, Monte Carlo look-ahead |
| `js/render.js` | Three.js scene: card meshes, environments, lighting, post-processing, animation, input |
| `js/hero.js` | HERO cinematics and effects |
| `js/textures.js` | Procedurally drawn card faces, backs, felt, wood, leather and normal maps |
| `js/audio.js` | Synthesized sound effects, room ambience and adaptive Chaos music |
| `js/ui.js`, `css/style.css` | Menus, HUD, seat labels and pop-up dialogs |
| `js/main.js` | Game controller: runs every action through a single queue so turns can't overlap |

## Tests

```bash
cd uno
npm test        # rule unit tests + full AI-vs-AI simulation
node tests/rules.test.js               # fast: 40 targeted rule tests
GAMES=300 node tests/simulate.test.js  # fewer simulated games
```

The simulation plays thousands of complete games across every house-rule combination and Chaos Mode.
After every action it checks that no card was lost or duplicated, that turn order is valid,
that no game stalls, and that rules don't leak between modes.
