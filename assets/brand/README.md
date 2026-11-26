# OpenAlgo brand assets

Every logo the app ships is the official OpenAlgo logo. None of them is an Expo or React default.

## Source

`openalgo-logo.svg` is an unchanged copy of `openalgo-charts/assets/openalgo-logo.svg`, with one
credit comment added above the `<svg>`. It is a traced 1024 × 1024 drawing with 18 paths:

- 9 light paths (fills `#F4F4F4` to `#FCFCFD`): the mark and the eight letters of OPENALGO. Each
  light path carries its own holes as reverse-wound subpaths.
- 9 dark paths (fills `#020201` to `#0A0A0A`): the background square and patches over the holes.

In the source's 1024 units, the mark's box is x 315.1 to 712.1 and y 220.6 to 611.8
(397 × 391.2). The wordmark sits below y 625: x 259.7 to 766.3, y 640.7 to 699.5.

## Files

| File | What it is |
| --- | --- |
| `openalgo-logo.svg` | The source, as above. |
| `openalgo-mark.svg` | The mark's light path only, filled `#FFFFFF`, no background or wordmark. `viewBox="315.1 220.6 397 391.2"`. |
| `openalgo-logo-white.svg` | The mark and the wordmark, light paths only, filled `#FFFFFF` on transparent. `viewBox="259.7 220.6 506.6 478.9"`. |
| `openalgo-mark.png`, `@2x`, `@3x` | The in-app mark (`src/ui/BrandMark.tsx`): 64, 128 and 192 px squares, white on transparent. The mark fills the width. `BrandMark` tints it to the theme foreground. |
| `../images/icon.png` | The app icon (iOS, and Expo's fallback): 1024 px, RGB with no alpha channel, as the App Store requires. White mark on `#000000`, 62% of the width. |
| `../images/android-icon-foreground.png` | The adaptive icon foreground: 1024 px RGBA, white mark on transparent, 52% of the width. The config sets the background to `#000000`. |
| `../images/android-icon-monochrome.png` | The Android 13+ themed icon: the same image as the foreground. Android uses only its alpha. |
| `../images/splash-icon.png` | The splash image: 1024 px RGBA, white mark and wordmark on transparent, 68% of the width. The config shows it at `imageWidth: 200` on `#000000`, the same in light and dark mode. |
| `../images/favicon.png` | The web favicon: 48 px RGB, white mark on `#000000`, 80% of the width. |

Every image is centred on the box of what it draws. In the transparent PNGs, every pixel's colour is
pure white (`#FFFFFF`) and the shape lives only in the alpha channel. Scaling or tinting them
therefore leaves no grey fringe.

## Sizing rules

- **Android adaptive icon.** The canvas is 108 dp. Launchers show the inner 72 dp. Only a 66 dp
  circle (radius 0.306 of the canvas) is safe from every mask. The mark's farthest point (an arm
  tip) is 0.571 × its width from its centre. At 52% of the canvas, it reaches 0.298 of the canvas:
  about 64 dp across, inside the 66 dp circle. At 56%, the tips would reach about 69 dp and could be
  clipped.
- **Splash.** expo-splash-screen fits the image into an `imageWidth` (200 dp) square in the centre of
  a 288 dp icon. Android 12 and later mask that icon to a 192 dp circle, so everything must lie
  within 96 dp of the centre: 0.48 of the image. The logo's farthest point is 0.666 × its width
  from its centre. At 68% of the image, it reaches 0.453. On both platforms, the logo shows about
  136 dp (pt) wide.
- **iOS icon.** iOS rounds the corners itself. The image must be opaque.

`scripts/gen-brand.mjs` checks these limits. It fails if any image's art is clipped, or if it
reaches outside its safe circle.

## Regenerating

The renderer is [resvg](https://github.com/linebender/resvg) through `@resvg/resvg-js`. PNG
re-encoding uses `pngjs`. Neither is an app dependency. Install them into a throwaway folder and
pass that folder to the script:

```sh
TOOLS="$(mktemp -d)"
npm install --prefix "$TOOLS" --no-save --no-audit --no-fund @resvg/resvg-js@2.6.2 pngjs@7.0.0
node scripts/gen-brand.mjs "$TOOLS"
```

The script works as follows:

1. It reads `openalgo-logo.svg` and keeps the paths whose fill has every channel at `0xE0` or
   above. The mark is the one above y 625, and the eight letters lie below it.
2. It writes `openalgo-mark.svg` and `openalgo-logo-white.svg` with the original path data, fill
   `#FFFFFF`, and a tight `viewBox`. The box comes from resvg's `getBBox`, rounded outward to
   0.1 unit.
3. For each PNG, it builds a square SVG canvas: an optional `#000000` rect, then the paths, scaled
   so the art's larger side is the stated fraction of the canvas, and centred. resvg renders the
   canvas at its own size, with anti-aliasing (`shape-rendering` is the default
   `geometricPrecision`).
4. For the transparent images, it sets every pixel's RGB to `255,255,255` and keeps the alpha.
   It writes the opaque images as 8-bit RGB (colour type 2) and the transparent ones as 8-bit
   RGBA (colour type 6), at zlib level 9.

The renderer's output is deterministic, so a rerun with the same versions reproduces the committed
files.

The script does not use macOS Quick Look (`qlmanage -t`). Its PNG claims an alpha channel, but it
flattens a transparent SVG onto opaque white: `openalgo-mark.svg` comes out as a blank white
square. It also cannot crop or scale the art to a fraction of the canvas.

`test/app.config.test.ts` checks the config paths, the colours and the PNG sizes and colour types.
It also checks that `assets/images` holds nothing the config does not use.
