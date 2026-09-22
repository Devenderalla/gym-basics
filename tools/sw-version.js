#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   Gym Basics — service worker version stamp

   The one thing about the offline layer that was never checked
   by anything. `VERSION` in sw.js had to be bumped by hand every
   time a shell file changed, and forgetting is silent: the
   browser only reinstalls a worker whose own bytes differ, so an
   unbumped sw.js leaves returning phones serving the old build
   with nothing anywhere saying so.

   Nothing at runtime can fix that — by the time the worker runs,
   the browser has already decided not to reinstall it. So the
   version is derived from the content instead:

     gb-v31.a3f9c2d1
        │      └── sha256 of every shell file, first 8 hex
        └───────── human counter, bumped by hand for releases,
                   never touched by this script

   Usage:
     node tools/sw-version.js            check; exit 1 if stale
     node tools/sw-version.js --write    restamp sw.js

   `npm test` runs the check. `.githooks/pre-commit` runs --write,
   so in normal use the stamp maintains itself.
   ═══════════════════════════════════════════════════════════ */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const SW = path.join(ROOT, "sw.js");
const VERSION_RE = /^var VERSION = "([^"]*)";$/m;

/* The precache list is the definition of "the shell", so it is read
   from sw.js rather than kept in a second list here that could drift
   from it — drift between two lists being the exact bug this fixes. */
function shellFiles(src) {
  const block = /var SHELL_FILES = \[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error("sw.js: could not find SHELL_FILES");
  return block[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
}

/* "./" is index.html by another name; hashing it twice is harmless and
   hashing it not at all would miss a change to the page most people land
   on. A file named in the list but missing on disk is hashed as the fact
   that it is missing, so fixing it later still moves the stamp. */
function contentHash(src) {
  const h = crypto.createHash("sha256");
  const files = shellFiles(src).slice().sort();
  for (const f of files) {
    const rel = f === "./" ? "index.html" : f;
    const abs = path.join(ROOT, rel);
    h.update(f + "\0");
    h.update(fs.existsSync(abs) ? fs.readFileSync(abs) : Buffer.from("MISSING"));
    h.update("\0");
  }
  /* sw.js itself is part of the shell. Its VERSION line is blanked first,
     or the stamp would be hashing its own previous value and never settle. */
  h.update(src.replace(VERSION_RE, 'var VERSION = "";'));
  return h.digest("hex").slice(0, 8);
}

/* The stamp only proves the listed files are current. It says nothing
   about a file that was never listed — a new page ships, nobody adds it
   to SHELL_FILES, and it is the one page that doesn't work in the gym.
   Same class of mistake, same command, so it is checked here too. */
function unlisted(src) {
  const listed = new Set(shellFiles(src).map((f) => (f === "./" ? "index.html" : f)));
  const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  const gaps = [];

  for (const page of pages) {
    if (!listed.has(page)) { gaps.push([page, page]); continue; }
    const html = fs.readFileSync(path.join(ROOT, page), "utf8");
    const refs = [];
    let m;
    const script = /<script[^>]+src="([^"]+)"/g;
    while ((m = script.exec(html))) refs.push(m[1]);
    const style = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g;
    while ((m = style.exec(html))) refs.push(m[1]);
    for (const ref of refs) {
      if (/^(https?:)?\/\//.test(ref)) continue;   /* the site loads nothing remote, but don't assume it */
      if (!listed.has(ref)) gaps.push([ref, page]);
    }
  }

  /* One shared script missing from the list is one mistake, not ten — say
     it once, with how far it reaches, rather than once per page. */
  const byFile = new Map();
  for (const [ref, page] of gaps) {
    if (!byFile.has(ref)) byFile.set(ref, []);
    byFile.get(ref).push(page);
  }
  return [...byFile].map(([ref, pages]) =>
    pages.length === 1 && pages[0] === ref
      ? ref + " (page itself)"
      : ref + " (needed by " + pages[0] + (pages.length > 1 ? ` and ${pages.length - 1} more` : "") + ")");
}

function main() {
  const write = process.argv.includes("--write");
  const src = fs.readFileSync(SW, "utf8");

  const gaps = unlisted(src);
  if (gaps.length) {
    console.error(
      "sw.js: SHELL_FILES is missing files the site loads, so they would not\n" +
      "be there offline:\n  " + gaps.join("\n  ") + "\n" +
      "Add them to SHELL_FILES in sw.js, then run:  npm run bump:sw"
    );
    process.exit(1);
  }

  const current = VERSION_RE.exec(src);
  if (!current) { console.error("sw.js: no VERSION line"); process.exit(2); }

  /* The counter is whatever a human last wrote; only the suffix is ours. */
  const counter = current[1].split(".")[0] || "gb-v1";
  const want = counter + "." + contentHash(src);

  if (current[1] === want) {
    console.log("sw.js version is current: " + want);
    return;
  }
  if (!write) {
    console.error(
      "sw.js version is stale.\n" +
      "  is:     " + current[1] + "\n" +
      "  should: " + want + "\n" +
      "A shell file changed without the worker being restamped, so returning\n" +
      "visitors would keep the old cached build. Run:  npm run bump:sw"
    );
    process.exit(1);
  }
  fs.writeFileSync(SW, src.replace(VERSION_RE, 'var VERSION = "' + want + '";'));
  console.log("sw.js restamped: " + current[1] + " → " + want);
}

main();
