import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { sessionConfig } from "./telegram.js";
import {
  openDb,
  pickRandomRecipe,
  recipeCount,
  upsertRecipe,
} from "./db.js";


const CAPTION_LIMIT = 1000;

export function buildRecipePrompt({ recentTitles = [], todayLabel = "" } = {}) {
  const avoid =
    recentTitles.length > 0
      ? `Не повторяй эти недавние блюда:\n- ${recentTitles.join("\n- ")}`
      : "Выбери блюдо, которого ещё не было в канале.";

  const recentChicken =
    recentTitles.slice(0, 4).filter((t) => mentionsChicken(t)).length >= 2;
  const varietyHint = recentChicken
    ? `РАЗНООБРАЗИЕ (обязательно сегодня): в последних постах уже много курицы — сегодня НЕ курица и НЕ Hähnchen. Выбери другой белок или формат: индейка, говядина, рыба, яйца, бобовые, суп, гречка/булгур, вегетарианское итальянское/русское блюдо.`
    : `РАЗНООБРАЗИЕ: чередуй белок и формат. Не делай «курицу каждый день». Ротация: курица / индейка / говядина / рыба / яйца / бобовые / супы / крупы. Если недавние посты похожи по белку — смени белок.`;

  return `Ты редактор Telegram-канала «Рецепты на каждый день».

Задача: найти ОДИН полезный семейный ужин на вечер и оформить пост.

Контекст семьи:
- 2 взрослых + 3 детей (5 порций)
- Германия, продукты из обычных магазинов: Rewe, Penny, Lidl
- Без экзотики и редких ингредиентов
- Вкусно, полезно, сбалансированно (белок + овощи + сложные углеводы)
- Реалистично приготовить вечером (~45–70 мин, без ресторанной сложности)
- БЕЗ свинины: не Schwein, Schweinefleisch, Schnitzel из свинины, Speck, Bacon, Schinken, Kasseler, Bratwurst из свинины, Mett, Schweinefilet и т.п. Курица, индейка, говядина, рыба, яйца, бобовые — ок.
- Крупы приветствуются время от времени: гречка (Buchweizen), булгур (Bulgur); также рис, кускус, киноа — если обычно есть в Rewe/Penny/Lidl.
- Супы тоже ок (Suppe / Eintopf): овощные, куриные, с крупами или бобовыми — сытный семейный ужин, не только «второе».
- Кухни: можно русскую и итальянскую (и простую европейскую/немецкую), но ТОЛЬКО из продуктов Rewe/Penny/Lidl. Примеры: борщ/щи на говядине или овощные, гречка с грибами/индейкой, пельмени только если реально доступны без экзотики; паста, Risotto, Minestrone, Gnocchi, Pollo alla … без пармезана 36 месяцев и редкого морепродукта — обычный Hartkäse/Emmentaler/Mozzarella из дискаунтера ок.
${todayLabel ? `- Сегодня: ${todayLabel} (учти сезон, если уместно)` : ""}

${varietyHint}

${avoid}

Сделай короткий web-поиск (REWE Rezepte, Chefkoch, russian/italian family dinner адаптируемые под DE-супермаркет, и т.п.), выбери рецепт, адаптируй порции под семью из 5.

Верни ТОЛЬКО один JSON-объект (без markdown fences, без комментариев) со полями:
{
  "title": "короткое название блюда на русском",
  "caption": "полный текст поста для подписи к фото",
  "sourceUrl": "https-ссылка на страницу рецепта-источника",
  "imageUrl": "прямая https-ссылка на фото готового блюда с ЭТОЙ страницы (jpg/png/webp CDN)"
}

Правила для caption:
- На русском
- Один пост: заголовок, 1–2 предложения контекста, «На 5 порций», список покупок, кратко «Почему полезно», «Как готовить» нумерованными шагами
- В конце одна строка со ссылкой на источник, например: Источник: https://...
- БЕЗ эмодзи-спама
- Длина caption строго ≤ ${CAPTION_LIMIT} символов (лимит Telegram)
- Не выдумывай опасные кулинарные советы; шаги должны быть исполнимыми

Правила для картинки (обязательно):
- Бери ТОЛЬКО реальное фото блюда из источника. Никакой AI-генерации и стоковых «похожих» картинок.
- imageUrl — прямой URL файла изображения (не HTML). Можно взять og:image / главное фото рецепта.
- sourceUrl — страница рецепта, с которой взято фото (та же ссылка, что в конце caption).
- Если прямой imageUrl не находится — всё равно верни sourceUrl; imageUrl тогда null.
- Без sourceUrl и без imageUrl рецепт НЕ возвращай — выбери другой.`;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function sanitizeRecipe(raw) {
  const obj = typeof raw === "object" && raw ? raw : extractJsonObject(raw);
  if (!obj || typeof obj !== "object") return null;

  let caption = String(obj.caption || "").trim();
  caption = caption.replace(/\n{3,}/g, "\n\n").trim();

  const title = String(obj.title || "").trim() || caption.split("\n")[0].slice(0, 80);
  const imageUrl = obj.imageUrl ? String(obj.imageUrl).trim() : null;
  const sourceUrl = obj.sourceUrl ? String(obj.sourceUrl).trim() : null;
  const okImage = imageUrl && /^https?:\/\//i.test(imageUrl) ? imageUrl : null;
  const okSource = sourceUrl && /^https?:\/\//i.test(sourceUrl) ? sourceUrl : null;

  if (!caption || caption.length < 80) return null;
  if (!okImage && !okSource) return null;
  if (mentionsPork(`${title}\n${caption}`)) return null;

  // Ensure source link is in the caption (Telegram-friendly plain URL).
  if (okSource && !caption.includes(okSource)) {
    caption = `${caption.replace(/\s+$/, "")}\n\nИсточник: ${okSource}`;
  }

  if (caption.length > 1024) {
    // Prefer keeping the source URL: trim body, then re-append source.
    const footer = okSource ? `\n\nИсточник: ${okSource}` : "";
    const maxBody = 1024 - footer.length;
    let body = caption;
    if (okSource) {
      body = caption.replace(/\n\nИсточник:\s*\S+\s*$/i, "").trimEnd();
    }
    if (body.length > maxBody) body = body.slice(0, Math.max(0, maxBody - 1)).trimEnd() + "…";
    caption = `${body}${footer}`.slice(0, 1024);
  }

  return {
    title,
    caption,
    imageUrl: okImage,
    sourceUrl: okSource,
    imagePrompt: null,
  };
}

/** Reject dishes that mention pork (family does not eat it). */
export function mentionsPork(text) {
  const t = String(text || "").toLowerCase();
  // Avoid JS \b with Cyrillic — use unicode letter boundaries.
  const patterns = [
    /(^|[^\p{L}])свин(ин[аыуе]|иной|ой|ом|ое|ые|ых|ую|ье|ьей|ьего|ьи|ью)(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])ветчин[аыуеой]?(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])бекон[ауеом]?(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])schwein(e(fleisch|filet|braten|schnitzel|haxe|bauch)?)?(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])speck(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])bacon(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])schinken(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])kasseler(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])mett(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])pork(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])ham(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])pancetta(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])prosciutto(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])bratwurst(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])nürnberger(?=[^\p{L}]|$)/u,
    /(^|[^\p{L}])schweinebraten(?=[^\p{L}]|$)/u,
  ];
  return patterns.some((re) => re.test(t));
}

/** Detect chicken-heavy dishes (for variety — avoid posting chicken every day). */
export function mentionsChicken(text) {
  const t = String(text || "").toLowerCase();
  return (
    /курин|курица|курицы|курицу|курицей|курочк|цыпл[её]н/.test(t) ||
    /hähnchen|haehnchen|(^|[^\p{L}])huhn([^\p{L}]|$)|chicken|(^|[^\p{L}])pollo([^\p{L}]|$)/u.test(
      t,
    )
  );
}

function tooMuchRecentChicken(recentTitles = []) {
  return recentTitles.slice(0, 4).filter((t) => mentionsChicken(t)).length >= 2;
}

function rejectsForVariety(recipe, recentTitles = []) {
  if (!recipe) return true;
  const blob = `${recipe.title}\n${recipe.caption}`;
  if (mentionsPork(blob)) return true;
  if (tooMuchRecentChicken(recentTitles) && mentionsChicken(blob)) return true;
  return false;
}

function runCursorAgent(prompt, { mode = null } = {}) {
  const workspace =
    process.env.RECEIPT_CURSOR_WORKSPACE ||
    process.env.TELEGRAM_SESSION_CWD ||
    sessionConfig().sessionCwd;
  const bin = process.env.CURSOR_AGENT_BIN || `${homedir()}/.local/bin/cursor-agent`;
  const args = ["-p", "--output-format", "json", "--trust", "--workspace", workspace];
  if (mode) args.push("--mode", mode);
  if (process.env.RECEIPT_CURSOR_MODEL) {
    args.push("--model", process.env.RECEIPT_CURSOR_MODEL);
  }
  args.push(prompt);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      env: process.env,
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("cursor-agent timed out"));
    }, Number(process.env.RECEIPT_CURSOR_TIMEOUT_MS || 240000));

    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const raw = out.trim();
      let text = raw;
      if (raw.startsWith("{")) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.is_error) {
            reject(
              new Error(
                `cursor-agent error: ${String(parsed.result || parsed.error || "unknown").slice(0, 400)}`,
              ),
            );
            return;
          }
          if (typeof parsed?.result === "string") text = parsed.result.trim();
        } catch {
          // keep raw
        }
      }
      if (code !== 0 || !text) {
        reject(
          new Error(
            `cursor-agent exit ${code}: ${(err || out).slice(0, 400) || "empty output"}`,
          ),
        );
        return;
      }
      resolvePromise(text);
    });
  });
}

async function apiLlmRecipe(prompt) {
  const key =
    process.env.OPENROUTER_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENAI_API_KEY;
  if (!key) return null;

  let base = "https://api.openai.com/v1";
  let model = process.env.RECEIPT_LLM_MODEL || "gpt-4.1-mini";
  if (process.env.OPENROUTER_API_KEY) {
    base = "https://openrouter.ai/api/v1";
    model = process.env.RECEIPT_LLM_MODEL || "openai/gpt-4.1-mini";
  } else if (process.env.GROQ_API_KEY) {
    base = "https://api.groq.com/openai/v1";
    model = process.env.RECEIPT_LLM_MODEL || "llama-3.3-70b-versatile";
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(process.env.OPENROUTER_API_KEY
        ? { "HTTP-Referer": "https://github.com/receipt", "X-Title": "receipt-channel" }
        : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: "Return only a single valid JSON object. No markdown.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || null;
}

function persistFresh(recipe, source) {
  const db = openDb();
  const id = upsertRecipe(db, { ...recipe, source });
  return { ...recipe, id, source, fromDb: false };
}

function recipeFromDbFallback(notes, recentTitles = []) {
  const db = openDb();
  const count = recipeCount(db);
  const avoid = [...recentTitles];
  for (let i = 0; i < 12; i++) {
    const picked = pickRandomRecipe(db, {
      avoidDays: 21,
      avoidTitles: avoid,
      requireImage: true,
    });
    if (!picked) break;
    if (rejectsForVariety(picked, recentTitles)) {
      avoid.push(picked.title);
      notes.push(`пропуск из БД (свинина/мало разнообразия): ${picked.title}`);
      continue;
    }
    notes.push(`взял случайный рецепт из БД (всего ${count}): ${picked.title}`);
    return { ...picked, fromDb: true };
  }
  throw new Error(
    "generation failed and recipe DB has no suitable pork-free/varied entries with source image",
  );
}

export async function generateRecipe(opts = {}) {
  const notes = [];
  const prompt = buildRecipePrompt(opts);
  const useCursor = process.env.RECEIPT_USE_CURSOR_AGENT !== "0";
  const recentTitles = opts.recentTitles || [];

  if (useCursor) {
    try {
      console.log("generating recipe with cursor-agent...");
      const raw = await runCursorAgent(prompt, { mode: null });
      const cleaned = sanitizeRecipe(raw);
      if (cleaned && !rejectsForVariety(cleaned, recentTitles)) {
        return { recipe: persistFresh(cleaned, "cursor"), notes };
      }
      if (cleaned) {
        notes.push("cursor-agent: отклонено из‑за однообразия (слишком много курицы подряд)");
      } else {
        notes.push("cursor-agent вернул текст без валидного JSON рецепта");
      }
    } catch (e) {
      notes.push(`cursor-agent failed: ${e.message}`);
      console.warn("cursor-agent failed:", e.message);
    }
  }

  try {
    const api = await apiLlmRecipe(prompt);
    if (api) {
      const cleaned = sanitizeRecipe(api);
      if (cleaned && !rejectsForVariety(cleaned, recentTitles)) {
        notes.push("использован LLM API fallback");
        return { recipe: persistFresh(cleaned, "llm"), notes };
      }
      if (cleaned) {
        notes.push("LLM API: отклонено из‑за однообразия (слишком много курицы подряд)");
      } else {
        notes.push("LLM API вернул невалидный JSON");
      }
    }
  } catch (e) {
    notes.push(`LLM API failed: ${e.message}`);
    console.warn("LLM API failed:", e.message);
  }

  return { recipe: recipeFromDbFallback(notes, recentTitles), notes };
}
