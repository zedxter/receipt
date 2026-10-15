const INDEXES = [
  "https://www.rewe.de/rezepte/",
  "https://www.bbcgoodfood.com/recipes/collection/family-meal-recipes",
];
const allowed = (url) => {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      ["www.rewe.de", "www.chefkoch.de", "www.bbcgoodfood.com"].includes(
        u.hostname,
      ) &&
      !u.username &&
      !u.password &&
      !u.port
    );
  } catch {
    return false;
  }
};
async function page(url, signal) {
  for (let redirects = 0; redirects < 4; redirects++) {
    if (!allowed(url)) throw new Error("Unsupported recipe source");
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get("location"), url).href;
      continue;
    }
    if (!response.ok) throw new Error(`Recipe source HTTP ${response.status}`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2000000) throw new Error("Recipe page too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return { url, html: Buffer.concat(chunks).toString("utf8") };
  }
  throw new Error("Too many recipe redirects");
}
function findRecipe(value) {
  if (!value || typeof value !== "object") return null;
  if (
    [].concat(value["@type"] || []).includes("Recipe") &&
    value.recipeIngredient &&
    value.recipeInstructions
  )
    return value;
  for (const child of Object.values(value)) {
    const found = findRecipe(child);
    if (found) return found;
  }
  return null;
}
export async function recipeSource(db, recentTitles = []) {
  const signal = AbortSignal.timeout(30000);
  const candidates = [];
  for (const index of INDEXES) {
    try {
      const { html } = await page(index, signal);
      for (const match of html.matchAll(/href=["']([^"']+)["']/g)) {
        const url = new URL(match[1], index);
        if (
          url.origin === new URL(index).origin &&
          /^\/(?:rezepte|recipes)\/[^/]+\/?$/.test(url.pathname)
        )
          candidates.push(url.origin + url.pathname);
      }
    } catch {
      /* Previously saved sources remain available when discovery is down. */
    }
  }
  const recent = new Set(recentTitles.map((x) => x.toLowerCase()));
  const rows = db
    .prepare(
      "SELECT title, source_url FROM recipes WHERE source_url IS NOT NULL ORDER BY RANDOM()",
    )
    .all();
  const excluded = new Set(
    rows
      .filter((r) => recent.has(r.title.toLowerCase()))
      .map((r) => r.source_url),
  );
  candidates.push(
    ...rows
      .filter((r) => !recent.has(r.title.toLowerCase()))
      .map((r) => r.source_url),
  );
  const unique = [...new Set(candidates)].filter(
    (url) => allowed(url) && !excluded.has(url),
  );
  // Shuffle to avoid choosing the first recipe on the index every day.
  unique.sort(() => Math.random() - 0.5);
  for (const url of unique.slice(0, 5)) {
    try {
      const fetched = await page(url, signal);
      for (const match of fetched.html.matchAll(
        /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
      )) {
        let recipe;
        try {
          recipe = findRecipe(JSON.parse(match[1]));
        } catch {
          continue;
        }
        if (!recipe) continue;
        const img = [].concat(recipe.image || [])[0];
        const imageUrl = typeof img === "string" ? img : img?.url;
        if (!imageUrl || !/^https:\/\//i.test(imageUrl)) continue;
        return {
          sourceUrl: fetched.url,
          imageUrl,
          title: recipe.name,
          ingredients: recipe.recipeIngredient,
          instructions: recipe.recipeInstructions,
        };
      }
    } catch {
      if (signal.aborted) break;
    }
  }
  throw new Error("No verified recipe source available");
}
