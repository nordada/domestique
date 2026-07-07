import { test } from "node:test";
import assert from "node:assert/strict";
import { parseName } from "../src/parser.js";
import { matchShow } from "../src/matcher.js";
import { loadConfig } from "../src/config.js";
import { REAL_SOURCE_NAMES } from "./fixtures.js";

function freshConfig() {
  return loadConfig();
}

test("matches 'tdf' abbreviation to Tour de France", () => {
  const p = parseName(REAL_SOURCE_NAMES.tdfStage01Sbs);
  const m = matchShow(p, freshConfig());
  assert.equal(m.show.id, "tour-de-france");
  assert.equal(m.autoCreated, false);
});

test("routes a highlights release to the highlights variant, not the base show", () => {
  const p = parseName(REAL_SOURCE_NAMES.tdfHighlights);
  const m = matchShow(p, freshConfig());
  assert.equal(m.show.id, "tour-de-france-highlights");
});

test("prefers the more specific Eurosport highlights entry when 'eurosport' is present", () => {
  const p = parseName("tour.de.france.2026.stage04.eurosport.highlights.1080p");
  const m = matchShow(p, freshConfig());
  assert.equal(m.show.id, "tdf-euro-highlights");
});

test("matches British Nationals to the dynamic Nationals show", () => {
  const p = parseName(REAL_SOURCE_NAMES.britishNationalsMenFolder);
  const m = matchShow(p, freshConfig());
  assert.equal(m.show.id, "nationals");
  assert.equal(m.show.type, "multi-category-dynamic");
});

test("matches underscore/dash/bracket Worlds naming variants to World Championships", () => {
  const config = freshConfig();
  for (const name of [
    REAL_SOURCE_NAMES.worldsMenRoadRaceUnderscore,
    REAL_SOURCE_NAMES.worldsMenU23RoadRaceUnderscore,
    REAL_SOURCE_NAMES.worldsMenJuniorDash,
    REAL_SOURCE_NAMES.worldsWomenU23Dash,
  ]) {
    const p = parseName(name);
    const m = matchShow(p, config);
    assert.equal(m.show.id, "world-championships", `expected match for "${name}"`);
  }
});

test("auto-creates an unrecognized race (UCI World Cup) instead of failing", () => {
  const config = freshConfig();
  const before = config.shows.length;
  const p = parseName(REAL_SOURCE_NAMES.uciXccWorldCup);
  const m = matchShow(p, config);
  assert.equal(m.autoCreated, true);
  assert.equal(m.show.type, "one-day");
  assert.equal(config.shows.length, before + 1);
});
