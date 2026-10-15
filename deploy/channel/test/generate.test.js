import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { generateRecipe } from "../lib/generate.js";
import { openDb, upsertRecipe } from "../lib/db.js";
const dir = mkdtempSync(join(tmpdir(), "receipt-nous-"));
process.env.RECEIPT_DB = join(dir, "recipes.db");
process.env.NOUS_API_KEY = "nous-test-key";
process.env.OPENROUTER_API_KEY = "legacy-key";
process.env.RECEIPT_USE_CURSOR_AGENT = "0";
const original = globalThis.fetch;
after(() => {
  globalThis.fetch = original;
  openDb().close();
  rmSync(dir, { recursive: true, force: true });
});
const sourceUrl = "https://www.rewe.de/rezepte/linsensuppe/";
const imageUrl = "https://img.rewe-static.de/soup.jpg";
const recipe = {
  title: "Lentil soup",
  caption:
    "Lentil soup for five: lentils, carrots and potatoes. Simmer the vegetables with lentils until tender; serve hot. A balanced family dinner.",
  sourceUrl,
  imageUrl,
};
openDb().prepare("DELETE FROM recipes").run();
upsertRecipe(openDb(), recipe);
const page = `<script type="application/ld+json">${JSON.stringify({ "@type": "Recipe", name: "Lentil soup", recipeIngredient: ["lentils", "carrots"], recipeInstructions: [{ "@type": "HowToStep", text: "Simmer until tender" }], image: imageUrl })}</script>`;
function sources(url) {
  if (url === "https://www.rewe.de/rezepte/")
    return new Response('<a href="/rezepte/linsensuppe/">Soup</a>');
  if (url.startsWith("https://www.rewe.de/rezepte/")) return new Response(page);
  throw new Error("Unexpected source endpoint");
}
test("generates through Nous despite inherited OpenRouter credentials, using a real recipe page", async () => {
  let modelCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (!url.includes("/chat/completions")) return sources(url);
    modelCalls++;
    assert.equal(
      url,
      "https://inference-api.nousresearch.com/v1/chat/completions",
    );
    assert.equal(options.headers.Authorization, "Bearer nous-test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "openai/gpt-6.1-sol");
    assert.equal(body.temperature, undefined);
    assert.equal(body.plugins, undefined);
    assert.match(body.messages.at(-1).content, /Simmer until tender/);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({
      choices: [{ message: { content: JSON.stringify(recipe) } }],
    });
  };
  const result = await generateRecipe();
  assert.equal(result.recipe.fromDb, false);
  assert.equal(result.recipe.source, "nous");
  assert.equal(modelCalls, 1);
  assert.deepEqual(result.notes, []);
});
test("anchors source and image to the fetched page rather than model-invented URLs", async () => {
  globalThis.fetch = async (url) =>
    url.includes("/chat/completions")
      ? Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...recipe,
                  sourceUrl: "https://invented.example/recipe",
                  imageUrl: "https://invented.example/image.jpg",
                  caption:
                    recipe.caption +
                    "\nSource: https://invented.example/recipe",
                }),
              },
            },
          ],
        })
      : sources(url);
  const result = await generateRecipe();
  assert.equal(result.recipe.fromDb, false);
  assert.equal(result.recipe.sourceUrl, sourceUrl);
  assert.equal(result.recipe.imageUrl, imageUrl);
  assert.ok(!result.recipe.caption.includes("invented.example"));
});
test("rejects stale DeepSeek config without making a model call", async () => {
  process.env.RECEIPT_LLM_MODEL = "deepseek/deepseek-v3.2";
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) {
      calls++;
      return Response.json({
        choices: [{ message: { content: JSON.stringify(recipe) } }],
      });
    }
    return sources(url);
  };
  try {
    assert.equal((await generateRecipe()).recipe.fromDb, true);
    assert.equal(calls, 0);
  } finally {
    delete process.env.RECEIPT_LLM_MODEL;
  }
});
for (const [name, reply] of [
  [
    "HTTP error",
    () => new Response("private body nous-test-key", { status: 401 }),
  ],
  ["API error", () => Response.json({ error: { message: "private body" } })],
  ["invalid JSON", () => new Response("invalid")],
  [
    "empty completion",
    () => Response.json({ choices: [{ message: { content: "" } }] }),
  ],
  [
    "truncated response",
    () =>
      Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { content: JSON.stringify(recipe) },
          },
        ],
      }),
  ],
  [
    "pork",
    () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({ ...recipe, title: "Pork stew" }),
            },
          },
        ],
      }),
  ],
]) {
  test(`${name} falls back without another provider or leaking response details`, async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      if (url.includes("/chat/completions")) {
        assert.equal(new URL(url).hostname, "inference-api.nousresearch.com");
        calls++;
        return reply();
      }
      return sources(url);
    };
    const result = await generateRecipe();
    assert.equal(result.recipe.fromDb, true);
    assert.equal(calls, 1);
    assert.ok(!result.notes.join().includes("private body"));
    assert.ok(!result.notes.join().includes("nous-test-key"));
  });
}
test("missing Nous credential never uses inherited provider keys", async () => {
  delete process.env.NOUS_API_KEY;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) {
      calls++;
      throw new Error("Unexpected call");
    }
    return sources(url);
  };
  try {
    assert.equal((await generateRecipe()).recipe.fromDb, true);
    assert.equal(calls, 0);
  } finally {
    process.env.NOUS_API_KEY = "nous-test-key";
  }
});
test("provider deadline returns the DB fallback", async () => {
  process.env.RECEIPT_LLM_TIMEOUT_MS = "10";
  globalThis.fetch = async (url, { signal } = {}) => {
    if (!url.includes("/chat/completions")) return sources(url);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("deadline not enforced")),
        500,
      );
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
  try {
    const result = await generateRecipe();
    assert.equal(result.recipe.fromDb, true);
    assert.match(result.notes.join(), /timed out/);
  } finally {
    delete process.env.RECEIPT_LLM_TIMEOUT_MS;
  }
});
test("unverified source pages never reach the model", async () => {
  let modelCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) modelCalls++;
    return new Response("<html>not a recipe</html>");
  };
  assert.equal((await generateRecipe()).recipe.fromDb, true);
  assert.equal(modelCalls, 0);
});
test("discovers another real recipe source when REWE blocks requests", async () => {
  const bbc = "https://www.bbcgoodfood.com/recipes/lentil-soup";
  globalThis.fetch = async (url) => {
    if (url.startsWith("https://www.rewe.de"))
      return new Response("blocked", { status: 403 });
    if (
      url ===
      "https://www.bbcgoodfood.com/recipes/collection/family-meal-recipes"
    )
      return new Response('<a href="/recipes/lentil-soup">Soup</a>');
    if (url === bbc) return new Response(page);
    if (url.includes("/chat/completions"))
      return Response.json({
        choices: [{ message: { content: JSON.stringify(recipe) } }],
      });
    throw new Error("Unexpected URL");
  };
  const result = await generateRecipe();
  assert.equal(result.recipe.fromDb, false);
  assert.equal(result.recipe.sourceUrl, bbc);
});
