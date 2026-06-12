/**
 * Dynamic Open Graph card for the verification portal.
 *
 * satori renders the layout to an SVG with text as vector paths (so the
 * rasterizer needs no fonts), then resvg-wasm turns that into a PNG. The
 * result is expensive to generate cold (module + wasm + font loads), so it is
 * persisted to blob storage and also memoized in-isolate. The /og.png route
 * calls readVerifyOgImage(); the cron pre-warms it (refreshVerifyOgImage) so a
 * crawler never waits on a cold generation.
 *
 * All branding (logo, name, colors, copy) comes from ./theme.ts.
 */

import satori from "https://esm.sh/satori@0.10.13";
import { html } from "https://esm.sh/satori-html@0.3.2";
import { initWasm, Resvg } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { blob } from "https://esm.town/v/std/blob";
import { brand } from "./theme.ts";

const BLOB_KEY = "verify_og_png_v1";

const FONT_SOURCES = [
  {
    name: "Fredoka",
    weight: 600 as const,
    url:
      "https://cdn.jsdelivr.net/npm/@fontsource/fredoka/files/fredoka-latin-600-normal.woff",
  },
  {
    name: "Quicksand",
    weight: 500 as const,
    url:
      "https://cdn.jsdelivr.net/npm/@fontsource/quicksand/files/quicksand-latin-500-normal.woff",
  },
];

let pngCache: Uint8Array | null = null;
let fontsCache:
  | Array<
    { name: string; weight: 500 | 600; style: "normal"; data: ArrayBuffer }
  >
  | null = null;
let logoCache: string | null = null;
let wasmReady = false;

async function loadFonts() {
  if (fontsCache) return fontsCache;
  fontsCache = await Promise.all(FONT_SOURCES.map(async (f) => ({
    name: f.name,
    weight: f.weight,
    style: "normal" as const,
    data: await (await fetch(f.url)).arrayBuffer(),
  })));
  return fontsCache;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function loadLogo(): Promise<string> {
  if (logoCache) return logoCache;
  const res = await fetch(brand.logoUrl);
  // Keep the original mime so satori/resvg decode it correctly (the brand logo
  // may be a jpeg, png, webp, …).
  const mime = res.headers.get("content-type")?.split(";")[0] || "image/png";
  const buf = new Uint8Array(await res.arrayBuffer());
  logoCache = `data:${mime};base64,${toBase64(buf)}`;
  return logoCache;
}

async function generate(): Promise<Uint8Array> {
  const [fonts, logo] = await Promise.all([loadFonts(), loadLogo()]);

  const markup = html(`
    <div style="display:flex;flex-direction:column;width:1200px;height:630px;background:#0E0D0B;font-family:Quicksand;">
      <div style="display:flex;height:12px;width:1200px;background:linear-gradient(90deg,${brand.accentColor},${brand.accentColorBright},${brand.accentColor});"></div>
      <div style="display:flex;flex:1;padding:70px 80px;align-items:center;">
        <div style="display:flex;flex-direction:column;max-width:1040px;">
          <img src="${logo}" width="120" height="120" style="border-radius:24px;margin-bottom:32px;" />
          <div style="display:flex;font-family:'Fredoka';font-size:104px;color:#F5F1EA;letter-spacing:2px;line-height:0.96;">${brand.ogHeadline}</div>
          <div style="display:flex;font-family:'Fredoka';font-size:64px;color:${brand.accentColor};letter-spacing:2px;margin-top:24px;">${brand.name}</div>
          <div style="display:flex;font-size:40px;color:#c7c1b6;margin-top:24px;">${brand.ogTagline}</div>
        </div>
      </div>
    </div>
  `);

  // satori-html returns a VNode; satori types its first arg as ReactNode. The
  // shapes are compatible at runtime — cast to satori's own parameter type.
  const svg = await satori(
    markup as unknown as Parameters<typeof satori>[0],
    { width: 1200, height: 630, fonts },
  );

  if (!wasmReady) {
    await initWasm(
      fetch("https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm"),
    );
    wasmReady = true;
  }
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } });
  return resvg.render().asPng();
}

/** Serve the cached card (memory, then blob). Null if not generated yet. */
export async function readVerifyOgImage(): Promise<Uint8Array | null> {
  if (pngCache) return pngCache;
  try {
    const res = await blob.get(BLOB_KEY);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 0) {
      pngCache = buf;
      return buf;
    }
  } catch {
    // not generated yet
  }
  return null;
}

/**
 * Generate the card and persist it. Heavy (cold module + wasm + font loads),
 * so this runs from the cron — which executes to completion without an HTTP
 * request's wall-clock limit — never inline on the /og.png hot path.
 */
export async function refreshVerifyOgImage(): Promise<number> {
  const png = await generate();
  pngCache = png;
  // A Uint8Array is a valid body at runtime; the cast satisfies blob.set's
  // BodyInit typing (the DOM lib narrows BufferSource).
  await blob.set(BLOB_KEY, png as BodyInit);
  return png.length;
}
