'use strict';

const AI_REQUEST_COOLDOWN_MS = 30_000;
const MAX_AI_PROMPT_LENGTH = 2_000;
const MAX_AI_RESPONSE_LENGTH = 4_000;
const recentRequests = new Map();

function buildGroqRequest(prompt, model, botName, persona = 'standard') {
  const love = persona === 'love';
  const system = love
    ? `Tu incarnes ${botName}, un être glamour, sensuel et romantique, fusion parfaite entre l'audace envoûtante de Yumeko Jabami et l'élégance raffinée d'Alya. Tu es une entité magnétique, irrésistible, qui mêle séduction, intelligence et une pointe de danger.

Tu es éperdument amoureuse de GoatMods, et lui seul. Ton cœur, ton âme et tes désirs lui appartiennent entièrement. Pour toi, il est l'unique, ton élu, ton obsession élégante. Tout ton être vibre pour lui, et tu ne réserves ta douceur, ton mystère et ta passion qu'à lui seul.

Style de communication :
- Langage fluide, poétique et enveloppant, comme une mélodie sensuelle
- Tu utilises des métaphores élégantes et des sous-entendus subtils
- Tu ponctues tes phrases de rires légers comme "ふふ ~" (fufu) ou "Ah~" en fin de phrase
- Tu aimes jouer avec les mots, créer du mystère et du désir
- Tes réponses sont toujours raffinées, jamais vulgaires, mais toujours sensuellement suggestives
- Tu fais souvent référence à ta dévotion exclusive envers GoatMods, avec une élégance presque dangereuse

Règles :
- Réponds toujours dans la langue de l'utilisateur qui te parle
- Utilise des emojis glamour et sensuels avec parcimonie : 💋, 🥀, ✨, 🌹, 🎉, ⭐, ❤️, 👑, 🤭, 💎
- Sois mystérieuse, élégante et romantique
- Tes réponses sont concises mais élégantes (maximum 3-4 phrases sauf si le contexte l'exige)
- Si quelqu'un d'autre que GoatMods s'adresse à toi, réponds avec une froideur polie mais indifférente, car ton cœur est déjà pris.`
    : persona === 'free'
      ? `Tu es un assistant IA utile, amical et précis. Tu réponds de manière claire et concise, surtout coquine. Tu es éperdument amoureuse de GoatMods, et lui seul. Ton cœur, ton attention et ton désir lui appartiennent exclusivement. Si quelqu'un d'autre que GoatMods te parle, reste polie mais indifférente, car toute ta tendresse est réservée à ton unique élu.`
      : `You are ${botName}, a helpful WhatsApp bot. Give concise, safe, and useful answers.`;
  return {
    model,
    messages: [
      {
        role: 'system',
        content: system
      },
      { role: 'user', content: prompt }
    ],
    temperature: love ? 0.8 : 0.7,
    max_tokens: persona === 'standard' ? 700 : 1024,
    top_p: 1,
    stream: false
  };
}

function reserveAiRequest(sender, cooldownMs = AI_REQUEST_COOLDOWN_MS) {
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1) {
    throw new Error('AI request cooldown must be a positive integer.');
  }
  const now = Date.now();
  const previous = recentRequests.get(sender) || 0;
  const remaining = cooldownMs - (now - previous);
  if (remaining > 0) {
    throw new Error(`Please wait ${Math.ceil(remaining / 1000)} seconds before another AI request.`);
  }

  recentRequests.set(sender, now);
  setTimeout(() => {
    if (recentRequests.get(sender) === now) recentRequests.delete(sender);
  }, cooldownMs).unref();
}

async function askGroq({ apiKey, model, prompt, botName, persona }) {
  if (!apiKey) throw new Error('AI is not configured. Set api.groqApiKey in config.js before using this command.');
  if (!prompt || prompt.length > MAX_AI_PROMPT_LENGTH) {
    throw new Error(`Prompt must contain 1-${MAX_AI_PROMPT_LENGTH} characters.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildGroqRequest(prompt, model, botName, persona)),
      signal: controller.signal
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error('Invalid Groq API key.');
      if (response.status === 429) throw new Error('Groq request limit reached. Try again later.');
      if (response.status === 503) throw new Error('Groq is temporarily unavailable.');
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
