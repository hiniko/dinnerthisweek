# Dinner This Week

A single-page, game-show-style meal planner. Load your Recipe Keeper export, say
how much energy you have each evening, hit **SPIN THE WEEK**, and each day's reel
spins up a main that fits — plus a side or dessert where you asked for one, no
repeats within the week. Export the result as a PDF with a shopping list.

No server, no build step, no dependencies. Three static files.

## Layout

A two-tier sticky header: the title on its own row, then a flow row with
**⚙ Settings** on the left and the three steps on the right —
**① Recipes › ② Your Week › ③ Spin** — numbered and chevron-separated so they read
as a progression rather than unrelated tabs. The current step is gold, completed
steps cyan. Each section ends with a "Next:" button, and only one section renders
at a time, so each view fits a phone screen instead of one long scroll. Tapping
Spin when already on that step starts the spin.

Settings is a screen of its own, off to the side of the flow rather than a fourth
step; "done" returns you to whichever step you left.

Every day starts at `???`. On spin, all reels run at once as vertical
slot-machine strips, blurring at speed and decelerating to a stop in sequence.
`↻` re-spins a single course on a single day without disturbing the rest.

## Settings

| Setting | Effect |
|---|---|
| **Measurements** | Metric (g, kg, ml, l) or Imperial (oz, lb, fl oz, pt). Display only — totals are calculated identically either way, and imperial rounds to the nearest quarter since converted figures land on arbitrary decimals. |
| **Combine similar names** | How eagerly the shopping list merges near-identical ingredients: exact / balanced / merge more. The guard words hold at every level. |
| **Sides & desserts up to** | The complexity ceiling for extras. |
| **Sound effects** | Reel ticks and fanfare. |
| **Confetti** | The celebration when a week lands. |

Fields are declared in one table (`SETTING_FIELDS`), so adding a preference is one
entry there plus a default — the screen builds itself.

## Run it

Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000   # then http://localhost:8000
```

## Deploy

**GitHub Pages** — push the repo, then Settings → Pages → deploy from branch
root. Nothing else to configure.

**Container** — any static file server will do:

```dockerfile
FROM nginx:alpine
COPY index.html app.css app.js example.zip /usr/share/nginx/html/
```

## Recipes

The app starts empty: drop a **Recipe Keeper export** (`.zip`, or the
`recipes.html` inside it) on the Recipe Pool tab. It's parsed in the browser —
nothing is uploaded, and it works offline.
"Try the example recipes" loads the bundled `example.zip` (needs http, not `file://`).

The pool is then cached in `localStorage`, so a second visit skips the upload
entirely. Only what the app uses is kept — names, courses, times, ingredients and
a step count. Photos, directions text and the raw HTML are all discarded, which
is what keeps it small: **a 6.8 MB / 105-recipe export caches as ~48 KB**, about
1% of the usual 5 MB quota. If the quota is ever exceeded the app keeps working
and falls back to saving settings only.

Re-importing a grown export keeps the corrections you've made — a hand-set
course, a hand-set complexity, a benched recipe — and recomputes everything else
from the new data. "clear pool" starts over.

## Courses

Recipe Keeper's own `recipeCourse` tag decides what a recipe can be rolled as:

| Export tag | Rolled as |
|---|---|
| Main Dish, Main Course, Entree | **Main** |
| Side Dish, Appetizer, Starter, Salad | **Side** |
| Dessert, Pudding, Baking | **Dessert** |
| anything else, or blank | **not rolled** |

So Breakfast, Snack, Sauces — and the Medicine / Cosmetics / Baby Food entries a
real library accumulates — are listed but never served for dinner. Unmapped
recipes show the export's own tag (`tagged "Medicine"`) as a cue, and every
recipe has a **Course** dropdown to correct it once. Corrections persist.

Only **mains** are rolled by default. Sides and desserts are rolled per day, when
that day's `+ side` / `+ dessert` box is ticked. A toggle is disabled outright if
the pool has nothing of that course, so it can never promise a course it can't
fill.

Use the course filter and search to navigate a large pool.

## Complexity

Each recipe gets an effort score in "effective minutes":

```
prep + cook  +  1.5 × (ingredients beyond 6)  +  0.8 × (steps beyond 5)
```

bucketed into **Zero effort** (≤20), **Easy** (≤45), **Medium** (≤75),
**Hard** (≤120), **Project** (above). Thresholds were calibrated against a real
export.

Recipe Keeper often exports `PT0S` for both times — 14 of 105 in a real library.
Scoring those as zero would make them the easiest thing in the pool and hand them
every tight weeknight, so instead they're estimated from the work involved
(`10 + 2×ingredients + 3×steps`) and shown as `~43m` so an estimate never
masquerades as a known time. The estimate is what gets checked against a time cap
too.

## The week

Each day is **Cooking**, **Takeaway**, **Leftovers** or **Not cooking**. Only
cooking nights take part in the spin; the other three record *why* there's no
recipe, and that reason shows on the board and prints on the plan instead of
leaving a blank.

A cooking day has a **max complexity** and a **time cap**, both of which its main
must satisfy. Extras answer to their own ceiling (up to Medium) rather than
competing for the main's time cap — otherwise a 45-minute weeknight could never
carry a side at all.

Mains are assigned most-constrained-first, so a tight Monday isn't robbed of its
only candidate by a loose Saturday. Each course draws from its own pool, so adding
a dessert never costs the week a main. Candidates are shuffled, so the plan varies
run to run. Shortfalls are reported per course before you spin ("Short by 2
desserts") rather than discovered after.

"copy Mon to all" copies Monday's whole row — mode, limits and extras — over
every other day.

## Shopping list

Appears under the spin button once a week is rolled, and on page 2 of the PDF.
Amounts are **aggregated across the week**, so four recipes wanting 500g of beef
mince produce one line reading `2kg`, not four.

**Units.** Everything measurable folds to one base per dimension — grams for
weight, millilitres for volume — then reports back at a readable scale in whichever
system **Settings → Measurements** selects, so imperial adds into metric
(`1 lb` + `100g` → `554g`) and totals promote themselves (`500ml` + `750ml` →
`1.25l`). Deliberate exceptions:

- **Spoons stay spoons.** `½ tsp cayenne` as `2.46ml` is arithmetically right and
  useless — nobody buys spices by millilitre.
- **Cups convert only for liquids.** A cup of stock reconciles against millilitres;
  a cup of chopped peppers is a rough portion, so it stays `1 cup`.
- **Weight and volume never merge.** They appear side by side: `300g + 1 tbsp
  butter`. Converting between them needs a density per ingredient, and inventing
  those would put wrong numbers on a shopping list.

**Staples.** Salt, pepper, water, oils, vinegars, dried herbs, ground spices,
raising agents (bicarb, baking powder, yeast) and **milk** are listed *without
amounts*, in a separate "Check you have" section at the end. `3½ tsp salt` totalled
across a week tells you nothing about whether to buy salt — you either have it or
you don't. Flour, sugar and butter are deliberately *not* staples: `150g flour` is
a real quantity you might be short of.

Milk is kept **per named type**, so `whole milk`, `oat milk` and `almond milk` are
three separate reminders — a recipe needing oat milk is a different shop. Buttermilk
and condensed milk are excluded from the staples and stay quantified, since you buy
those per recipe.

**Trivial amounts.** Anything totalling under **50g / 50ml** shows the ingredient
with no figure — `25g butter` is a splash, and the number is noise. The amounts
still accumulate, so several small hits can cross the line and become a figure worth
carrying: 3 × 20g reports as `60g`. Counts are exempt — one lemon is one lemon.

**Whole items.** Onions, carrots, lemons, eggs and the like are counted, never
weighed — a recipe wanting `50g onion` still means "an onion" at the shop, so a
week reads `5 onion` instead of the nonsense `51g + 3 onion`.

**Names.** Accents and smart punctuation fold away (`pureé` = `puree`), prep words
and parentheticals are stripped (`chicken thighs, skin removed, halved` →
`chicken thighs`), ranges take their upper bound (`1-2 tsp` → `2 tsp`), duplicate
measures are dropped (`500g/1 lb 2 oz`, `1 cup (200 g)`), and near-identical names
are merged by **trigram similarity** — which catches `worcesteshire`/`worcestershire`,
`barbeque`/`barbecue`, `tomatoe`/`tomato`, `flatleaf`/`flat leaf`. How eagerly is a
setting.

A synonym table bridges what character similarity can't: `ground beef` = `beef
mince`, `cilantro` = `coriander`, `zucchini` = `courgette`, `all-purpose flour` =
`plain flour`. Grade words (`lean`, `boneless`, `organic`) are stripped, so
`lean beef mince` and `ground beef` land on one line.

Export quirks handled along the way: `2 x 400g cans` folds to `800g`, `1 heaped
tsp` finds its unit, `c.` reads as a cup, price annotations like
`((£0.85x2)=(£1.70))` are stripped, and comma-less prep instructions
(`tomatoes sliced`) are trimmed off the label. Where three or more incompatible
units collect on one item, the largest is shown with a `+` rather than printing
`190g + 1 cup + 1 tbsp + ½`.

Fuzzy matching is guarded: any pair differing by a word that changes what you buy
(`wine`, `cube`, `salted`, `dark`, `plain`, …) is never merged, however similar it
looks. So `white vinegar` and `white wine vinegar` stay apart, as do `chicken
stock` and `chicken stock cube`. The threshold (0.62) and guard list were validated
against a real 105-recipe export, and applies at every level of the setting.

Anything without a parseable amount is listed verbatim rather than dropped — on a
shopping list a missing item is far worse than an untidy one. Items tick off with a
running "N of M to get", and **copy** puts the list on the clipboard as text.

## PDF

**⬇ PDF** opens the browser print dialog against a print-only stylesheet: page 1
is the week's plan with each day's courses, page 2 the aggregated shopping list
with tick boxes. Choose "Save as PDF".

## Sound

Effects are synthesised with WebAudio (reel ticks, a landing chime, a fanfare) —
no audio files, so it works offline and there's nothing to license. Toggle with
the speaker button, top right.

## Tests

Open the page and run `selfTest()` in the console. It covers duration parsing, the
course mapping, the complexity curve including the no-time estimate, the
localStorage round-trip, day modes, shuffle integrity, the HTML parser, quantity
parsing and unit aggregation in both measurement systems, the staple, milk-type,
trivial-amount and whole-item rules, the name normalisation and every fuzzy-merge guard, the settings
contract, and the assignment invariants — no duplicates within a course, each reel drawing
only its own course, extras only where ticked, non-cooking days empty, limits
respected, constrained days still fed — across 200 randomised runs.

```
selfTest: all 127 checks passed
```

## Not built

- Converting between weight and volume (needs a density table per ingredient).
- Servings scaling, or accounting for who's home which night.
- Recipe photos (parsed but discarded, to keep the cache small).
- Breakfast and Snack courses are parsed but have no slot to roll into.
