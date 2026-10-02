/* Berlin Marathon course tour: every knob for preview.html.
 *
 * The shot: the orange dot runs the course from the start line on
 * Straße des 17. Juni to the finish beyond the Brandenburg Gate, once,
 * at a constant distance rate with a short ease at each end. The camera is
 * a helicopter in a slow orbit: constant altitude, pitch and distance,
 * always looking at the dot, bearing turning at one constant rate for the
 * whole piece. Nothing about the camera follows the road's heading.
 *
 * Distances are metres along the organiser's GPX (course/course.js),
 * which is scaled to the certified 42,195 m.
 */
window.PREVIEW = {
  duration: 60,
  fps: 30,

  // ---- the dot -------------------------------------------------------
  // Seconds. The dot sits on the start line until `startAt`, its speed
  // ramps up (smoothstep) over `easeIn`, runs flat, ramps down over
  // `easeOut` and arrives on the finish line at `arriveAt`. From there to
  // `duration` is the hold on the finish.
  dot: { startAt: 0.8, easeIn: 2.5, easeOut: 2.5, arriveAt: 57.0 },

  // ---- the camera ----------------------------------------------------
  camera: {
    // Constant for the whole piece. Zoom and pitch fix the helicopter's
    // distance and altitude above whatever it is looking at.
    zoom: 14.75,
    pitch: 54,
    // Bearing turns at one constant rate from bearingStart at t=0 to
    // bearingEnd at t=duration. Positive total = clockwise. 245 looks down
    // Straße des 17. Juni towards the Siegessäule at the gun; ~85 looks
    // east past the finish line to the Brandenburg Gate at the end.
    bearingStart: 245,
    bearingEnd: 445,
    // Zero-phase Gaussian low-pass on the dot's ground position, in
    // seconds (sigma). This is what the camera looks at: corners are
    // rounded off, there is no lag, and no parameter can snap.
    smoothSigma: 0.7,
    // In the closing seconds the aim point slides this fraction of the
    // way from the finish line towards the Brandenburg Gate, so the Gate
    // sits in the hold. Ramped in before smoothing, so it is smooth too.
    finishAim: [13.3777034, 52.5162699],
    finishAimShare: 0.35,
    finishAimFrom: 53.0,
    finishAimFull: 58.0,
    // Portrait (?portrait=1) sees less across, so pull back a touch.
    portraitZoomDelta: -0.45
  },

  // ---- overlays ------------------------------------------------------
  // [fadeInStart, full, fadeOutStart, gone] in seconds.
  title: [0.0, 0.4, 3.6, 4.6],
  hud: [2.2, 3.2, 99, 99],

  // Landmark pins. Every one checked against the GPX: `km` is the course
  // distance at the nearest route point, `offM` how far the landmark is
  // from the route there. Coordinates are OpenStreetMap (Nominatim,
  // fetched 2026-09-23). A pin fades in `lead` metres before the dot
  // reaches `km`, and out `trail` metres after (null: stays to the end).
  // Checked against the GPX with course/check-landmarks.py. On screen the
  // distance is shown in miles (km * 1000 / 1609.344).
  // side: 'left' hangs the label left of its stem, for pairs that would
  // otherwise overlap; stem sets the stem height in px (default 78).
  // portraitTrail overrides trail in the 9:16 cut only, where the narrower
  // frame makes a pair collide that clears in landscape.
  pinLead: 1700,
  pinTrail: 900,
  pins: [
    { name: 'Siegessäule', lon: 13.3501108, lat: 52.5145082, km: 0.70, offM: 61 },
    { name: 'Hauptbahnhof', lon: 13.3694480, lat: 52.5250175, km: 6.51, offM: 314 },
    { name: 'Alexanderplatz', lon: 13.4136358, lat: 52.5219814, km: 11.07, offM: 205 },
    { name: 'Kottbusser Tor', lon: 13.4183107, lat: 52.4989853, km: 15.29, offM: 22 },
    { name: 'Hermannplatz', lon: 13.4248023, lat: 52.4870894, km: 16.68, offM: 18 },
    { name: 'Rathaus Schöneberg', lon: 13.3441027, lat: 52.4848253, km: 23.19, offM: 61 },
    { name: 'Gedächtniskirche', sub: 'Kurfürstendamm', side: 'left', lon: 13.3350315, lat: 52.5047058, km: 34.89, offM: 35, portraitTrail: 400 },
    { name: 'KaDeWe', sub: 'Wittenbergplatz', lon: 13.3410035, lat: 52.5015753, km: 35.41, offM: 71 },
    { name: 'Potsdamer Platz', lon: 13.3755898, lat: 52.5098014, km: 38.56, offM: 48 },
    { name: 'Gendarmenmarkt', lon: 13.3922970, lat: 52.5135698, km: 40.48, offM: 65, trail: 600 },
    { name: 'Brandenburger Tor', lon: 13.3777034, lat: 52.5162699, km: 41.84, offM: 5, trail: null, gold: true },
    { name: 'Reichstag', lon: 13.3761015, lat: 52.5186538, km: 41.92, offM: 270, trail: null, lead: 250, side: 'left' }
  ]
};
