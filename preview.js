/* BMW BERLIN-MARATHON course preview.
 *
 * One continuous run of the course, start line to finish, with a helicopter
 * camera in a slow orbit around the orange dot. Config in
 * timeline-preview.js. Deterministic: everything is a pure function of t,
 * so frame 900 is the same whether it is rendered first or last.
 *
 * Public surface used by render.py:
 *   FT.ready          promise, map and layers are up
 *   FT.duration, FT.fps
 *   FT.seek(t)        promise, resolves once the frame at t is painted with
 *                     every tile loaded (waits on MapLibre 'idle')
 *   FT.probe(t)       camera + dot screen position at t, geometry only
 *   FT.frame()        the same numbers for the frame just painted
 *   FT.prefetch(n)    warm the tile cache along the timeline
 *   FT.stats          tile-wait timeouts, worst wait
 */
(function () {
  'use strict';

  var C = window.COURSE;
  var P = window.PREVIEW;
  var CAM = P.camera;
  var COORDS = C.coords;              // [lon, lat, metres], 10 m apart
  var TOTAL = C.official_length_m;
  var MILE = 1609.344;
  var STEP = C.resample_step_m;
  var DURATION = P.duration;
  var PORTRAIT = /[?&]portrait=1/.test(location.search);

  // ------------------------------------------------------------------
  // local metre frame
  // ------------------------------------------------------------------
  // origin: the start line (any nearby point works; this keeps it per-race)
  var LON0 = COORDS[0][0], LAT0 = COORDS[0][1];
  var MPD_LAT = 111319.49, MPD_LON = MPD_LAT * Math.cos(LAT0 * Math.PI / 180);
  function toXY(ll) { return [(ll[0] - LON0) * MPD_LON, (ll[1] - LAT0) * MPD_LAT]; }
  function toLL(xy) { return [LON0 + xy[0] / MPD_LON, LAT0 + xy[1] / MPD_LAT]; }

  function idxForMetre(m) {
    var i = Math.max(0, Math.min(COORDS.length - 1, Math.round(m / STEP)));
    while (i > 0 && COORDS[i][2] > m) i--;
    while (i < COORDS.length - 2 && COORDS[i + 1][2] <= m) i++;
    return i;
  }
  function pointAt(m) {
    m = Math.max(0, Math.min(TOTAL, m));
    var i = idxForMetre(m);
    var a = COORDS[i], b = COORDS[Math.min(i + 1, COORDS.length - 1)];
    var span = b[2] - a[2], f = span > 0 ? (m - a[2]) / span : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }
  function sliceTo(m) {
    var out = [], i = idxForMetre(m);
    for (var k = 0; k <= i; k++) out.push([COORDS[k][0], COORDS[k][1]]);
    out.push(pointAt(m));
    return out;
  }
  function smoothstep(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }

  // ------------------------------------------------------------------
  // the dot: constant distance rate, smoothstep speed ramps at each end
  // ------------------------------------------------------------------
  var D = P.dot;
  var T0 = D.startAt, TI = D.easeIn, TO = D.easeOut, TA = D.arriveAt;
  var V = TOTAL / (TA - T0 - TI / 2 - TO / 2);       // metres per second
  function rampInt(p) { return p * p * p - p * p * p * p / 2; }  // integral of smoothstep
  function dotM(t) {
    if (t <= T0) return 0;
    if (t >= TA) return TOTAL;
    if (t < T0 + TI) return V * TI * rampInt((t - T0) / TI);
    if (t > TA - TO) return TOTAL - V * TO * rampInt((TA - t) / TO);
    return V * TI / 2 + V * (t - T0 - TI);
  }

  // ------------------------------------------------------------------
  // what the camera looks at: the dot's ground position through a
  // zero-phase Gaussian low-pass (no lag, no snaps), tabulated at 120 Hz
  // ------------------------------------------------------------------
  var HZ = 120;
  var AIM = (function buildAim() {
    var sig = CAM.smoothSigma * HZ, half = Math.ceil(4 * sig);
    var n = Math.round(DURATION * HZ) + 1, i, k;
    var gate = toXY(CAM.finishAim), fin = toXY(pointAt(TOTAL));
    function raw(t) {
      t = Math.max(0, Math.min(DURATION, t));
      var p = toXY(pointAt(dotM(t)));
      var w = CAM.finishAimShare *
        smoothstep((t - CAM.finishAimFrom) / (CAM.finishAimFull - CAM.finishAimFrom));
      return [p[0] + w * (gate[0] - fin[0]), p[1] + w * (gate[1] - fin[1])];
    }
    var rx = new Float64Array(n + 2 * half), ry = new Float64Array(n + 2 * half);
    for (i = 0; i < n + 2 * half; i++) {
      var q = raw((i - half) / HZ);
      rx[i] = q[0]; ry[i] = q[1];
    }
    var ker = new Float64Array(2 * half + 1), ks = 0;
    for (k = -half; k <= half; k++) { ker[k + half] = Math.exp(-0.5 * k * k / (sig * sig)); ks += ker[k + half]; }
    var ax = new Float64Array(n), ay = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var sx = 0, sy = 0;
      for (k = 0; k <= 2 * half; k++) { sx += ker[k] * rx[i + k]; sy += ker[k] * ry[i + k]; }
      ax[i] = sx / ks; ay[i] = sy / ks;
    }
    return { x: ax, y: ay, n: n };
  })();
  function aimAt(t) {
    var f = Math.max(0, Math.min(AIM.n - 1, t * HZ));
    var i = Math.min(AIM.n - 2, Math.floor(f)), u = f - i;
    return toLL([AIM.x[i] + (AIM.x[i + 1] - AIM.x[i]) * u,
                 AIM.y[i] + (AIM.y[i + 1] - AIM.y[i]) * u]);
  }

  var ZOOM = CAM.zoom + (PORTRAIT ? CAM.portraitZoomDelta : 0);
  function cameraAt(t) {
    t = Math.max(0, Math.min(DURATION, t));
    return {
      t: t,
      center: aimAt(t),
      zoom: ZOOM,
      pitch: CAM.pitch,
      bearing: CAM.bearingStart + (CAM.bearingEnd - CAM.bearingStart) * t / DURATION,
      m: dotM(t)
    };
  }

  // ------------------------------------------------------------------
  // map
  // ------------------------------------------------------------------
  var map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: pointAt(0), zoom: ZOOM, pitch: CAM.pitch, bearing: CAM.bearingStart,
    maxPitch: 85, antialias: true, attributionControl: false,
    fadeDuration: 0, interactive: false, preserveDrawingBuffer: true
  });

  function line(coords) {
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };
  }

  function addLayers() {
    // Basemap labels are placed per frame with collision, which makes them
    // pop in and out as the camera turns. The pins carry the names instead.
    map.getStyle().layers.forEach(function (l) {
      if (l.type === 'symbol') map.setLayoutProperty(l.id, 'visibility', 'none');
    });

    map.addSource('course', { type: 'geojson', data: line(COORDS.map(function (p) { return [p[0], p[1]]; })) });
    map.addSource('run', { type: 'geojson', data: line([pointAt(0), pointAt(0)]) });
    map.addSource('dot', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: pointAt(0) } } });
    // Mile markers every 5 miles, on the course by distance.
    var miles = [];
    for (var mi = 5; mi * MILE < TOTAL; mi += 5) {
      miles.push({ type: 'Feature', properties: { label: 'MI ' + mi },
        geometry: { type: 'Point', coordinates: pointAt(mi * MILE) } });
    }
    map.addSource('kms', { type: 'geojson', data: { type: 'FeatureCollection', features: miles } });

    map.addLayer({
      id: 'buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'],
          ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
          0, '#20242F', 25, '#2C3140', 70, '#3A4054', 150, '#4A5169'],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true
      }
    }, map.getLayer('building') ? 'building' : undefined);
    if (map.getLayer('building')) map.setLayoutProperty('building', 'visibility', 'none');

    map.addLayer({ id: 'course-casing', type: 'line', source: 'course',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#122881', 'line-width': 12, 'line-opacity': 0.75, 'line-blur': 4 } });
    map.addLayer({ id: 'course-line', type: 'line', source: 'course',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#7E9DFF', 'line-width': 5, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'run-line', type: 'line', source: 'run',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#FF6230', 'line-width': 7 } });

    map.addLayer({ id: 'km-dot', type: 'circle', source: 'kms',
      paint: { 'circle-radius': 6, 'circle-color': '#FFFFFF', 'circle-opacity': 0.85,
        'circle-stroke-width': 2, 'circle-stroke-color': '#1F45E0' } });
    map.addLayer({ id: 'km-label', type: 'symbol', source: 'kms',
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 18,
        'text-offset': [0, -1.2], 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#FFFFFF', 'text-opacity': 0.8, 'text-halo-color': '#121317', 'text-halo-width': 2 } });

    map.addLayer({ id: 'dot-halo', type: 'circle', source: 'dot',
      paint: { 'circle-radius': 22, 'circle-color': '#FF6230', 'circle-opacity': 0.28, 'circle-pitch-alignment': 'viewport' } });
    map.addLayer({ id: 'dot', type: 'circle', source: 'dot',
      paint: { 'circle-radius': 10, 'circle-color': '#FF6230', 'circle-stroke-width': 3,
        'circle-stroke-color': '#FFFFFF', 'circle-pitch-alignment': 'viewport' } });
  }

  // ------------------------------------------------------------------
  // overlays
  // ------------------------------------------------------------------
  var el = {
    title: document.getElementById('title'),
    hud: document.getElementById('hud'),
    mi: document.querySelector('#hud .mi'),
    fill: document.querySelector('#hud .bar .fill'),
    pins: document.getElementById('pins')
  };
  function cue(c, t) {
    if (t < c[0] || t > c[3]) return 0;
    if (t < c[1]) return smoothstep((t - c[0]) / (c[1] - c[0]));
    if (t <= c[2]) return 1;
    return 1 - smoothstep((t - c[2]) / (c[3] - c[2]));
  }

  var STEM = 78;
  var PINS = P.pins.map(function (p) {
    var d = document.createElement('div');
    d.className = 'pin' + (p.gold ? ' gold' : '') + (p.side === 'left' ? ' left' : '');
    d.innerHTML = '<div class="stem"></div><div class="foot"></div><div class="label">'
      + p.name + '<span class="k">· MI ' + (p.km * 1000 / MILE).toFixed(1) + '</span>'
      + (p.sub ? '<span class="s">' + p.sub + '</span>' : '') + '</div>';
    el.pins.appendChild(d);
    var stem = p.stem || STEM;
    d.querySelector('.stem').style.height = stem + 'px';
    var label = d.querySelector('.label');
    label.style.bottom = stem + 'px';
    return { cfg: p, node: d, label: label, stem: stem, w: 0, h: 0 };
  });

  // Where each pin's label box lands for dot distance m. Labels hang to
  // the right of the stem (or the left with side: 'left') and slide to
  // stay on screen; they never flip. Shared by paint and the check.
  function layoutPins(m, w, h) {
    var out = [];
    PINS.forEach(function (p) {
      var o = pinOpacity(p.cfg, m);
      if (o <= 0.001) { out.push({ p: p, o: 0 }); return; }
      if (!p.w) { p.w = p.label.offsetWidth; p.h = p.label.offsetHeight; }
      var q = map.project([p.cfg.lon, p.cfg.lat]);
      var margin = 40, left = p.cfg.side === 'left';
      var x0 = left ? q.x - p.w + 2 : q.x - 2;
      var shift = 0;
      if (x0 + p.w > w - margin) shift = (w - margin) - (x0 + p.w);
      if (x0 + shift < margin) shift = margin - x0;
      var box = { x: x0 + shift, y: q.y - p.stem - p.h, w: p.w, h: p.h };
      out.push({ p: p, o: o, q: q, shift: shift, box: box });
    });
    return out;
  }
  function overlaps(lay) {
    var vis = lay.filter(function (l) { return l.o > 0.05; }), n = 0;
    for (var i = 0; i < vis.length; i++) {
      for (var j = i + 1; j < vis.length; j++) {
        var a = vis[i].box, b = vis[j].box;
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) n++;
      }
    }
    var low = 0;
    vis.forEach(function (l) { low = Math.max(low, l.q.y + 6, l.box.y + l.box.h); });
    return { shown: vis.length, overlaps: n, low: low };
  }

  var FADE_M = 450;
  function pinOpacity(p, m) {
    var at = p.km * 1000, lead = p.lead || P.pinLead;
    var trail = p.trail === undefined ? P.pinTrail : p.trail;
    if (PORTRAIT && p.portraitTrail !== undefined) trail = p.portraitTrail;
    var a = smoothstep((m - (at - lead)) / FADE_M);
    var b = trail === null ? 1 : 1 - smoothstep((m - (at + trail)) / FADE_M);
    return Math.min(a, b);
  }

  function hudText(m) {
    // Miles only. 42,195 m is 26.22 mi, shown as 26.2.
    el.mi.innerHTML = '<span class="u">MI</span>' + (m / MILE).toFixed(1);
    el.fill.style.width = (100 * m / TOTAL).toFixed(3) + '%';
  }

  // ------------------------------------------------------------------
  // paint + seek
  // ------------------------------------------------------------------
  var LAST = null;
  function paint(t, geometryOnly) {
    var cam = cameraAt(t);
    map.jumpTo({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing });
    var dotLL = pointAt(cam.m);
    var sp = map.project(dotLL);
    var w = map.getCanvas().clientWidth, h = map.getCanvas().clientHeight;
    var lay = layoutPins(cam.m, w, h), ov = overlaps(lay);
    LAST = { t: t, cam: cam, dot: dotLL, fx: sp.x / w, fy: sp.y / h,
      pins: ov.shown, overlaps: ov.overlaps, pinLowY: ov.low / h };
    if (geometryOnly) return LAST;

    map.getSource('run').setData(line(cam.m > 1 ? sliceTo(cam.m) : [pointAt(0), pointAt(0)]));
    map.getSource('dot').setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: dotLL } });

    el.title.style.opacity = cue(P.title, t);
    el.hud.style.opacity = cue(P.hud, t);
    hudText(cam.m);

    lay.forEach(function (l) {
      if (!l.o) { l.p.node.style.opacity = 0; return; }
      l.p.label.style.transform = 'translateX(' + l.shift.toFixed(1) + 'px)';
      l.p.node.style.transform = 'translate(' + l.q.x.toFixed(1) + 'px,' + l.q.y.toFixed(1) + 'px)';
      l.p.node.style.opacity = l.o.toFixed(3);
    });

    return LAST;
  }

  var STATS = { seeks: 0, timeouts: 0, worstWaitMs: 0 };
  function waitIdle(timeoutMs) {
    var t0 = performance.now();
    return new Promise(function (resolve) {
      var done = false;
      function finish(timedOut) {
        if (done) return;
        done = true;
        var ms = performance.now() - t0;
        STATS.seeks++;
        if (timedOut) STATS.timeouts++;
        if (ms > STATS.worstWaitMs) STATS.worstWaitMs = ms;
        LAST.tilesLoaded = map.areTilesLoaded();
        LAST.waitMs = ms;
        requestAnimationFrame(function () { resolve(); });
      }
      map.once('idle', function () { finish(false); });
      map.triggerRepaint();
      setTimeout(function () { finish(true); }, timeoutMs);
    });
  }

  var FT = {
    duration: DURATION,
    fps: P.fps,
    stats: STATS,
    seek: function (t) { paint(t); return waitIdle(45000); },
    probe: function (t) {
      var r = paint(t, true);
      return { t: t, lon: r.cam.center[0], lat: r.cam.center[1], bearing: r.cam.bearing,
        zoom: r.cam.zoom, pitch: r.cam.pitch, m: r.cam.m, fx: r.fx, fy: r.fy,
        pins: r.pins, overlaps: r.overlaps, pinLowY: r.pinLowY };
    },
    // every frame's camera, geometry only, for render.py --check
    probeAll: function (fps) {
      var out = [], n = Math.round(DURATION * fps);
      for (var i = 0; i <= n; i++) out.push(FT.probe(i / fps));
      paint(0);
      return out;
    },
    frame: function () {
      var r = LAST;
      return { t: r.t, lon: r.cam.center[0], lat: r.cam.center[1], bearing: r.cam.bearing,
        zoom: r.cam.zoom, pitch: r.cam.pitch, m: r.cam.m, fx: r.fx, fy: r.fy,
        pins: r.pins, overlaps: r.overlaps, pinLowY: r.pinLowY, tilesLoaded: r.tilesLoaded, waitMs: r.waitMs };
    },
    prefetch: function (steps) {
      var chain = Promise.resolve();
      for (var i = 0; i <= steps; i++) {
        (function (k) { chain = chain.then(function () { return FT.seek(DURATION * k / steps); }); })(i);
      }
      return chain;
    },
    speed: V
  };

  FT.ready = new Promise(function (resolve) {
    map.on('load', function () {
      addLayers();
      document.fonts.ready.then(function () {
        paint(0);
        map.once('idle', function () { resolve(); });
      });
      setTimeout(resolve, 30000);
    });
  });
  window.FT = FT;
  window.maplibreMap = map;

  // Live preview by hand: Space plays/pauses, arrows scrub 5 s.
  if (!/headless/.test(location.search)) {
    var playing = false, clock0 = 0, t0 = 0, cursor = 0;
    function loop(now) {
      if (!playing) return;
      cursor = t0 + (now - clock0) / 1000;
      if (cursor > DURATION) { cursor = 0; t0 = 0; clock0 = now; }
      paint(cursor);
      requestAnimationFrame(loop);
    }
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Space') {
        e.preventDefault(); playing = !playing;
        if (playing) { t0 = cursor; requestAnimationFrame(function (n) { clock0 = n; requestAnimationFrame(loop); }); }
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault();
        cursor = Math.max(0, Math.min(DURATION, cursor + (e.code === 'ArrowRight' ? 5 : -5)));
        t0 = cursor; clock0 = performance.now(); paint(cursor);
      }
    });
  }
})();
