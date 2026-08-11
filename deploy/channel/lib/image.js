import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function absolutize(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

export function extractImageFromHtml(html, pageUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /"image"\s*:\s*"(https?:[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
    /"image"\s*:\s*\[\s*"(https?:[^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const abs = absolutize(m[1].replace(/&amp;/g, "&"), pageUrl);
      if (abs && /^https?:\/\//i.test(abs)) return abs;
    }
  }
  return null;
}

async function downloadToFile(url, dest) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "image/jpeg,image/png",
      Referer: new URL(url).origin + "/",
    },
  });
  if (!res.ok) throw new Error(`image HTTP ${res.status} for ${url.slice(0, 120)}`);
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct && !ct.startsWith("image/") && !ct.includes("octet-stream")) {
    throw new Error(`not an image content-type: ${ct}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(res.body, createWriteStream(dest));
  return { path: dest, contentType: ct };
}

async function imageFromSourcePage(pageUrl) {
  const res = await fetch(pageUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`source page HTTP ${res.status}`);
  const html = await res.text();
  const img = extractImageFromHtml(html, pageUrl);
  if (!img) throw new Error("no og:image / schema image on source page");
  return img;
}

/** Telegram is picky: wrong extension / progressive JPEG → IMAGE_PROCESS_FAILED. */
export function normalizeImageForTelegram(inputPath) {
  const out = `${inputPath}.tg.jpg`;
  const py = `
from PIL import Image
im = Image.open(${JSON.stringify(inputPath)})
im = im.convert("RGB")
w, h = im.size
max_side = 1600
if max(w, h) > max_side:
    scale = max_side / float(max(w, h))
    im = im.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
im.save(${JSON.stringify(out)}, "JPEG", quality=85, optimize=True, progressive=False)
print(${JSON.stringify(out)})
`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`image normalize failed: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  }
  return (r.stdout || "").trim() || out;
}

/**
 * Download dish photo from the recipe source only (no AI generation).
 * Tries recipe.imageUrl, then og:image from recipe.sourceUrl.
 */
export async function resolveRecipeImage(recipe, { cacheDir } = {}) {
  const dir = cacheDir || join(tmpdir(), "receipt-channel");
  await mkdir(dir, { recursive: true });
  const id = randomBytes(6).toString("hex");
  const notes = [];
  const candidates = [];

  if (recipe.imageUrl && /^https?:\/\//i.test(recipe.imageUrl)) {
    candidates.push(recipe.imageUrl);
  }

  if (recipe.sourceUrl && /^https?:\/\//i.test(recipe.sourceUrl)) {
    try {
      const fromPage = await imageFromSourcePage(recipe.sourceUrl);
      notes.push(`og/schema image from source page`);
      if (!candidates.includes(fromPage)) candidates.push(fromPage);
    } catch (e) {
      notes.push(`source page scrape failed: ${e.message}`);
      console.warn("source page scrape failed:", e.message);
    }
  }

  if (!candidates.length) {
    throw new Error(
      `no source image for «${recipe.title || "?"}» (need imageUrl or sourceUrl); ${notes.join("; ")}`,
    );
  }

  let lastErr = null;
  for (const url of candidates) {
    const dest = join(dir, `recipe-${id}.img`);
    try {
      await downloadToFile(url, dest);
      const jpegPath = normalizeImageForTelegram(dest);
      try {
        await unlink(dest);
      } catch {
        // ignore
      }
      notes.push(`image from source (normalized JPEG): ${url.slice(0, 140)}`);
      return { path: jpegPath, notes, imageUrl: url };
    } catch (e) {
      lastErr = e;
      notes.push(`download failed (${url.slice(0, 80)}): ${e.message}`);
      console.warn("image download failed:", e.message);
      try {
        await unlink(dest);
      } catch {
        // ignore
      }
    }
  }

  throw new Error(
    `Could not download source image: ${lastErr?.message || "unknown"}; ${notes.join("; ")}`,
  );
}
