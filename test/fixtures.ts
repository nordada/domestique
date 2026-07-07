/**
 * Real torrent/download names pulled from the user's actual Transmission
 * complete-downloads directory and Plex library, gathered while designing
 * this tool. Kept here verbatim so parser/namer regressions get caught
 * against real data instead of invented edge cases.
 */

export const REAL_SOURCE_NAMES = {
  britishNationalsMenFolder: "British.National.Road.Championships.2026.Mens.Road.Race",
  britishNationalsWomenFile: "British.National.Road.Championships.2026.Womens.Road.Race",
  tdfStage01Sbs: "TDF-Stage01-SBS",
  tdfStage01FolderName: "Tour-de-France-2026-Stage-01",
  tdfStage01Part1: "Tour-de-France-2026-Stage-01-(Part-1-of-2)-(720p@50fps)",
  tdfStage01Part2: "Tour-de-France-2026-Stage-01-(Part-2-of-2)-(720p@50fps)",
  tdfStage04FolderName: "Tour-de-France-2026-Stage-04",
  tdfStage04Part1: "Tour-de-France-2026-Stage-04-(Part-1-of-4)-(720p@50fps)",
  tdfStage04Part4: "Tour-de-France-2026-Stage-04-(Part-4-of-4)-(720p@50fps)",
  tdfRoutePresentation: "Tour-de-France-2026-Route-Presentation",
  tdfTeamPresentation: "Tour-de-France-2026-Team-Presentation",
  uciXccWorldCup: "UCI.XCC.World.Cup.2026.La.Thuile.Men.Elite.720p-[Eurosport][Webrip]",
  uciXcoWorldCup: "UCI.XCO.World.Cup.2026.La.Thuile.Women.Elite.720p-[Eurosport][Webrip]",
  worldsMenRoadRaceUnderscore: "World_Championships_Road_2025_Road_Race_Men_[UCIChannel]",
  worldsMenU23RoadRaceUnderscore: "World_Championships_Road_2025_Road_Race_Men_U23_[UCI_Channel]",
  worldsMenJuniorDash: "world-championships-road-2025-men-junior-ucichannel",
  worldsWomenU23Dash: "world-championships-road-2025-women-u23-ucichannel",
  tdfHighlights: "tdf2026-stage04-tnt-highlights-1080p-50fps",
  parisRoubaix2018Part1: "PaisRoubaix_2018_SBS_HD_Part1",
};

export const REAL_DEST_EXAMPLES = {
  tdfTeamPresentation: "Tour de France - S2026E00 - Team Presentation.mp4",
  tdfStage01Part1: "Tour de France - S2026E01 - Stage 1 - pt01.mp4",
  tdfStage01Part2: "Tour de France - S2026E01 - Stage 1 - pt02.mp4",
  tdfHighlightsStage1: "Tour de France - S2026E01 - Stage 1 Highlights.mp4",
  worldsMenRoadRace: "World Championships - S2025E01 World Championships Mens Road Race pt01.mp4",
  worldsMenU23RoadRace:
    "World Championships - S2025E05 World Championships Mens U23 Road Race pt01.mp4",
};
