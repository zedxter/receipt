import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB = join(homedir(), ".local/share/receipt/recipes.db");

let _db;

export function dbPath() {
  return process.env.RECEIPT_DB || DEFAULT_DB;
}

export function openDb() {
  if (_db) return _db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      title_key TEXT NOT NULL UNIQUE,
      caption TEXT NOT NULL,
      image_url TEXT,
      image_prompt TEXT,
      source_url TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      posted_at TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'channel'
    );

    CREATE INDEX IF NOT EXISTS posts_recipe_id ON posts(recipe_id);
    CREATE INDEX IF NOT EXISTS posts_posted_at ON posts(posted_at);
  `);

  // migrate older DBs
  const cols = db.prepare("PRAGMA table_info(recipes)").all().map((c) => c.name);
  if (!cols.includes("source_url")) {
    db.exec("ALTER TABLE recipes ADD COLUMN source_url TEXT");
  }
  _db = db;
  seedIfEmpty(db);
  return db;
}

function titleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function seedIfEmpty(db) {
  const n = db.prepare("SELECT COUNT(*) AS c FROM recipes").get().c;
  if (n > 0) return;

  const caption = `Ужин на сегодня: курица с овощами с одного противня

Семейный лист из духовки — белок, овощи и картофель. Без экзотики: Rewe, Penny, Lidl.

На 5 порций (2 взрослых + 3 детей)

Список покупок
• 6–8 куриных бёдер/голеней (~1,2–1,4 кг) или ~900 г филе
• 800 г картофеля (festkochend)
• 2 цукини
• 2 болгарских перца (красный + жёлтый)
• 2 красных луковицы
• розмарин / тимьян
• 6–7 ст.л. оливкового или рапсового масла
• 1½ ч.л. сладкой паприки, соль, перец
• по желанию: Kräuterquark

Почему полезно
Белок из курицы + овощи + картофель — сытно без тяжёлого соуса. Одно блюдо на всю семью.

Как готовить (~50–55 мин, активных ~15)
1. Духовка 200 °C (или 180 °C Umluft). Противень с бумагой.
2. 3 ст.л. масла + соль, перец, паприка → натереть курицу (кожу обсушить).
3. Картофель дольками с маслом и травами → рядом. В духовку ~25 мин.
4. Цукини, перец, лук с маслом и травами — ещё 20–25 мин.
5. Подать с творожком/йогуртом с зеленью.`;

  upsertRecipe(db, {
    title: "Курица с овощами с одного противня",
    caption,
    imageUrl: null,
    sourceUrl: "https://www.rewe.de/rezepte/haehnchenschenkel-ofengemuese-blech/",
    imagePrompt: null,
    source: "seed",
  });
}

export function upsertRecipe(db, recipe) {
  const now = new Date().toISOString();
  const key = titleKey(recipe.title);
  const row = db
    .prepare(
      `INSERT INTO recipes (title, title_key, caption, image_url, image_prompt, source_url, source, created_at, updated_at)
       VALUES (@title, @title_key, @caption, @image_url, @image_prompt, @source_url, @source, @now, @now)
       ON CONFLICT(title_key) DO UPDATE SET
         title = excluded.title,
         caption = excluded.caption,
         image_url = COALESCE(excluded.image_url, recipes.image_url),
         image_prompt = COALESCE(excluded.image_prompt, recipes.image_prompt),
         source_url = COALESCE(excluded.source_url, recipes.source_url),
         source = excluded.source,
         updated_at = excluded.updated_at
       RETURNING id`,
    )
    .get({
      title: recipe.title,
      title_key: key,
      caption: recipe.caption,
      image_url: recipe.imageUrl || null,
      image_prompt: recipe.imagePrompt || null,
      source_url: recipe.sourceUrl || null,
      source: recipe.source || "unknown",
      now,
    });
  return row.id;
}

export function withSourceInCaption(recipe) {
  if (!recipe) return recipe;
  let caption = String(recipe.caption || "").trim();
  const sourceUrl = recipe.sourceUrl;
  if (sourceUrl && /^https?:\/\//i.test(sourceUrl) && !caption.includes(sourceUrl)) {
    caption = `${caption}\n\nИсточник: ${sourceUrl}`;
  }
  if (caption.length > 1024 && sourceUrl) {
    const footer = `\n\nИсточник: ${sourceUrl}`;
    const maxBody = 1024 - footer.length;
    let body = caption.replace(/\n\nИсточник:\s*\S+\s*$/i, "").trimEnd();
    if (body.length > maxBody) body = body.slice(0, Math.max(0, maxBody - 1)).trimEnd() + "…";
    caption = `${body}${footer}`.slice(0, 1024);
  } else if (caption.length > 1024) {
    caption = caption.slice(0, 1021).trimEnd() + "…";
  }
  return { ...recipe, caption };
}

export function recipeFromRow(row) {
  if (!row) return null;
  return withSourceInCaption({
    id: row.id,
    title: row.title,
    caption: row.caption,
    imageUrl: row.image_url,
    imagePrompt: row.image_prompt,
    sourceUrl: row.source_url,
    source: row.source,
  });
}

export function pickRandomRecipe(
  db,
  { avoidDays = 21, avoidTitles = [], requireImage = true } = {},
) {
  const avoidKeys = avoidTitles.map(titleKey).filter(Boolean);
  const days = `-${Math.max(1, avoidDays)} days`;
  const avoidSql = avoidKeys.length
    ? `AND r.title_key NOT IN (${avoidKeys.map((_, i) => `@a${i}`).join(",")})`
    : "";
  const imageSql = requireImage
    ? `AND (r.image_url IS NOT NULL OR r.source_url IS NOT NULL)`
    : "";
  const bind = Object.fromEntries([
    ["days", days],
    ...avoidKeys.map((k, i) => [`a${i}`, k]),
  ]);

  let row = db
    .prepare(
      `SELECT r.* FROM recipes r
       WHERE r.id NOT IN (
         SELECT recipe_id FROM posts
         WHERE posted_at >= datetime('now', @days)
       )
       ${avoidSql}
       ${imageSql}
       ORDER BY RANDOM()
       LIMIT 1`,
    )
    .get(bind);

  if (!row) {
    row = db
      .prepare(
        `SELECT r.* FROM recipes r
         WHERE 1=1 ${imageSql}
         ORDER BY RANDOM()
         LIMIT 1`,
      )
      .get({});
  }
  return recipeFromRow(row);
}

export function recentPostedTitles(db, n = 21) {
  return db
    .prepare(
      `SELECT r.title FROM posts p
       JOIN recipes r ON r.id = p.recipe_id
       ORDER BY p.posted_at DESC
       LIMIT ?`,
    )
    .all(n)
    .map((x) => x.title);
}

export function recordPost(db, recipeId, mode = "channel") {
  db.prepare(
    `INSERT INTO posts (recipe_id, posted_at, mode) VALUES (?, ?, ?)`,
  ).run(recipeId, new Date().toISOString(), mode);
}

export function recipeCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM recipes").get().c;
}
