const OpenAI = require('openai');

let cached = null;

function getOpenAI() {
    const key = process.env.OPENAI_API_KEY;
    if (typeof key !== 'string' || !key.trim()) {
        const err = new Error(
            'OPENAI_API_KEY is not set. Add it to your .env file to use chat, embeddings, and related features.'
        );
        err.code = 'OPENAI_CONFIG';
        throw err;
    }
    if (!cached) {
        cached = new OpenAI({ apiKey: key.trim() });
    }
    return cached;
}

function hasOpenAIKey() {
    return typeof process.env.OPENAI_API_KEY === 'string' && Boolean(process.env.OPENAI_API_KEY.trim());
}

module.exports = { getOpenAI, hasOpenAIKey };
