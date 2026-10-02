#!/usr/bin/env python3
"""Check every landmark pin in timeline-preview.js against the course GPX.

For each pin: distance from the landmark to the nearest point of the route,
and the course distance there (km and miles). Also lists every other pass
of the route within 800 m, since the course comes back past some places.
Run course/build-course.py first. Stdlib only:

    python3 course/check-landmarks.py

Exits non-zero if any pin's km/offM in the config no longer matches the route.
"""
import json, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(HERE, "course.js")
if not os.path.exists(path):
    sys.exit("no course/course.js yet: run python3 course/build-course.py first")
src = open(path, encoding="utf-8").read()
C = json.loads(src[src.index("{"):src.rindex("}") + 1])
P = C["coords"]
cfg = open(os.path.join(HERE, "..", "timeline-preview.js"), encoding="utf-8").read()
pins = re.findall(r"name: '([^']+)'.*?lon: ([\d.]+), lat: ([\d.]+), km: ([\d.]+), offM: (\d+)", cfg)

K = 111319.49
kx = K * math.cos(math.radians(sum(p[1] for p in P) / len(P)))
ok = True
print("%-20s %8s %8s %8s   %s" % ("pin", "off m", "km", "mi", "passes within 800 m (km, m)"))
for name, lon, lat, km, off in pins:
    lon, lat, km, off = float(lon), float(lat), float(km), int(off)
    ds = [math.hypot((p[0] - lon) * kx, (p[1] - lat) * K) for p in P]
    i = min(range(len(ds)), key=ds.__getitem__)
    passes = [(round(P[j][2] / 1000, 2), round(ds[j])) for j in range(len(ds))
              if ds[j] < 800 and (j == 0 or ds[j] <= ds[j - 1])
              and (j == len(ds) - 1 or ds[j] <= ds[j + 1])]
    near = [p for p in passes if abs(p[0] - km) < 0.05]
    flag = ""
    if not near or abs(near[0][1] - off) > 15:
        flag = "  <-- config says km %.2f, %d m" % (km, off); ok = False
    if (near[0][1] if near else 9e9) > 400:
        flag += "  <-- more than 400 m from the route"; ok = False
    print("%-20s %8d %8.2f %8.2f   %s%s" % (name, near[0][1] if near else ds[i], km,
          km * 1000 / 1609.344, passes, flag))
print("OK" if ok else "MISMATCH")
sys.exit(0 if ok else 1)
