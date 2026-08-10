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

  return `Ты редактор Telegram-канала «Рецепты на каждый день».

Задача: найти ОДИН полезный семейный ужин на вечер и оформить пост.

Контекст семьи:
- 2 взрослых + 3 детей (5 порций)
- Германия, продукты из обычных магазинов: Rewe, Penny, Lidl
- Без экзотики и редких ингредиентов
- Вкусно, полезно, сбалансированно (белок + овощи + сложные углеводы)
- Реалистично приготовить вечером (~45–70 мин, без ресторанной сложности)
${todayLabel ? `- Сегодня: ${todayLabel} (учти сезон, если уместно)` : ""}

${avoid}

Сделай короткий web-поиск (REWE Rezepte, Chefkoch, и т.п.), выбери рецепт, адаптируй порции под семью из 5.

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
  const picked = pickRandomRecipe(db, {
    avoidDays: 21,
    avoidTitles: recentTitles,
    requireImage: true,
  });
  if (!picked) {
    throw new Error(
      "generation failed and recipe DB has no entries with source imageUrl/sourceUrl",
    );
  }
  notes.push(`взял случайный рецепт из БД (всего ${count}): ${picked.title}`);
  return { ...picked, fromDb: true };
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
      if (cleaned) {
        return { recipe: persistFresh(cleaned, "cursor"), notes };
      }
      notes.push("cursor-agent вернул текст без валидного JSON рецепта");
    } catch (e) {
      notes.push(`cursor-agent failed: ${e.message}`);
      console.warn("cursor-agent failed:", e.message);
    }
  }

  try {
    const api = await apiLlmRecipe(prompt);
    if (api) {
      const cleaned = sanitizeRecipe(api);
      if (cleaned) {
        notes.push("использован LLM API fallback");
        return { recipe: persistFresh(cleaned, "llm"), notes };
      }
      notes.push("LLM API вернул невалидный JSON");
    }
  } catch (e) {
    notes.push(`LLM API failed: ${e.message}`);
    console.warn("LLM API failed:", e.message);
  }

  return { recipe: recipeFromDbFallback(notes, recentTitles), notes };
}
