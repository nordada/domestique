# bike-race-archiver

Copies completed bike-race torrent downloads (autobrr → Transmission) into a
Plex-friendly library layout, renaming them from whatever the tracker called
them into a standardized `Show Name - SYYYYEnn - Title - ptNN.ext` scheme.

It does **not** move or delete anything from Transmission's download
directory — everything is copied, so seeding is unaffected.

## How it works

1. Transmission finishes a download and runs `scripts/torrent-done.sh`
   (installed wherever Transmission itself runs), which POSTs the torrent's
   dir/name/id/hash as JSON to this app's `/webhook/torrent-done` endpoint.
2. The app parses the raw name (`src/parser.ts`) to pull out year, stage
   number, part number, gender/age/discipline category hints, and
   highlights/presentation flags.
3. It matches those tokens against `config/shows.json` (`src/matcher.ts`) to
   find the right show. If nothing matches, it **auto-creates** a best-effort
   entry (title-cased from the leftover tokens, filed as a one-day race) and
   persists it back to `config/shows.json` so it's reused next time — but
   this is a guess; check the log and clean up the entry by hand.
4. It computes the destination folder/filename (`src/namer.ts`) and copies
   the file in (`src/fileops.ts`), writing to a `.tmp` sibling and renaming
   into place so Plex never sees a half-copied file.

## Filename convention (new downloads only — existing seasons are untouched)

- Stage race: `Show - SYYYYEnn - Stage n.ext` (or `- pt01.ext` per part).
  `E00` is reserved for Team/Route Presentation specials.
- One-day race: `Show - SYYYYE01.ext` (no title segment — the show + season
  already say what it is).
- Multi-category, fixed order (Worlds, Olympics): `Show - SYYYYEnn - Category
  Title.ext`, where the episode number for each category is defined in
  `config/shows.json` so it's stable across years.
- Multi-category, dynamic order (Nationals — the category set is open-ended
  across countries): `Show - SYYYYEnn - Country Gender Discipline.ext`,
  episode number assigned by scanning what's already in that season's folder
  (reuses the number if that exact title is already there, otherwise
  next-available).
- Highlights: filed under a separate show folder (e.g. `Tour de France
  HIGHLIGHTS`), but the *filename* keeps the base show's name, e.g. `Tour de
  France - S2026E01 - Stage 1 Highlights.mp4` — matches what's already in
  the library.

## Setup

All host-specific values (paths, IPs, port) live in two `.env` files, never
committed to git — copy the `.example` versions and fill them in.

### 1. Configure the archiver itself

```
cp .env.example .env
```

Edit `.env` and set `LIBRARY_ROOT`, `DOWNLOADS_DIR`, and `PORT` to match your
setup (defaults match this project's original `/mnt/user/fastARCHIVE-seeding/complete`
and `/mnt/user/towerMEDIAracing/2021_plex_library`). Then:

```
docker compose up -d --build
```

`docker-compose.yml` reads `.env` automatically — nothing else to edit there.
Verify it's up: `curl http://localhost:8420/health` should return
`{"status":"ok"}`.

### 2. Configure Transmission's hook script

In Transmission's `settings.json`:

```json
"script-torrent-done-enabled": true,
"script-torrent-done-filename": "/path/to/torrent-done.sh"
```

Copy `scripts/torrent-done.sh` **and** `scripts/torrent-done.env.example`
to wherever Transmission can read them (inside its own container if that's
where it runs), then:

```
cp torrent-done.env.example torrent-done.env
chmod +x torrent-done.sh
```

Edit `torrent-done.env` and set `ARCHIVER_URL` — since Transmission and
`bike-race-archiver` are separate containers not on the same Docker network,
this needs to be TOWER's LAN IP (not a container name), e.g.
`http://192.168.1.50:8420/webhook/torrent-done`, using the same `PORT` you
set in the archiver's `.env`.

**Path consistency matters**: the `dir` Transmission reports has to resolve
to the same file both inside Transmission's container and inside this one.
See the comment at the top of `docker-compose.yml` for the recommended
identity-path-mapping approach.

### 3. Add a new show

Every show your tracker feed covers needs an entry in `config/shows.json`.
The file is bind-mounted, so edits take effect on the next webhook call — no
rebuild needed. Minimal example:

```json
{
  "id": "my-new-race",
  "folderName": "My New Race",
  "matchKeywords": ["my new race", "mnr"],
  "type": "one-day"
}
```

- `type` is one of `stage-race`, `one-day`, `multi-category-fixed`,
  `multi-category-dynamic` — see the Filename convention section above.
- `matchKeywords` entries are space-separated phrases; a show matches if
  *every* token in one of its phrases is present in the parsed name. List
  multiple phrases (e.g. both `"tour de france"` and `"tdf"`) to catch
  abbreviations. More specific phrases (more tokens) win over vaguer ones
  when several shows could match.
- For `multi-category-fixed`, add a `categories` array — see `Nationals` vs
  `World Championships` in `config/shows.json` for a worked dynamic vs.
  fixed example.
- `filenamePrefix` is optional and only needed when the filename should say
  something different from the folder name (this is how the HIGHLIGHTS
  shows keep the base show's name in the file itself).

## Known limitations / assumptions (check these against reality as you go)

- **UCI XCC/XCO World Cup** isn't in `config/shows.json` yet — it wasn't in
  the Plex library at design time, and it has a per-round venue (e.g. "La
  Thuile") baked into the name that a fixed-category show can't cleanly
  express. First download will auto-create a folder per venue; you'll
  probably want to hand-write a proper config entry (possibly
  `stage-race`-shaped, with "round" standing in for "stage") once you see a
  few real names.
- Auto-created show names are naive title-case — acronyms like "UCI" come
  out as "Uci". Expect to rename auto-created folders/entries by hand.
- Missing year in a source name (e.g. `TDF-Stage01-SBS.mp4`, which has no
  year at all) defaults to the current calendar year — logged as a warning.
  Fine for same-season downloads; wrong if you ever batch-import an old
  archive with this tool.
- `TdF Euro Hghlights` vs `Tour de France HIGHLIGHTS`: the config guesses
  that "Eurosport"-branded highlight releases go to the former and
  everything else to the latter. Verify this matches how your tracker
  actually labels releases; adjust `tdf-euro-highlights`'s `matchKeywords`
  in `config/shows.json` if not.
- Nationals dynamic episode numbering scans the destination folder's
  existing filenames to avoid collisions/reuse the right number — if you
  manually rename files in a Nationals season folder, keep the `- Country
  Gender Discipline.ext` shape intact or the scanner won't recognize them.

## Testing

```
npm install
npm test
```

`test/fixtures.ts` holds real torrent/download names gathered from this
library while designing the tool; `parser.test.ts`, `matcher.test.ts`, and
`namer.test.ts` exercise the pipeline against them, including the exact
Tour de France / World Championships / Nationals destination examples this
tool was built to reproduce.

For an end-to-end check without touching real data: `docker compose up
--build`, then `curl` the webhook directly:

```
curl -X POST http://localhost:8420/webhook/torrent-done \
  -H "Content-Type: application/json" \
  -d '{"dir":"/path/to/scratch/downloads","name":"Tour-de-France-2026-Stage-01"}'
```
