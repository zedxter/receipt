import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function extFromContentType(ct = "") {
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("gif")) return ".gif";
  return ".jpg";
}

function extFromUrl(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".png")) return ".png";
    if (p.endsWith(".webp")) return ".webp";
    if (p.endsWith(".gif")) return ".gif";
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return ".jpg";
  } catch {
    // ignore
  }
  return null;
}

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
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
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
      const got = await downloadToFile(url, dest);
      const ext = extFromContentType(got.contentType) || extFromUrl(url) || ".jpg";
      const finalDest = join(dir, `recipe-${id}${ext}`);
      if (finalDest !== dest) {
        const { rename } = await import("node:fs/promises");
        await rename(dest, finalDest);
      }
      notes.push(`image from source: ${url.slice(0, 160)}`);
      return { path: finalDest, notes, imageUrl: url };
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
