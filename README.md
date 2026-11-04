# Rev My Dishwasher — personal build

**Your dishwasher deserves a V8.**

Personal web app for testing synthesized vehicle sounds in a Tesla browser. No payments, subscription flow, analytics, user accounts or server-side GPS collection.

## Audio engine and source files

The following supplied TeslaSound source files are kept as the audio engine and profile source, without rewriting their synthesis logic:

- `js/engine-dsp.js` — original AudioWorklet / ScriptProcessor synthesizer.
- `js/audio.js` — original Web Audio routing, compressor, volume and safety clipper.
- `js/cars.js` — original 18 vehicle sound and drivetrain profiles.
- `js/gps.js` — original browser geolocation speed estimator.

`js/vehicle.js` is the Rev My Dishwasher control bridge. It turns GPS or test-drive pedal input into the parameter messages consumed by the supplied synthesizer. `js/main.js`, `index.html` and `styles.css` are the new personal interface. The app contains no paywall code and does not load analytics.

## Test locally

From this folder run:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`. Press **TEST AUDIO** first, then **AVVIA MOTORE**. `localhost` is suitable for local audio testing; GPS on a deployed site requires HTTPS and browser permission.

## Publish privately on Cloudflare Pages

1. Create a private GitHub repository and push the contents of this folder.
2. In Cloudflare Pages, create a project from that repository. Use production branch `main`, build command `exit 0`, and build output directory `.` (the repository root).
3. In Cloudflare Zero Trust, create a Self-hosted Access application for the Pages hostname. Enable One-time PIN as a login method and add an Allow policy whose Include rule lists only your email address. Do not use an “Everyone” or “all valid emails” rule.
4. Test the URL while parked in the Tesla browser, approve location access, and keep the page in the foreground.

Cloudflare Access is an access gate, not a paywall; the app itself remains free of payment or subscription features. Do not treat an unlisted URL as access protection.

## Notes

- The TeslaSound / Lifemock source files are being reused under the permission you confirmed you already obtained.

- The UI is a new personal implementation; the provided synthesizer/profile files remain the supplied originals.
- The vehicle-to-sound control bridge is a separate implementation and should be tuned against GPS data and the actual Tesla audio system.
- The GPS estimate is supplementary and must not replace the vehicle speedometer. Keep the volume low enough to hear sirens, horns, navigation and vehicle warnings.
- No Tesla vehicle API is used. GPS and app settings are handled locally in the browser.
