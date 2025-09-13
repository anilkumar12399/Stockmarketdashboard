// server.js

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const yahooFinance = require('yahoo-finance2').default;
const axios = require('axios'); // NEW: For making HTTP requests to the Python service
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { defaultSymbols, fnoSymbols } = require('./config'); // Centralized configuration for symbols
const Agent = require('agentkeepalive'); // NEW: For robust keep-alive connections
const CircuitBreaker = require('opossum'); // NEW: For circuit breaker pattern

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity
        methods: ["GET", "POST"]
    }
});
const PORT = process.env.PORT || 3001;

// --- NEW: Configuration for the Python Analysis Service ---
const PYTHON_API_URL = process.env.PYTHON_API_URL || 'http://localhost:5000/analyze';
const PYTHON_HEALTH_URL = 'http://localhost:5000/health'; // NEW: Health check URL
const HISTORICAL_DAYS = 100; // Fetch 100 days of data for more accurate long-term indicators (like SMA50)

// --- NEW: Create a dedicated agent for Python service calls for performance ---
// Using agentkeepalive reuses the underlying TCP connection for multiple requests,
// which significantly reduces latency, improves speed, and handles socket timeouts better.
const pythonApiAgent = new Agent({
    keepAlive: true,
    maxSockets: 100, // Allow many concurrent connections to the Python service
    maxFreeSockets: 10,
    timeout: 60000, // Active socket timeout
    freeSocketTimeout: 30000, // Free socket timeout
});

// --- NEW: Create a dedicated axios instance for performance ---
const pythonApiClient = axios.create({ httpAgent: pythonApiAgent });

// --- NEW: Create a circuit breaker for the Python service ---
const breakerOptions = {
    timeout: 15000, // If the function does not return within 15s, trigger a failure
    errorThresholdPercentage: 50, // When 50% of requests fail, open the circuit
    resetTimeout: 30000 // After 30s, try again (half-open state).
};

// The function the breaker will wrap. It takes the POST body as an argument.
const pythonApiRequestFn = (payload) => pythonApiClient.post(PYTHON_API_URL, payload);

const pythonApiBreaker = new CircuitBreaker(pythonApiRequestFn, breakerOptions);

// --- NEW: Add logging for breaker state changes for observability ---
pythonApiBreaker.on('open', () => {
    console.error(`[Circuit Breaker] OPEN: The circuit for the Python API is now open. No more requests will be sent for ${breakerOptions.resetTimeout / 1000}s.`);
    // NEW: Update health status and notify clients
    isPythonServiceHealthy = false;
    io.emit('pythonHealthUpdate', { isHealthy: false });
    io.emit('scanStatus', { message: `Analysis service is overloaded or down. Pausing analysis...`, step: 'error' });
});
pythonApiBreaker.on('close', () => {
    console.log('[Circuit Breaker] CLOSE: The circuit for the Python API is now closed. Service has recovered.');
    // NEW: Update health status and notify clients
    isPythonServiceHealthy = true;
    io.emit('pythonHealthUpdate', { isHealthy: true });
    io.emit('scanStatus', { message: `Analysis service has recovered. Resuming analysis.`, step: 'connecting' });
});
pythonApiBreaker.on('halfOpen', () => {
    console.log('[Circuit Breaker] HALF_OPEN: The circuit is half-open. Trying one request to Python API.');
});
let db;
let isPythonServiceHealthy = false; // NEW: Track Python service health


// --- Promise Timeout Helper ---
/**
 * Wraps a promise with a timeout. If the promise does not resolve or reject
 * within the given time, it will be rejected with a timeout error.
 * @param {Promise<T>} promise The promise to wrap.
 * @param {number} ms The timeout in milliseconds.
 * @param {Error} [timeoutError] The error to reject with on timeout.
 * @returns {Promise<T>}
 */
function promiseWithTimeout(promise, ms, timeoutError = new Error('Promise timed out')) {
    const timeout = new Promise((_, reject) => {
        const id = setTimeout(() => {
            clearTimeout(id);
            reject(timeoutError);
        }, ms);
    });
    return Promise.race([promise, timeout]);
}

// --- NEW: Python Service Health Check ---
/**
 * Periodically checks the health of the Python analysis service.
 * Updates the `isPythonServiceHealthy` state and logs status changes.
 */
async function checkPythonServiceHealth() {
    try {
        // Use the existing pythonApiClient which benefits from keep-alive connections
        await pythonApiClient.get(PYTHON_HEALTH_URL, { timeout: 5000 }); // 5-second timeout for health check
        if (!isPythonServiceHealthy) {
            console.log('[Health Check] Python analysis service is now online.');
            isPythonServiceHealthy = true;
            // NEW: Notify all clients about the service status change.
            io.emit('pythonHealthUpdate', { isHealthy: true });
        }
    } catch (error) {
        if (isPythonServiceHealthy) {
            console.error(`[Health Check] Python analysis service has gone offline. Error: ${error.message}`);
            isPythonServiceHealthy = false;
            // NEW: Notify all clients about the service status change.
            io.emit('pythonHealthUpdate', { isHealthy: false });
        }
        // If it was already offline, we don't need to log every failed check to avoid spamming logs.
    }
}

// --- Database Setup ---
async function setupDatabase() {
    db = await open({
        filename: process.env.DATABASE_PATH || './database.db', // Use an env var for the path
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS watchlists (
            userId TEXT NOT NULL,
            symbol TEXT NOT NULL,
            PRIMARY KEY (userId, symbol)
        )
    `);
    await db.exec(`
        CREATE TABLE IF NOT EXISTS strategies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            field TEXT NOT NULL, -- 'price' or 'change'
            operator TEXT NOT NULL, -- '>', '<', '==', etc.
            value REAL NOT NULL,
            signal TEXT NOT NULL -- 'BUY' or 'SELL'
        )
    `);
    console.log('Database connected and schema ensured.');
}

setupDatabase()
    .then(() => {
        // NEW: Perform an initial health check on startup before starting the main loops.
        console.log('[Health Check] Performing initial check on Python analysis service...');
        checkPythonServiceHealth();
    })
    .catch(console.error);

// Use CORS middleware to allow requests from your frontend
app.use(cors());
app.use(express.json()); // Middleware to parse JSON bodies

// Serve static files (HTML, CSS, JS) from the project's root directory.
// This allows you to run `node server.js` and then open
// http://localhost:3001 in your browser to see the application.
app.use(express.static(__dirname));

// --- Watchlist API Endpoints ---

app.get('/api/watchlist/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const symbols = await db.all('SELECT symbol FROM watchlists WHERE userId = ?', userId);
        res.json(symbols.map(s => s.symbol));
    } catch (error) {
        console.error(`Error fetching watchlist for ${userId}:`, error);
        res.status(500).json({ error: 'Failed to fetch watchlist.' });
    }
});

app.post('/api/watchlist/:userId', async (req, res) => {
    const { userId } = req.params;
    const { symbol } = req.body;
    if (!symbol) {
        return res.status(400).json({ error: 'Symbol is required.' });
    }
    try {
        await db.run('INSERT OR IGNORE INTO watchlists (userId, symbol) VALUES (?, ?)', userId, symbol);
        res.status(201).json({ message: 'Symbol added to watchlist.' });
        // Trigger an immediate fetch since the tracked symbols have changed
        fetchAndEmitStockUpdates();
    } catch (error) {
        console.error(`Error adding to watchlist for ${userId}:`, error);
        res.status(500).json({ error: 'Failed to add symbol to watchlist.' });
    }
});

app.delete('/api/watchlist/:userId/:symbol', async (req, res) => {
    const { userId, symbol } = req.params;
    try {
        await db.run('DELETE FROM watchlists WHERE userId = ? AND symbol = ?', userId, symbol);
        res.status(200).json({ message: 'Symbol removed from watchlist.' });
        // Trigger an immediate fetch since the tracked symbols have changed
        fetchAndEmitStockUpdates();
    } catch (error) {
        console.error(`Error removing from watchlist for ${userId}:`, error);
        res.status(500).json({ error: 'Failed to remove symbol from watchlist.' });
    }
});

// --- Strategy API Endpoints ---

app.get('/api/strategies', async (req, res) => {
    try {
        const strategies = await db.all('SELECT * FROM strategies ORDER BY name');
        res.json(strategies);
    } catch (error) {
        console.error('Error fetching strategies:', error);
        res.status(500).json({ error: 'Failed to fetch strategies.' });
    }
});

app.post('/api/strategies', async (req, res) => {
    const { name, field, operator, value, signal } = req.body;
    if (!name || !field || !operator || value === undefined || !signal) {
        return res.status(400).json({ error: 'All strategy fields are required.' });
    }
    try {
        const result = await db.run(
            'INSERT INTO strategies (name, field, operator, value, signal) VALUES (?, ?, ?, ?, ?)',
            name, field, operator, value, signal
        );
        res.status(201).json({ id: result.lastID, ...req.body });
    } catch (error) {
        console.error('Error creating strategy:', error);
        res.status(500).json({ error: 'Failed to create strategy.' });
    }
});

app.delete('/api/strategies/:id', async (req, res) => {
    const { id } = req.params;
    await db.run('DELETE FROM strategies WHERE id = ?', id);
    res.status(200).json({ message: 'Strategy deleted.' });
});

// New endpoint for searching symbols
app.get('/api/search', async (req, res) => {
    const query = req.query.query;
    if (!query) {
        return res.status(400).json({ error: 'Search query is required.' });
    }

    try {
        // 1. Search for symbols matching the query
        const searchResult = await yahooFinance.search(query);
        const symbols = searchResult.quotes.map(q => q.symbol);

        if (symbols.length === 0) {
            return res.json([]);
        }

        // 2. Get quote data for the found symbols
        const quoteData = await yahooFinance.quote(symbols);
        const quotes = Array.isArray(quoteData) ? quoteData : [quoteData];

        // 3. Map to the format our frontend expects
        const mappedData = quotes.filter(stock => stock).map(stock => ({
            symbol: stock.symbol,
            name: stock.longName || stock.shortName,
            price: stock.regularMarketPrice,
            change: stock.regularMarketChangePercent,
            currency: stock.currency
        }));

        res.json(mappedData);
    } catch (error) {
        console.error('Full error object in /api/search:', error);
        console.error('Error in /api/search:', error);
        res.status(500).json({ error: 'Failed to search for stocks.' });
    }
});

/**
 * NEW: Calls the external Python service to get technical analysis and signals.
 * This function offloads all heavy computation to a dedicated Python process.
 * @param {object} stockQuote - The current quote data for the stock.
 * @param {Array<object>} history - The historical data for the stock.
 * @param {Array<object>} strategies - User-defined strategies from the DB.
 * @returns {Promise<object|null>} An object with indicators and signals, or null on failure.
 */
async function analyzeWithPythonService(stockQuote, history, strategies) {
    // The manual retry loop is now replaced by the circuit breaker logic.
    try {
        const payload = {
            quote: stockQuote,
            // OPTIMIZATION: Send only necessary data to reduce payload size
            history: history.map(h => ({
                date: h.date,
                open: h.open,
                high: h.high,
                low: h.low,
                close: h.close,
                volume: h.volume
            })),
            strategies: strategies // Pass user strategies to Python service as well
        };

        // Use the breaker to make the call. The breaker's options include the timeout.
        const response = await pythonApiBreaker.fire(payload);

        // The Python service should return a comprehensive analysis object
        return response.data;
    } catch (error) {
        // Opossum will throw an error if the circuit is open ('EOPENBREAKER')
        // or if the underlying function fails. We don't need to log every
        // single failure here, as the breaker's state change events are more informative and less noisy.
        // The 'open' event handler will have already set the service health status to false.
        if (error.code !== 'EOPENBREAKER') {
            // The 'open' event handler already logs when the circuit opens.
            // This block could log individual failures if needed, but it's often too verbose.
        }
        return null; // Indicate failure for this stock, allowing the main loop to continue.
    }
}

async function getCombinedTrackedSymbols() {
    const allTrackedSymbols = new Set(defaultSymbols);

    try {
        const dbSymbols = await db.all('SELECT DISTINCT symbol FROM watchlists');
        dbSymbols.forEach(row => allTrackedSymbols.add(row.symbol));
    } catch (error) {
        console.error('Could not get distinct symbols from DB:', error);
        // Fallback to defaults if DB fails
    }

    return Array.from(allTrackedSymbols);
}

/**
 * NEW: Ranks F&O stocks by a combined momentum score.
 * This strategy is designed to always produce results if there is any positive market movement.
 * @param {Array<object>} allStocks - The full list of analyzed stocks.
 * @param {Set<string>} fnoSymbols - A set of all F&O stock symbols.
 * @returns {Array<object>} The top 5 stocks based on the momentum score.
 */
function getFastVolumeAccumulators(allStocks, fnoSymbols) {
    const fnoStocks = allStocks.filter(s => fnoSymbols.has(s.symbol));

    const scoredStocks = fnoStocks
        .map(stock => {
            const priceChange = stock.change || 0;
            const volume = stock.volume;
            const avgVolume = stock.indicators?.avgVolume20;

            // Only consider stocks that are up for the day and have valid volume data
            if (priceChange <= 0 || !volume || !avgVolume || avgVolume === 0) {
                return { ...stock, score: -1 };
            }

            const volumeRatio = volume / avgVolume;
            // A simple weighted score. Emphasize volume surge (70%) over price change (30%).
            const score = (volumeRatio * 0.7) + (priceChange * 0.3);
            return { ...stock, score };
        })
        .filter(stock => stock.score > 0)
        .sort((a, b) => b.score - a.score);

    return scoredStocks.slice(0, 5); // Return top 5
}

async function fetchQuotes(symbolsToFetch) {
    console.log(`[${new Date().toISOString()}] Step 1: Fetching quotes for ${symbolsToFetch.length} symbols...`);
    try {
        const quoteResults = await promiseWithTimeout(
            yahooFinance.quote(symbolsToFetch),
            20000, // Increased timeout for larger request
            new Error('Yahoo Finance quote API call timed out')
        );
        const quotes = Array.isArray(quoteResults) ? quoteResults : [quoteResults];
        const quotesMap = new Map(quotes.filter(q => q).map(q => [q.symbol, q]));
        console.log(`[${new Date().toISOString()}] Step 1: Successfully fetched ${quotesMap.size} quotes.`);
        return quotesMap;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Step 1 Failed: Error fetching quotes.`, error.message);
        throw error; // Re-throw to be caught by the main handler
    }
}

async function fetchAllHistoricalData(symbolsToFetch) {
    console.log(`[${new Date().toISOString()}] Step 2: Fetching historical data for ${symbolsToFetch.length} symbols...`);
    try {
        const allHistoricalData = [];
        const CHUNK_SIZE = 25; // Process 25 symbols at a time

        for (let i = 0; i < symbolsToFetch.length; i += CHUNK_SIZE) {
            const chunk = symbolsToFetch.slice(i, i + CHUNK_SIZE);
            console.log(`[Unified Scan] Fetching historical data for chunk ${Math.floor(i / CHUNK_SIZE) + 1}... (${chunk.length} symbols)`);

            const historicalDataPromises = chunk.map(async(symbol) => {
                const fromDate = new Date();
                fromDate.setDate(fromDate.getDate() - HISTORICAL_DAYS);

                const maxRetries = 2;
                let lastError = null;

                for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                        // Attempt to fetch the historical data
                        const history = await yahooFinance.historical(symbol, {
                            period1: fromDate,
                            interval: '1d'
                        });
                        // If successful, return the data and exit the loop
                        return history;
                    } catch (err) {
                        lastError = err;
                        // Log a warning on failed attempts, but don't give up yet
                        console.warn(`Attempt ${attempt} failed for ${symbol}: ${err.message}`);
                        if (attempt < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 500 * attempt)); // Wait before retrying
                        }
                    }
                }
                // If all retries fail, log the final error and return an empty array.
                console.error(`All retries failed for ${symbol}. Final error:`, lastError ? lastError.message : 'Unknown error');
                return []; // Return empty array on final failure for this symbol
            });

            try {
                const chunkResults = await promiseWithTimeout(
                    Promise.all(historicalDataPromises),
                    20000, // 20-second timeout for each chunk is more reasonable
                    new Error(`Yahoo Finance historical data API call timed out for chunk starting with ${chunk[0]}`)
                );
                allHistoricalData.push(...chunkResults);
            } catch (error) {
                console.error(error.message);
                // If a chunk times out, fill with empty arrays to not break the mapping later
                const emptyResults = new Array(chunk.length).fill([]);
                allHistoricalData.push(...emptyResults);
            }

            // Add a small delay between chunks to be polite to the API
            if (i + CHUNK_SIZE < symbolsToFetch.length) {
                await new Promise(resolve => setTimeout(resolve, 250));
            }
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
        const CHUNK_SIZE = 10; // Process 10 symbols at a time for analysis

        for (let i = 0; i < symbolsToFetch.length; i += CHUNK_SIZE) {
            const chunk = symbolsToFetch.slice(i, i + CHUNK_SIZE);
            console.log(`[Unified Scan] Analyzing chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(symbolsToFetch.length / CHUNK_SIZE)}... (${chunk.length} symbols)`);

            const analysisPromises = chunk.map(async(symbol) => {
                try {
                    const stockQuote = quotesMap.get(symbol);
                    if (!stockQuote) return null;

                    const history = historicalDataMap.get(symbol);
                    if (!history || history.length === 0) return null;

                    // Call the Python service for analysis
                    const analysisResult = await analyzeWithPythonService(stockQuote, history, strategies);

                    if (!analysisResult) return null;

                    const { indicators, recommendedSignal, signal, customStrategyMatches } = analysisResult;

                    return {
                        symbol: stockQuote.symbol,
                        name: stockQuote.longName || stockQuote.shortName,
                        price: stockQuote.regularMarketPrice,
                        change: stockQuote.regularMarketChangePercent,
                        volume: stockQuote.regularMarketVolume,
                        fiftyTwoWeekLow: stockQuote.fiftyTwoWeekLow,
                        fiftyTwoWeekHigh: stockQuote.fiftyTwoWeekHigh,
                        currency: stockQuote.currency,
                        rsi: indicators ? indicators.rsi : null,
                        indicators: indicators,
                        signal: signal,
                        recommendedSignal: recommendedSignal,
                        history: history.slice(-30).map(h => ({ date: h.date, close: h.close })),
                        customStrategyMatches: customStrategyMatches || []
                    };
                } catch (e) {
                    console.error(`[Robustness] Error processing symbol ${symbol}: ${e.message}. Skipping this symbol for the current update cycle.`);
                    return null;
                }
            });

            const chunkResults = await Promise.all(analysisPromises);
            allAnalyzedData.push(...chunkResults.filter(data => data !== null));

            // Add a small delay between chunks to be polite to the Python service
            if (i + CHUNK_SIZE < symbolsToFetch.length) {
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }

        console.log(`[${new Date().toISOString()}] Step 3: Successfully analyzed ${allAnalyzedData.length} symbols.`);
        return allAnalyzedData;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Step 3 Failed: Error during analysis phase.`, error.message);
        throw error;
    }
}

// Main function to fetch and emit stock data
async function fetchAndEmitStockUpdates() {
    // NEW: Don't run the scan if the Python service is offline.
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
        // Step 1: Get user strategies from DB
        const strategies = await db.all('SELECT * FROM strategies');

        // Step 2: Fetch all quotes and historical data
        const quotesMap = await fetchQuotes(symbolsToFetch);
        const historicalDataMap = await fetchAllHistoricalData(symbolsToFetch);

        const mappedData = await analyzeAllStocks(symbolsToFetch, quotesMap, historicalDataMap, strategies);

        // --- NEW: Aggregate custom strategy results after all analyses are complete ---
        let customStrategyResults = {};
        mappedData.forEach(stockData => {
            stockData.customStrategyMatches.forEach(match => {
                if (!customStrategyResults[match.name]) {
                    customStrategyResults[match.name] = { type: match.type, stocks: [] };
                }
                customStrategyResults[match.name].stocks.push(stockData);
            });
        });

        // --- NEW: Add logging for strategy results for better debugging ---
        const totalMatches = Object.values(customStrategyResults).reduce((acc, strategy) => acc + strategy.stocks.length, 0);
        const strategiesWithMatches = Object.keys(customStrategyResults).length;
        console.log(`[Strategies] Found ${totalMatches} total stock matches across ${strategiesWithMatches} strategies.`);

        // --- Sort and slice custom strategy results (assuming Python service did not) ---
        for (const strategyName in customStrategyResults) {
            customStrategyResults[strategyName].stocks = customStrategyResults[strategyName].stocks
                .sort((a, b) => (b.change || 0) - (a.change || 0)) // Sort by highest % change
                .slice(0, 10); // Show top 10 for each strategy
        }

        // --- Find and emit top buys and sells separately ---
        const topBuys = mappedData
            .filter(stock => stock.recommendedSignal === 'STRONG BUY')
            // Sort by RSI ascending to find the most "oversold" buys first
            .sort((a, b) => (a.rsi || 100) - (b.rsi || 100))
            .slice(0, 5);

        const topSells = mappedData
            .filter(stock => stock.recommendedSignal === 'STRONG SELL')
            // Sort by RSI descending to find the most "overbought" sells first
            .sort((a, b) => (b.rsi || 0) - (a.rsi || 0))
            .slice(0, 5);

        const topRecommendations = { buys: topBuys, sells: topSells };

        // --- NEW: Calculate and find the fast volume accumulators ---
        const fastVolumeAccumulators = getFastVolumeAccumulators(mappedData, fnoSymbols);

        // Broadcast the updates to all connected clients
        io.emit('stockUpdate', mappedData);
        io.emit('topRecommendationsUpdate', topRecommendations); // New event with new structure
        io.emit('customStrategiesUpdate', { strategies: customStrategyResults, timestamp: new Date().toISOString() });
        io.emit('fastVolumeAccumulatorsUpdate', fastVolumeAccumulators);
        io.emit('scanStatus', { message: 'Scan complete. Broadcasting updates.', step: 'done' });
        console.log(`[${new Date().toISOString()}] Unified scan complete. All data sent to clients.`);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in fetchAndEmitStockUpdates:`, error.message);
        // --- IMPROVED: Simplified check for timeout errors for cleaner logging ---
        const isTimeoutError = error.message && error.message.includes('timed out');
        // Only log the full stack trace if it's not a simple, expected timeout.
        if (!isTimeoutError) { console.error('Full error object:', error); }
        console.error('Symbols in this fetch attempt:', symbolsToFetch);
        io.emit('scanStatus', { message: `Scan failed: ${error.message}`, step: 'error' });
        io.emit('fetchError', { error: 'Unified scan failed. The data provider might be temporarily unavailable.' });
    }
}

// --- Main Update Loops ---

// NEW: Periodically check the health of the Python service.
setInterval(checkPythonServiceHealth, 30000); // Check every 30 seconds

// This single, unified loop powers all features of the dashboard.
// It performs a deep analysis of the entire stock universe.
// NOTE: A 60-second interval is aggressive and may hit API rate limits. Monitor for errors.
setInterval(fetchAndEmitStockUpdates, 60000); // 60 seconds (previously 240000 for 4 minutes)

io.on('connection', (socket) => {
    console.log('A user connected via WebSocket:', socket.id);

    // NEW: Immediately send the current Python service health status to the new client.
    // This ensures the UI is correct on page load.
    socket.emit('pythonHealthUpdate', { isHealthy: isPythonServiceHealthy });

    // Immediately trigger a scan for the new client so they don't have to wait.
    // Use a small delay to allow the connection to fully establish.
    setTimeout(() => {
        fetchAndEmitStockUpdates(); // Trigger the unified scan
    }, 1000);

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// Start the server using the http server instance
server.listen(PORT, () => {
    console.log(`Stock API server is running on port ${PORT}`);
});

// --- NEW: Add robust error handling for the server itself ---
server.on('error', (error) => {
    if (error.syscall !== 'listen') {
        throw error;
    }

    // Handle specific listen errors with friendly messages
    switch (error.code) {
        case 'EACCES':
            console.error(`Port ${PORT} requires elevated privileges. Please run with sudo or as an administrator.`);
            process.exit(1);
            break;
        case 'EADDRINUSE':
            console.error(`Port ${PORT} is already in use. Please check if another instance of the server is running or close the application using this port.`);
            process.exit(1);
            break;
        default:
            throw error;
    }
});

// Add a global handler for unhandled promise rejections for better debugging and server stability.
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // In a production environment, you might want to log this to an external service.
});