const db = require('../config/db');
const { getOpenAI } = require('./openaiClient');

async function extractMemories(userId, userMessage, assistantMessage) {
    if (!userId) return;

    try {
        const response = await getOpenAI().chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: `Extract factual information about the user from this conversation exchange. Return a JSON array of objects with "key" and "value" fields. Only extract concrete facts like: program/course of study, year of study, hall of residence, faculty, college, interests, home district. If nothing personal is revealed, return an empty array []. Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `User said: "${userMessage}"\nAssistant replied: "${assistantMessage}"`
                }
            ],
            max_tokens: 200,
            response_format: { type: 'json_object' }
        });

        let parsed;
        try {
            parsed = JSON.parse(response.choices[0].message.content);
        } catch {
            return;
        }

        const facts = parsed.memories || parsed.facts || parsed;
        if (!Array.isArray(facts)) return;

        for (const fact of facts) {
            if (!fact.key || !fact.value) continue;

            const existing = await db.query(
                'SELECT id FROM user_memories WHERE user_id = $1 AND memory_key = $2',
                [userId, fact.key]
            );

            if (existing.rows.length) {
                await db.query(
                    'UPDATE user_memories SET memory_value = $1, updated_at = NOW() WHERE user_id = $2 AND memory_key = $3',
                    [fact.value, userId, fact.key]
                );
            } else {
                await db.query(
                    'INSERT INTO user_memories (user_id, memory_key, memory_value) VALUES ($1, $2, $3)',
                    [userId, fact.key, fact.value]
                );
            }
        }
    } catch (err) {
        console.error('Memory extraction failed:', err.message);
    }
}

async function summarizeHistory(messages) {
    if (messages.length <= 10) return messages;

    const older = messages.slice(0, -8);
    const recent = messages.slice(-8);

    try {
        const response = await getOpenAI().chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Summarize this conversation history in 2-3 sentences, preserving key facts and context.' },
                { role: 'user', content: older.map(m => `${m.role}: ${m.content}`).join('\n') }
            ],
            max_tokens: 200
        });

        return [
            { role: 'system', content: 'Previous conversation summary: ' + response.choices[0].message.content },
            ...recent
        ];
    } catch {
        return messages.slice(-8);
    }
}

module.exports = { extractMemories, summarizeHistory };
