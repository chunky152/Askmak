const db = require('../config/db');
const storage = require('./storage');
const { getOpenAI, hasOpenAIKey } = require('./openaiClient');

async function generateEmbedding(text) {
    const openai = getOpenAI();
    const response = await openai.embeddings.create({
        model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
        input: text.substring(0, 8000)
    });
    return response.data[0].embedding;
}

async function generateEmbeddings(texts) {
    const openai = getOpenAI();
    const batches = [];
    for (let i = 0; i < texts.length; i += 100) {
        batches.push(texts.slice(i, i + 100));
    }

    const results = [];
    for (const batch of batches) {
        const response = await openai.embeddings.create({
            model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
            input: batch.map(t => t.substring(0, 8000))
        });
        results.push(...response.data.map(d => d.embedding));
    }
    return results;
}

async function vectorSearch(query, options = {}) {
    if (!hasOpenAIKey()) {
        return [];
    }
    const embedding = await generateEmbedding(query);
    const embeddingStr = '[' + embedding.join(',') + ']';

    let sql = `
        SELECT id, title, content, source_url, category, image_keys, metadata,
               1 - (embedding <=> $1::vector) AS similarity
        FROM documents
        WHERE embedding IS NOT NULL
    `;
    const params = [embeddingStr];
    let paramIdx = 2;

    if (options.category) {
        sql += ` AND category = $${paramIdx}`;
        params.push(options.category);
        paramIdx++;
    }

    sql += ` ORDER BY embedding <=> $1::vector LIMIT $${paramIdx}`;
    params.push(options.limit || 5);

    const result = await db.query(sql, params);
    return result.rows;
}

async function fullTextSearch(query, options = {}) {
    const tsQuery = query.split(/\s+/).filter(Boolean).join(' & ');

    let sql = `
        SELECT id, title, content, source_url, category, image_keys, metadata,
               ts_rank(tsv, to_tsquery('english', $1)) AS rank
        FROM documents
        WHERE tsv @@ to_tsquery('english', $1)
    `;
    const params = [tsQuery];
    let paramIdx = 2;

    if (options.category) {
        sql += ` AND category = $${paramIdx}`;
        params.push(options.category);
        paramIdx++;
    }

    sql += ` ORDER BY rank DESC LIMIT $${paramIdx}`;
    params.push(options.limit || 5);

    const result = await db.query(sql, params);
    return result.rows;
}

function retrievalStrength(doc) {
    if (doc.vectorSimilarity != null && doc.vectorSimilarity > 0) {
        return doc.vectorSimilarity;
    }
    if (doc.ftsRank != null && doc.ftsRank > 0) {
        return Math.min(1, doc.ftsRank * 5);
    }
    if (doc.score != null) {
        return Math.min(1, Math.max(0, doc.score));
    }
    return 0;
}

async function hybridSearch(query, options = {}) {
    const threshold = options.minScore != null
        ? options.minScore
        : parseFloat(process.env.RAG_MIN_RETRIEVAL_SCORE || '0.22');

    const [vectorResults, textResults] = await Promise.all([
        vectorSearch(query, options),
        fullTextSearch(query, options).catch(() => [])
    ]);

    const seen = new Map();
    const vlen = Math.max(vectorResults.length, 1);

    vectorResults.forEach((doc, idx) => {
        const rankBoost = 1 - idx / vlen;
        seen.set(doc.id, {
            ...doc,
            vectorSimilarity: doc.similarity,
            ftsRank: null,
            score: (doc.similarity || 0) * 0.7 + rankBoost * 0.3
        });
    });

    textResults.forEach((doc, idx) => {
        const rnk = doc.rank || 0;
        if (seen.has(doc.id)) {
            const existing = seen.get(doc.id);
            existing.ftsRank = rnk;
            existing.score += rnk * 0.3;
        } else {
            seen.set(doc.id, {
                ...doc,
                vectorSimilarity: null,
                ftsRank: rnk,
                score: rnk * 0.5
            });
        }
    });

    const results = Array.from(seen.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit || 5);

    let bestStrength = 0;
    for (const doc of results) {
        const s = retrievalStrength(doc);
        if (s > bestStrength) bestStrength = s;
    }

    const passedThreshold = results.length > 0 && bestStrength >= threshold;

    for (const doc of results) {
        if (doc.image_keys && doc.image_keys.length) {
            doc.image_urls = await Promise.all(
                doc.image_keys.map(key =>
                    storage.getPresignedUrl(process.env.MINIO_BUCKET_DOCUMENTS, key).catch(() => null)
                )
            );
        }
    }

    return {
        documents: results,
        retrieval: {
            bestStrength,
            passedThreshold,
            threshold,
            query
        }
    };
}

function expandAbbreviations(query) {
    const abbrevs = {
        'cobams': 'College of Business and Management Sciences',
        'cedat': 'College of Engineering Design Art and Technology',
        'chs': 'College of Health Sciences',
        'chuss': 'College of Humanities and Social Sciences',
        'cocis': 'College of Computing and Information Sciences',
        'caes': 'College of Agricultural and Environmental Sciences',
        'conas': 'College of Natural Sciences',
        'covab': 'College of Veterinary Medicine Animal Resources and Biosecurity',
        'school of law': 'School of Law',
        'acmis': 'Academic Management Information System',
        'prn': 'Payment Reference Number',
        'mak': 'Makerere University'
    };

    let expanded = query;
    for (const [abbr, full] of Object.entries(abbrevs)) {
        const regex = new RegExp('\\b' + abbr + '\\b', 'gi');
        if (regex.test(expanded)) {
            expanded = expanded + ' ' + full;
        }
    }
    return expanded;
}

function formatContextForLLM(docs, retrieval = {}) {
    const { passedThreshold = true, bestStrength = 0, threshold = 0 } = retrieval;
    const lowConfidence = !docs.length || !passedThreshold;
    const strengthNote = `best match strength ${(bestStrength || 0).toFixed(2)} (threshold ${(threshold || 0).toFixed(2)})`;

    let preamble = '';
    if (lowConfidence) {
        preamble =
            `IMPORTANT — Retrieval ${docs.length ? 'is weak' : 'returned no chunks'} (${strengthNote}). ` +
            'Do not invent fees, dates, or policies. If you lack solid KB support, say so and point users to official Makerere pages or offices.\n\n';
    }

    if (!docs.length) {
        return preamble + 'No relevant documents were retrieved from the knowledge base for this query.';
    }

    const body = docs.map((doc, i) => {
        let block = `[Source ${i + 1}: ${doc.title || 'Untitled'}]\n${doc.content}`;
        if (doc.source_url) block += `\nURL: ${doc.source_url}`;
        return block;
    }).join('\n\n---\n\n');

    return preamble + body;
}

module.exports = {
    generateEmbedding, generateEmbeddings, vectorSearch, fullTextSearch,
    hybridSearch, expandAbbreviations, formatContextForLLM, retrievalStrength
};
