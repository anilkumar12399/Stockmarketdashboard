// server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const yahooFinance = require('yahoo-finance2').default;
const axios = require('axios');
const { Pool } = require('pg'); // NEW: PostgreSQL driver
const { defaultSymbols, fnoSymbols } = require('./config');
const Agent = require('agentkeepalive');
const CircuitBreaker = require('opossum');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const PORT = process.env.PORT || 3001;

// --- Service URLs ---
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:5000/analyze';
const PYTHON_HEALTH_URL = 'http://localhost:5000/health';
const HISTORICAL_DAYS = 100;

// --- Connection Agents & Circuit Breaker ---
const pythonApiAgent = new Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 10, timeout: 60000, freeSocketTimeout: 30000 });
const pythonApiClient = axios.create({ httpAgent: pythonApiAgent });
const breakerOptions = { timeout: 15000, errorThresholdPercentage: 50, resetTimeout: 30000 };
const pythonApiRequestFn = (payload) => pythonApiClient.post(PYTHON_API_URL, payload);
const pythonApiBreaker = new CircuitBreaker(pythonApiRequestFn, breakerOptions);

let db;
let isPythonServiceHealthy = false;

// --- NEW: PostgreSQL Database Setup ---
async function setupDatabase() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.warn('WARNING: DATABASE_URL environment variable is not set. Watchlist and custom strategies will not work.');
        db = null;
        return;
    }

    db = new Pool({
        connectionString,
        ssl: {
            rejectUnauthorized: false // Required for Render's internal connections
        }
    });

    try {
        await db.query('SELECT NOW()');
        console.log('PostgreSQL Database connected successfully.');

        await db.query(`
            CREATE TABLE IF NOT EXISTS watchlists (
                userId TEXT NOT NULL,
                symbol TEXT NOT NULL,
                PRIMARY KEY (userId, symbol)
            );
        `);
        await db.query(`
            CREATE TABLE IF NOT EXISTS strategies (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                field TEXT NOT NULL,
                operator TEXT NOT NULL,
                value REAL NOT NULL,
                signal TEXT NOT NULL
            );
        `);
        console.log('Database schema ensured.');
    } catch (err) {
        console.error('CRITICAL: Failed to connect or setup PostgreSQL database.', err);
        db = null;
    }
}

// --- App Initialization ---
async function initialize() {
    await setupDatabase();
    console.log('[Health Check] Performing initial check on Python analysis service...');
    checkPythonServiceHealth();
}

initialize().catch(console.error);

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- API Endpoints ---

app.get('/api/watchlist/:userId', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available.' });
    const { userId } = req.params;
    try {
        const result = await db.query('SELECT symbol FROM watchlists WHERE userId = $1', [userId]);
        res.json(result.rows.map(s => s.symbol));
    } catch (error) {
        console.error(`Error fetching watchlist for ${userId}:`, error);
        res.status(500).json({ error: 'Failed to fetch watchlist.' });
    }
});

app.post('/api/watchlist/:userId', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available.' });
    const { userId } = req.params;
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Symbol is required.' });
    try {
        await db.query('INSERT INTO watchlists (userId, symbol) VALUES ($1, $2) ON CONFLICT (userId, symbol) DO NOTHING', [userId, symbol]);
        res.status(201).json({ message: 'Symbol added to watchlist.' });
        fetchAndEmitStockUpdates();
    } catch (error) {
        console.error(`Error adding to watchlist for ${userId}:`, error);
        res.status(500).json({ error: 'Failed to add symbol to watchlist.' });
    }
});

app.delete('/api/watchlist/:userId/:symbol', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available.' });
    const { userId, symbol } = req.params;
    try {
        await db.query('DELETE FROM watchlists WHERE userId = $1 AND symbol = $2', [userId, symbol]);
        res.status(200).json({ message: 'Symbol removed from watchlist.' });
        fetchAndEmitStockUpdates();
    } catch (error) {
        console.error(`Error removing from watchlist for ${userId}:`, error);
        res.status(500).json({ error: 'Failed to remove symbol from watchlist.' });
    }
});

app.get('/api/strategies', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available.' });
    try {
        const result = await db.query('SELECT * FROM strategies ORDER BY name');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching strategies:', error);
        res.status(500).json({ error: 'Failed to fetch strategies.' });
    }
});

app.post('/api/strategies', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available.' });
    const { name, field, operator, value, signal } = req.body;
    if (!name || !field || !operator || value === undefined || !signal) return res.status(400).json({ error: 'All strategy fields are required.' });
    try {
        const result = await db.query(
            'INSERT INTO strategies (name, field, operator, value, signal) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [name, field, operator, value, signal]
        );
        res.status(201).json({ id: result.rows[0].id, ...req.body });
    } catch (error) {
        console.error('Error creating strategy:', error);
        res.status(500).json({ error: 'Failed to create strategy.' });
    }
});

app.delete('/api/strategies/:id', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not available.' });
    const { id } = req.params;
    await db.query('DELETE FROM strategies WHERE id = $1', [id]);
    res.status(200).json({ message: 'Strategy deleted.' });
});

app.get('/api/search', async (req, res) => {
    const query = req.query.query;
    if (!query) {
        return res.status(400).json({ error: 'Search query is required.' });
    }
    try {
        const searchResult = await yahooFinance.search(query);
        const symbols = searchResult.quotes.map(q => q.symbol);
        if (symbols.length === 0) return res.json([]);
        const quoteData = await yahooFinance.quote(symbols);
        const quotes = Array.isArray(quoteData) ? quoteData : [quoteData];
        const mappedData = quotes.filter(stock => stock).map(stock => ({
            symbol: stock.symbol,
            name: stock.longName || stock.shortName,
            price: stock.regularMarketPrice,
            change: stock.regularMarketChangePercent,
            currency: stock.currency
        }));
        res.json(mappedData);
    } catch (error) {
        console.error('Error in /api/search:', error);
        res.status(500).json({ error: 'Failed to search for stocks.' });
    }
});

// --- Core Application Logic ---

async function getCombinedTrackedSymbols() {
    const allTrackedSymbols = new Set(defaultSymbols);
    if (db) {
        try {
            const result = await db.query('SELECT DISTINCT symbol FROM watchlists');
            result.rows.forEach(row => allTrackedSymbols.add(row.symbol));
        } catch (error) {
            console.error('Could not get distinct symbols from DB:', error);
        }
    }
    return Array.from(allTrackedSymbols);
}

async function fetchAndEmitStockUpdates() {
    console.log("[DEBUG] Starting fetchAndEmitStockUpdates...");
    if (!isPythonServiceHealthy) {
        console.log(`[${new Date().toISOString()}] Skipping scan: Python service is offline.`);
        io.emit('scanStatus', { message: `Scan paused: Analysis service is offline.`, step: 'error' });
        return;
    }
    const symbolsToFetch = await getCombinedTrackedSymbols();
    if (symbolsToFetch.length === 0) {
        console.log(`[${new Date().toISOString()}] No symbols to track. Skipping scan.`);
        return;
    }
    console.log(`[${new Date().toISOString()}] Starting unified scan for ${symbolsToFetch.length} symbols...`);
    try {
        let strategies = [];
        if (db) {
            console.log("[DEBUG] Step 1: Getting strategies from DB...");
            const result = await db.query('SELECT * FROM strategies');
            strategies = result.rows;
        } else {
            console.log("[DEBUG] Step 1: Skipping strategies (DB not available)...");
        }

        console.log("[DEBUG] Step 2: Fetching all quotes...");
        const quotesMap = await fetchQuotes(symbolsToFetch);
        console.log("[DEBUG] Step 3: Fetching all historical data...");
        const historicalDataMap = await fetchAllHistoricalData(symbolsToFetch);
        console.log("[DEBUG] Step 4: Analyzing all stocks...");
        const mappedData = await analyzeAllStocks(symbolsToFetch, quotesMap, historicalDataMap, strategies);
        console.log("[DEBUG] Step 5: Aggregating custom strategy results...");
        let customStrategyResults = {};
        mappedData.forEach(stockData => {
            stockData.customStrategyMatches.forEach(match => {
                if (!customStrategyResults[match.name]) {
                    customStrategyResults[match.name] = { type: match.type, stocks: [] };
                }
                customStrategyResults[match.name].stocks.push(stockData);
            });
        });
        console.log("[DEBUG] Step 6: Sorting and slicing custom strategy results...");
        for (const strategyName in customStrategyResults) {
            customStrategyResults[strategyName].stocks = customStrategyResults[strategyName].stocks
                .sort((a, b) => (b.change || 0) - (a.change || 0))
                .slice(0, 10);
        }
        console.log("[DEBUG] Step 7: Finding top buys and sells...");
        const topBuys = mappedData.filter(stock => stock.recommendedSignal === 'STRONG BUY').sort((a, b) => (a.rsi || 100) - (b.rsi || 100)).slice(0, 5);
        const topSells = mappedData.filter(stock => stock.recommendedSignal === 'STRONG SELL').sort((a, b) => (b.rsi || 0) - (a.rsi || 0)).slice(0, 5);
        const topRecommendations = { buys: topBuys, sells: topSells };
        console.log("[DEBUG] Step 8: Calculating fast volume accumulators...");
        const fastVolumeAccumulators = getFastVolumeAccumulators(mappedData, fnoSymbols);
        console.log("[DEBUG] Step 9: Broadcasting updates to clients...");
        io.emit('stockUpdate', mappedData);
        io.emit('topRecommendationsUpdate', topRecommendations);
        io.emit('customStrategiesUpdate', { strategies: customStrategyResults, timestamp: new Date().toISOString() });
        io.emit('fastVolumeAccumulatorsUpdate', fastVolumeAccumulators);
        io.emit('scanStatus', { message: 'Scan complete. Broadcasting updates.', step: 'done' });
        console.log(`[${new Date().toISOString()}] Unified scan complete. All data sent to clients.`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in fetchAndEmitStockUpdates:`, error.message);
        io.emit('scanStatus', { message: `Scan failed: ${error.message}`, step: 'error' });
    }
}

// --- Main Update Loops ---
setInterval(checkPythonServiceHealth, 30000);
setInterval(fetchAndEmitStockUpdates, 60000);

io.on('connection', (socket) => {
    console.log('A user connected via WebSocket:', socket.id);
    socket.emit('pythonHealthUpdate', { isHealthy: isPythonServiceHealthy });
    setTimeout(() => { fetchAndEmitStockUpdates(); }, 1000);
    socket.on('disconnect', () => { console.log('User disconnected:', socket.id); });
});

server.listen(PORT, () => {
    console.log(`Stock API server is running on port ${PORT}`);
});

// ... (utility functions like promiseWithTimeout, analyzeWithPythonService, etc. need to be included here)
// NOTE: The following functions are copied from the previous version of the file.

function promiseWithTimeout(promise, ms, timeoutError = new Error('Promise timed out')) {
    const timeout = new Promise((_, reject) => {
        const id = setTimeout(() => {
            clearTimeout(id);
            reject(timeoutError);
        }, ms);
    });
    return Promise.race([promise, timeout]);
}

async function analyzeWithPythonService(stockQuote, history, strategies) {
    try {
        const payload = {
            quote: stockQuote,
            history: history.map(h => ({ date: h.date, open: h.open, high: h.high, low: h.low, close: h.close, volume: h.volume })),
            strategies: strategies
        };
        const response = await pythonApiBreaker.fire(payload);
        return response.data;
    } catch (error) {
        if (error.code !== 'EOPENBREAKER') {}
        return null;
    }
}

function getFastVolumeAccumulators(allStocks, fnoSymbols) {
    const fnoStocks = allStocks.filter(s => fnoSymbols.has(s.symbol));
    const scoredStocks = fnoStocks
        .map(stock => {
            const priceChange = stock.change || 0;
            const volume = stock.volume;
            const avgVolume = stock.indicators?.avgVolume20;
            if (priceChange <= 0 || !volume || !avgVolume || avgVolume === 0) {
                return { ...stock, score: -1 };
            }
            const volumeRatio = volume / avgVolume;
            const score = (volumeRatio * 0.7) + (priceChange * 0.3);
            return { ...stock, score };
        })
        .filter(stock => stock.score > 0)
        .sort((a, b) => b.score - a.score);
    return scoredStocks.slice(0, 5);
}

async function fetchQuotes(symbolsToFetch) {
    console.log(`[${new Date().toISOString()}] Step 1: Fetching quotes for ${symbolsToFetch.length} symbols...`);
    try {
        const quoteResults = await promiseWithTimeout(yahooFinance.quote(symbolsToFetch), 20000, new Error('Yahoo Finance quote API call timed out'));
        const quotes = Array.isArray(quoteResults) ? quoteResults : [quoteResults];
        const quotesMap = new Map(quotes.filter(q => q).map(q => [q.symbol, q]));
        console.log(`[${new Date().toISOString()}] Step 1: Successfully fetched ${quotesMap.size} quotes.`);
        return quotesMap;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Step 1 Failed: Error fetching quotes.`, error.message);
        throw error;
    }
}

async function fetchAllHistoricalData(symbolsToFetch) {
    console.log(`[${new Date().toISOString()}] Step 2: Fetching historical data for ${symbolsToFetch.length} symbols...`);
    try {
        const allHistoricalData = [];
        const CHUNK_SIZE = 25;
        for (let i = 0; i < symbolsToFetch.length; i += CHUNK_SIZE) {
            const chunk = symbolsToFetch.slice(i, i + CHUNK_SIZE);
            console.log(`[Unified Scan] Fetching historical data for chunk ${Math.floor(i / CHUNK_SIZE) + 1}... (${chunk.length} symbols)`);
            const historicalDataPromises = chunk.map(async (symbol) => {
                const fromDate = new Date();
                fromDate.setDate(fromDate.getDate() - HISTORICAL_DAYS);
                for (let attempt = 1; attempt <= 2; attempt++) {
                    try {
                        return await yahooFinance.historical(symbol, { period1: fromDate, interval: '1d' });
                    } catch (err) {
                        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
                        else console.error(`All retries failed for ${symbol}. Final error:`, err.message);
                    }
                }
                return [];
            });
            try {
                const chunkResults = await promiseWithTimeout(Promise.all(historicalDataPromises), 20000, new Error(`Yahoo Finance historical data API call timed out for chunk starting with ${chunk[0]}`));
                allHistoricalData.push(...chunkResults);
            } catch (error) {
                console.error(error.message);
                allHistoricalData.push(...new Array(chunk.length).fill([]));
            }
            if (i + CHUNK_SIZE < symbolsToFetch.length) await new Promise(resolve => setTimeout(resolve, 250));
        }
        const historicalDataMap = new Map(symbolsToFetch.map((symbol, i) => [symbol, allHistoricalData[i] || []]));
        console.log(`[${new Date().toISOString()}] Step 2: Successfully fetched historical data.`);
        return historicalDataMap;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Step 2 Failed: Error fetching historical data.`, error.message);
        throw error;
    }
}

async function analyzeAllStocks(symbolsToFetch, quotesMap, historicalDataMap, strategies) {
    console.log(`[${new Date().toISOString()}] Step 3: Analyzing ${symbolsToFetch.length} symbols in chunks...`);
    try {
        const allAnalyzedData = [];
        const CHUNK_SIZE = 10;
        for (let i = 0; i < symbolsToFetch.length; i += CHUNK_SIZE) {
            const chunk = symbolsToFetch.slice(i, i + CHUNK_SIZE);
            console.log(`[Unified Scan] Analyzing chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(symbolsToFetch.length / CHUNK_SIZE)}... (${chunk.length} symbols)`);
            const analysisPromises = chunk.map(async (symbol) => {
                try {
                    const stockQuote = quotesMap.get(symbol);
                    if (!stockQuote) return null;
                    const history = historicalDataMap.get(symbol);
                    if (!history || history.length === 0) return null;
                    const analysisResult = await analyzeWithPythonService(stockQuote, history, strategies);
                    if (!analysisResult) return null;
                    const { indicators, recommendedSignal, signal, customStrategyMatches } = analysisResult;
                    return { symbol: stockQuote.symbol, name: stockQuote.longName || stockQuote.shortName, price: stockQuote.regularMarketPrice, change: stockQuote.regularMarketChangePercent, volume: stockQuote.regularMarketVolume, fiftyTwoWeekLow: stockQuote.fiftyTwoWeekLow, fiftyTwoWeekHigh: stockQuote.fiftyTwoWeekHigh, currency: stockQuote.currency, rsi: indicators ? indicators.rsi : null, indicators: indicators, signal: signal, recommendedSignal: recommendedSignal, history: history.slice(-30).map(h => ({ date: h.date, close: h.close })), customStrategyMatches: customStrategyMatches || [] };
                } catch (e) {
                    console.error(`[Robustness] Error processing symbol ${symbol}: ${e.message}.`);
                    return null;
                }
            });
            const chunkResults = await Promise.all(analysisPromises);
            allAnalyzedData.push(...chunkResults.filter(data => data !== null));
            if (i + CHUNK_SIZE < symbolsToFetch.length) await new Promise(resolve => setTimeout(resolve, 250));
        }
        console.log(`[${new Date().toISOString()}] Step 3: Successfully analyzed ${allAnalyzedData.length} symbols.`);
        return allAnalyzedData;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Step 3 Failed: Error during analysis phase.`, error.message);
        throw error;
    }
}

server.on('error', (error) => {
    if (error.syscall !== 'listen') throw error;
    switch (error.code) {
        case 'EACCES':
            console.error(`Port ${PORT} requires elevated privileges.`);
            process.exit(1);
            break;
        case 'EADDRINUSE':
            console.error(`Port ${PORT} is already in use.`);
            process.exit(1);
            break;
        default:
            throw error;
    }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});