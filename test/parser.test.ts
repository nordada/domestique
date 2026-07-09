import { test } from "node:test";
import assert from "node:assert/strict";
import { parseName, mergeParsed } from "../src/parser.js";
import { REAL_SOURCE_NAMES } from "./fixtures.js";

test("extracts year glued directly onto a prefix (tdf2026-...)", () => {
  const p = parseName(REAL_SOURCE_NAMES.tdfHighlights);
  assert.equal(p.year, 2026);
  assert.equal(p.yearWasExplicit, true);
  assert.equal(p.stageNum, 4);
  assert.equal(p.isHighlights, true);
  assert.ok(p.tokens.includes("tdf"));
  assert.ok(!p.tokens.includes("2026"));
});

test("detects known broadcaster tokens with their canonical display form", () => {
  const sbs = parseName(REAL_SOURCE_NAMES.tdfStage01Sbs);
  assert.equal(sbs.broadcaster, "SBS");

  const eurosport = parseName("tour.de.france.2026.stage04.eurosport.highlights.1080p");
  assert.equal(eurosport.broadcaster, "Eurosport");

  const unknown = parseName("Tour-de-France-2026-Stage-01");
  assert.equal(unknown.broadcaster, null);
});

test("falls back to the current year when none is present", () => {
  const p = parseName(REAL_SOURCE_NAMES.tdfStage01Sbs);
  assert.equal(p.yearWasExplicit, false);
  assert.equal(p.year, new Date().getFullYear());
  assert.equal(p.stageNum, 1);
  assert.deepEqual(p.tokens.sort(), ["sbs", "tdf"]);
});

test("extracts resolution when present, null when absent", () => {
  const withRes = parseName(REAL_SOURCE_NAMES.tdfStage01Part1);
  assert.equal(withRes.resolution, 720);
  assert.ok(!withRes.tokens.includes("720p"));

  const withoutRes = parseName(REAL_SOURCE_NAMES.tdfStage01Sbs);
  assert.equal(withoutRes.resolution, null);
});

test("extracts part-with-total from (Part-N-of-M) style names", () => {
  const p = parseName(REAL_SOURCE_NAMES.tdfStage01Part1);
  assert.equal(p.year, 2026);
  assert.equal(p.stageNum, 1);
  assert.equal(p.partNum, 1);
  assert.equal(p.partTotal, 2);
});

test("extracts a 4-part stage correctly", () => {
  const p1 = parseName(REAL_SOURCE_NAMES.tdfStage04Part1);
  const p4 = parseName(REAL_SOURCE_NAMES.tdfStage04Part4);
  assert.equal(p1.partNum, 1);
  assert.equal(p1.partTotal, 4);
  assert.equal(p4.partNum, 4);
  assert.equal(p4.partTotal, 4);
});

test("extracts bare PartN with no known total (legacy Paris-Roubaix style)", () => {
  const p = parseName(REAL_SOURCE_NAMES.parisRoubaix2018Part1);
  assert.equal(p.partNum, 1);
  assert.equal(p.partTotal, null);
  assert.equal(p.year, 2018);
});

test("extracts bare 'NofM' with no 'part' keyword at all", () => {
  // Regression test: this exact bug happened for real — a tracker split a
  // stage into "... 1of2" / "... 2of2" with no "part" prefix, so neither
  // file's part number was recognized and the leftover "1of2"/"2of2" tokens
  // leaked into auto-create name-guessing, splitting one stage into two
  // separate shows.
  const p1 = parseName(REAL_SOURCE_NAMES.bareOfStage1Part1);
  const p2 = parseName(REAL_SOURCE_NAMES.bareOfStage1Part2);
  assert.equal(p1.stageNum, 1);
  assert.equal(p1.partNum, 1);
  assert.equal(p1.partTotal, 2);
  assert.ok(!p1.tokens.includes("1of2"));
  assert.equal(p2.partNum, 2);
  assert.equal(p2.partTotal, 2);
  assert.deepEqual(p1.tokens.sort(), p2.tokens.sort());
});

test("aliases Italian singular 'donna' to the canonical 'donne' config already uses", () => {
  const p = parseName(REAL_SOURCE_NAMES.girodItaliaDonnaHighlightsStage7);
  assert.ok(p.tokenSet.has("donne"));
  assert.ok(!p.tokenSet.has("donna"));
});

test("detects team and route presentation flags", () => {
  const team = parseName(REAL_SOURCE_NAMES.tdfTeamPresentation);
  assert.equal(team.isTeamPresentation, true);
  assert.equal(team.isRoutePresentation, false);

  const route = parseName(REAL_SOURCE_NAMES.tdfRoutePresentation);
  assert.equal(route.isRoutePresentation, true);
  assert.equal(route.isTeamPresentation, false);
});

test("normalizes gender/age plurals and merges split U23 tokens", () => {
  const p = parseName(REAL_SOURCE_NAMES.worldsMenU23RoadRaceUnderscore);
  assert.ok(p.tokenSet.has("men"));
  assert.ok(p.tokenSet.has("u23"));
  assert.ok(p.tokenSet.has("road"));
  assert.ok(p.tokenSet.has("race"));
});

test("strips apostrophes so D'Italia / l'Ain normalize to single tokens", () => {
  const p = parseName("Giro D'Italia");
  assert.ok(p.tokenSet.has("ditalia"));
});

test("mergeParsed prefers the file's explicit fields, falls back to the folder's", () => {
  const folder = parseName(REAL_SOURCE_NAMES.tdfStage01FolderName);
  const file = parseName(REAL_SOURCE_NAMES.tdfStage01Part1);
  const merged = mergeParsed(folder, file);
  assert.equal(merged.year, 2026);
  assert.equal(merged.stageNum, 1);
  assert.equal(merged.partNum, 1);
  assert.equal(merged.partTotal, 2);
});

test("mergeParsed unions tokens from both folder and file", () => {
  const folder = parseName("British.National.Road.Championships.2026.Mens.Road.Race");
  const file = parseName("video");
  const merged = mergeParsed(folder, file);
  assert.ok(merged.tokenSet.has("british"));
  assert.ok(merged.tokenSet.has("men"));
});
