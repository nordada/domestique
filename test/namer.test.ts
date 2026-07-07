import { test } from "node:test";
import assert from "node:assert/strict";
import { parseName, mergeParsed } from "../src/parser.js";
import { matchShow } from "../src/matcher.js";
import { loadConfig } from "../src/config.js";
import { buildDestination } from "../src/namer.js";
import { REAL_SOURCE_NAMES, REAL_DEST_EXAMPLES } from "./fixtures.js";

const noopResolver = async () => 1;

async function process(rawFolder: string | null, rawFile: string) {
  const config = loadConfig();
  const fileParsed = parseName(rawFile);
  const parsed = rawFolder ? mergeParsed(parseName(rawFolder), fileParsed) : fileParsed;
  const match = matchShow(parsed, config);
  const plan = await buildDestination(match.show, parsed, "mp4", match.matchedTokens, noopResolver);
  return plan;
}

test("Team Presentation folder maps to S{year}E00", async () => {
  const plan = await process(REAL_SOURCE_NAMES.tdfTeamPresentation, REAL_SOURCE_NAMES.tdfTeamPresentation);
  assert.equal(plan.destDir, "Tour de France/Season 2026");
  assert.equal(plan.destFilename, REAL_DEST_EXAMPLES.tdfTeamPresentation);
});

test("2-part stage maps to pt01/pt02 with the same episode number", async () => {
  const plan1 = await process(REAL_SOURCE_NAMES.tdfStage01FolderName, REAL_SOURCE_NAMES.tdfStage01Part1);
  const plan2 = await process(REAL_SOURCE_NAMES.tdfStage01FolderName, REAL_SOURCE_NAMES.tdfStage01Part2);
  assert.equal(plan1.destFilename, REAL_DEST_EXAMPLES.tdfStage01Part1);
  assert.equal(plan2.destFilename, REAL_DEST_EXAMPLES.tdfStage01Part2);
  assert.equal(plan1.destDir, plan2.destDir);
});

test("4-part stage pads part numbers to 2 digits", async () => {
  const plan1 = await process(REAL_SOURCE_NAMES.tdfStage04FolderName, REAL_SOURCE_NAMES.tdfStage04Part1);
  const plan4 = await process(REAL_SOURCE_NAMES.tdfStage04FolderName, REAL_SOURCE_NAMES.tdfStage04Part4);
  assert.equal(plan1.destFilename, "Tour de France - S2026E04 - Stage 4 - pt01.mp4");
  assert.equal(plan4.destFilename, "Tour de France - S2026E04 - Stage 4 - pt04.mp4");
});

test("highlights file lands in the HIGHLIGHTS folder but keeps the base show's filename prefix", async () => {
  const plan = await process(null, REAL_SOURCE_NAMES.tdfHighlights);
  assert.equal(plan.destDir, "Tour de France HIGHLIGHTS/Season 2026");
  assert.equal(plan.destFilename, "Tour de France - S2026E04 - Stage 4 Highlights.mp4");
});

test("no-year source file warns and defaults to the current year", async () => {
  const plan = await process(null, REAL_SOURCE_NAMES.tdfStage01Sbs);
  assert.match(plan.warning ?? "", /defaulted to/);
  assert.equal(plan.destFilename, `Tour de France - S${new Date().getFullYear()}E01 - Stage 1.mp4`);
});

test("Worlds Men Road Race hits fixed category E01", async () => {
  const plan = await process(null, REAL_SOURCE_NAMES.worldsMenRoadRaceUnderscore);
  assert.equal(plan.destDir, "World Championships/Season 2025");
  assert.equal(plan.destFilename, "World Championships - S2025E01 - Mens Road Race.mp4");
});

test("Worlds Men U23 Road Race hits fixed category E05, distinct from plain Men RR", async () => {
  const plan = await process(null, REAL_SOURCE_NAMES.worldsMenU23RoadRaceUnderscore);
  assert.equal(plan.destFilename, "World Championships - S2025E05 - Mens U23 Road Race.mp4");
});

test("British Nationals Men vs Women get distinct dynamic episode numbers via directory scan", async () => {
  const config = loadConfig();
  const seen: Record<string, number> = {};
  const resolver = async (_destDir: string, title: string) => {
    if (!(title in seen)) {
      seen[title] = Object.keys(seen).length + 1;
    }
    return seen[title];
  };

  const menParsed = mergeParsed(
    parseName(REAL_SOURCE_NAMES.britishNationalsMenFolder),
    parseName(REAL_SOURCE_NAMES.britishNationalsMenFolder)
  );
  const menMatch = matchShow(menParsed, config);
  const menPlan = await buildDestination(menMatch.show, menParsed, "mp4", menMatch.matchedTokens, resolver);

  const womenParsed = parseName(REAL_SOURCE_NAMES.britishNationalsWomenFile);
  const womenMatch = matchShow(womenParsed, config);
  const womenPlan = await buildDestination(womenMatch.show, womenParsed, "mp4", womenMatch.matchedTokens, resolver);

  assert.notEqual(menPlan.destFilename, womenPlan.destFilename);
  assert.match(menPlan.destFilename, /British Mens Road Race/);
  assert.match(womenPlan.destFilename, /British Womens Road Race/);
});
