// config.js

/**
 * A curated list of default symbols for initial scanning.
 * This list includes major indices and a broad selection of large, mid, and small-cap stocks
 * from the Indian market (NSE/BSE) to provide a comprehensive market overview.
 */
const defaultSymbols = new Set([
    // Indices
    '^NSEI',
    'RELIANCE.NS',
]);

/**
 * A set of symbols for stocks that are part of the Futures and Options (F&O) segment.
 * This is used by specific strategies that target high-volume, high-volatility stocks.
 */
const fnoSymbols = new Set([
    'RELIANCE.NS'
]);

// Ensure all F&O symbols are included in the default tracking universe so their data is always fetched.
// fnoSymbols.forEach(symbol => defaultSymbols.add(symbol)); // Temporarily disabled for debugging

module.exports = {
    defaultSymbols,
    fnoSymbols
};