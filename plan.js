/* ═══════════════════════════════════════════════════════════
   Gym Basics — training engine
   Two layers, no DOM:

   1. Selection  — pick / rx / bestRx / STRUCT. Lifted out of the
      workout builder so the weekly planner uses the same logic
      instead of a second copy that drifts.
   2. Week       — split templates, day generation, progression.

   Loads after data.js, before app.js.
   ═══════════════════════════════════════════════════════════ */

window.GBPlan = (function () {
  "use strict";
  var GB = window.GB;

  /* ═══ 1. selection engine ═══ */

  /* which kit each "available equipment" answer allows */
  var KIT_SETS = {
    full: null, /* everything */
    machines: ["machine", "cable", "cardio", "bodyweight"],
    dumbbells: ["dumbbell", "kettlebell", "bodyweight", "cardio"]
  };

  /* structure by duration: how many of each role */
  var STRUCT = {
    20: { main: 1, acc: 1, core: 1, cond: 0 },
    30: { main: 2, acc: 1, core: 1, cond: 0 },
    45: { main: 3, acc: 2, core: 1, cond: 0 },
    60: { main: 3, acc: 3, core: 1, cond: 1 },
    75: { main: 4, acc: 3, core: 2, cond: 1 },
    90: { main: 4, acc: 4, core: 2, cond: 1 }
  };

  function bestRx(ex, lv) {
    return ex.rx[lv] || ex.rx[lv - 1] || ex.rx[lv + 1] || ex.rx[1] || ex.rx[2] || ex.rx[3];
  }

  /* goal reshapes the prescription rather than the exercise: the
     database is too thin on fatloss/endurance tags to select on alone */
  function rx(ex, level, goal, role) {
    var base = bestRx(ex, level);
    if (!base || base.time) return base;
    var out = { sets: base.sets, reps: base.reps, rest: base.rest };
    if (role === "main") {
      if (goal === "strength" && level > 1) { out.reps = "5–8"; out.rest = Math.max(base.rest, 180); }
      if (goal === "fatloss" || goal === "endurance") { out.reps = "12–15"; out.rest = Math.min(base.rest, 60); }
    }
    return out;
  }

  /* opts: {level, goal, kit, muscles, used, usedMuscles, usedParts, usedEq, offset}
     `used`, `usedMuscles`, `usedParts` and `usedEq` are mutated, as the
     builder relies on. */
  function pick(role, count, opts) {
    if (!count) return [];
    var kits = KIT_SETS[opts.kit];
    var muscles = opts.muscles || ["full"];
    var used = opts.used || [];
    var usedMuscles = opts.usedMuscles || [];
    var usedParts = opts.usedParts || [];
    var usedEq = opts.usedEq || [];
    var wantAll = muscles.indexOf("full") > -1;

    var pool = GB.EXERCISES.filter(function (x) {
      if (x.role !== role) return false;
      if (x.level > opts.level) return false;
      if (kits && kits.indexOf(x.kit) === -1) return false;
      if (used.indexOf(x.id) > -1) return false;
      /* core and conditioning serve any focus, so they skip the muscle filter */
      if (!wantAll && muscles.indexOf(x.muscle) === -1 && (opts.parts || []).indexOf(x.part) === -1 &&
          !(role === "conditioning" || role === "core" || role === "warmup" || role === "cooldown")) return false;
      if (!bestRx(x, opts.level)) return false;
      return true;
    });

    /* goal match first, then exact level match, then spread across muscles */
    pool.sort(function (a, b) {
      var ga = a.goals.indexOf(opts.goal) > -1 ? 0 : 1;
      var gb = b.goals.indexOf(opts.goal) > -1 ? 0 : 1;
      if (ga !== gb) return ga - gb;
      var la = a.level === opts.level ? 0 : 1;
      var lb = b.level === opts.level ? 0 : 1;
      if (la !== lb) return la - lb;
      return 0;
    });

    /* offset rotates *within* the tier of equally-good candidates, so two
       days of the same split (Full body A / B) differ without either
       becoming the worse session. offset 0 reproduces the builder exactly. */
    var offset = opts.offset || 0;
    /* spread, in order of importance: a muscle not yet trained, then a
       body part within it (a hamstring lift before a third quad lift), then a station
       not yet used — the gym has the full kit, so use it */
    function spread(x) {
      var part = x.part || x.muscle;
      var partCount = usedParts.filter(function (p) { return p === part; }).length;
      return (usedMuscles.indexOf(x.muscle) > -1 ? 4 : 0) + partCount * 2 +
        (x.eq && usedEq.indexOf(x.eq) > -1 ? 1 : 0);
    }
    var out = [];
    while (out.length < count && pool.length) {
      var best = Infinity, fresh = [];
      pool.forEach(function (x, i) {
        var sc = spread(x);
        if (sc < best) { best = sc; fresh = [i]; } else if (sc === best) fresh.push(i);
      });
      var idx = fresh[offset % fresh.length];
      var chosen = pool.splice(idx, 1)[0];
      out.push(chosen);
      used.push(chosen.id);
      usedMuscles.push(chosen.muscle);
      usedParts.push(chosen.part || chosen.muscle);
      if (chosen.eq) usedEq.push(chosen.eq);
    }
    return out;
  }

  /* ═══ 2. week engine ═══ */

  /* bumped when the exercise pool or selection changes, so a stored week
     built from the old library is rebuilt with the same answers */
  var PLAN_V = 7;

  var DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  var DOW_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  /* The muscle taxonomy has a single "arms" bucket, so a pull day would
     otherwise be free to pick triceps work and a push day biceps curls.
     Ruled out by body part, so new arm exercises are covered automatically. */
  var TRICEPS = ["triceps"];
  var BICEPS = ["biceps", "rear-delts"];
  /* rear shoulders are a pulling muscle: they belong on pull day, not push */
  var PULL_PARTS = ["rear-delts"];

  /* day templates — a name plus a muscle focus. Counts still come from
     STRUCT[duration], so a day generates through the proven builder path. */
  var TPL = {
    fullA:   { name: "Full body A", muscles: ["full"], offset: 0 },
    fullB:   { name: "Full body B", muscles: ["full"], offset: 1 },
    fullC:   { name: "Full body C", muscles: ["full"], offset: 2 },
    upperA:  { name: "Upper A", muscles: ["chest", "back", "shoulders", "arms"], offset: 0 },
    upperB:  { name: "Upper B", muscles: ["chest", "back", "shoulders", "arms"], offset: 1 },
    lowerA:  { name: "Lower A", muscles: ["legs", "glutes"], offset: 0 },
    lowerB:  { name: "Lower B", muscles: ["legs", "glutes"], offset: 1 },
    pushA:   { name: "Push A", muscles: ["chest", "shoulders", "arms"], offset: 0, avoid: BICEPS },
    pushB:   { name: "Push B", muscles: ["chest", "shoulders", "arms"], offset: 1, avoid: BICEPS },
    pullA:   { name: "Pull A", muscles: ["back", "arms"], parts: PULL_PARTS, offset: 0, avoid: TRICEPS },
    pullB:   { name: "Pull B", muscles: ["back", "arms"], parts: PULL_PARTS, offset: 1, avoid: TRICEPS },
    legsA:   { name: "Legs A", muscles: ["legs", "glutes"], offset: 0 },
    legsB:   { name: "Legs B", muscles: ["legs", "glutes"], offset: 1 },
    cardio:  { name: "Cardio + core", muscles: ["full"], offset: 0, cardioDay: true }
  };

  /* What a session actually trains, in body-part words. "Push A" is a split
     name, not an answer to "what am I doing today" — so the day is named from
     the exercises that were picked: "Chest · Shoulders · Triceps". The split
     name is kept alongside it as `code` for anyone who wants it. */
  var GROUP_LABEL = {
    chest: "Chest", back: "Back", shoulders: "Shoulders", legs: "Legs", glutes: "Glutes",
    biceps: "Biceps", triceps: "Triceps", "rear-delts": "Rear shoulders",
    arms: "Arms", core: "Core", full: "Full body"
  };
  /* parts worth naming in their own right: the data has one "arms" bucket, so
     a push day and a pull day would otherwise both read "Arms" */
  var NAMED_PARTS = ["triceps", "biceps", "rear-delts"];
  /* head to toe, the order a session is normally described in */
  var GROUP_ORDER = ["chest", "back", "shoulders", "rear-delts", "arms", "biceps", "triceps", "legs", "glutes", "core", "full"];

  function bodyFocus(tpl, lifts) {
    if (tpl.cardioDay) return "Cardio · Core";
    var order = [], count = {};
    lifts.forEach(function (ex) {
      if (!ex) return;
      var part = ex.part || ex.muscle;
      var g = NAMED_PARTS.indexOf(part) > -1 ? part : ex.muscle;
      if (!GROUP_LABEL[g]) g = ex.muscle;
      if (count[g] == null) { count[g] = 0; order.push(g); }
      count[g]++;
    });
    /* the most-trained groups earn the name; a full-body day gets a fourth */
    order.sort(function (a, b) { return count[b] - count[a]; });
    var room = tpl.muscles.indexOf("full") > -1 ? 4 : 3;
    /* then read them out head to toe, so the same session is always worded
       the same way round: "Chest · Shoulders · Triceps", never "Triceps · Chest" */
    var top = order.slice(0, room).sort(function (a, b) {
      return GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b);
    }).map(function (g) { return GROUP_LABEL[g] || g; });
    return top.length ? top.join(" · ") : tpl.name;
  }

  /* Beginners are not given six lifting days. Level 1 has a smaller pool of
     main+accessory exercises — six lifting days would repeat the same
     handful, and more days is not automatically better. Extra days become
     cardio and active recovery instead. */
  var SPLITS = {
    1: {
      2: ["fullA", "fullB"],
      3: ["fullA", "fullB", "fullC"],
      4: ["fullA", "fullB", "fullA", "fullB"],
      5: ["fullA", "fullB", "cardio", "fullC"],
      6: ["fullA", "fullB", "cardio", "fullC", "fullA"]
    },
    2: {
      2: ["upperA", "lowerA"],
      3: ["pushA", "pullA", "legsA"],
      4: ["upperA", "lowerA", "upperB", "lowerB"],
      5: ["pushA", "pullA", "legsA", "upperB", "lowerB"],
      6: ["pushA", "pullA", "legsA", "pushB", "pullB", "legsB"]
    },
    3: {
      2: ["upperA", "lowerA"],
      3: ["pushA", "pullA", "legsA"],
      4: ["upperA", "lowerA", "upperB", "lowerB"],
      5: ["pushA", "pullA", "legsA", "upperB", "lowerB"],
      6: ["pushA", "pullA", "legsA", "pushB", "pullB", "legsB"]
    }
  };

  /* which weekdays carry the training, spread for recovery */
  var PLACEMENT = { 1: [0], 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5] };

  /* week 1–4 focus. Progression is real but conservative: volume before load,
     and never an automatic weight jump. */
  var WEEKS = {
    1: { focus: "Learn the movements", note: "Lightest settings that still feel like work. Success this week is finishing every session.", sets: 0 },
    2: { focus: "Same weights, better reps", note: "Nothing gets heavier. Slow the lowering, use the full range, breathe on rhythm.", sets: 0 },
    3: { focus: "Add volume", note: "One extra set on the main lifts. Weights stay exactly where they were.", sets: 1 },
    4: { focus: "Add load", note: "Back to the week-2 set count. Where all sets felt smooth, take the next weight up — a small jump.", sets: 0 }
  };

  var ACTIVE = {
    name: "Active recovery",
    suggestions: ["A 20–30 minute walk, outdoors if you can", "Easy mobility — hip circles, cat–cow, shoulder rolls", "Stretch whatever is still sore from the last session"]
  };
  var REST = {
    name: "Rest",
    suggestions: ["Nothing planned — this is where the training actually pays off", "Eat normally, drink water, sleep well", "A gentle walk is fine if you want to move"]
  };

  function weekMeta(n) { return WEEKS[((n - 1) % 4) + 1]; }

  /* An interval finisher costs what its intervals cost. "8 × 15 s hard / 45 s
     easy" is eight minutes and "5 × 4 min hard / 2 min easy" is thirty, but
     both used to be priced at the one minute a mobility drill costs, because
     neither says "N min" in a way a single match could see. The clock then
     waved a whole conditioning block past the budget as though it were free. */
  function timeMinutes(t) {
    var s = String(t);
    var iv = /(\d+)\s*×\s*(\d+)\s*(s|min)\b[^/]*\/\s*(\d+)\s*(s|min)\b/i.exec(s);
    if (iv) {
      var work = +iv[2] / (iv[3].toLowerCase() === "s" ? 60 : 1);
      var rest = +iv[4] / (iv[5].toLowerCase() === "s" ? 60 : 1);
      return Math.max(1, Math.round(+iv[1] * (work + rest)));
    }
    /* distance intervals: a row or a run is about a minute, the rest is stated */
    var dist = /(\d+)\s*×\s*\d+\s*m\b(?:[^,]*,\s*(\d+)\s*min\s*rest)?/i.exec(s);
    if (dist) return Math.max(1, Math.round(+dist[1] * (1 + (+dist[2] || 0))));
    var m = s.match(/(\d+)\s*min/);
    return m ? +m[1] : 1;                              /* a drill is about a minute */
  }

  /* what one prescribed exercise costs in minutes, per planing1 */
  function itemMinutes(it) {
    if (!it || !it.rx) return 0;
    if (it.rx.time) return timeMinutes(it.rx.time);
    var sets = it.rx.sets || 1;
    return sets * (45 + (it.rx.rest || 60)) / 60;      /* ~45s under load + the rest */
  }

  /* what the card shows: the work, warm-up and cool-down included */
  function showMinutes(mins) { return Math.max(15, Math.round(mins / 5) * 5); }

  /* rough session length from the work itself: what the card shows is what
     the exercises cost, never the number the visitor pressed */
  function estimateMinutes(day) {
    var mins = 0;
    day.blocks.forEach(function (b) {
      b.items.forEach(function (it) { mins += itemMinutes(it); });
    });
    return showMinutes(mins);
  }

  /* ── fit the work to the clock ──
     STRUCT counts exercises, not minutes, and it cannot see the level or
     the goal: three main lifts are 45 minutes of work once an advanced
     lifter rests three minutes between heavy sets, which quietly turned a
     "45 min" session into 75. The duration is a promise about someone's
     evening, so the session is filled in the order of what it would miss
     most and stops at the budget — and if room is left over, the spares
     spend it rather than under-delivering the hour asked for.

     Both the weekly planner and the one-off builder make that promise, so
     both come through here. The builder used to keep its own copy of the
     assembly and print the duration that was asked for over whatever it
     happened to produce; a "20 min" session was never once 20 minutes.

     opts.fixed  minutes already spoken for (warm-up, cool-down)
     opts.first  the item that goes in whatever the clock says
     opts.rest   the rest, in the order they would be missed
     → { keep: [items], minutes: what it actually costs } */
  function fitToClock(opts) {
    var budget = opts.budget, spent = opts.fixed || 0, keep = [];
    function put(it) { keep.push(it); spent += itemMinutes(it); }
    if (opts.first) put(opts.first);
    (opts.rest || []).forEach(function (it) {
      if (showMinutes(spent + itemMinutes(it)) <= budget) put(it);
    });
    return { keep: keep, minutes: showMinutes(spent) };
  }

  function buildDay(tplId, cfg) {
    var tpl = TPL[tplId];
    var wk = weekMeta(cfg.weekNumber);
    var st = STRUCT[cfg.duration] || STRUCT[45];
    /* fat loss and endurance always earn a conditioning finisher, not only
       at the longer durations the builder reserves it for */
    var wantCond = st.cond || ((cfg.goal === "fatloss" || cfg.goal === "endurance") && cfg.duration >= 30);
    /* keyed to the template, not the weekday: on an A/B/A/B week, Monday's
       Full body A and Thursday's Full body A are deliberately the same
       session — that repetition is how the movement gets learned. */
    var offset = (tpl.offset || 0) + (cfg.seed || 0);

    /* seeding `used` is how a template rules an exercise out */
    var used = GB.EXERCISES.filter(function (x) {
      return (tpl.avoid || []).indexOf(x.part) > -1;
    }).map(function (x) { return x.id; });
    var usedMuscles = [], usedParts = [], usedEq = [];
    var base = { level: cfg.level, goal: cfg.goal, kit: cfg.kit || "full", used: used };

    function take(role, count, muscles, um, off, up, ue) {
      return pick(role, count, {
        level: base.level, goal: base.goal, kit: base.kit, muscles: muscles,
        parts: tpl.parts, used: used, usedMuscles: um, usedParts: up || [], usedEq: ue || [], offset: off
      });
    }

    /* pre-gym: one easy cardio piece + two dynamic drills */
    var warmCardio = take("warmup", 1, ["full"], [], offset);
    var warmPrep = GB.EXERCISES.filter(function (x) {
      return x.role === "warmup" && x.kit !== "cardio" && used.indexOf(x.id) === -1;
    });
    var prep = [];
    for (var i = 0; i < 2 && warmPrep.length; i++) {
      var pk = warmPrep.splice((offset + i) % warmPrep.length, 1)[0];
      used.push(pk.id); prep.push(pk);
    }

    /* body parts and stations carry from main work into accessories, so the
       accessory slots finish what the main lifts left untouched */
    var mains = tpl.cardioDay ? [] : take("main", st.main, tpl.muscles, usedMuscles, offset, usedParts, usedEq);
    if (!tpl.cardioDay && mains.length < st.main) {
      mains = mains.concat(take("accessory", st.main - mains.length, tpl.muscles, usedMuscles, offset, usedParts, usedEq));
    }
    /* more accessories than the shape asks for: the spare ones are only
       used if the clock has room left after the session proper */
    var accs = tpl.cardioDay ? [] : take("accessory", st.acc + 4, tpl.muscles, usedMuscles.slice(), offset, usedParts, usedEq);
    /* a cardio day is carried entirely by core and conditioning, so it is
       picked with spares the way a lifting day is picked with spare
       accessories — otherwise a 90-minute booking buys the same 40 minutes
       as a 45-minute one. */
    var cores = take("core", tpl.cardioDay ? 6 : st.core, ["full"], [], offset);
    var conds = (tpl.cardioDay || wantCond) ? take("conditioning", tpl.cardioDay ? 6 : (st.cond || 1), ["full"], [], offset) : [];

    /* post-gym: three stretches, rotated so it is not the same three daily */
    var coolPool = GB.EXERCISES.filter(function (x) { return x.role === "cooldown"; });
    var cools = [];
    for (var j = 0; j < 3 && coolPool.length; j++) {
      cools.push(coolPool.splice((offset + j * 2) % coolPool.length, 1)[0]);
    }

    function item(ex, role, bump) {
      var r = rx(ex, cfg.level, cfg.goal, role);
      var out = { id: ex.id, name: ex.name, kit: ex.kit, eq: ex.eq || null, muscles: ex.musclesText, role: role, rx: r };
      /* week 3 adds a set to the main lifts; show what changed */
      if (role === "main" && r && !r.time && bump) {
        out.rx = { sets: r.sets + bump, reps: r.reps, rest: r.rest };
        out.prev = r.sets + " × " + r.reps;
      }
      return out;
    }
    function block(label, items, role) {
      return { label: label, role: role, items: items };
    }
    function priced(list, role) {
      return list.map(function (x) { return item(x, role); });
    }

    var warmItems = priced(warmCardio.concat(prep), "warmup");
    var coolItems = priced(cools, "cooldown");
    var mainItems = priced(mains, "main");
    var accItems = priced(accs, "accessory");
    var coreItems = priced(cores, "core");
    var condItems = priced(conds, "conditioning");

    /* the first main lift is the day itself — it goes in whatever the clock
       says; everything after it is ordered by what the session would miss
       most, and fitToClock stops at the budget. */
    var wantCore = tpl.cardioDay ? 2 : st.core;
    var wantCondN = tpl.cardioDay ? 2 : (wantCond ? (st.cond || 1) : 0);
    var fixedMinutes = warmItems.concat(coolItems).reduce(function (a, it) { return a + itemMinutes(it); }, 0);
    var fitted = fitToClock({
      budget: cfg.duration,
      fixed: fixedMinutes,
      first: mainItems[0],
      rest: mainItems.slice(1, st.main)             /* the rest of the main work */
        .concat(condItems.slice(0, wantCondN))      /* the finisher the goal earns */
        .concat(coreItems.slice(0, 1))              /* core is cheap and always worth it */
        .concat(accItems.slice(0, st.acc))          /* the accessories the shape asks for */
        .concat(coreItems.slice(1, wantCore))       /* a second core piece if there is time */
        .concat(accItems.slice(st.acc))             /* and the spares, to fill the hour */
        /* a cardio day has no accessories to spend a long booking on, so its
           own spares do it — two finishers and a plank was 40 minutes whether
           the visitor asked for 45 or 90. */
        .concat(condItems.slice(wantCondN))
        .concat(coreItems.slice(Math.max(wantCore, 1)))
    });

    /* ── the volume week is added after the clock, not before it ──
       Week 3 puts an extra set on the main lifts. Pricing that set *before*
       the fit meant the clock paid for it out of whatever came last — and on
       a strength day, where a main lift carries three-minute rests, what came
       last was another main lift. Adding volume then removed volume: main-lift
       sets fell in week 3 on 64 of 1,350 answer combinations (18 sets became
       16), and total sets fell on 461 of them.

       So the clock chooses the session from the base prescription — every week
       in the block therefore runs the same exercises, which is the point of a
       block — and the extra set is then offered to each main lift in turn,
       first lift first, out of whatever slack the booking has left. Nothing is
       ever sold to pay for it: not a main lift, not an accessory. When the
       slack runs out the remaining lifts keep their week-1 sets, which is the
       honest answer at 45 minutes with three-minute rests — there is no room
       for a fourth set, and inventing it would mean dropping a lift or running
       the booking over. The week adds volume on 1,113 of the 1,350
       combinations and takes none away on any of them.

       Known gap: on the other 237 the session is identical to week 2 while
       `WEEKS[3].note` still promises an extra set. See README, "Still open". */
    if (wk.sets) {
      var items = fitted.keep.slice();
      var spent = items.reduce(function (a, it) { return a + itemMinutes(it); }, fixedMinutes);
      for (var mi = 0; mi < items.length; mi++) {
        if (items[mi].role !== "main") continue;
        var up = item(GB.EX_BY_ID[items[mi].id], "main", wk.sets);
        var cost = itemMinutes(up) - itemMinutes(items[mi]);
        if (cost > 0 && showMinutes(spent + cost) > cfg.duration) break;   /* no slack left */
        items[mi] = up; spent += Math.max(cost, 0);
      }
      fitted = { keep: items, minutes: showMinutes(spent) };
    }

    var keep = { main: [], accessory: [], conditioning: [], core: [] };
    fitted.keep.forEach(function (it) { keep[it.role].push(it); });

    var blocks = [block("Pre-gym · Warm-up", warmItems, "warmup")];
    if (keep.main.length) blocks.push(block("Main work", keep.main, "main"));
    if (keep.accessory.length) blocks.push(block("Accessory work", keep.accessory, "accessory"));
    if (keep.conditioning.length) blocks.push(block("Conditioning", keep.conditioning, "conditioning"));
    if (keep.core.length) blocks.push(block("Core", keep.core, "core"));
    blocks.push(block("Post-gym · Cool-down", coolItems, "cooldown"));

    /* named for the work that survived the clock, not the work that was picked */
    var trained = keep.main.concat(keep.accessory).map(function (it) { return GB.EX_BY_ID[it.id]; });
    var day = { type: "train", tpl: tplId, code: tpl.name,
      name: bodyFocus(tpl, trained), blocks: blocks };
    day.count = blocks.reduce(function (a, b) {
      return a + (b.role === "warmup" || b.role === "cooldown" ? 0 : b.items.length);
    }, 0);
    day.minutes = estimateMinutes(day);
    return day;
  }

  /* cfg: {level, days, goal, duration, kit, weekNumber, seed} */
  function generate(cfg) {
    cfg = cfg || {};
    var c = {
      level: +cfg.level || 1,
      days: Math.min(6, Math.max(2, +cfg.days || 3)),
      goal: cfg.goal || "fitness",
      duration: +cfg.duration || 45,
      kit: cfg.kit || "full",
      weekNumber: +cfg.weekNumber || 1,
      seed: +cfg.seed || 0
    };
    var split = (SPLITS[c.level] || SPLITS[1])[c.days] || SPLITS[1][3];
    var slots = PLACEMENT[c.days] || PLACEMENT[3];

    var week = [], t = 0;
    for (var d = 0; d < 7; d++) {
      var slot = slots.indexOf(d);
      if (slot > -1 && t < split.length) {
        var day = buildDay(split[t], c);
        day.dow = d; day.dayName = DOW[d]; day.short = DOW_SHORT[d];
        week.push(day); t++;
      } else {
        /* one active-recovery day; the rest are honest rest days */
        var isActive = (slot > -1) || (d === 5 && c.days <= 3);
        var r = isActive ? ACTIVE : REST;
        week.push({
          type: isActive ? "active" : "rest", dow: d, dayName: DOW[d], short: DOW_SHORT[d],
          name: r.name, suggestions: r.suggestions.slice(), blocks: [], count: 0, minutes: isActive ? 25 : 0
        });
      }
    }

    var wk = weekMeta(c.weekNumber);
    return {
      v: PLAN_V, level: c.level, days: c.days, goal: c.goal, duration: c.duration, kit: c.kit,
      weekNumber: c.weekNumber, seed: c.seed,
      focus: wk.focus, note: wk.note,
      trainingDays: split.length,
      week: week
    };
  }

  /* Monday-first index for today */
  function todayIndex(now) {
    var d = (now || new Date()).getDay(); /* 0 = Sunday */
    return (d + 6) % 7;
  }

  return {
    /* selection */
    KIT_SETS: KIT_SETS, STRUCT: STRUCT, bestRx: bestRx, rx: rx, pick: pick,
    /* week */
    PLAN_V: PLAN_V, TPL: TPL, SPLITS: SPLITS, WEEKS: WEEKS, DOW: DOW, DOW_SHORT: DOW_SHORT,
    GROUP_LABEL: GROUP_LABEL, bodyFocus: bodyFocus,
    generate: generate, weekMeta: weekMeta, todayIndex: todayIndex,
    estimateMinutes: estimateMinutes, itemMinutes: itemMinutes, fitToClock: fitToClock
  };
})();
