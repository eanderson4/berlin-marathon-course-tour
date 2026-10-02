# Course geometry provenance

## Source: the organiser's own GPX

- **File:** `BM25_Marathon-Strecke.gpx`
- **URL:** https://www.bmw-berlin-marathon.com/fileadmin/media/events/berlinmarathon/gpx/BM25_Marathon-Strecke.gpx
- **Linked from:** https://www.bmw-berlin-marathon.com/en/your-race/course (under "GPX for
  BMW BERLIN-MARATHON"). As of September 2026 the course page still links the `BM25_*` file.
- **Fetched with:** a browser user agent and the course page as referer.
  `build-course.py` does this for you. Checked working on 2026-10-02 (HTTP 200, 24,110 bytes).
- **Creator string in the file:** `SCC KML/KMZ/GPX Tools` (SCC EVENTS is the race organiser).
- **Contents:** one `<trk>` / `<trkseg>` with 508 `<trkpt>` elements. Latitude and longitude only:
  no elevation, no timestamps, no waypoints, no kilometre markers.

**This file is not in the repository.** See "Licence and terms" below. `build-course.py`
downloads it into `course/` (git-ignored) and builds `course/course.js` (also git-ignored).

### If the download fails

Open https://www.bmw-berlin-marathon.com/en/your-race/course in a browser, click the GPX
link for the marathon, save the file as `course/BM25_Marathon-Strecke.gpx`, and run
`python course/build-course.py` again. If the organiser publishes a newer file (for example
`BM26_*`), pass it with `--url` or download it and pass `--gpx PATH`.

### Sanity check

Summed great-circle length of the raw polyline is **42,183.6 m** against the certified
**42,195 m**, i.e. 0.03 percent short. That is what you expect from a lightly simplified
polyline of the certified course, and it is close enough to treat as authoritative geometry
rather than a community trace.

| | lat, lon | what it is |
|---|---|---|
| start | 52.515214, 13.360200 | Strasse des 17. Juni, east of Kleiner Stern |
| finish | 52.516013, 13.372547 | Strasse des 17. Juni, about 380 m west of the Brandenburg Gate |

The finish coordinate is west of the Gate because the course comes east down Unter den
Linden, passes **through** the Gate at roughly km 41.8, and the line is on the far side.

## Licence and terms

The organiser publishes these GPX files as a free download for participants and does not
attach an explicit licence. There is no Creative Commons or open-data grant. So this repo:

- uses it only as reference geometry for a derived visualisation,
- does **not** republish it (neither the GPX nor the resampled `course.js` is committed),
- credits the organiser on screen: `Course: BMW BERLIN-MARATHON (SCC EVENTS)`.

The rendered tour draws the course over OpenStreetMap-derived tiles, so the map itself
carries the separate ODbL attribution described in the top-level README.

### OpenStreetMap has no course relation

Checked via Overpass in September 2026: there is no OSM relation for the Berlin Marathon
course. Queries for `relation[route=running]` and for any relation or way whose name matches
`Marathon` inside the Berlin bounding box return only small club loops. Without the
organiser file, the fallback would be snapping a route onto OSM ways with a router.

## What build-course.py does to it

- drops points closer than 0.5 m to their predecessor
- resamples to a uniform 10 m spacing by linear interpolation, because the raw file has
  segments up to 828 m on the long straights and the camera lurches on those
- rescales cumulative distance onto the certified length (42,195 m by default,
  `--length-m` to change it) so kilometre and mile markers land on the certified distances
- derives one marker per kilometre by interpolation

Output: `course.js`, a single `window.COURSE = {...}` assignment (about 124 kB, 4,220
points). Standard library only.

## Landmark pins

Pin coordinates in `../timeline-preview.js` come from OpenStreetMap via Nominatim
(fetched 2026-09-23), so they are OSM data under the ODbL. `check-landmarks.py` re-measures
each pin's distance from the route and its course km against `course.js`.
