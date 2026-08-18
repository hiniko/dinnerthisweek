/* Dinner This Week — no build step, no server, no dependencies. */
(() => {
'use strict';

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

/* Tier ceilings are in effort-score units (see score()), calibrated against a
   real export so a 55-minute pancake reads Medium rather than Hard. */
const TIERS = [
  { n: 'Zero effort', max: 20 },        // 0
  { n: 'Easy',        max: 45 },        // 1
  { n: 'Medium',      max: 75 },        // 2
  { n: 'Hard',        max: 120 },       // 3
  { n: 'Project',     max: Infinity },  // 4
];

const TIME_CAPS = [0, 20, 30, 45, 60, 90, 120]; // 0 = no cap
const STORE = 'dinnerthisweek.v2';

/* User preferences, saved alongside the pool. Defaults match what the app did
   before settings existed, so an upgrade changes nothing. */
const DEFAULT_SETTINGS = {
  units: 'metric',      // how shopping amounts are printed
  sfx: true,
  extraMaxTier: 2,      // ceiling for a side or dessert (index into TIERS)
  fuzzy: 'balanced',    // how eagerly similar ingredient names combine
  confetti: true,
};
let settings = { ...DEFAULT_SETTINGS };

/* How hard the shopping list tries to combine near-identical names. Thresholds
   are trigram-similarity cutoffs; see canMerge(). */
const FUZZY_LEVELS = {
  off:      { label: 'Exact names only', min: 1.01 },
  balanced: { label: 'Balanced',         min: 0.62 },
  eager:    { label: 'Merge more',       min: 0.5 },
};

/* What gets rolled. 'skip' recipes stay visible in the pool with their course
   shown, so anything mis-tagged in Recipe Keeper can be re-assigned by hand. */
const COURSES = {
  main:    { label: 'Main',    plural: 'mains' },
  side:    { label: 'Side',    plural: 'sides' },
  dessert: { label: 'Dessert', plural: 'desserts' },
  skip:    { label: "Don't roll", plural: 'not rolled' },
};
const COURSE_KEYS = Object.keys(COURSES);

/* Recipe Keeper's recipeCourse values, lowercased, mapped onto the three slots we
   actually roll. Anything unlisted (Breakfast, Snack, Sauces, Medicine,
   Cosmetics, Baby Food, or a blank field) falls through to 'skip'. */
const COURSE_MAP = {
  'main dish': 'main',
  'main course': 'main',
  'main': 'main',
  'entree': 'main',
  'side dish': 'side',
  'side': 'side',
  'appetizer': 'side',
  'appetiser': 'side',
  'starter': 'side',
  'salad': 'side',
  'dessert': 'dessert',
  'desserts': 'dessert',
  'pudding': 'dessert',
  'baking': 'dessert',
};
const courseOf = (raw) => COURSE_MAP[(raw || '').trim().toLowerCase()] || 'skip';


/* How a day is handled. Everything but 'cook' means no recipe is assigned, but
   each says *why* — it prints on the plan and shows on the board, so "Thursday
   is leftovers" is a decision you recorded rather than a blank. */
const MODES = {
  cook:      { label: 'Cooking',     short: 'Cooking',   board: null,           plan: null },
  takeout:   { label: 'Takeaway',    short: 'Takeaway',  board: '🥡 takeaway',  plan: 'Takeaway' },
  leftovers: { label: 'Leftovers',   short: 'Leftovers', board: '🍲 leftovers', plan: 'Leftovers' },
  none:      { label: 'Not cooking', short: 'Off',       board: '🚫 not cooking', plan: 'Not cooking' },
};
const MODE_KEYS = Object.keys(MODES);
const isCooking = (d) => (d.mode || 'cook') === 'cook';

/* ── State ─────────────────────────────────────────────── */
let recipes = [];   // {name, prep, cook, ingredients[], steps, source, servings, course, tier, auto, inPool}
let days = [];      // {maxTier, timeCap, mode, side, dessert}
let plan = [];      // per-day {main, side, dessert} — each a recipe or null
let rolling = false;

const emptySlot = () => ({ main: null, side: null, dessert: null });
/* Every recipe on a day, in serving order — the shared shape for the board, the
   printed plan and the shopping list. */
const slotList = (s) => [s?.main, s?.side, s?.dessert].filter(Boolean);

/* ── Utilities ─────────────────────────────────────────── */
const $  = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const total = (r) => r.prep + r.cook;

function fmtMins(m) {
  if (!m) return '—';
  const h = Math.floor(m / 60), mm = m % 60;
  return h ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`;
}

/* Fisher-Yates. Unbiased, unlike sort(() => Math.random() - .5). */
function shuffle(a) {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ── Shopping list ─────────────────────────────────────── */
/* Ingredient lines are free text a human typed or pasted from a website, so this
   parses what it confidently can and passes the rest through untouched. Measured
   against a real 105-recipe export: 97% of numeric lines parse.

   Quantities only ever combine when the unit matches exactly. "530g butter" and
   "1 tbsp butter" stay as two lines under one heading — converting spoons to
   grams needs a density per ingredient, and inventing those would quietly put
   wrong numbers on a shopping list. */

const VULGAR = { '½':.5, '⅓':1/3, '⅔':2/3, '¼':.25, '¾':.75, '⅕':.2, '⅖':.4, '⅗':.6, '⅘':.8, '⅙':1/6, '⅛':.125, '⅜':.375, '⅝':.625, '⅞':.875 };
const VULGAR_CLASS = '½⅓⅔¼¾⅕⅖⅗⅘⅙⅛⅜⅝⅞';

/* Longest-first so "tablespoons" wins over "tablespoon", and "tbsp" isn't
   shadowed. Plural and spelt-out forms fold onto one canonical token. */
const UNIT_CANON = {
  tablespoons: 'tbsp', tablespoon: 'tbsp', tbsps: 'tbsp', tbsp: 'tbsp', tbs: 'tbsp',
  teaspoons: 'tsp', teaspoon: 'tsp', tsps: 'tsp', tsp: 'tsp',
  cups: 'cup', cup: 'cup', c: 'cup',   // "1 c. flour" is a cup
  kg: 'kg', kgs: 'kg', kilograms: 'kg', kilogram: 'kg',
  g: 'g', grams: 'g', gram: 'g',
  ml: 'ml', millilitres: 'ml', milliliters: 'ml',
  litres: 'l', liters: 'l', litre: 'l', liter: 'l', l: 'l',
  oz: 'oz', ounces: 'oz', ounce: 'oz',
  lbs: 'lb', lb: 'lb', pounds: 'lb', pound: 'lb',
  cloves: 'clove', clove: 'clove',
  cans: 'can', can: 'can', tins: 'can', tin: 'can',
  packets: 'packet', packet: 'packet', packs: 'pack', pack: 'pack',
  sachets: 'sachet', sachet: 'sachet',
  slices: 'slice', slice: 'slice',
  sprigs: 'sprig', sprig: 'sprig',
  bunches: 'bunch', bunch: 'bunch',
  heads: 'head', head: 'head',
  sticks: 'stick', stick: 'stick',
  pints: 'pint', pint: 'pint',
  handfuls: 'handful', handful: 'handful',
};
const UNIT_ALT = Object.keys(UNIT_CANON).sort((a, b) => b.length - a.length).join('|');

/* Measurements fold to one base unit per dimension — grams for weight,
   millilitres for volume — so "4 × 500g" totals "2kg" and imperial amounts add
   into metric ones instead of sitting on their own line.

   Spoons stay spoons. Converting "½ tsp cayenne" to "2.46ml" is arithmetically
   fine and useless on a shopping list: nobody buys spices by millilitre, and it
   reads like a bug. Cups do convert, because a cup is a bulk quantity you might
   genuinely reconcile against a litre. Anything else (clove, can, slice, pinch)
   keeps its own unit and still totals within that unit. */
const TO_BASE = {
  g: [1, 'g'], kg: [1000, 'g'], oz: [28.3495, 'g'], lb: [453.592, 'g'],
  ml: [1, 'ml'], l: [1000, 'ml'], pint: [568.261, 'ml'], cup: [236.588, 'ml'],
};

/* Reported back in whatever size keeps the number readable. Base units stay
   metric internally whatever the display setting — one arithmetic path, and the
   choice only changes the final format. */
const BASE_STEPS = {
  metric: {
    g:  [[1000, 'kg'], [1, 'g']],
    ml: [[1000, 'l'],  [1, 'ml']],
  },
  imperial: {
    // 1 lb = 453.592g, 1 oz = 28.3495g; 1 pint = 568.261ml, 1 fl oz = 28.4131ml
    g:  [[453.592, 'lb'], [28.3495, 'oz'], [1, 'g']],
    ml: [[568.261, 'pt'], [28.4131, 'fl oz'], [1, 'ml']],
  },
};

/* Metric symbols sit tight against the number ("2kg"); imperial units read as
   words and conventionally take a space ("2 lb", "3 fl oz"). */
const IMPERIAL_LABELS = new Set(['lb', 'oz', 'pt', 'fl oz']);

function displayAmount(qty, unit) {
  // Amounts arrive already in base units (see add()), so this only chooses how to
  // print them — converting here as well would double-apply the factor.
  const steps = BASE_STEPS[settings.units]?.[unit] || BASE_STEPS.metric[unit];
  if (!steps) {
    // Not a base unit: "3 clove", "1 cup", "2 tbsp". Space for word-like units.
    return `${fmtQty(qty)}${unit ? (unit.length > 2 ? ' ' + unit : unit) : ''}`;
  }
  const join = (n, label) =>
    `${n}${IMPERIAL_LABELS.has(label) || label.length > 2 ? ' ' : ''}${label}`;
  for (const [size, label] of steps) {
    if (qty >= size) {
      const n = qty / size;
      // Round to something you can actually shop to. Converted imperial figures
      // land on arbitrary decimals ("6.17 oz"), so they round harder than metric
      // amounts that were probably written as round numbers to begin with.
      const coarse = IMPERIAL_LABELS.has(label);
      const rounded = n >= 100 ? Math.round(n)
        : coarse ? Math.round(n * 4) / 4          // nearest quarter
        : n >= 10 ? Math.round(n * 10) / 10
        : Math.round(n * 100) / 100;
      return join(rounded, label);
    }
  }
  const last = steps.at(-1)[1];
  return join(Math.round(qty * 10) / 10, last);
}

/* ── Name matching ─────────────────────────────────────── */
/* Accents and smart punctuation fold away, so "pureé" and "puree" are one thing. */
const foldText = (s) => s
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-');

/* Words that change what you put in the basket. Two names differing by any of
   these are never merged, however similar they look — "white vinegar" vs "white
   wine vinegar" and "chicken stock" vs "chicken stock cube" are different
   shopping, and a fuzzy match would otherwise fold them together. */
const GUARD_WORDS = new Set([
  'wine','cube','cubes','chip','chips','bun','buns','powder','extract','essence',
  'sauce','stock','oil','vinegar','milk','cream','yoghurt','yogurt','butter',
  'smoked','dark','white','light','brown','red','green','black','wholemeal',
  'self','plain','raising','unsalted','salted','double','single','free',
  'caster','icing','granulated','condensed','evaporated','desiccated',
  'fresh','frozen','tinned','canned','ripe','baby','wild','sweet','sour','hot',
]);

/* Bulk measures lead, spoons and bare counts follow. */
const AMOUNT_ORDER = (unit) =>
  unit === 'g' || unit === 'ml' ? 0 : unit === 'tbsp' || unit === 'tsp' ? 2 : unit ? 1 : 3;

/* Below this, a weight or volume isn't worth printing — "25g butter" or "15ml
   soy" is a splash, and the number only adds noise to a shopping list. The
   amounts still accumulate, so several small hits can cross the line and become a
   figure worth carrying: 3 × 20g reports as 60g. */
const MIN_USEFUL = 50;   // grams or millilitres

/* Spoons are converted purely to test them against that floor; they are never
   displayed in millilitres (see displayAmount). */
const SPOON_ML = { tsp: 4.92892, tbsp: 14.7868 };
const roughlyMl = (unit, qty) =>
  unit === 'g' || unit === 'ml' ? qty : SPOON_ML[unit] ? qty * SPOON_ML[unit] : Infinity;

/* Things a cup measures as a genuine volume rather than a rough portion. */
const POURABLE = /\b(water|milk|cream|stock|broth|juice|oil|wine|vinegar|syrup|sauce|yoghurt|yogurt|buttermilk|passata)\b/;

/* Store-cupboard staples: listed as a reminder, never with a quantity.
   "3½ tsp salt" is noise — you either have salt or you don't, and totalling
   teaspoons of it across a week tells you nothing about whether to buy more.
   Same for water, oils, vinegars, and dried herbs and spices. */
/* Kept deliberately narrow: only things measured out in pinches and spoonfuls,
   where a weekly total is meaningless. Flour, sugar and butter are NOT here —
   "150g flour" is a real quantity you might be short of. */
const PANTRY = [
  /^(table |sea |kosher |rock |flaky )?salt$/,
  /^(sea |kosher |table |rock )?salt ?(and|&|n) ?(freshly ground )?(black )?pepper$/,
  /^pepper ?(and|&) ?salt$/,
  // Ground pepper only — "red pepper" and "bell pepper" are vegetables.
  /^(freshly ground |ground )?(black|white|cayenne) pepper( ?corns?)?$/,
  /^pepper( ?corns?)?$/,
  /^(cold |warm |hot |boiling |iced )?water$/,
  /^(olive|vegetable|sunflower|rapeseed|canola|cooking|groundnut|avocado|sesame|neutral)? ?oil$/,
  /^(olive or avocado|extra.virgin olive) oil$/,
  /^(white |red |cider |apple cider |balsamic |rice |malt |wine )?vinegar$/,
  /^(baking powder|baking soda|bicarbonate of soda|cornflour|cornstarch)$/,
  // Dried herbs and ground spices — bought once, used by the spoonful for months.
  // Leading qualifiers (smoked, hot, sweet, ground…) are optional and stackable.
  /^((dried|ground|smoked|hot|sweet|mild|whole|crushed|flaked)\s+)*(oregano|basil|thyme|rosemary|sage|coriander|cumin|paprika|turmeric|cinnamon|nutmeg|mixed herb|italian herb|bay ?leaf|marjoram|tarragon|dill|allspice|cardamom|mustard powder|garlic powder|onion powder|curry powder|cayenne|chilli powder|chili powder|chilli flake|chili flake|chilli|chili|cumin seed|coriander seed|fennel seed|sesame seed|caraway)s?$/,
  /^(vanilla|almond) (extract|essence)$/,
  /^(soy|worcestershire|hot|tabasco|fish|oyster|dark soy|light soy) sauce$/,
  /^(honey|golden syrup|tomato puree|tomato paste|mustard|ketchup|mayonnaise|browning)$/,
  /^(olive oil|oil|butter) for (frying|drizzling|greasing|cooking|the tin)$/,
  // Raising agents: a tub lasts months, so the teaspoon count is meaningless.
  /^(bicarbonate of soda|bicarb( of soda)?|baking soda|baking powder|cream of tartar|(fast.action |instant |dried |active dry )?yeast)$/,
  // Milk kept per named type — a recipe needing oat milk is a different shop from
  // one needing whole milk, but "3 tbsp whole milk" is still not a quantity to
  // total. Buttermilk and condensed milk are excluded: those you buy per recipe.
  /^((whole|semi.skimmed|skimmed|full.fat|dairy|fresh|cold|warm|hot)\s+)*milk$/,
  /^(oat|almond|soya|soy|coconut|cashew|rice|hemp|hazelnut|non.dairy|plant|plant.based|unsweetened)\s+milk$/,
];
const isPantry = (key) => PANTRY.some((re) => re.test(key));

/* Things bought as whole items, so a gram weight for them is meaningless — a
   recipe saying "50g onion" still means "an onion" at the shop. Counting these
   avoids nonsense like "51g + 3 onion". */
const COUNTABLE = /^(onion|red onion|white onion|spring onion|shallot|carrot|potato|sweet potato|tomato|lemon|lime|orange|apple|banana|avocado|courgette|zucchini|aubergine|eggplant|cucumber|pepper|bell pepper|red pepper|green pepper|yellow pepper|chilli|chili|egg|garlic|leek|celery stick|celery|cabbage|cauliflower|broccoli|lettuce|corn on the cob|parsnip|turnip|beetroot|radish|mushroom|banana shallot|scotch bonnet|jalapeno|ginger)$/;

/* Jaccard overlap of padded character trigrams. Cheap, needs no dictionary, and
   tolerant of the misspellings a hand-typed recipe collection accumulates. */
function trigrams(s) {
  const p = `  ${s} `;
  const out = new Set();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}

function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / (A.size + B.size - shared);
}

/* The "balanced" threshold was validated against a real 105-recipe export: 0.62
   with the guard list merges the genuine variants (worcesteshire/worcestershire,
   barbeque/barbecue, tomatoe/tomato, flatleaf/flat leaf) and splits every
   near-miss that matters. The guard applies at every level — even "eager" won't
   merge across a word that changes what you buy. */
const fuzzyMin = () => (FUZZY_LEVELS[settings.fuzzy] || FUZZY_LEVELS.balanced).min;

function canMerge(a, b) {
  const wa = new Set(a.split(' ')), wb = new Set(b.split(' '));
  for (const w of wa) if (!wb.has(w) && GUARD_WORDS.has(w)) return false;
  for (const w of wb) if (!wa.has(w) && GUARD_WORDS.has(w)) return false;
  return similarity(a, b) >= fuzzyMin();
}

const NUM_RE = `(?:\\d+\\s*[${VULGAR_CLASS}]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\.\\d+|\\d+|[${VULGAR_CLASS}])`;
const QTY_RE = new RegExp(`^(${NUM_RE})\\s*(?:(${UNIT_ALT})\\b\\.?)?\\s*(.*)$`, 'i');

/* "1 ½" → 1.5, "3/4" → 0.75, "0.25" → 0.25. */
function parseQty(t) {
  const s = t.trim();
  let m = new RegExp(`^(\\d+)\\s*([${VULGAR_CLASS}])$`).exec(s);
  if (m) return +m[1] + VULGAR[m[2]];
  if (VULGAR[s] != null) return VULGAR[s];
  m = /^(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (m) return +m[1] + +m[2] / +m[3];
  m = /^(\d+)\/(\d+)$/.exec(s);
  if (m) return +m[1] / +m[2];
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* Recipes pasted from websites carry list bullets and checkbox glyphs. */
const cleanLine = (l) => l
  .replace(/&nbsp;?/gi, ' ')          // entity survives some exports un-decoded
  .replace(/\u00a0/g, ' ')
  .replace(/^[\s▢□☐✓•*\-–—]+/, '')
  // Price annotations some exports carry: "((£0.85x2)=(£1.70))".
  .replace(/\(*[^()]*[£$€][^()]*\)*/g, ' ')
  .replace(/\s*\({2,}[^)]*\)*\s*$/, '')  // trailing "((note))" aside
  .replace(/[=]+\s*$/, '')            // leftover operator from a stripped price
  .replace(/\s+/g, ' ')
  .trim();

/* Recipe sites state one amount twice — "500g/1 lb 2 oz beef" or
   "1 cup (200 g) sugar". The alternative isn't extra shopping, and leaving it in
   the name stops that ingredient combining with the same thing written plainly,
   so the redundant half is dropped and the leading measure kept. */
const UNIT_WORD = `(?:${UNIT_ALT})`;
/* The alternative is one or two number+unit groups ("1 lb 2 oz", "6 oz", "18fl
   oz"), and no more — matching greedily would eat the ingredient name too. */
const ALT_MEASURE = `${NUM_RE}\\s*(?:fl\\s*)?${UNIT_WORD}?(?:\\s+${NUM_RE}\\s*(?:fl\\s*)?${UNIT_WORD})?`;

const dropDualUnits = (l) => l
  // "500g/1 lb 2 oz beef" -> "500g beef"
  .replace(new RegExp(`^(${NUM_RE}\\s*${UNIT_WORD})\\s*/\\s*${ALT_MEASURE}\\b`, 'i'), '$1 ')
  // "150 grams or 3/4 cup sugar" -> "150 grams sugar"
  .replace(new RegExp(`^(${NUM_RE}\\s*${UNIT_WORD})\\s+or\\s+${ALT_MEASURE}\\b`, 'i'), '$1 ')
  // "1 cup (200 g) sugar" -> "1 cup sugar"  (parens holding only a measure)
  .replace(new RegExp(`\\(\\s*${ALT_MEASURE}\\s*\\)`, 'gi'), ' ')
  .replace(/\s+/g, ' ')
  .trim();

/* Words sitting between the number and the unit, or standing in for one:
   "1 heaped tsp", "4 Cloves garlic", "½ bunch parsley". Dropping the modifier
   lets the real unit be recognised; a bare descriptor becomes a plain count. */
const QTY_FILLER = /^(heaped|heaping|level|rounded|generous|scant|good|good-quality|whole|large|small|medium|fresh|freshly|ripe|raw)\s+/i;

const dropQtyFiller = (rest) => {
  let out = rest, guard = 0;
  while (QTY_FILLER.test(out) && guard++ < 4) out = out.replace(QTY_FILLER, '');
  return out;
};

/* "1-2 tsp chilli" or "2 to 4 sprigs" — take the upper bound. Buying too little
   is the worse mistake, and it stops the range splitting into a bare "1" with
   "-2 tsp chilli" left as the name. */
const openRange = (l) =>
  l.replace(new RegExp(`^(${NUM_RE})\\s*(?:-|–|—|\\s+to\\s+)\\s*(${NUM_RE})`, 'i'), '$2');

/* "2 x 400g cans chopped tomatoes" is 800g, not two of something unnamed. Folding
   the multiplier into the measure gets the real weight onto the list. */
const foldMultiplier = (l) => {
  const m = new RegExp(`^(\\d+)\\s*[x×]\\s*(${NUM_RE})\\s*(${UNIT_ALT})\\b\\.?\\s*(.*)$`, 'i').exec(l);
  if (m) {
    const n = parseQty(m[1]), each = parseQty(m[2]);
    if (n && each) return `${n * each}${m[3]} ${m[4]}`.trim();
  }
  // "2x tins chopped tomato" — a plain count of a packaged item.
  return l.replace(/^(\d+)\s*[x×]\s+/i, '$1 ');
};

/* A section header ("For the sauce:", "Filling") is not an ingredient.

   Deliberately narrow: a trailing colon, a "for the …" opener, or a single word
   from a known set of section names. An earlier version treated any short
   digit-less line as a header, which silently ate real ingredients like "salt and
   pepper" and "pinch of salt" — on a shopping list a missing item is far worse
   than a stray heading, so anything uncertain is kept. */
const SECTION_WORDS = /^(filling|topping|toppings|sauce|dressing|marinade|garnish|base|crust|frosting|icing|glaze|batter|dough|assembly|method|equipment|optional|serving|to serve|for serving)$/i;

const isHeader = (l) => {
  if (/[0-9½⅓⅔¼¾⅕⅖⅗⅘⅙⅛⅜⅝⅞]/.test(l)) return false;
  if (l.endsWith(':')) return true;
  if (/^for the\b/i.test(l)) return true;
  return SECTION_WORDS.test(l.trim());
};

/* Match key for combining: accent-folded, lowercased, parentheticals and prep
   words dropped, crudely singularised.

   Only words describing *handling* are stripped. Words that change what you buy
   (fresh/dried, salted/unsalted, dark/white) are deliberately absent here and
   listed in GUARD_WORDS instead, so they survive into the key and then block a
   fuzzy merge. */
/* Grade and cut adjectives ("lean", "boneless") describe the same shopping item,
   so they're stripped too — otherwise "lean beef mince" and "beef mince" sit just
   under the similarity threshold and appear twice. */
const PREP_WORDS = /\b(freshly|finely|roughly|thinly|coarsely|lightly|large|small|medium|extra|chopped|grated|shredded|sliced|diced|minced|crushed|softened|melted|beaten|peeled|picked|ground|optional|halved|quartered|cubed|trimmed|rinsed|drained|packed|good|quality|approx|about|plus|for|the|of|a|an|lean|boneless|skinless|free.range|organic|best|premium)\b/g;

/* UK/US and word-order variants that no character-similarity measure will ever
   connect. Applied to the key, so "ground beef" and "lean beef mince" land
   together as one line. */
const SYNONYMS = [
  [/\b(ground|minced) (beef|pork|lamb|turkey|chicken)\b/, '$2 mince'],
  [/\b(beef|pork|lamb|turkey|chicken) (mince|mincemeat)\b/, '$1 mince'],
  [/\bstek?ak? mince\b/, 'beef mince'],
  [/\bcilantro\b/, 'coriander'],
  [/\bscallions?\b/, 'spring onion'],
  [/\bzucchini\b/, 'courgette'],
  [/\beggplant\b/, 'aubergine'],
  [/\ball.purpose flour\b/, 'plain flour'],
  [/\bconfectioners.? sugar\b/, 'icing sugar'],
  [/\bheavy cream\b/, 'double cream'],
  [/\bcanned\b/, 'can'],
  [/\btinned\b/, 'can'],
  [/\bgarbanzo beans?\b/, 'chickpea'],
];

function ingredientKey(name) {
  let n = foldText(name).toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,;]/)[0]                 // "beef mince, sliced" → "beef mince"
    .replace(/\s*&\s*/g, ' and ')     // "salt & pepper" = "salt and pepper"
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Synonyms first: "ground"/"minced" carry meaning here ("ground beef" is mince)
  // but are prep words elsewhere, so they must be rewritten before stripping.
  for (const [re, to] of SYNONYMS) n = n.replace(re, to);
  n = n.replace(PREP_WORDS, ' ').replace(/\s+/g, ' ').trim();
  // A unit word can end up on either side of the name ("6 garlic cloves",
  // "Stalks scallion"); strip it from both so all spellings land together.
  n = n.replace(new RegExp(`^(?:${UNIT_ALT}|stalks?|slices?|pieces?)\\s+`, 'i'), '')
       .replace(new RegExp(`\\s+(?:${UNIT_ALT}|stalks?|pieces?)$`, 'i'), '')
       .trim();
  if (n.endsWith('es') && !/(ch|sh|ss|x)es$/.test(n)) n = n.slice(0, -1);
  else if (n.endsWith('s') && !n.endsWith('ss')) n = n.slice(0, -1);
  // Again after singularising, so "beef minces" → "beef mince" still maps.
  for (const [re, to] of SYNONYMS) n = n.replace(re, to);
  return n.replace(/\s+/g, ' ').trim();
}

/* What to show on the list. Keeps the original wording but drops the recipe-desk
   noise — a trailing prep clause and any parenthetical aside — because you shop
   for "chicken thighs", not "chicken thighs, skin removed, halved". */
function shopLabel(name) {
  let s = foldText(name)
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,;]/)[0]
    .replace(/[()]/g, ' ')        // half a bracket pair left after the split
    .replace(/\s+/g, ' ')
    // Left over when a measure in front of it was consumed: "cans of tuna" → "tuna".
    .replace(/^(?:of|x)\s+/i, '')
    .replace(/^(?:cans?|tins?|packs?|packets?|jars?|bottles?|bags?)\s+of\s+/i, '')
    .replace(/[\s\/.=-]+$/, '')   // trailing punctuation from "chops / cutlets ("
    .trim();
  // Prep instructions tacked on without a comma: "tomatoes sliced",
  // "red onion finely sliced", "bok choy stems separated".
  s = s.replace(/\s+((finely|thinly|roughly|coarsely|freshly)\s+)?(sliced|chopped|diced|grated|shredded|crushed|minced|halved|quartered|cubed|peeled|trimmed|beaten|softened|melted|drained|rinsed|separated|washed)(\s+lengthways|\s+thinly)?$/i, '');
  return s.trim() || name.trim();
}

/* Trim a float for display: 1.5 → "1.5", 2.0 → "2", 0.333… → "1/3". */
function fmtQty(n) {
  const near = Object.entries(VULGAR).find(([, v]) => Math.abs(v - (n % 1)) < 0.02);
  const whole = Math.floor(n);
  if (near && n % 1 > 0.01) return whole ? `${whole}${near[0]}` : near[0];
  return String(Math.round(n * 100) / 100);
}

/* Builds the week's list.

   Two passes. First every quantified line is bucketed under an exact key, adding
   into base units (grams / millilitres) so amounts genuinely total rather than
   sitting side by side. Then near-identical keys are folded together by trigram
   similarity, subject to the guard words. Anything unquantifiable is passed
   through verbatim, so no ingredient ever silently vanishes.

   ponytail: the fuzzy pass is O(n²) over distinct names. A week is tens of items,
   so it is nowhere near worth an index; if this ever ran over a whole library,
   bucket by first letter before comparing. */
function buildShoppingList(entries) {
  const combined = new Map();   // key -> {label, dims: Map<baseUnit, qty>, from: Set}
  const loose = [];

  const add = (key, label, unit, qty, day) => {
    if (!combined.has(key)) {
      combined.set(key, { label, dims: new Map(), from: new Set(), pantry: isPantry(key) });
    }
    const item = combined.get(key);
    item.from.add(day);
    if (label.length < item.label.length) item.label = label;

    // A store-cupboard staple is a reminder, not a quantity to total. "3½ tsp
    // salt" across a week says nothing about whether to buy salt.
    if (item.pantry) return;

    // Whole items are bought by the piece, so a gram weight is meaningless: a
    // recipe wanting "50g onion" still means "an onion". Counting them avoids
    // "51g + 3 onion".
    if (COUNTABLE.test(key)) {
      const each = TO_BASE[unit] ? 1 : qty;   // a weight or volume ⇒ call it one
      item.dims.set('', (item.dims.get('') || 0) + each);
      return;
    }

    // A cup of a liquid is a volume worth reconciling against millilitres; a cup
    // of chopped peppers is a rough portion, and "237ml bell peppers" is nonsense.
    const cupOfSolid = unit === 'cup' && !POURABLE.test(key);
    const conv = cupOfSolid ? null : TO_BASE[unit];
    // Convertible units share a bucket; the rest keep their own.
    const bucket = conv ? conv[1] : unit;
    const amount = conv ? qty * conv[0] : qty;
    item.dims.set(bucket, (item.dims.get(bucket) || 0) + amount);
  };

  for (const { r, i } of entries) {
    const day = DAYS[i].slice(0, 3);
    for (const raw of r.ingredients) {
      const line = cleanLine(raw);
      if (!line || isHeader(line)) continue;
      const norm = openRange(foldMultiplier(dropDualUnits(line)));

      const m = QTY_RE.exec(norm);
      const qty = m ? parseQty(m[1]) : null;
      let rest = m ? m[3].trim() : '';
      let unit = UNIT_CANON[(m?.[2] || '').toLowerCase()] || '';

      // "1 heaped tsp chilli" hides the unit behind a modifier — drop it and look
      // again, so the tsp is recognised rather than becoming part of the name.
      if (rest) {
        const stripped = dropQtyFiller(rest);
        if (stripped !== rest) {
          rest = stripped;
          if (!unit) {
            const again = new RegExp(`^(${UNIT_ALT})\\b\\.?\\s*(.*)$`, 'i').exec(rest);
            if (again) { unit = UNIT_CANON[again[1].toLowerCase()] || ''; rest = again[2].trim(); }
          }
        }
      }

      // A leftover vulgar fraction means we split a mixed number wrongly.
      const bad = !m || qty == null || !rest || new RegExp(`^[${VULGAR_CLASS}]`).test(rest);
      if (bad) {
        // An unquantified staple ("salt and pepper", "olive oil") is still a
        // pantry entry, not a loose line — otherwise it appears twice.
        const bareKey = ingredientKey(line);
        if (bareKey && isPantry(bareKey)) { add(bareKey, shopLabel(line), '', 0, day); continue; }
        loose.push({ text: line, day, recipe: r.name });
        continue;
      }

      const key = ingredientKey(rest);
      if (!key) { loose.push({ text: line, day, recipe: r.name }); continue; }
      add(key, shopLabel(rest), unit, qty, day);
    }
  }

  // Fuzzy pass: fold spelling variants into the first key that accepts them.
  const keys = [...combined.keys()];
  const merged = new Map();
  for (const key of keys) {
    const item = combined.get(key);
    const host = [...merged.keys()].find((k) => canMerge(k, key));
    if (!host) { merged.set(key, item); continue; }
    const into = merged.get(host);
    for (const [unit, qty] of item.dims) into.dims.set(unit, (into.dims.get(unit) || 0) + qty);
    for (const d of item.from) into.from.add(d);
    if (item.label.length < into.label.length) into.label = item.label;
    // Merging a staple in makes the whole entry a staple.
    if (item.pantry) { into.pantry = true; into.dims.clear(); }
  }

  const items = [...merged.values()]
    .map((it) => ({
      label: it.label,
      pantry: !!it.pantry,
      from: [...it.from],
      // Weight and volume can't be summed, so they're reported side by side —
      // bulk first, spoons and counts after, which reads as "325g + 1 tbsp".
      //
      // Beyond two fragments it stops being information: "190g + 1 cup + 1 tbsp
      // + ½ flour" is four recipes disagreeing about units, and nobody shops from
      // that. Past two, keep the largest measure and flag that there's more.
      amounts: (() => {
        const parts = [...it.dims.entries()]
          .filter(([, qty]) => qty > 0)
          .sort((a, b) => AMOUNT_ORDER(a[0]) - AMOUNT_ORDER(b[0]));

        // A trivial total is just the ingredient — drop the figure, keep the item.
        const total = parts.reduce((sum, [u, q]) => sum + roughlyMl(u, q), 0);
        if (parts.length && total < MIN_USEFUL) return [];

        if (parts.length <= 2) return parts.map(([u, q]) => displayAmount(q, u));
        const [first] = parts;
        return [displayAmount(first[1], first[0]) + ' +'];
      })(),
    }))
    // Things to buy first; staples last, as a "check you have these" tail.
    .sort((a, b) => (a.pantry - b.pantry) || a.label.localeCompare(b.label));

  return { items, loose };
}

/* ── Recipe Keeper parsing ─────────────────────────────── */
function isoMinutes(s) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  if (!m) return 0;
  return (+m[1] || 0) * 60 + (+m[2] || 0) + Math.round((+m[3] || 0) / 60);
}

/* Parses the microdata in a Recipe Keeper HTML export via DOMParser. */
function parseExport(htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const out = [];
  for (const node of doc.querySelectorAll('.recipe-details')) {
    const prop = (p) => node.querySelector(`[itemprop="${p}"]`);
    const meta = (p) => {
      const m = node.querySelector(`meta[itemprop="${p}"]`);
      return m ? m.getAttribute('content') : '';
    };
    const name = prop('name')?.textContent.trim();
    if (!name) continue;

    const ingBox = node.querySelector('.recipe-ingredients, [itemprop="recipeIngredients"]');
    const dirBox = node.querySelector('[itemprop="recipeDirections"]');
    const lines = (box) => box
      ? [...box.querySelectorAll('p')].map((p) => p.textContent.trim()).filter(Boolean)
      : [];

    const rawCourse = prop('recipeCourse')?.textContent.trim() || '';
    out.push({
      name,
      rawCourse,                          // kept so the pool can show the original tag
      course:   courseOf(rawCourse),
      source:   prop('recipeSource')?.querySelector('a')?.href
                || prop('recipeSource')?.textContent.trim() || '',
      servings: prop('recipeYield')?.textContent.trim() || '',
      prep:     isoMinutes(meta('prepTime')),
      cook:     isoMinutes(meta('cookTime')),
      ingredients: lines(ingBox),
      steps:    lines(dirBox).length,
    });
  }
  return out;
}

/* ── Complexity ────────────────────────────────────────── */
/* Recipe Keeper often exports PT0S for both times — 14 of 105 in a real export.
   Scoring those as zero would make them the easiest thing in the pool and hand
   them every tight weeknight, so instead we estimate from the work involved:
   ingredients and steps are all the signal we have. */
const hasTime = (r) => total(r) > 0;

function estimate(r) {
  return 10                                  // any dish has some baseline
       + r.ingredients.length * 2
       + r.steps * 3;
}

/* Effort score in "effective minutes": clock time plus a penalty for a long
   ingredient list and a fiddly method. Time dominates; the extras exist so a
   19-ingredient bake doesn't rate the same as a 3-ingredient one-pot. */
function score(r) {
  if (!hasTime(r)) return estimate(r);
  return total(r)
       + Math.max(0, r.ingredients.length - 6) * 1.5
       + Math.max(0, r.steps - 5) * 0.8;
}

function autoTier(r) {
  const s = score(r);
  return TIERS.findIndex((t) => s <= t.max);
}


/* ── Persistence ───────────────────────────────────────── */
/* The imported pool is cached so a second visit skips the upload. Only what the
   app actually uses is kept — no photos, no directions text, no raw HTML — which
   is what keeps a 100+ recipe export inside the localStorage quota. Ingredients
   stay because the shopping list needs them; steps collapse to a count, which is
   all the complexity score reads.

   Field names are shortened because this is the one payload big enough for the
   JSON key overhead to matter across a few hundred recipes. */
const packRecipe = (r) => ({
  n: r.name,
  c: r.course,
  rc: r.rawCourse || '',
  s: r.source || '',
  y: r.servings || '',
  p: r.prep,
  k: r.cook,
  i: r.ingredients,
  t: r.steps,
  tier: r.auto ? null : r.tier,     // null = still derived from the score
  out: r.inPool ? undefined : 1,    // absent = in the pool
});

/* Returns the pre-normalise shape, leaving tier/auto for setRecipes to derive —
   deriving them here too would double-apply and mark every cached recipe as
   manually overridden. */
const unpackRecipe = (o) => ({
  name: o.n, course: o.c, rawCourse: o.rc || '', source: o.s || '',
  servings: o.y || '', prep: o.p || 0, cook: o.k || 0,
  ingredients: o.i || [], steps: o.t || 0,
  tier: o.tier ?? undefined,      // undefined = derive from the score
  inPool: !o.out,
});

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      v: 2,
      days,
      settings,
      pool: recipes.map(packRecipe),
      src: sourceLabel,
    }));
  } catch (e) {
    // Quota exceeded (or private browsing): keep running, just don't persist.
    // Settings alone are small enough to be worth a second attempt.
    try {
      localStorage.setItem(STORE, JSON.stringify({ v: 2, days, settings }));
    } catch (e2) { /* nothing more we can do */ }
  }
}

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; }
  catch (e) { return {}; }
}

/* ── Sound (synthesised — no asset files, works offline) ─ */
let audio = null;

function ac() {
  if (!audio) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    audio = new C();
  }
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

function beep({ freq = 440, dur = 0.08, type = 'square', gain = 0.08, slide = 0, delay = 0 }) {
  if (!settings.sfx) return;
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

const sfx = {
  tick:  () => beep({ freq: 1180, dur: 0.025, type: 'square', gain: 0.025 }),
  land:  () => { beep({ freq: 784, dur: 0.1, type: 'triangle', gain: 0.09 });
                 beep({ freq: 1175, dur: 0.16, type: 'triangle', gain: 0.07, delay: 0.07 }); },
  fanfare: () => [523, 659, 784, 1047].forEach((f, i) =>
                 beep({ freq: f, dur: 0.28, type: 'triangle', gain: 0.075, delay: i * 0.1 })),
  dud:   () => beep({ freq: 190, dur: 0.22, type: 'sawtooth', gain: 0.05, slide: -80 }),
};

/* ── Confetti ──────────────────────────────────────────── */
const cv = $('#confetti');
const ctx = cv.getContext('2d');
let bits = [], raf = 0;

function sizeCanvas() {
  const d = window.devicePixelRatio || 1;
  cv.width = innerWidth * d;
  cv.height = innerHeight * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
}
sizeCanvas();
addEventListener('resize', sizeCanvas);

function confetti(n = 140, originY = 0.35) {
  if (!settings.confetti) return;
  const cols = ['#ffc93c', '#ff4d6d', '#38e8d0', '#8ce99a', '#fdf6e3', '#b06bff'];
  for (let i = 0; i < n; i++) {
    bits.push({
      x: innerWidth * (0.5 + (Math.random() - 0.5) * 0.7),
      y: innerHeight * originY,
      vx: (Math.random() - 0.5) * 9,
      vy: Math.random() * -11 - 3,
      w: 5 + Math.random() * 6,
      h: 3 + Math.random() * 5,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      c: cols[(Math.random() * cols.length) | 0],
      life: 1,
    });
  }
  if (!raf) raf = requestAnimationFrame(drawBits);
}

function drawBits() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  bits = bits.filter((b) => b.life > 0 && b.y < innerHeight + 40);
  for (const b of bits) {
    b.vy += 0.32;            // gravity
    b.vx *= 0.995;
    b.x += b.vx; b.y += b.vy;
    b.rot += b.spin;
    if (b.y > innerHeight * 0.75) b.life -= 0.02;
    ctx.save();
    ctx.globalAlpha = Math.max(0, b.life);
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.fillStyle = b.c;
    ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
    ctx.restore();
  }
  raf = bits.length ? requestAnimationFrame(drawBits) : 0;
  if (!raf) ctx.clearRect(0, 0, innerWidth, innerHeight);
}

/* ── Assignment ────────────────────────────────────────── */
/* A main answers to the day's own limits. Extras are the quick thing alongside,
   so they answer to a fixed ceiling instead of competing for the main's time cap
   — otherwise a 45-minute weeknight could never carry a side at all. */
/* A recipe with no recorded time is judged on its estimate, so it can't slip
   under a tight cap just because the export left the fields empty. */
const timeFor = (r) => (hasTime(r) ? total(r) : score(r));

const fits = (r, d) =>
  r.course === 'main'
    ? r.tier <= d.maxTier && (!d.timeCap || timeFor(r) <= d.timeCap)
    : r.tier <= settings.extraMaxTier;

const poolFor = (course) => recipes.filter((r) => r.inPool && r.course === course);
const wants = (d, course) =>
  course === 'main' ? true : course === 'side' ? !!d.side : !!d.dessert;

/* Assign each cooking day a distinct main, plus a side/dessert where asked for.
   Mains go first and most-constrained-first, so a tight Monday doesn't lose its
   only candidate to a loose Saturday. Extras are drawn from their own pools, so
   adding a dessert never costs the week a main. Candidates are shuffled, so the
   result still varies run to run. */
function assign() {
  const out = days.map(() => emptySlot());
  const cooking = days.map((d, i) => ({ i, d })).filter((x) => isCooking(x.d));

  for (const course of COURSE_KEYS) {
    if (course === 'skip') continue;
    const pool = poolFor(course);
    const used = new Set();

    const queue = cooking
      .filter((x) => wants(x.d, course))
      .map((x) => ({ ...x, cands: shuffle(pool.filter((r) => fits(r, x.d))) }))
      .sort((a, b) => a.cands.length - b.cands.length);

    for (const { i, cands } of queue) {
      const pick = cands.find((r) => !used.has(r.name));
      if (pick) { used.add(pick.name); out[i][course] = pick; }
    }
  }
  return out;
}

/* Swap one course on one day for another eligible recipe not already used that
   week in the same course. */
function rerollDay(i, course = 'main') {
  const d = days[i];
  const used = new Set(plan.flatMap((s) => (s?.[course] ? [s[course].name] : [])));
  used.delete(plan[i]?.[course]?.name);
  const cands = shuffle(poolFor(course).filter((r) => fits(r, d) && !used.has(r.name)));
  return cands.find((r) => r.name !== plan[i]?.[course]?.name) || cands[0] || null;
}

/* ── Rendering: recipes ────────────────────────────────── */
let filterCourse = 'all';
let filterText = '';

/* Cards rather than a table: no intrinsic minimum width, so it never forces the
   page sideways on a phone. A 100+ recipe export needs the filter and search to
   stay navigable, so the list is only ever the current selection. */
function renderRecipes() {
  const list = $('#recipeRows');
  list.textContent = '';

  const q = filterText.trim().toLowerCase();
  const shown = recipes.filter((r) =>
    (filterCourse === 'all' || r.course === filterCourse) &&
    (!q || r.name.toLowerCase().includes(q)));

  for (const r of shown) {
    const li = el('li', 'ritem' + (r.inPool ? '' : ' benched'));

    li.appendChild(el('div', 'rname', r.name));

    const meta = el('div', 'rmeta');
    meta.append(
      el('span', `chip c${r.tier}`, TIERS[r.tier].n),
      document.createTextNode(` ${showMins(r)} · ${r.ingredients.length} ingr.`),
    );
    // Show the export's own tag when we couldn't map it — that's the cue to fix.
    if (r.course === 'skip' && r.rawCourse) {
      meta.append(document.createTextNode(` · tagged “${r.rawCourse}”`));
    }
    if (!r.auto) {
      const rst = el('button', 'link', 'reset');
      rst.title = 'Back to the derived complexity';
      rst.onclick = () => { r.tier = autoTier(r); r.auto = true; renderRecipes(); save(); };
      meta.append(document.createTextNode(' · '), rst);
    }
    li.appendChild(meta);

    const ctl = el('div', 'rctl');

    const cs = el('select', 's-course');
    cs.setAttribute('aria-label', `${r.name} course`);
    for (const k of COURSE_KEYS) {
      cs.appendChild(Object.assign(el('option', null, COURSES[k].label), { value: k }));
    }
    cs.value = r.course;
    cs.onchange = () => { r.course = cs.value; renderRecipes(); renderDays(); save(); };
    ctl.appendChild(cs);

    const sel = el('select');
    sel.setAttribute('aria-label', `${r.name} complexity`);
    for (const [t, tier] of TIERS.entries()) {
      sel.appendChild(Object.assign(el('option', null, tier.n), { value: String(t) }));
    }
    sel.value = String(r.tier);
    sel.onchange = () => {
      r.tier = +sel.value;
      r.auto = r.tier === autoTier(r);
      renderRecipes(); save();
    };
    ctl.appendChild(sel);

    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = r.inPool;
    cb.title = 'Include this week';
    cb.setAttribute('aria-label', `Include ${r.name} this week`);
    cb.onchange = () => { r.inPool = cb.checked; renderRecipes(); save(); };
    ctl.appendChild(cb);

    li.appendChild(ctl);
    list.appendChild(li);
  }

  if (!shown.length && recipes.length) {
    list.appendChild(el('li', 'ritem empty-note', 'Nothing matches that filter.'));
  }

  renderCounts(shown.length);
  checkFeasible();
}

/* Per-course counts of what's actually rollable — the number that matters when a
   day can't be filled. */
function renderCounts(shownCount) {
  const n = (c) => poolFor(c).length;
  $('#recipeCount').textContent = recipes.length
    ? `${n('main')} mains · ${n('side')} sides · ${n('dessert')} desserts`
    : '';
  $('#tabPoolN').textContent = recipes.length || '';

  const tally = $('#filterTally');
  if (tally) {
    tally.textContent = recipes.length
      ? `showing ${shownCount} of ${recipes.length}`
      : '';
  }
}

/* ── Rendering: days ───────────────────────────────────── */
function renderDays() {
  const box = $('#dayRows');
  box.textContent = '';
  for (const [i, d] of days.entries()) {
    const row = el('div', 'day-row' + (isCooking(d) ? '' : ' off'));
    row.appendChild(el('div', 'dname', DAYS[i]));

    // What's happening this day. Only 'cook' asks for a recipe; the rest record
    // an explicit reason instead of a silent gap.
    const mode = el('select', 's-mode');
    mode.setAttribute('aria-label', `${DAYS[i]} plan`);
    for (const k of MODE_KEYS) {
      mode.appendChild(Object.assign(el('option', null, MODES[k].label), { value: k }));
    }
    mode.value = d.mode || 'cook';
    mode.onchange = () => {
      d.mode = mode.value;
      if (!isCooking(d)) plan[i] = null;
      renderDays(); renderBoard(); save(); checkFeasible();
    };
    row.appendChild(mode);

    const tier = el('select', 's-tier');
    tier.setAttribute('aria-label', `${DAYS[i]} maximum complexity`);
    for (const [t, x] of TIERS.entries()) {
      tier.appendChild(Object.assign(el('option', null, `up to ${x.n}`), { value: String(t) }));
    }
    tier.value = String(d.maxTier);
    tier.disabled = !isCooking(d);
    tier.onchange = () => { d.maxTier = +tier.value; save(); checkFeasible(); };
    row.appendChild(tier);

    const cap = el('select', 's-cap');
    cap.setAttribute('aria-label', `${DAYS[i]} time available`);
    for (const c of TIME_CAPS) {
      cap.appendChild(Object.assign(el('option', null, c ? `≤ ${c} min` : 'any time'),
                                    { value: String(c) }));
    }
    cap.value = String(d.timeCap);
    cap.disabled = !isCooking(d);
    cap.onchange = () => { d.timeCap = +cap.value; save(); checkFeasible(); };
    row.appendChild(cap);

    // Optional extras. Disabled outright when nothing of that course is in the
    // pool, so a tick can never promise a course we can't fill.
    const extras = el('div', 'extras');
    for (const course of ['side', 'dessert']) {
      const have = poolFor(course).length;
      const lab = el('label',
        'extra' + (have ? '' : ' none') + (d[course] ? ' on' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!d[course];
      cb.disabled = !isCooking(d) || !have;
      cb.setAttribute('aria-label', `${DAYS[i]}: add a ${course}`);
      // Only the board changes shape here, so the day list is left alone — a
      // full re-render would rip the checkbox out from under the tap.
      cb.onchange = () => {
        d[course] = cb.checked;
        if (!cb.checked && plan[i]) plan[i][course] = null;
        lab.classList.toggle('on', cb.checked);
        renderBoard(); save(); checkFeasible();
      };
      lab.title = have
        ? `Roll a ${course} for ${DAYS[i]}`
        : `No ${COURSES[course].plural} in the pool`;
      lab.append(cb, document.createTextNode(`+ ${course}`));
      extras.appendChild(lab);
    }
    row.appendChild(extras);

    box.appendChild(row);
  }
}

/* Warn up front when the pool can't fill the week, rather than after a spin.
   Reports per course, since a missing dessert is a different fix to a missing
   main. */
function checkFeasible() {
  const note = $('#spinNote');
  if (!recipes.length) { note.textContent = ''; return; }

  const cooking = days.filter(isCooking);
  if (!cooking.length) {
    note.textContent = 'No cooking nights this week — nothing to spin.';
    return;
  }
  if (!poolFor('main').length) {
    note.textContent = 'No mains in the pool — set some recipes to Main in the Recipe Pool.';
    return;
  }

  const trial = assign();
  const gaps = [];
  for (const course of ['main', 'side', 'dessert']) {
    const asked = cooking.filter((d) => wants(d, course)).length;
    if (!asked) continue;
    const got = trial.filter((s, i) => isCooking(days[i]) && s[course]).length;
    if (got < asked) gaps.push(`${asked - got} ${COURSES[course].plural}`);
  }

  note.textContent = gaps.length
    ? `Short by ${gaps.join(' and ')} — raise a limit, or add recipes to that course.`
    : `${poolFor('main').length} mains ready for ${cooking.length} ${cooking.length === 1 ? 'night' : 'nights'}.`;
}

/* ── Rendering: board of reels ─────────────────────────── */
const IDLE = '???';
const NOFIT = 'Nothing fits this day';

/* A card per day. A cooking day carries one reel per course it asked for — main
   always, side and dessert when ticked — each independently spinnable. Cards
   survive re-render across spins so a reroll only touches its own reel. */
function renderBoard() {
  const board = $('#board');
  board.textContent = '';

  for (const [i, d] of days.entries()) {
    const cooking = isCooking(d);
    const card = el('div', 'slot' + (cooking ? '' : ' off'));
    card.dataset.day = String(i);
    card.appendChild(el('div', 'sday', DAYS[i].slice(0, 3)));

    const rows = el('div', 'srows');
    if (!cooking) {
      rows.appendChild(reelRow(i, 'mode', MODES[d.mode].board, false));
    } else {
      for (const course of ['main', 'side', 'dessert']) {
        if (!wants(d, course)) continue;
        rows.appendChild(reelRow(i, course, IDLE, true));
      }
    }
    card.appendChild(rows);
    board.appendChild(card);
  }
  // Centring needs real geometry, so it runs once the rows are in the document.
  for (const strip of board.querySelectorAll('.reel-strip')) centreStrip(strip);
  buildPrintSheet();
}

/* One reel line: course label, the reel window, its meta, and a reroll. */
function reelRow(dayIdx, course, text, spinnable) {
  const row = el('div', 'srow' + (spinnable ? ' idle' : ' fixed'));
  row.dataset.day = String(dayIdx);
  row.dataset.course = course;

  row.appendChild(el('div', 'scourse', course === 'mode' ? '' : COURSES[course].label));

  const reel = el('div', 'reel');
  const strip = el('div', 'reel-strip');
  strip.appendChild(el('div', 'reel-cell', text));
  reel.appendChild(strip);
  row.appendChild(reel);

  row.appendChild(el('div', 'smeta', ''));

  if (spinnable) {
    const btn = el('button', 'reroll', '↻');
    const what = `${DAYS[dayIdx]} ${course}`;
    btn.title = `Re-spin the ${what}`;
    btn.setAttribute('aria-label', `Re-spin the ${what}`);
    btn.onclick = () => spinOne(dayIdx, course);
    row.appendChild(btn);
  }
  return row;
}

const allRows = () => [...document.querySelectorAll('.srow.idle, .srow.spun')];
const rowFor = (i, course) =>
  document.querySelector(`.srow[data-day="${i}"][data-course="${course}"]`);

/* The reel window is taller than one cell so neighbours show at the edges. A
   resting strip is pushed down by the leftover half so its cell sits centred.
   Both are measured, so this tracks the CSS --cell/height at any breakpoint. */
function stripOffset(row) {
  const reelH = row.querySelector('.reel').getBoundingClientRect().height;
  const cellH = row.querySelector('.reel-cell')?.getBoundingClientRect().height || 24;
  return { cellH, pad: (reelH - cellH) / 2 };
}

function centreStrip(strip) {
  const row = strip.closest('.srow');
  const { pad } = stripOffset(row);
  strip.style.transform = `translateY(${pad}px)`;
}

/* Content of a settled cell: the name, linked to its source when we have one. */
function cellFor(r) {
  const cell = el('div', 'reel-cell');
  if (!r) { cell.textContent = NOFIT; return cell; }
  if (r.source) {
    const a = el('a', null, r.name);
    a.href = r.source;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'Open the recipe';
    cell.appendChild(a);
  } else {
    cell.textContent = r.name;
  }
  return cell;
}

/* Spin one reel.

   The strip is built as [n random names..., winner]. We slide it from the top
   down to the winner on an ease-out curve, so it starts fast, blurs, and clicks
   to rest — the mechanical feel of a real reel. Ticks fire as cells pass the
   window, thinning out with the deceleration.

   ponytail: drives transform from rAF rather than a CSS transition so the tick
   sounds can follow the actual position. A pure CSS transition would be less
   code but the audio would drift out of sync with the visible motion. */
function reelSpin(row, winner, { spins = 14, ms = 1500 } = {}) {
  const strip = row.querySelector('.reel-strip');
  // Filler is drawn from the same course, so a dessert reel only ever teases
  // desserts on its way past.
  const pool = poolFor(row.dataset.course);

  // Build the strip: filler cells then the winner last.
  strip.textContent = '';
  const filler = Math.max(4, spins);
  for (let k = 0; k < filler; k++) {
    const r = pool.length ? pool[(Math.random() * pool.length) | 0] : null;
    strip.appendChild(el('div', 'reel-cell', r ? r.name : IDLE));
  }
  strip.appendChild(cellFor(winner));

  const { cellH, pad } = stripOffset(row);
  const travel = filler * cellH;             // distance to bring the winner up
  const at = (y) => `translateY(${pad - y}px)`;
  strip.style.transform = at(0);
  row.classList.remove('idle', 'empty', 'landed');
  row.classList.add('spinning', 'spun');

  return new Promise((done) => {
    let start = null, lastTick = -1;
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);   // fast start, soft landing

    const frame = (now) => {
      if (start === null) start = now;
      const t = Math.min(1, (now - start) / ms);
      const y = easeOut(t) * travel;
      strip.style.transform = at(y);

      const idx = Math.floor(y / cellH);
      if (idx !== lastTick) { lastTick = idx; sfx.tick(); }

      if (t < 1) { requestAnimationFrame(frame); return; }

      // Settle: drop the filler so the winner is the only cell left.
      row.classList.remove('spinning');
      const win = strip.lastElementChild;
      strip.textContent = '';
      strip.appendChild(win);
      strip.style.transform = at(0);
      row.classList.toggle('empty', !winner);
      row.classList.add('landed');
      setTimeout(() => row.classList.remove('landed'), 450);
      done();
    };
    requestAnimationFrame(frame);
  });
}

/* "~40m" flags an estimate, so a missing time never masquerades as a known one. */
const showMins = (r) => (hasTime(r) ? fmtMins(total(r)) : `~${fmtMins(Math.round(score(r)))}`);

function setMeta(row, r) {
  row.querySelector('.smeta').textContent =
    r ? `${showMins(r)} · ${TIERS[r.tier].n}` : '';
}

async function spinAll() {
  if (rolling) return;
  rolling = true;
  $('#spinBtn').disabled = true;
  document.querySelectorAll('.reroll').forEach((b) => (b.disabled = true));
  document.body.classList.add('flashing');
  ac(); // unlock audio inside the click gesture

  plan = assign();
  ticked = new Set();          // a new week means a new list

  // Reset every reel to ??? so the reveal starts from a clean board.
  for (const row of allRows()) {
    row.classList.add('idle');
    row.classList.remove('empty', 'spun');
    row.querySelector('.smeta').textContent = '';
    const strip = row.querySelector('.reel-strip');
    strip.textContent = '';
    strip.appendChild(el('div', 'reel-cell', IDLE));
    centreStrip(strip);
  }

  // Reels start together and land in sequence — each runs a little longer, so
  // the week reveals top to bottom, main before its side before its dessert.
  const runs = [];
  let n = 0;
  for (const row of allRows()) {
    const i = +row.dataset.day;
    const r = plan[i][row.dataset.course];
    runs.push(
      reelSpin(row, r, { spins: 12 + n * 2, ms: 1300 + n * 200 })
        .then(() => { setMeta(row, r); r ? sfx.land() : sfx.dud(); }),
    );
    n++;
  }
  await Promise.all(runs);

  document.body.classList.remove('flashing');
  $('#spinBtn').disabled = false;
  $('#spinBtn').textContent = 'SPIN AGAIN';
  document.querySelectorAll('.reroll').forEach((b) => (b.disabled = false));
  rolling = false;

  if (plan.some((s) => slotList(s).length)) { confetti(170, 0.3); sfx.fanfare(); }
  buildPrintSheet();
}

async function spinOne(i, course = 'main') {
  if (rolling) return;
  rolling = true;
  document.querySelectorAll('.reroll').forEach((b) => (b.disabled = true));
  $('#spinBtn').disabled = true;
  ac();

  const pick = rerollDay(i, course);
  plan[i][course] = pick;
  const row = rowFor(i, course);
  row.querySelector('.smeta').textContent = '';
  await reelSpin(row, pick, { spins: 9, ms: 1100 });
  setMeta(row, pick);
  if (pick) { sfx.land(); confetti(45, 0.45); } else { sfx.dud(); }

  document.querySelectorAll('.reroll').forEach((b) => (b.disabled = false));
  $('#spinBtn').disabled = false;
  rolling = false;
  buildPrintSheet();
}

/* ── Print sheet (becomes the PDF) ─────────────────────── */
function buildPrintSheet() {
  const sheet = $('#printSheet');
  sheet.textContent = '';
  // Every assigned recipe, flattened, keeping its day and course for grouping.
  const chosen = plan.flatMap((s, i) => isCooking(days[i])
    ? ['main', 'side', 'dessert'].filter((c) => s[c]).map((c) => ({ r: s[c], i, course: c }))
    : []);

  sheet.appendChild(el('h1', 'p-title', 'Dinner This Week'));
  sheet.appendChild(el('p', 'p-sub', new Date().toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })));

  const table = el('table', 'p-plan');
  const thead = el('thead');
  const hr = el('tr');
  for (const [h, cls] of [['Day', 'p-day'], ['Meal', ''], ['Time', 'p-time']]) {
    hr.appendChild(Object.assign(el('th', cls, h)));
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const [i, d] of days.entries()) {
    const tr = el('tr');
    tr.appendChild(el('td', 'p-day', DAYS[i]));
    const meal = el('td');
    const slot = plan[i] || emptySlot();
    const courses = slotList(slot);

    if (!isCooking(d)) {
      meal.appendChild(el('span', 'p-meal', MODES[d.mode].plan));
      meal.appendChild(el('span', 'p-note', 'no cooking'));
    } else if (courses.length) {
      for (const course of ['main', 'side', 'dessert']) {
        const r = slot[course];
        if (!r) continue;
        const line = el('span', course === 'main' ? 'p-meal' : 'p-extra');
        // Extras are labelled so the plan reads as a menu, not a list of equals.
        if (course !== 'main') line.appendChild(el('em', null, `${COURSES[course].label}: `));
        line.appendChild(document.createTextNode(r.name));
        meal.appendChild(line);

        const timing = hasTime(r)
          ? [r.prep && `prep ${fmtMins(r.prep)}`, r.cook && `cook ${fmtMins(r.cook)}`]
              .filter(Boolean).join(', ')
          : `about ${fmtMins(Math.round(score(r)))} (no time recorded)`;
        const bits = [[TIERS[r.tier].n, timing].filter(Boolean).join(' · ')];
        // Recipe Keeper yields are free text ("4", "8 servings", "Cuts into 8-10 slices").
        if (r.servings) bits.push(/^[\d\s./-]+$/.test(r.servings) ? `serves ${r.servings}` : r.servings);
        meal.appendChild(el('span', 'p-note', bits.join(' · ')));
      }
    } else {
      meal.appendChild(el('span', 'p-meal', 'Nothing assigned'));
      meal.appendChild(el('span', 'p-note', 'nothing in the pool fitted this day'));
    }
    tr.appendChild(meal);

    // Estimates are included so the day total isn't silently short.
    const mins = courses.reduce((sum, r) => sum + timeFor(r), 0);
    tr.appendChild(el('td', 'p-time', mins ? fmtMins(mins) : ''));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  sheet.appendChild(table);

  if (chosen.length) {
    const { items, loose } = buildShoppingList(chosen);
    const buy = items.filter((it) => !it.pantry);
    const pantry = items.filter((it) => it.pantry);

    const shop = el('section', 'p-shop');
    shop.appendChild(el('h2', 'p-h', `Shopping List — ${buy.length + loose.length} items`));

    const cols = el('div', 'p-cols');
    for (const it of buy) {
      const li = el('div', 'p-item');
      li.appendChild(el('span', 'p-box', '☐'));
      li.appendChild(el('span', 'p-amt', it.amounts.join(' + ')));
      li.appendChild(document.createTextNode(' ' + it.label));
      cols.appendChild(li);
    }
    // Unquantified lines still have to be bought, so they follow verbatim.
    for (const l of loose) {
      const li = el('div', 'p-item p-loose');
      li.appendChild(el('span', 'p-box', '☐'));
      li.appendChild(document.createTextNode(' ' + l.text));
      cols.appendChild(li);
    }
    shop.appendChild(cols);

    // Staples last, without amounts — a glance at the cupboard, not a shop.
    if (pantry.length) {
      shop.appendChild(el('h3', 'p-h2', 'Check you have'));
      const pc = el('div', 'p-cols');
      for (const it of pantry) {
        const li = el('div', 'p-item p-pantry');
        li.appendChild(el('span', 'p-box', '☐'));
        li.appendChild(document.createTextNode(' ' + it.label));
        pc.appendChild(li);
      }
      shop.appendChild(pc);
    }
    sheet.appendChild(shop);
  }

  const totalMins = chosen.reduce((s, x) => s + timeFor(x.r), 0);
  const nights = plan.filter((s, i) => isCooking(days[i]) && slotList(s).length).length;
  const extras = chosen.length - chosen.filter((x) => x.course === 'main').length;
  const bits = [`${nights} ${nights === 1 ? 'night' : 'nights'} cooking`];
  if (extras) bits.push(`${extras} ${extras === 1 ? 'extra' : 'extras'}`);
  bits.push(`${fmtMins(totalMins)} total kitchen time`);
  sheet.appendChild(el('p', 'p-foot', bits.join(' · ')));

  renderShopping(chosen);
}

/* ── On-screen shopping list ───────────────────────────── */
/* Ticked items are keyed by label so the state survives a re-render, but reset
   when the week is re-spun (the labels change). */
let ticked = new Set();

function renderShopping(chosen) {
  const box = $('#shopping');
  if (!box) return;
  box.textContent = '';

  if (!chosen.length) { box.hidden = true; return; }
  box.hidden = false;

  const { items, loose } = buildShoppingList(chosen);
  const buy = items.filter((it) => !it.pantry);
  const pantry = items.filter((it) => it.pantry);
  const looseRows = loose.map((l) => ({ label: l.text, amounts: [], loose: true }));

  const head = el('div', 'shop-head');
  head.appendChild(el('h3', null, 'Shopping List'));
  const shopRows = [...buy, ...looseRows];
  const n = shopRows.filter((x) => !ticked.has(x.label)).length;
  head.appendChild(el('span', 'count', `${n} of ${shopRows.length} to get`));

  const copy = el('button', 'link', 'copy');
  copy.title = 'Copy the list as text';
  copy.onclick = async () => {
    const line = (x) => `- ${[x.amounts.join(' + '), x.label].filter(Boolean).join(' ')}`;
    const text = [
      ...shopRows.map(line),
      ...(pantry.length ? ['', 'Check you have:', ...pantry.map((p) => `- ${p.label}`)] : []),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'copied';
      setTimeout(() => { copy.textContent = 'copy'; }, 1500);
    } catch (e) {
      copy.textContent = 'copy failed';   // clipboard needs a secure context
    }
  };
  head.appendChild(copy);
  box.appendChild(head);

  const row = (x) => {
    const li = el('li', 'shop-item' + (ticked.has(x.label) ? ' got' : '') + (x.loose ? ' loose' : ''));
    const lab = el('label');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = ticked.has(x.label);
    cb.onchange = () => {
      cb.checked ? ticked.add(x.label) : ticked.delete(x.label);
      renderShopping(chosen);
    };
    lab.appendChild(cb);
    if (x.amounts.length) lab.appendChild(el('span', 'amt', x.amounts.join(' + ')));
    lab.appendChild(el('span', 'iname', x.label));
    li.appendChild(lab);
    return li;
  };

  const ul = el('ul', 'shop-list');
  for (const x of shopRows) ul.appendChild(row(x));
  box.appendChild(ul);

  // Staples are a "have you got these?" tail, deliberately without amounts.
  if (pantry.length) {
    box.appendChild(el('h4', 'shop-sub', 'Check you have'));
    const pl = el('ul', 'shop-list pantry');
    for (const x of pantry) pl.appendChild(row(x));
    box.appendChild(pl);
  }

  if (loose.length) {
    box.appendChild(el('p', 'dim shop-note',
      `${loose.length} line${loose.length === 1 ? '' : 's'} had no clear amount — listed as written.`));
  }
}

/* ── Import ────────────────────────────────────────────── */
async function importFile(file) {
  const dz = $('#dropzone');
  dz.classList.remove('err');
  setDropMessage('Reading…', true);
  const name = file.name.toLowerCase();
  try {
    let text;
    if (name.endsWith('.zip')) {
      text = await htmlFromZip(await file.arrayBuffer());
    } else if (name.endsWith('.html') || name.endsWith('.htm')) {
      text = await file.text();
    } else {
      throw new Error('Need a .zip or .html Recipe Keeper export.');
    }
    const found = parseExport(text);
    if (!found.length) throw new Error("No recipes found — is this a Recipe Keeper export?");

    // Course/complexity tweaks are keyed by name, so re-importing a grown export
    // keeps the corrections already made.
    // Only genuine overrides carry across: a hand-set tier, a corrected course, a
    // benched recipe. A derived tier is left undefined so it is recomputed from
    // the incoming data rather than resurrected from the previous import.
    const prev = Object.fromEntries(recipes.map((r) => [r.name, r]));
    sourceLabel = file.name;
    setRecipes(found.map((r) => {
      const old = prev[r.name];
      if (!old) return r;
      const kept = { ...r, inPool: old.inPool };
      if (old.course !== courseOf(old.rawCourse)) kept.course = old.course;  // corrected by hand
      if (!old.auto) kept.tier = old.tier;                                   // set by hand
      return kept;
    }));

    showLoaded();
    confetti(60, 0.2);
  } catch (err) {
    dz.classList.add('err');
    setDropMessage(`<strong>Import failed:</strong> ${err.message}`);
  }
}

function setDropMessage(html, busy = false) {
  const p = $('#dropMsg');
  p.innerHTML = html;
  $('#dropzone').classList.toggle('busy', busy);
}

/* Once a pool is loaded the dropzone shrinks out of the way — it's only the front
   door on a first visit. With no pool it stays the prompt. */
function showLoaded() {
  const n = recipes.length;
  document.body.classList.toggle('has-pool', n > 0);
  $('#dropzone').classList.toggle('loaded', n > 0);
  setDropMessage(n
    ? `<strong>${n} recipes</strong> loaded${sourceLabel ? ` from ${sourceLabel}` : ''}`
    : '<strong>Drop a Recipe Keeper export</strong> — <code>.zip</code> or <code>.html</code>');
}

const ZIP64_MARK = 0xffffffff;

/* Reads the Zip64 extended-information extra field (header id 0x0001), which is
   where real sizes live when the 32-bit fields are all-ones. Recipe Keeper's
   exports are Zip64, so this is the normal path, not an edge case. Fields are
   present in a fixed order but only for whichever 32-bit fields were saturated.
   Returns the patched {compSz, uncSz, lho}. */
function zip64Fix(dv, extraStart, extraLen, rec) {
  let q = extraStart;
  const end = extraStart + extraLen;
  while (q + 4 <= end) {
    const id = dv.getUint16(q, true);
    const sz = dv.getUint16(q + 2, true);
    if (id === 0x0001) {
      let f = q + 4;
      const next = () => { const v = Number(dv.getBigUint64(f, true)); f += 8; return v; };
      if (rec.uncSz  === ZIP64_MARK && f + 8 <= q + 4 + sz) rec.uncSz  = next();
      if (rec.compSz === ZIP64_MARK && f + 8 <= q + 4 + sz) rec.compSz = next();
      if (rec.lho    === ZIP64_MARK && f + 8 <= q + 4 + sz) rec.lho    = next();
      break;
    }
    q += 4 + sz;
  }
  return rec;
}

/* Minimal ZIP reader: finds recipes.html and inflates it. Handles Zip64 and
   both compression methods Recipe Keeper emits (stored / deflate).
   ponytail: no encryption, no multi-disk, no other methods — the error names
   the method if one ever shows up, swap in a real zip library then. */
async function htmlFromZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Walk the End-Of-Central-Directory record back from the tail.
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 65558; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a valid .zip file');

  let count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);

  // Zip64: the true count/offset sit in the Zip64 EOCD, located via its locator.
  if (count === 0xffff || p === ZIP64_MARK) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x07064b50) {            // Zip64 EOCD locator
        const z = Number(dv.getBigUint64(i + 8, true));
        if (dv.getUint32(z, true) === 0x06064b50) {          // Zip64 EOCD
          count = Number(dv.getBigUint64(z + 32, true));
          p = Number(dv.getBigUint64(z + 48, true));
        }
        break;
      }
    }
  }

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method  = dv.getUint16(p + 10, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen= dv.getUint16(p + 30, true);
    const cmtLen  = dv.getUint16(p + 32, true);
    const fname   = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));

    if (/(^|\/)recipes\.html?$/i.test(fname)) {
      const rec = zip64Fix(dv, p + 46 + nameLen, extraLen, {
        compSz: dv.getUint32(p + 20, true),
        uncSz:  dv.getUint32(p + 24, true),
        lho:    dv.getUint32(p + 42, true),
      });
      // Local header: skip its own name + extra fields to reach the data.
      const lNameLen  = dv.getUint16(rec.lho + 26, true);
      const lExtraLen = dv.getUint16(rec.lho + 28, true);
      const start = rec.lho + 30 + lNameLen + lExtraLen;
      if (rec.compSz === ZIP64_MARK) throw new Error('zip entry size is unreadable');
      const data = u8.subarray(start, start + rec.compSz);
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8) {
        const ds = new DecompressionStream('deflate-raw');
        return await new Response(new Blob([data]).stream().pipeThrough(ds)).text();
      }
      throw new Error(`unsupported compression in zip (method ${method})`);
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error('no recipes.html inside the zip');
}

/* ── Tabs ──────────────────────────────────────────────── */
/* One section visible at a time — keeps each view inside a phone screen instead
   of one long scroll. Settings is a screen of its own, off to the side of the
   1-2-3 flow, so it never appears as a fourth step. */
const STEPS = ['pool', 'week', 'spin'];
let lastStep = 'pool';   // where "Done" returns to

function showTab(name) {
  for (const sec of document.querySelectorAll('.sec')) {
    sec.hidden = sec.id !== `sec-${name}`;
  }
  if (STEPS.includes(name)) lastStep = name;

  // Earlier steps show as done, so the bar reads as progress rather than as
  // three unrelated tabs.
  const at = STEPS.indexOf(name);
  for (const btn of document.querySelectorAll('.tab')) {
    const idx = STEPS.indexOf(btn.dataset.tab);
    btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
    btn.classList.toggle('done', at >= 0 && idx < at);
  }
  $('#settingsBtn').setAttribute('aria-pressed', String(name === 'settings'));

  // A hidden section has no geometry, so reels can only be centred once shown.
  if (name === 'spin' && !rolling) {
    for (const strip of document.querySelectorAll('.reel-strip')) centreStrip(strip);
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ── Settings screen ───────────────────────────────────── */
/* Declared rather than hand-built, so adding a preference is one entry here plus
   a default in DEFAULT_SETTINGS. `after` names what to refresh once it changes. */
const SETTING_FIELDS = [
  {
    key: 'units', label: 'Measurements',
    help: 'How shopping amounts are printed. Totals are calculated the same either way.',
    type: 'select',
    options: [['metric', 'Metric (g, kg, ml, l)'], ['imperial', 'Imperial (oz, lb, fl oz, pt)']],
    after: 'shopping',
  },
  {
    key: 'fuzzy', label: 'Combine similar names',
    help: 'How eagerly the shopping list merges near-identical ingredients. Words that change what you buy — wine, cube, salted — are never merged, whatever this is set to.',
    type: 'select',
    options: Object.entries(FUZZY_LEVELS).map(([k, v]) => [k, v.label]),
    after: 'shopping',
  },
  {
    key: 'extraMaxTier', label: 'Sides & desserts up to',
    help: 'Extras are the quick thing alongside a main, so they answer to this ceiling instead of the day\'s time cap.',
    type: 'select',
    options: TIERS.map((t, i) => [String(i), t.n]),
    coerce: Number,
    after: 'plan',
  },
  {
    key: 'sfx', label: 'Sound effects',
    help: 'Reel ticks and a fanfare, synthesised in the browser — no audio files.',
    type: 'toggle',
  },
  {
    key: 'confetti', label: 'Confetti',
    help: 'The celebration when a week lands.',
    type: 'toggle',
  },
];

function renderSettings() {
  const box = $('#settingsRows');
  if (!box) return;
  box.textContent = '';

  for (const f of SETTING_FIELDS) {
    const row = el('div', 'set-row');
    const text = el('div', 'set-text');
    text.appendChild(el('div', 'set-label', f.label));
    if (f.help) text.appendChild(el('div', 'set-help', f.help));
    row.appendChild(text);

    const ctl = el('div', 'set-ctl');
    if (f.type === 'select') {
      const sel = el('select');
      sel.setAttribute('aria-label', f.label);
      for (const [value, label] of f.options) {
        sel.appendChild(Object.assign(el('option', null, label), { value }));
      }
      sel.value = String(settings[f.key]);
      sel.onchange = () => {
        settings[f.key] = f.coerce ? f.coerce(sel.value) : sel.value;
        applySetting(f.after);
      };
      ctl.appendChild(sel);
    } else {
      const lab = el('label', 'switch');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!settings[f.key];
      cb.setAttribute('aria-label', f.label);
      cb.onchange = () => {
        settings[f.key] = cb.checked;
        if (f.key === 'sfx' && cb.checked) sfx.land();
        applySetting(f.after);
      };
      lab.append(cb, el('span', 'track'));
      ctl.appendChild(lab);
    }
    row.appendChild(ctl);
    box.appendChild(row);
  }
}

/* A setting change only needs to redo the work it actually affects. */
function applySetting(scope) {
  save();
  if (scope === 'shopping') buildPrintSheet();          // also redraws the list
  if (scope === 'plan') { renderDays(); checkFeasible(); }
}

/* ── Wiring ────────────────────────────────────────────── */
let sourceLabel = '';

/* Normalises whatever came in — a fresh parse or the cached pool — into the
   working recipe shape, sorted easiest-first within each course. */
function setRecipes(list) {
  recipes = list.map((r) => {
    const auto = autoTier(r);
    return {
      ...r,
      course: r.course || 'skip',
      tier: r.tier ?? auto,
      auto: r.tier == null,
      inPool: r.inPool ?? true,
    };
  }).sort((a, b) => score(a) - score(b));

  // Dropping a pool invalidates any plan built from the old one.
  plan = days.map(() => emptySlot());
  renderRecipes();
  renderDays();
  renderBoard();
  save();
}

function init() {
  const st = load();
  days = DAYS.map((_, i) => {
    const d = st.days?.[i] || {
      maxTier: i < 5 ? 2 : 4,     // weeknights sane, weekend ambitious
      timeCap: i < 5 ? 60 : 0,
    };
    // Settings saved before modes existed only had a boolean skip.
    if (!d.mode) d.mode = d.skip ? 'none' : 'cook';
    delete d.skip;
    return d;
  });
  plan = days.map(() => emptySlot());

  // st.sfx is the pre-settings shape; fold it in so sound stays as it was.
  settings = { ...DEFAULT_SETTINGS, ...(st.settings || {}) };
  if (st.settings === undefined && st.sfx !== undefined) settings.sfx = st.sfx !== false;

  // A cached pool means a returning visitor skips the upload entirely.
  sourceLabel = st.src || '';
  setRecipes((st.pool || []).map(unpackRecipe));
  showLoaded();
  renderSettings();
  showTab('pool');

  // Tapping SPIN in the bar goes to the board; a second tap spins it.
  for (const btn of document.querySelectorAll('.tab')) {
    btn.onclick = () => {
      const was = btn.getAttribute('aria-selected') === 'true';
      showTab(btn.dataset.tab);
      if (btn.dataset.tab === 'spin' && was && !rolling) spinAll();
    };
  }

  for (const btn of document.querySelectorAll('.next')) {
    btn.onclick = () => showTab(btn.dataset.next);
  }

  $('#spinBtn').onclick = spinAll;
  $('#printBtn').onclick = () => { buildPrintSheet(); window.print(); };

  $('#settingsBtn').onclick = () => showTab('settings');
  $('#settingsDone').onclick = () => showTab(lastStep);

  // Copies Monday's whole row — mode, limits and extras — over every other day.
  $('#applyAll').onclick = () => {
    const { mode, maxTier, timeCap, side, dessert } = days[0];
    days = days.map(() => ({ mode, maxTier, timeCap, side, dessert }));
    plan = days.map(() => emptySlot());
    renderDays(); renderBoard(); save(); checkFeasible();
  };

  $('#clearPool').onclick = () => {
    if (!recipes.length) return;
    sourceLabel = '';
    setRecipes([]);
    $('#dropzone').classList.remove('err');
    showLoaded();
    showTab('pool');
  };

  $('#courseFilter').onchange = (e) => { filterCourse = e.target.value; renderRecipes(); };
  $('#poolSearch').oninput = (e) => { filterText = e.target.value; renderRecipes(); };

  const dz = $('#dropzone'), fi = $('#fileInput');
  $('#browseBtn').onclick = (e) => { e.stopPropagation(); fi.click(); };
  fi.onchange = () => fi.files[0] && importFile(fi.files[0]);
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
  });
  // A file dropped outside the zone would otherwise navigate away and lose state.
  for (const ev of ['dragover', 'drop']) {
    window.addEventListener(ev, (e) => { if (!dz.contains(e.target)) e.preventDefault(); });
  }

  // The breakpoint changes cell height, so resting reels need re-centring.
  addEventListener('resize', () => {
    if (rolling) return;
    for (const strip of document.querySelectorAll('.reel-strip')) centreStrip(strip);
  });

  buildPrintSheet();
}

document.addEventListener('DOMContentLoaded', init);

/* ── Self-check: the logic that would silently rot ──────── */
window.selfTest = function selfTest() {
  const ok = [];
  const t = (label, cond) => { ok.push([label, !!cond]); };

  t('iso PT1H', isoMinutes('PT1H') === 60);
  t('iso PT1H30M', isoMinutes('PT1H30M') === 90);
  t('iso PT0S', isoMinutes('PT0S') === 0);
  t('iso junk', isoMinutes('banana') === 0);

  const quick = { prep: 5, cook: 5, ingredients: [], steps: 1 };
  const epic  = { prep: 60, cook: 120, ingredients: new Array(20).fill('x'), steps: 30 };
  t('quick is tier 0', autoTier(quick) === 0);
  t('epic is tier 4', autoTier(epic) === 4);
  t('ingredients raise score', score({ prep: 30, cook: 0, ingredients: new Array(20).fill('x'), steps: 1 })
                             > score({ prep: 30, cook: 0, ingredients: [], steps: 1 }));

  // shuffle keeps membership
  const src = [1,2,3,4,5,6,7,8];
  t('shuffle preserves items', shuffle(src).sort((a,b)=>a-b).join() === src.join());

  // zero-time recipes: Recipe Keeper leaves PT0S often, and scoring those as 0
  // would hand them every tight weeknight
  const noTime = { prep: 0, cook: 0, ingredients: new Array(12).fill('x'), steps: 9 };
  t('no-time recipe is not Zero effort', autoTier(noTime) > 0);
  t('no-time recipe is estimated, not zero', score(noTime) > 20);
  t('no-time recipe blocked by a tight cap',
    !fits({ ...noTime, course: 'main', tier: autoTier(noTime) }, { maxTier: 4, timeCap: 20 }));
  t('timed recipe still uses its real time',
    timeFor({ prep: 10, cook: 20, ingredients: [], steps: 1 }) === 30);

  // quantity parsing — free text a human typed, so this is the fragile part
  t('parses integers', parseQty('200') === 200);
  t('parses decimals', parseQty('0.25') === 0.25);
  t('parses vulgar fractions', parseQty('½') === 0.5);
  t('parses mixed vulgar', parseQty('1 ½') === 1.5);
  t('parses ascii fractions', parseQty('3/4') === 0.75);
  t('parses mixed ascii', parseQty('1 1/2') === 1.5);
  t('rejects non-numbers', parseQty('some') === null);

  t('strips pasted bullets and checkboxes',
    cleanLine('▢ 1 cup flour') === '1 cup flour' && cleanLine('•  2 eggs') === '2 eggs');
  t('drops a slash-separated duplicate measure',
    dropDualUnits('500g/1 lb 2 oz beef mince') === '500g beef mince');
  t('drops a parenthesised duplicate measure',
    dropDualUnits('1 cup (200 g) sugar') === '1 cup sugar');
  t('keeps a real parenthetical note',
    dropDualUnits('2 lbs oxtail (chopped into chunks)') === '2 lbs oxtail (chopped into chunks)');
  t('spots section headers',
    isHeader('For the sauce:') && isHeader('Filling') && !isHeader('200g flour'));
  t('folds units onto one token',
    UNIT_CANON.tablespoons === 'tbsp' && UNIT_CANON.tbsp === 'tbsp'
    && UNIT_CANON.teaspoon === 'tsp' && UNIT_CANON.grams === 'g');
  t('ingredient key ignores prep words and case',
    ingredientKey('Finely Chopped Onions') === ingredientKey('onion'));
  t('ingredient key drops parentheticals',
    ingredientKey('flour (plain, sifted)') === 'flour');

  // aggregation: same unit combines, different units stay separate.
  // Amount assertions pin the unit system, since a saved preference would
  // otherwise decide what these print.
  const withUnits = (u, fn) => {
    const was = settings.units;
    settings.units = u;
    try { return fn(); } finally { settings.units = was; }
  };
  const metricShop = (lists) => withUnits('metric', () => shopFrom(lists));
  const shopFrom = (lists) => buildShoppingList(
    lists.map((ings, k) => ({ r: { name: `R${k}`, ingredients: ings }, i: 0 })));

  t('combines same ingredient and unit', (() => {
    const { items } = metricShop([['200g flour'], ['100g flour']]);
    return items.length === 1 && items[0].amounts.join() === '300g';
  })());
  // The headline case: a week's beef should read as one weight you can buy.
  t('scales a total up to kg', (() => {
    const { items } = metricShop([['500g beef mince'], ['500g beef mince'],
                                  ['500g beef mince'], ['500g beef mince']]);
    return items.length === 1 && items[0].amounts.join() === '2kg';
  })());
  t('adds imperial into metric', (() => {
    const { items } = metricShop([['1 lb beef mince'], ['100g beef mince']]);
    // 453.592g + 100g, rounded to a figure you can shop to
    return items.length === 1 && items[0].amounts.join() === '554g';
  })());
  t('scales millilitres up to litres', (() => {
    const { items } = metricShop([['500ml stock'], ['750ml stock']]);
    return items.length === 1 && items[0].amounts.join() === '1.25l';
  })());
  // Spoons are a measure, not a shopping volume — "2.46ml cayenne" is useless.
  t('keeps spoons as spoons', (() => {
    const { items } = shopFrom([['3 tbsp double cream'], ['2 tbsp double cream']]);
    return items.length === 1 && items[0].amounts.join() === '5 tbsp';
  })());
  t('never reports a spooned item in millilitres', (() => {
    const { items } = shopFrom([['½ tsp miso paste']]);
    return !items[0].amounts.join().includes('ml');
  })());
  t('converts cups of a liquid', (() => {
    const { items } = metricShop([['2 cups double cream'], ['500ml double cream']]);
    return items.length === 1 && items[0].amounts.length === 1
        && items[0].amounts[0].endsWith('ml');
  })());
  t('keeps cups of a chopped solid as cups', (() => {
    const { items } = shopFrom([['1 cup grated cheddar']]);
    return items[0].amounts.join() === '1 cup';
  })());
  t('cleans nbsp entities and doubled-bracket asides',
    cleanLine('Pork Belly&nbsp;') === 'Pork Belly'
    && cleanLine('1 batch pesto ((or 1 cup of any pesto))') === '1 batch pesto');
  t('takes the top of a range', (() => {
    const { items } = shopFrom([['100-200g double cream']]);
    return items.length === 1 && items[0].amounts.join() === '200g'
        && !items[0].label.startsWith('-');
  })());
  t('takes the top of a written range',
    openRange('2 to 4 sprigs thyme') === '4 sprigs thyme');
  t('label drops prep clauses and asides',
    shopLabel('chicken thighs, skin removed, halved') === 'chicken thighs'
    && shopLabel('flour (plain, sifted)') === 'flour');
  t('weight and volume stay separate', (() => {
    const { items } = metricShop([['200g tomatoes'], ['100ml tomatoes']]);
    return items.length === 1 && items[0].amounts.length === 2;
  })());
  // Trivial weights are noise: name the ingredient, drop the figure. They still
  // accumulate, so enough small hits become a number worth carrying.
  t('a small weight shows no amount', (() => {
    const { items } = metricShop([['25g pine nuts']]);
    return items.length === 1 && items[0].amounts.length === 0;
  })());
  t('small amounts still add up past the floor', (() => {
    const { items } = metricShop([['20g pine nuts'], ['20g pine nuts'], ['20g pine nuts']]);
    return items[0].amounts.join() === '60g';
  })());
  t('a small amount merges into a larger one', (() => {
    const { items } = metricShop([['25g pine nuts'], ['200g pine nuts']]);
    return items.length === 1 && items[0].amounts.join() === '225g';
  })());
  t('a spoonful alone shows no amount', (() => {
    const { items } = metricShop([['1 tbsp miso paste']]);
    return items[0].amounts.length === 0;
  })());
  t('many spoonfuls cross the floor', (() => {
    const { items } = metricShop([['2 tbsp miso paste'], ['2 tbsp miso paste']]);
    return items[0].amounts.join() === '4 tbsp';
  })());
  // Counts are not weights — one lemon is one lemon, however small.
  t('a count of one still shows its number', (() => {
    const { items } = metricShop([['1 lemon']]);
    return items[0].amounts.join() === '1';
  })());

  // Raising agents and milk-by-type are staples.
  t('raising agents are staples',
    ['bicarbonate of soda', 'bicarb', 'baking soda', 'baking powder',
     'cream of tartar', 'yeast', 'fast-action yeast'].every(isPantry));
  t('milk is a staple, per named type',
    ['milk', 'whole milk', 'semi-skimmed milk', 'oat milk', 'almond milk',
     'soya milk', 'non-dairy milk'].every(isPantry));
  t('each milk type stays its own line', (() => {
    const { items } = metricShop([['200ml whole milk'], ['200ml oat milk']]);
    return items.length === 2 && items.every((i) => i.pantry);
  })());
  t('salt & pepper matches salt and pepper',
    ingredientKey('Salt & pepper') === ingredientKey('salt and pepper')
    && isPantry(ingredientKey('Salt & pepper')));
  t('milk-adjacent purchases are not staples',
    !isPantry('buttermilk') && !isPantry('condensed milk')
    && !isPantry('sweetened condensed milk') && !isPantry('milk chocolate'));

  // Four disagreeing units is noise, not detail — show the biggest and flag it.
  t('more than two fragments collapse to the largest', (() => {
    const { items } = metricShop([['190g flour'], ['1 cup flour'], ['1 tbsp flour'], ['2 flour']]);
    return items[0].amounts.length === 1 && items[0].amounts[0] === '190g +';
  })());
  t('c. is read as a cup', (() => {
    const { items } = metricShop([['1 c. double cream']]);
    return items[0].label === 'double cream' && items[0].amounts.join() === '237ml';
  })());
  t('combines across singular/plural wording', (() => {
    const { items } = shopFrom([['2 slices sourdough'], ['1 slice sourdough']]);
    return items.length === 1 && items[0].amounts.join() === '3 slice';
  })());

  // Pantry staples: named, never quantified. "3½ tsp salt" tells you nothing.
  t('salt is a staple, not a quantity', (() => {
    const { items } = shopFrom([['1 tsp salt'], ['2 tsp salt']]);
    return items.length === 1 && items[0].pantry && items[0].amounts.length === 0;
  })());
  t('staples cover oils, water, herbs and spices',
    ['salt', 'pepper', 'water', 'olive oil', 'oil', 'vinegar', 'dried oregano',
     'ground cumin', 'paprika', 'vanilla extract', 'soy sauce', 'baking powder']
      .every(isPantry));
  // Weighed-out basics stay on the shopping list — "150g flour" is a real amount.
  t('real shopping is not treated as a staple',
    ['beef mince', 'chicken breast', 'mature cheddar', 'lemon', 'mushroom',
     'dried fusilli', 'red wine', 'plain flour', 'caster sugar', 'butter',
     'chicken stock', 'double cream'].every((k) => !isPantry(k)));
  t('an unquantified staple does not also appear as a loose line', (() => {
    const { items, loose } = shopFrom([['salt and pepper'], ['1 tsp salt']]);
    return loose.length === 0 && items.every((i) => i.pantry);
  })());
  t('staples sort to the end', (() => {
    const { items } = shopFrom([['1 tsp salt'], ['500g beef mince']]);
    return items[0].label.includes('beef') && items.at(-1).pantry;
  })());

  // Countables are bought whole, so a weight for them means "one of these".
  t('a weight and a count of an onion do not collide', (() => {
    const { items } = shopFrom([['50g onion'], ['2 onions'], ['1 onion']]);
    return items.length === 1 && items[0].amounts.join() === '4';
  })());
  t('countables cover the usual whole veg and fruit',
    ['onion', 'carrot', 'lemon', 'egg', 'potato', 'courgette', 'garlic']
      .every((k) => COUNTABLE.test(k)));
  t('red pepper is a vegetable, not the seasoning',
    !isPantry('red pepper') && !isPantry('bell pepper')
    && isPantry('black pepper') && isPantry('freshly ground black pepper'));
  t('a qualified spice is still a staple',
    isPantry('smoked paprika') && isPantry('hot chilli powder')
    && isPantry('dried mixed herbs') && isPantry('ground cinnamon'));

  // UK/US wording differences that character similarity can't bridge.
  t('ground beef and beef mince are one line', (() => {
    const { items } = shopFrom([['500g ground beef'], ['500g lean beef mince']]);
    return items.length === 1 && items[0].amounts.join() === '1kg';
  })());
  t('synonyms map across dialects',
    ingredientKey('cilantro') === ingredientKey('coriander')
    && ingredientKey('zucchini') === ingredientKey('courgette')
    && ingredientKey('all-purpose flour') === ingredientKey('plain flour'));

  // "150 grams or 3/4 cup sugar" states one amount twice.
  t('drops an "or" alternative measure',
    dropDualUnits('150 grams or 3/4 cup granulated sugar') === '150 grams granulated sugar');
  t('a modifier between number and unit does not hide the unit', (() => {
    const { items } = shopFrom([['1 heaped tsp hot chilli powder']]);
    return items[0].label === 'hot chilli powder';
  })());
  t('a leading unit word is not part of the name',
    ingredientKey('Stalks scallion') === ingredientKey('scallion')
    && ingredientKey('4 Cloves garlic'.replace(/^4 /, '')) === 'garlic');

  // normalisation: accents, spelling variants, and the guards against over-merging
  t('folds accents so pureé matches puree',
    ingredientKey('tomato pureé') === ingredientKey('tomato puree'));
  t('merges a misspelling', (() => {
    const { items } = shopFrom([['1 tbsp worcestershire sauce'], ['1 tbsp worcesteshire sauce']]);
    return items.length === 1;
  })());
  t('merges barbeque/barbecue', (() => {
    const { items } = shopFrom([['2 tbsp barbecue sauce'], ['1 tbsp barbeque sauce']]);
    return items.length === 1;
  })());
  t('merges flatleaf/flat leaf parsley', (() => {
    const { items } = shopFrom([['1 bunch flat leaf parsley'], ['1 bunch flatleaf parsley']]);
    return items.length === 1;
  })());
  t('does NOT merge vinegar with wine vinegar', (() => {
    const { items } = shopFrom([['1 tbsp white vinegar'], ['1 tbsp white wine vinegar']]);
    return items.length === 2;
  })());
  t('does NOT merge stock with stock cube', (() => {
    const { items } = shopFrom([['500ml chicken stock'], ['1 chicken stock cube']]);
    return items.length === 2;
  })());
  t('does NOT merge salted with unsalted butter', (() => {
    const { items } = shopFrom([['100g salted butter'], ['100g unsalted butter']]);
    return items.length === 2;
  })());
  t('does NOT merge dark with white chocolate', (() => {
    const { items } = shopFrom([['100g dark chocolate'], ['100g white chocolate']]);
    return items.length === 2;
  })());
  t('trigram similarity is symmetric and bounded',
    Math.abs(similarity('onion', 'onions') - similarity('onions', 'onion')) < 1e-9
    && similarity('onion', 'onion') === 1 && similarity('abc', 'xyz') < 0.2);
  t('strips a trailing prep clause before matching',
    ingredientKey('beef mince, sliced') === ingredientKey('beef mince'));
  t('matches an ingredient whether the unit leads or trails',
    ingredientKey('garlic cloves') === ingredientKey('garlic'));
  t('combines garlic written both ways', (() => {
    const { items } = shopFrom([['1 clove garlic'], ['6 garlic cloves']]);
    return items.length === 1 && items[0].amounts.join() === '7';
  })());
  // "2 x 400g cans" is 800g of the thing, not two unnamed items.
  t('folds a multiplier into the measure',
    foldMultiplier('2 x 400g cans chopped tomatoes') === '800g cans chopped tomatoes');
  t('a bare multiplier becomes a count',
    foldMultiplier('2x tins chopped tomato') === '2 tins chopped tomato');
  t('strips a price annotation and its leftovers',
    cleanLine('2 x 400g cans of cherry tomatoes ((£0.85x2)=(£1.70))')
      === '2 x 400g cans of cherry tomatoes');
  t('label drops a container phrase',
    shopLabel('cans of tuna') === 'tuna' && shopLabel('of tuna') === 'tuna');
  t('label drops a comma-less prep instruction',
    shopLabel('tomatoes sliced') === 'tomatoes'
    && shopLabel('red onion finely sliced') === 'red onion'
    && shopLabel('gherkin sliced lengthways') === 'gherkin');
  t('label has no orphaned bracket',
    shopLabel('baby potatoes (larger ones cut in half (Note 5))') === 'baby potatoes'
    && !shopLabel('pork chops / cutlets (around 200g each').includes('('));
  t('unquantified lines are kept, not dropped', (() => {
    const { items, loose } = shopFrom([['a good handful of rocket', '2 eggs']]);
    return items.length === 1 && loose.length === 1
        && loose[0].text === 'a good handful of rocket';
  })());
  t('section headers never reach the list', (() => {
    const { items, loose } = shopFrom([['For the sauce:', '1 tbsp soy sauce']]);
    return items.length === 1 && loose.length === 0;
  })());
  t('no ingredient is silently lost', (() => {
    const lines = ['200g flour', '1 ½ tsp baking powder', 'pinch of salt', '▢ 2 eggs', 'Topping'];
    const { items, loose } = shopFrom([lines]);
    return items.length + loose.length === 4;   // 5 lines minus one header
  })());
  t('formats quantities readably',
    fmtQty(2) === '2' && fmtQty(1.5) === '1½' && fmtQty(0.5) === '½' && fmtQty(300) === '300');

  t('metric prints kg and litres',
    withUnits('metric', () => displayAmount(2000, 'g') === '2kg'
                            && displayAmount(1250, 'ml') === '1.25l'));
  t('imperial prints lb and pints',
    withUnits('imperial', () => displayAmount(907.184, 'g') === '2 lb'
                              && displayAmount(1136.522, 'ml') === '2 pt'));
  t('imperial falls back to oz then g',
    withUnits('imperial', () => displayAmount(56.699, 'g') === '2 oz'
                              && displayAmount(10, 'g') === '10g'));
  // Converted imperial lands on arbitrary decimals, so it rounds to a quarter.
  t('imperial rounds to shoppable quarters',
    withUnits('imperial', () => displayAmount(175, 'g') === '6.25 oz'));
  t('unit choice does not change the arithmetic', (() => {
    const total = () => shopFrom([['500g beef'], ['500g beef']]).items[0];
    const m = withUnits('metric', total), i = withUnits('imperial', total);
    return m.amounts.join() === '1kg' && i.amounts.join() === '2.25 lb';
  })());

  // Fuzzy strictness is a setting; the guards hold at every level.
  const withFuzzy = (level, fn) => {
    const was = settings.fuzzy;
    settings.fuzzy = level;
    try { return fn(); } finally { settings.fuzzy = was; }
  };
  t('fuzzy off keeps spelling variants apart',
    withFuzzy('off', () => shopFrom([['1 tbsp barbecue sauce'], ['1 tbsp barbeque sauce']]).items.length === 2));
  t('fuzzy eager still respects the guard words',
    withFuzzy('eager', () => shopFrom([['1 tbsp white vinegar'], ['1 tbsp white wine vinegar']]).items.length === 2));
  t('every fuzzy level is a usable threshold',
    Object.values(FUZZY_LEVELS).every((l) => typeof l.min === 'number' && l.label));

  // Settings screen contract: every field maps to a real, defaulted preference.
  t('every setting field has a default',
    SETTING_FIELDS.every((f) => f.key in DEFAULT_SETTINGS));
  t('select fields offer the current value as an option',
    SETTING_FIELDS.filter((f) => f.type === 'select')
      .every((f) => f.options.some(([v]) => v === String(DEFAULT_SETTINGS[f.key]))));

  // course mapping — the whole point of the filter
  t('maps Main Dish to main', courseOf('Main Dish') === 'main');
  t('maps Side Dish to side', courseOf('Side Dish') === 'side');
  t('maps Appetizer to side', courseOf('Appetizer') === 'side');
  t('maps Dessert to dessert', courseOf('Dessert') === 'dessert');
  t('case/space insensitive', courseOf('  dESSERT ') === 'dessert');
  t('non-food courses are not rolled',
    ['Medicine', 'Cosmetics', 'Baby Food', 'Breakfast', 'Snack', 'Sauces', '', null]
      .every((c) => courseOf(c) === 'skip'));

  // assignment: courses kept apart, no repeats, most-constrained day still fed
  const stash = [recipes, days, plan];
  const mk = (name, course, tier, mins) => ({
    name, course, tier, inPool: true,
    prep: mins, cook: 0, ingredients: [], steps: 1,
  });
  recipes = [
    mk('A', 'main', 0, 10),                 // only main that fits a tier-0 day
    mk('B', 'main', 2, 40),
    mk('C', 'main', 3, 80),
    mk('S1', 'side', 1, 15),
    mk('S2', 'side', 1, 15),
    mk('D1', 'dessert', 1, 20),
    mk('X', 'skip', 0, 5),                  // must never be rolled
  ];
  days = [
    { maxTier: 0, timeCap: 0,  mode: 'cook', side: true },     // only A fits
    { maxTier: 4, timeCap: 0,  mode: 'cook', side: true },
    { maxTier: 4, timeCap: 0,  mode: 'cook', dessert: true },
    { maxTier: 4, timeCap: 0,  mode: 'takeout', side: true },  // non-cook wins
    { maxTier: 1, timeCap: 10, mode: 'cook' },                 // A only, taken
    { maxTier: 4, timeCap: 0,  mode: 'leftovers' },
    { maxTier: 4, timeCap: 0,  mode: 'none' },
  ];

  const fail = new Set();
  for (let n = 0; n < 200; n++) {
    const p = assign();
    for (const course of ['main', 'side', 'dessert']) {
      const got = p.map((s) => s[course]).filter(Boolean);
      if (new Set(got.map((r) => r.name)).size !== got.length) fail.add('no duplicates within a course');
      if (got.some((r) => r.course !== course)) fail.add('each reel draws its own course');
    }
    if (p.some((s) => slotList(s).some((r) => r.course === 'skip'))) fail.add("'don't roll' never appears");
    if ([3, 5, 6].some((i) => slotList(p[i]).length)) fail.add('non-cooking days stay empty');
    if (p[0].main?.name !== 'A') fail.add('most-constrained day gets its only option');
    if (p[4].main) fail.add('impossible day left empty');
    if (p.some((s, i) => s.main && !fits(s.main, days[i]))) fail.add('every main fits its day');
    // Extras are only ever placed where asked for.
    if (p.some((s, i) => s.side && !days[i].side)) fail.add('sides only where ticked');
    if (p.some((s, i) => s.dessert && !days[i].dessert)) fail.add('desserts only where ticked');
    // A side must not be blocked by the main's tight time cap.
    if (days[0].side && !p[0].side) fail.add('extras ignore the main time cap');
  }
  for (const label of ['no duplicates within a course', 'each reel draws its own course',
                       "'don't roll' never appears", 'non-cooking days stay empty',
                       'most-constrained day gets its only option', 'impossible day left empty',
                       'every main fits its day', 'sides only where ticked',
                       'desserts only where ticked', 'extras ignore the main time cap']) {
    t(label, !fail.has(label));
  }

  // modes: only 'cook' asks for a recipe, and every mode has printable text
  t('isCooking only for cook',
    isCooking({ mode: 'cook' }) && isCooking({}) &&
    !isCooking({ mode: 'takeout' }) && !isCooking({ mode: 'leftovers' }) && !isCooking({ mode: 'none' }));
  t('every non-cook mode has board + plan text',
    MODE_KEYS.filter((k) => k !== 'cook').every((k) => MODES[k].board && MODES[k].plan));
  t('cooking count ignores non-cook days', days.filter(isCooking).length === 4);

  // localStorage round-trip: what we cache must rebuild the working shape
  const packed = recipes.map(packRecipe);
  const back = packed.map(unpackRecipe);
  t('cache round-trip keeps name/course/times',
    back.every((r, i) => r.name === recipes[i].name && r.course === recipes[i].course
                      && r.prep === recipes[i].prep && r.cook === recipes[i].cook));
  t('cache carries no photo or directions payload',
    packed.every((o) => !('image' in o) && !('directions' in o)));
  // A manual tier must survive the cache; a derived one must be recomputed, and
  // must not come back looking like a manual override.
  t('cache keeps a manual tier but not a derived one', (() => {
    const norm = (r) => {
      const round = unpackRecipe(packRecipe(r));
      const auto = autoTier(round);
      return { tier: round.tier ?? auto, auto: round.tier == null };
    };
    const manual  = norm({ ...mk('M', 'main', 4, 10), auto: false });
    const derived = norm({ ...mk('N', 'main', 4, 10), auto: true });
    return manual.tier === 4 && !manual.auto && derived.auto;
  })());

  // parser round-trip on a minimal fragment
  const frag = `<div class="recipe-details">
    <h2 itemprop="name">Test Dish</h2>
    <span itemprop="recipeCourse">Main Dish</span>
    <span itemprop="recipeYield">4</span>
    <meta content="PT10M" itemprop="prepTime"><meta content="PT20M" itemprop="cookTime">
    <div class="recipe-ingredients" itemprop="recipeIngredients"><p>salt</p><p></p><p>pepper</p></div>
    <div itemprop="recipeDirections"><p>1. do it</p><p>2. done</p></div></div>`;
  const pr = parseExport(frag);
  t('parses one recipe', pr.length === 1);
  t('parses times', pr[0]?.prep === 10 && pr[0]?.cook === 20);
  t('parses course', pr[0]?.course === 'main' && pr[0]?.rawCourse === 'Main Dish');
  t('drops blank ingredient lines', pr[0]?.ingredients.length === 2);
  t('counts steps', pr[0]?.steps === 2);

  [recipes, days, plan] = stash;

  const failed = ok.filter(([, v]) => !v);
  console.log(failed.length
    ? `selfTest: ${failed.length} FAILED — ` + failed.map(([l]) => l).join(', ')
    : `selfTest: all ${ok.length} checks passed`);
  return failed.length === 0;
};

})();
