#!/usr/bin/env python3
"""Headless frame grabber for the Berlin Marathon course tour.

Drives preview.html one frame at a time with Playwright (headless Chromium),
writes PNGs, then hands them to ffmpeg. Nothing about the shot lives here:
the camera is a pure function of time in preview.js, configured in
timeline-preview.js, so this is just a loop.

Examples:

    # smoothness check, every frame, geometry only (seconds, writes nothing)
    python render.py --check
    python render.py --check --portrait

    # a 3 second test from the top
    python render.py --duration 3 --out renders/test.mp4

    # one still at t = 30 s
    python render.py --still 30 --out renders/still.png

    # the full 60 second tour, 16:9 and 9:16
    python render.py --out renders/course-tour-16x9.mp4
    python render.py --portrait --out renders/course-tour-9x16.mp4
"""

import argparse
import functools
import http.server
import os
import shutil
import socketserver
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, "frames")

WIDTH, HEIGHT = 1920, 1080

# Headless Chromium needs to be told to rasterise WebGL in software. These
# flags work on a Linux box with no GPU; drop the swiftshader pair if a real
# GPU is available and you want hardware rendering.
CHROME_ARGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--disable-lcd-text",
    "--force-device-scale-factor=1",
    "--hide-scrollbars",
    "--font-render-hinting=none",
    "--disable-dev-shm-usage",
]


def serve(directory):
    """Serve the folder on a free localhost port; returns (url, shutdown)."""
    handler = functools.partial(QuietHandler, directory=directory)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return "http://127.0.0.1:%d" % port, httpd.shutdown


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def page_url(base_url, args):
    url = base_url + "/preview.html?headless=1"
    if args.portrait:
        url += "&portrait=1"
    if args.clean:
        url += "&clean=1"
    return url


def stage_size(args):
    if args.portrait:
        return HEIGHT, WIDTH
    return WIDTH, HEIGHT


def capture(args):
    from playwright.sync_api import sync_playwright

    base_url, shutdown = serve(HERE)
    url = page_url(base_url, args)
    width, height = stage_size(args)
    frames = args.frames_dir or FRAMES

    if args.still is None:
        if os.path.isdir(frames):
            shutil.rmtree(frames)
        os.makedirs(frames)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=CHROME_ARGS)
        page = browser.new_page(viewport={"width": width, "height": height},
                                device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.set_default_timeout(120000)
        page.goto(url, wait_until="load", timeout=90000)
        page.wait_for_function("window.FT !== undefined", timeout=60000)
        page.evaluate("() => window.FT.ready")

        if errors:
            print("page errors:", errors[:4], file=sys.stderr)

        if not args.no_prefetch:
            t0 = time.time()
            print("prefetching tiles along the route ...")
            page.evaluate("() => window.FT.prefetch(%d)" % args.prefetch_steps)
            print("prefetch done in %.1fs" % (time.time() - t0))

        duration = page.evaluate("() => window.FT.duration")
        fps = args.fps or page.evaluate("() => window.FT.fps")

        if args.still is not None:
            page.evaluate("t => window.FT.seek(t)", args.still)
            page.evaluate("t => window.FT.seek(t)", args.still)
            out = args.out if args.out.endswith(".png") else "still.png"
            out = out if os.path.isabs(out) else os.path.join(HERE, out)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            page.locator("#stage").screenshot(path=out)
            print("wrote %s" % out)
            browser.close()
            shutdown()
            return None, fps

        start = args.start
        end = min(duration, start + args.duration) if args.duration else duration
        n = int(round((end - start) * fps))
        print("capturing %d frames, t=%.2f..%.2f at %d fps" % (n, start, end, fps))

        stage = page.locator("#stage")
        log = []
        t0 = time.time()
        for i in range(n):
            t = start + i / float(fps)
            page.evaluate("t => window.FT.seek(t)", t)
            log.append(page.evaluate("() => window.FT.frame()"))
            path = os.path.join(frames, "f%06d.png" % i)
            stage.screenshot(path=path)
            if i and i % 30 == 0:
                rate = i / (time.time() - t0)
                print("  %d/%d  %.1f fps capture  eta %.0fs"
                      % (i, n, rate, (n - i) / max(rate, 0.01)))
        print("captured %d frames in %.1fs" % (n, time.time() - t0))
        stats = page.evaluate("() => window.FT.stats")
        print("tile waits: %d seeks, %d timed out, worst %.0f ms"
              % (stats["seeks"], stats["timeouts"], stats["worstWaitMs"]))
        bad = [r for r in log if not r.get("tilesLoaded")]
        print("frames painted with tiles still loading: %d" % len(bad))
        logpath = args.frame_log or os.path.join(frames, "frames.csv")
        write_frame_log(log, logpath)
        print("frame log: %s" % logpath)
        if len(log) > 2:
            smoothness(log, fps, args.portrait)
        browser.close()

    shutdown()
    return frames, fps


FIELDS = ["t", "lon", "lat", "bearing", "zoom", "pitch", "m", "fx", "fy",
          "pins", "overlaps", "pinLowY", "tilesLoaded", "waitMs"]


def write_frame_log(rows, path):
    import csv
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)


def smoothness(rows, fps, portrait=False):
    """Per-frame camera deltas. The centre is reported in metres per frame
    (first difference) and metres per frame squared (second difference): a
    snap shows up as a spike in the second, a steady pan does not."""
    import math
    kx = 111319.49 * math.cos(math.radians(rows[0]["lat"]))
    ky = 111319.49
    vel, acc, db, dz, dp = [], [], [], [], []
    for a, b in zip(rows, rows[1:]):
        vel.append(((b["lon"] - a["lon"]) * kx, (b["lat"] - a["lat"]) * ky))
        db.append(abs(((b["bearing"] - a["bearing"]) + 540) % 360 - 180))
        dz.append(abs(b["zoom"] - a["zoom"]))
        dp.append(abs(b["pitch"] - a["pitch"]))
    for a, b in zip(vel, vel[1:]):
        acc.append(math.hypot(b[0] - a[0], b[1] - a[1]))
    speed = [math.hypot(*v) for v in vel]

    def worst(xs):
        i = max(range(len(xs)), key=lambda k: xs[k]) if xs else 0
        return (xs[i] if xs else 0.0), rows[i + 1]["t"] if xs else 0.0

    s_max, s_t = worst(speed)
    a_max, a_t = worst(acc)
    b_max, _ = worst(db)
    b_min = min(db) if db else 0.0
    fx = [r["fx"] for r in rows]
    fy = [r["fy"] for r in rows]
    print("smoothness over %d frames at %d fps" % (len(rows), fps))
    print("  centre move    max %.1f m/frame at t=%.2f s" % (s_max, s_t))
    print("  centre accel   max %.2f m/frame^2 at t=%.2f s (median %.2f)"
          % (a_max, a_t, sorted(acc)[len(acc) // 2] if acc else 0))
    print("  bearing        %.4f .. %.4f deg/frame (constant rate, no reversals: %s)"
          % (b_min, b_max, "yes" if all(
              ((b["bearing"] - a["bearing"]) > 0) == ((rows[1]["bearing"] - rows[0]["bearing"]) > 0)
              for a, b in zip(rows, rows[1:])) else "NO"))
    print("  zoom           max %.5f per frame" % max(dz or [0]))
    print("  pitch          max %.5f deg per frame" % max(dp or [0]))
    print("  dot on screen  x %.1f%% .. %.1f%%, y %.1f%% .. %.1f%%"
          % (100 * min(fx), 100 * max(fx), 100 * min(fy), 100 * max(fy)))
    if "pins" in rows[0]:
        print("  pins on screen max %d, frames with overlapping labels %d"
              % (max(r.get("pins", 0) for r in rows),
                 sum(1 for r in rows if r.get("overlaps"))))
        bad = [r["t"] for r in rows if r.get("overlaps")]
        if bad:
            print("    overlaps at t=%.2f .. %.2f s" % (bad[0], bad[-1]))
    if portrait and "pinLowY" in rows[0]:
        # lowest visible pin foot or label edge, as a fraction of height;
        # > 0.8 means it reaches into the bottom-20% zone that Shorts/Reels
        # cover with their own UI
        low = [r for r in rows if (r.get("pinLowY") or 0) > 0.8]
        print("  pins lowest    %.1f%% of height; frames with a pin in the bottom 20%%: %d"
              % (100 * max((r.get("pinLowY") or 0) for r in rows), len(low)))
        if low:
            print("    bottom-20%% pins at t=%.2f .. %.2f s" % (low[0]["t"], low[-1]["t"]))


def check(args):
    """Probe every frame of the preview (geometry only, no tiles) and
    report the smoothness numbers. Writes the per-frame log if asked."""
    from playwright.sync_api import sync_playwright

    base_url, shutdown = serve(HERE)
    url = page_url(base_url, args)
    width, height = stage_size(args)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=CHROME_ARGS)
        page = browser.new_page(viewport={"width": width, "height": height},
                                device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.set_default_timeout(120000)
        page.goto(url, wait_until="load", timeout=90000)
        page.wait_for_function("window.FT !== undefined", timeout=60000)
        page.evaluate("() => window.FT.ready")
        fps = args.fps or page.evaluate("() => window.FT.fps")
        rows = page.evaluate("f => window.FT.probeAll(f)", fps)
        speed = page.evaluate("() => window.FT.speed")
        browser.close()
    shutdown()
    if errors:
        print("page errors:", errors[:4], file=sys.stderr)
        return 1
    print("course preview check, %s, %dx%d, dot speed %.0f m/s"
          % ("portrait" if args.portrait else "landscape", width, height, speed))
    smoothness(rows, fps, args.portrait)
    if args.frame_log:
        write_frame_log(rows, args.frame_log)
        print("frame log: %s" % args.frame_log)
    return 0


def encode(frames_dir, fps, out):
    out = out if os.path.isabs(out) else os.path.join(HERE, out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", os.path.join(frames_dir, "f%06d.png"),
        "-c:v", "libx264",
        "-profile:v", "high",
        "-pix_fmt", "yuv420p",
        "-crf", "17",
        "-preset", "slow",
        "-movflags", "+faststart",
        "-r", str(fps),
        out,
    ]
    print("$ " + " ".join(cmd))
    subprocess.run(cmd, check=True)
    print("wrote %s (%.1f MB)" % (out, os.path.getsize(out) / 1e6))


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--start", type=float, default=0.0, help="start time in seconds")
    p.add_argument("--duration", type=float, default=0.0,
                   help="seconds to capture, 0 means to the end")
    p.add_argument("--fps", type=int, default=0, help="override timeline fps")
    p.add_argument("--still", type=float, default=None,
                   help="capture a single frame at this time and exit")
    p.add_argument("--out", default="renders/course-tour.mp4",
                   help="output .mp4 (or .png with --still), relative to this folder")
    p.add_argument("--no-encode", action="store_true", help="leave the PNGs, skip ffmpeg")
    p.add_argument("--no-prefetch", action="store_true",
                   help="skip the tile warm-up pass")
    p.add_argument("--prefetch-steps", type=int, default=28)
    p.add_argument("--clean", action="store_true",
                   help="plate for compositing: hide the title, the MI counter, "
                        "the progress bar and the attribution line; keep route, "
                        "dot, pins and mile markers. Whatever you composite on "
                        "top must carry the attribution.")
    p.add_argument("--portrait", action="store_true",
                   help="1080x1920 stage instead of 1920x1080")
    p.add_argument("--frames-dir", default=None,
                   help="write PNGs here instead of ./frames")
    p.add_argument("--frame-log", default=None,
                   help="write the per-frame camera log (CSV) here "
                        "(default: frames.csv in the frames folder)")
    p.add_argument("--check", action="store_true",
                   help="probe every frame's camera (geometry only, no tiles), "
                        "print the smoothness numbers, write nothing")
    args = p.parse_args()

    if not os.path.exists(os.path.join(HERE, "course", "course.js")):
        sys.exit("no course/course.js yet: run python course/build-course.py first")

    if args.check:
        sys.exit(check(args))

    frames_dir, fps = capture(args)
    if frames_dir and not args.no_encode:
        encode(frames_dir, fps, args.out)


if __name__ == "__main__":
    main()
