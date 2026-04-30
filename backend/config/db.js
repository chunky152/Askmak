const path = require('path');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

/** Matches docker-compose.yml (Postgres on host port 5434, db name askmak). */
const DOCKER_DEFAULT_URL = 'postgresql://askmak:askmak_dev@127.0.0.1:5434/askmak';

let connectionString = process.env.DATABASE_URL;
if (typeof connectionString === 'string') {
    connectionString = connectionString.trim();
}
if (!connectionString) {
    console.warn(
        'DATABASE_URL is not set (or empty). Using Docker Compose default. ' +
            'Add DATABASE_URL to .env if you use a different database (see .env.example).'
    );
    connectionString = DOCKER_DEFAULT_URL;
}

const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
    console.error('Unexpected pool error:', err.message);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(),
    pool
};
