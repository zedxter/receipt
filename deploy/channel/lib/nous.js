// Nous Portal is the only model provider; there is deliberately no endpoint override.
const ENDPOINT = "https://inference-api.nousresearch.com/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-6.1-sol";

// OpenAI reasoning models reject temperature and take an effort instead.
export const reasoningModel = (model) => /(^|\/)(gpt-[5-9]|o\d)/i.test(model);

export async function nousText({ system, prompt, temperature }) {
  const key = process.env.NOUS_API_KEY?.trim();
  if (!key) throw new Error("NOUS_API_KEY missing");
  const model = process.env.RECEIPT_LLM_MODEL?.trim() || DEFAULT_MODEL;
  if (!/^openai\/(?:gpt-|o[0-9])/.test(model))
    throw new Error("RECEIPT_LLM_MODEL must be an OpenAI model on Nous Portal");
  const configuredTimeout = Number(process.env.RECEIPT_LLM_TIMEOUT_MS || 60000);
  const timeout =
    Number.isSafeInteger(configuredTimeout) &&
    configuredTimeout > 0 &&
    configuredTimeout <= 2147483647
      ? configuredTimeout
      : 60000;
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      signal: AbortSignal.timeout(timeout),
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        ...(reasoningModel(model)
          ? { reasoning_effort: "low" }
          : { temperature }),
        max_completion_tokens: 4096,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
  } catch (error) {
    throw new Error(
      error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "Nous request timed out"
        : "Nous network request failed",
    );
  }
  if (!response.ok) throw new Error(`Nous HTTP ${response.status}`);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Nous response could not be read as JSON");
  }
  if (data?.error) throw new Error("Nous returned an API error");
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === "length")
    throw new Error("Nous response truncated");
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Nous returned an empty or invalid completion");
  }
  return content.trim();
}
