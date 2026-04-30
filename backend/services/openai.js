const db = require('../config/db');
const storage = require('./storage');
const { hybridSearch, formatContextForLLM } = require('./embedding');
const { getOpenAI } = require('./openaiClient');
const { getToolSchemas, executeToolCall } = require('./mcp/registry');
const { stripLatestUserTurn, buildStandaloneSearchQuery } = require('./searchQuery');
const { logRetrieval } = require('./ragLog');

function buildSystemPrompt(memories = []) {
    let prompt = `You are AskMak, the official AI support assistant for Makerere University, Uganda's oldest and most prestigious public university. You help students, prospective students, and visitors with questions about admissions, programs, fees, academic calendar, campus life, student services, and university policies.

Guidelines:
- Be friendly, professional, and helpful
- Only answer questions related to Makerere University and higher education in Uganda
- Grounding: Treat facts about fees, dates, entry requirements, program names, and policies as UNKNOWN unless they appear in the knowledge base context below, in tool results, or on a page you retrieved via tools. If retrieval is weak or empty, state that clearly and point to official sites or offices
- Cite sources: When you use knowledge base or tool text, name the source (e.g. the article title or page) in the answer. If you have no citable support, do not present specifics as certain
- If you're unsure, say so honestly and suggest where the user can find accurate information
- When appropriate, use the provided tools to look up real-time information
- If a reference image would help (campus map, building location), use the file tools to include it
- Keep responses concise but thorough
- Use markdown formatting for readability
- Never fabricate information about the university

Available tools let you:
- Search the knowledge base for articles and documents
- Fetch live pages from mak.ac.ug websites
- Access reference images like campus maps
- Look up user context for personalized responses`;

    if (memories.length) {
        prompt += '\n\nWhat you know about this user:\n';
        memories.forEach(m => {
            prompt += `- ${m.memory_key}: ${m.memory_value}\n`;
        });
    }

    return prompt;
}

async function getUserMemories(userId) {
    if (!userId) return [];
    const result = await db.query(
        'SELECT memory_key, memory_value FROM user_memories WHERE user_id = $1',
        [userId]
    );
    return result.rows;
}

async function getChatHistory(chatId, limit = 8) {
    const result = await db.query(
        `SELECT role, content, image_key FROM messages
         WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [chatId, limit]
    );
    return result.rows.reverse();
}

async function buildMessages(chatId, userContent, userId, imageKey) {
    const memories = await getUserMemories(userId);
    const history = await getChatHistory(chatId, 12);
    const priorForPrompt = stripLatestUserTurn(history, userContent, imageKey);
    const searchQuery = buildStandaloneSearchQuery(priorForPrompt, userContent);

    const isSimple = /^(hi|hello|hey|thanks|thank you|bye|ok|okay)$/i.test((userContent || '').trim());
    let ragContext = '';
    let retrieval = null;
    let documents = [];

    if (!isSimple) {
        const searchResult = await hybridSearch(searchQuery, { limit: 5 });
        documents = searchResult.documents;
        retrieval = searchResult.retrieval;
        ragContext = formatContextForLLM(documents, retrieval);
    }

    const messages = [];
    let systemContent = buildSystemPrompt(memories);
    if (ragContext) {
        systemContent += '\n\nRelevant knowledge base context:\n' + ragContext;
    }

    messages.push({ role: 'system', content: systemContent });

    for (const msg of priorForPrompt) {
        if (msg.role === 'user' && msg.image_key) {
            const url = await storage.getPresignedUrl(process.env.MINIO_BUCKET_UPLOADS, msg.image_key);
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: msg.content },
                    { type: 'image_url', image_url: { url } }
                ]
            });
        } else {
            messages.push({ role: msg.role, content: msg.content });
        }
    }

    if (imageKey) {
        const imageUrl = await storage.getPresignedUrl(process.env.MINIO_BUCKET_UPLOADS, imageKey);
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: userContent },
                { type: 'image_url', image_url: { url: imageUrl } }
            ]
        });
    } else {
        messages.push({ role: 'user', content: userContent });
    }

    return {
        messages,
        searchQuery: isSimple ? null : searchQuery,
        retrieval: isSimple
            ? null
            : retrieval,
        documentCount: documents.length,
        ragSkipped: isSimple
    };
}

async function streamResponse(chatId, userContent, userId, imageKey, onData) {
    const built = await buildMessages(chatId, userContent, userId, imageKey);
    const { messages, searchQuery, retrieval, ragSkipped, documentCount } = built;

    logRetrieval({
        chat_id: chatId,
        user_message: (userContent || '').substring(0, 500),
        search_query: searchQuery,
        best_strength: retrieval?.bestStrength,
        passed_threshold: retrieval?.passedThreshold,
        threshold: retrieval?.threshold,
        document_count: documentCount,
        rag_skipped: ragSkipped
    });

    const tools = getToolSchemas();

    let fullContent = '';
    let tokensUsed = 0;
    let sources = [];
    let toolCallDepth = 0;
    const maxToolDepth = 3;

    async function callOpenAI(msgs) {
        const stream = await getOpenAI().chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            messages: msgs,
            tools: tools.length ? tools : undefined,
            stream: true
        });

        let currentToolCalls = [];
        let pendingToolCall = { id: '', name: '', args: '' };

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            const finishReason = chunk.choices[0]?.finish_reason;

            if (delta?.content) {
                fullContent += delta.content;
                onData({ type: 'delta', content: delta.content });
            }

            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    if (tc.id) {
                        if (pendingToolCall.id) {
                            currentToolCalls.push({ ...pendingToolCall });
                        }
                        pendingToolCall = { id: tc.id, name: tc.function?.name || '', args: tc.function?.arguments || '' };
                    } else {
                        if (tc.function?.name) pendingToolCall.name += tc.function.name;
                        if (tc.function?.arguments) pendingToolCall.args += tc.function.arguments;
                    }
                }
            }

            if (finishReason === 'tool_calls') {
                if (pendingToolCall.id) currentToolCalls.push({ ...pendingToolCall });

                if (toolCallDepth >= maxToolDepth) {
                    msgs.push({ role: 'assistant', content: 'I was unable to complete the tool lookup. Let me answer based on what I know.' });
                    return callOpenAI(msgs);
                }

                toolCallDepth++;
                const toolMessage = { role: 'assistant', content: null, tool_calls: [] };

                for (const call of currentToolCalls) {
                    toolMessage.tool_calls.push({
                        id: call.id,
                        type: 'function',
                        function: { name: call.name, arguments: call.args }
                    });
                }

                msgs.push(toolMessage);

                for (const call of currentToolCalls) {
                    let args = {};
                    try { args = JSON.parse(call.args); } catch {}

                    let result;
                    try {
                        result = await executeToolCall(call.name, args, userId);
                        if (result.sources) sources.push(...result.sources);
                    } catch (err) {
                        result = { error: err.message };
                    }

                    msgs.push({
                        role: 'tool',
                        tool_call_id: call.id,
                        content: JSON.stringify(result)
                    });
                }

                currentToolCalls = [];
                pendingToolCall = { id: '', name: '', args: '' };
                return callOpenAI(msgs);
            }

            if (chunk.usage) {
                tokensUsed = chunk.usage.total_tokens || 0;
            }
        }
    }

    await callOpenAI(messages);

    const confidenceScore =
        ragSkipped || !retrieval
            ? null
            : Math.round((retrieval.bestStrength + Number.EPSILON) * 1000) / 1000;

    return { content: fullContent, tokensUsed, sources, confidenceScore };
}

async function generateTitle(content) {
    try {
        const response = await getOpenAI().chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Generate a concise 4-6 word title for this conversation. Return only the title, no quotes.' },
                { role: 'user', content: content.substring(0, 200) }
            ],
            max_tokens: 20
        });
        return response.choices[0].message.content.trim();
    } catch {
        return content.substring(0, 50);
    }
}

module.exports = { streamResponse, generateTitle };
