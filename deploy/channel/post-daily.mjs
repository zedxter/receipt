#!/usr/bin/env node
/**
 * Morning recipe post for «Рецепты на каждый день».
 *
 *   node post-daily.mjs            # generate + post to channel
 *   node post-daily.mjs --preview  # generate + DM owner only (no channel)
 *   node post-daily.mjs --dry-run  # generate only, print caption (still saves new recipes to DB)
 */
import { unlink } from "node:fs/promises";
import { loadPosterEnv } from "./lib/env.js";
import { generateRecipe, mentionsPork } from "./lib/generate.js";
import { resolveRecipeImage } from "./lib/image.js";
import {
  openDb,
  pickRandomRecipe,
  recentPostedTitles,
  recordPost,
  recipeCount,
  upsertRecipe,
  withSourceInCaption,
} from "./lib/db.js";
import { notifyOwner, sendChannelPhoto, sendOwnerPhoto } from "./lib/telegram.js";

loadPosterEnv();

const args = new Set(process.argv.slice(2));
const preview = args.has("--preview");
const dryRun = args.has("--dry-run");

function todayLabel() {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Berlin",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
}

function saveRecipe(db, recipe) {
  const id = upsertRecipe(db, {
    ...recipe,
    source: recipe.source || (recipe.fromDb ? "db" : "unknown"),
  });
  return { ...recipe, id };
}

async function ensureImage(recipe, notes, db, recent) {
  try {
    const image = await resolveRecipeImage(recipe);
    if (image.imageUrl && image.imageUrl !== recipe.imageUrl) {
      recipe = saveRecipe(db, { ...recipe, imageUrl: image.imageUrl });
    }
    return { recipe, image };
  } catch (e) {
    notes.push(`source image failed for «${recipe.title}»: ${e.message}`);
    console.warn("source image failed:", e.message);
  }

  const tried = new Set([recipe.title]);
  for (let i = 0; i < 5; i++) {
    const alt = pickRandomRecipe(db, {
      avoidDays: 21,
      avoidTitles: [...recent, ...tried],
      requireImage: true,
    });
    if (!alt || tried.has(alt.title)) break;
    tried.add(alt.title);
    if (mentionsPork(`${alt.title}\n${alt.caption}`)) {
      notes.push(`alt пропуск (свинина): ${alt.title}`);
      continue;
    }
    try {
      const image = await resolveRecipeImage(alt);
      notes.push(`переключился на рецепт из БД с рабочей картинкой: ${alt.title}`);
      return { recipe: { ...alt, fromDb: true }, image };
    } catch (e) {
      notes.push(`alt «${alt.title}» image failed: ${e.message}`);
    }
  }
  throw new Error("no downloadable source image (fresh recipe and DB fallbacks failed)");
}

async function main() {
  const db = openDb();
  const recent = recentPostedTitles(db, 21);
  console.log("recipe DB:", process.env.RECEIPT_DB || "(default)", `count=${recipeCount(db)}`);

  let { recipe, notes } = await generateRecipe({
    recentTitles: recent,
    todayLabel: todayLabel(),
  });

  if (!recipe.id) recipe = saveRecipe(db, recipe);
  recipe = withSourceInCaption(recipe);

  console.log("title:", recipe.title);
  console.log("caption chars:", recipe.caption.length);
  console.log("fromDb:", Boolean(recipe.fromDb), "source:", recipe.source || "?");
  console.log("imageUrl:", recipe.imageUrl || "(none)");
  console.log("sourceUrl:", recipe.sourceUrl || "(none)");
  if (notes.length) console.log("notes:\n-", notes.join("\n- "));

  if (dryRun) {
    console.log("\n--- caption ---\n" + recipe.caption);
    return;
  }

  const resolved = await ensureImage(recipe, notes, db, recent);
  recipe = withSourceInCaption(resolved.recipe);
  const image = resolved.image;
  if (!recipe.id) recipe = saveRecipe(db, recipe);

  if (image.notes?.length) console.log("image:\n-", image.notes.join("\n- "));

  try {
    if (preview) {
      await sendOwnerPhoto(image.path, recipe.caption);
      console.log("preview photo DM sent");
      recordPost(db, recipe.id, "preview");
    } else {
      await sendChannelPhoto(image.path, recipe.caption);
      console.log("posted to channel");
      recordPost(db, recipe.id, "channel");
    }
  } finally {
    try {
      await unlink(image.path);
    } catch {
      // ignore
    }
  }

  if (notes.length && !preview) {
    try {
      await notifyOwner(`Ок: ${recipe.title}\n\n${notes.join("\n")}`);
    } catch (e) {
      console.warn("owner notify failed:", e.message);
    }
  }
}

main().catch(async (e) => {
  console.error(e);
  try {
    loadPosterEnv();
    await notifyOwner(`FAIL: ${e.message || e}`);
  } catch {
    // ignore
  }
  process.exit(1);
});
