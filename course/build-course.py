#!/usr/bin/env python3
"""Download the organiser's BMW BERLIN-MARATHON GPX and turn it into course.js.

Input : course/BM25_Marathon-Strecke.gpx, downloaded from the organiser's
        site on first run (see SOURCE.md). It has no open licence, so it
        is git-ignored and never committed.
Output: course/course.js, a single `window.COURSE = {...}` assignment so the
        page works over file:// as well as over http://. Also git-ignored:
        it is a resampled copy of the same coordinates.

Run:
    python3 course/build-course.py                 # fetch if missing, then build
    python3 course/build-course.py --refetch       # download again
    python3 course/build-course.py --gpx my.gpx    # use a local file (another race)

Standard library only.
"""

import argparse
import json
import math
import os
import re
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
GPX = os.path.join(HERE, "BM25_Marathon-Strecke.gpx")
OUT = os.path.join(HERE, "course.js")

GPX_URL = ("https://www.bmw-berlin-marathon.com/fileadmin/media/events/"
           "berlinmarathon/gpx/BM25_Marathon-Strecke.gpx")
COURSE_PAGE = "https://www.bmw-berlin-marathon.com/en/your-race/course"
# The organiser's server expects a browser: send a browser user agent and
# the course page as referer, the same as clicking the link on that page.
USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

# The course is certified at 42.195 km. The published GPX is a simplified
# polyline, so we rescale the cumulative distance onto the official length
# instead of trusting the raw polyline sum.
OFFICIAL_LENGTH_M = 42195.0

# Resample spacing. The raw GPX has segments up to ~830 m on long straights,
# which makes camera interpolation lurch. 10 m gives a smooth path and a file
# that is still small.
STEP_M = 10.0

R_EARTH = 6371008.8


def haversine(a, b):
    la1, lo1 = math.radians(a[1]), math.radians(a[0])
    la2, lo2 = math.radians(b[1]), math.radians(b[0])
    dla, dlo = la2 - la1, lo2 - lo1
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * R_EARTH * math.asin(math.sqrt(h))


def bearing(a, b):
    la1, lo1 = math.radians(a[1]), math.radians(a[0])
    la2, lo2 = math.radians(b[1]), math.radians(b[0])
    dlo = lo2 - lo1
    y = math.sin(dlo) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dlo)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def fetch(url, path):
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "Referer": COURSE_PAGE})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            "download failed: %s\n\n"
            "Download it by hand instead: open %s in a browser, click the\n"
            "GPX link for the marathon, and save it as\n  %s\n"
            "or pass any GPX with --gpx PATH." % (e, COURSE_PAGE, path))
    if b"<trkpt" not in data:
        raise SystemExit("downloaded file from %s has no <trkpt>; not a GPX track" % url)
    with open(path, "wb") as fh:
        fh.write(data)
    print("downloaded         %s (%d bytes)" % (path, len(data)))


def read_gpx(path):
    src = open(path, encoding="utf-8").read()
    pts = re.findall(r'<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"', src)
    if not pts:
        raise SystemExit("no <trkpt> found in %s" % path)
    # GeoJSON order: [lon, lat]
    return [[float(lon), float(lat)] for lat, lon in pts]


def dedupe(pts):
    out = [pts[0]]
    for p in pts[1:]:
        if haversine(out[-1], p) > 0.5:
            out.append(p)
    return out


def resample(pts, step):
    """Walk the polyline and emit a point every `step` metres."""
    out = [list(pts[0])]
    carry = 0.0
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        seg = haversine(a, b)
        if seg <= 0:
            continue
        pos = step - carry
        while pos < seg:
            t = pos / seg
            out.append([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
            pos += step
        carry = seg - (pos - step)
    if haversine(out[-1], pts[-1]) > 1.0:
        out.append(list(pts[-1]))
    return out


def point_at(coords, target_m):
    """Interpolate [lon, lat] at a cumulative distance, using coords[i][2]."""
    if target_m <= 0:
        return coords[0][:2]
    for i in range(len(coords) - 1):
        d0, d1 = coords[i][2], coords[i + 1][2]
        if d0 <= target_m <= d1:
            t = 0.0 if d1 == d0 else (target_m - d0) / (d1 - d0)
            return [
                coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
                coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
            ]
    return coords[-1][:2]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gpx", default=None,
                    help="build from this local GPX instead of downloading")
    ap.add_argument("--url", default=GPX_URL, help="GPX download URL")
    ap.add_argument("--refetch", action="store_true",
                    help="download the GPX again even if it is already here")
    ap.add_argument("--length-m", type=float, default=OFFICIAL_LENGTH_M,
                    help="certified course length the distances are scaled onto")
    args = ap.parse_args()

    gpx = args.gpx or GPX
    if not args.gpx and (args.refetch or not os.path.exists(gpx)):
        fetch(args.url, gpx)
    if not os.path.exists(gpx):
        raise SystemExit("no GPX at %s" % gpx)

    official = args.length_m
    raw = dedupe(read_gpx(gpx))
    raw_len = sum(haversine(raw[i], raw[i + 1]) for i in range(len(raw) - 1))

    pts = resample(raw, STEP_M)

    # Cumulative distance, rescaled so the last point sits on the certified length.
    cum = [0.0]
    for i in range(len(pts) - 1):
        cum.append(cum[-1] + haversine(pts[i], pts[i + 1]))
    scale = official / cum[-1]
    coords = [
        [round(p[0], 6), round(p[1], 6), round(c * scale, 1)]
        for p, c in zip(pts, cum)
    ]

    km_markers = []
    for km in range(1, int(official // 1000) + 1):
        lon, lat = point_at(coords, km * 1000.0)
        km_markers.append({"km": km, "lon": round(lon, 6), "lat": round(lat, 6)})

    course = {
        "source": os.path.basename(gpx),
        "license_note": "Geometry from the organiser. Attribution required on screen.",
        "official_length_m": official,
        "raw_gpx_points": len(raw),
        "raw_gpx_length_m": round(raw_len, 1),
        "resample_step_m": STEP_M,
        "start_bearing_deg": round(bearing(coords[0][:2], coords[5][:2]), 1),
        "coords": coords,
        "km_markers": km_markers,
    }

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("// Generated by build-course.py. Do not edit by hand.\n")
        fh.write("window.COURSE = ")
        json.dump(course, fh, separators=(",", ":"))
        fh.write(";\n")

    print("raw gpx points     %d" % len(raw))
    print("raw gpx length     %.1f m  (official %.0f m, delta %.2f%%)"
          % (raw_len, official, 100.0 * (raw_len - official) / official))
    print("resampled points   %d at %.0f m" % (len(coords), STEP_M))
    print("wrote              %s (%.0f kB)" % (OUT, os.path.getsize(OUT) / 1024.0))


if __name__ == "__main__":
    main()
