'use strict';

const AI_REQUEST_COOLDOWN_MS = 30_000;
const MAX_AI_PROMPT_LENGTH = 2_000;
const MAX_AI_RESPONSE_LENGTH = 4_000;
const recentRequests = new Map();

function buildGroqRequest(prompt, model, botName) {
  return {
    model,
    messages: [
      {
        role: 'system',
        content: `You are ${botName}, a helpful WhatsApp bot. Give concise, safe, and useful answers.`
      },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 700
  };
}

function reserveAiRequest(sender) {
  const now = Date.now();
  const previous = recentRequests.get(sender) || 0;
  const remaining = AI_REQUEST_COOLDOWN_MS - (now - previous);
  if (remaining > 0) {
    throw new Error(`Please wait ${Math.ceil(remaining / 1000)} seconds before another AI request.`);
  }

  recentRequests.set(sender, now);
  setTimeout(() => {
    if (recentRequests.get(sender) === now) recentRequests.delete(sender);
  }, AI_REQUEST_COOLDOWN_MS).unref();
}

async function askGroq({ apiKey, model, prompt, botName }) {
  if (!apiKey) throw new Error('AI is not configured. Set GROQ_API_KEY before using this command.');
  if (!prompt || prompt.length > MAX_AI_PROMPT_LENGTH) {
    throw new Error(`Prompt must contain 1-${MAX_AI_PROMPT_LENGTH} characters.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildGroqRequest(prompt, model, botName)),
      signal: controller.signal
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new Error(`AI request failed with HTTP ${response.status}${details ? '.' : ''}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('AI returned an empty response.');
    return text.slice(0, MAX_AI_RESPONSE_LENGTH);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('AI request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  AI_REQUEST_COOLDOWN_MS,
  MAX_AI_PROMPT_LENGTH,
  askGroq,
  buildGroqRequest,
  reserveAiRequest
};
