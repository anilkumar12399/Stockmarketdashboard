// script.js

document.addEventListener('DOMContentLoaded', () => {
    let socket; // Will be initialized in initializeDashboard

    const watchlist = document.getElementById('watchlist');
    const stockInfo = document.getElementById('stock-info');
    const searchInput = document.getElementById('search');
    const stockTableBody = document.querySelector('#stock-table tbody');
    const strategyForm = document.getElementById('strategy-form');
    const recommendationsBuyTableBody = document.querySelector('#recommendations-buy-table-body');
    const recommendationsSellTableBody = document.querySelector('#recommendations-sell-table-body');
    const statusDisplay = document.getElementById('connection-status');
    const volumePriceTableBody = document.querySelector('#volume-price-table-body');
    const fastAccumulatorsTableBody = document.querySelector('#fast-accumulators-table-body');
    const strategyList = document.getElementById('strategy-list');

    // --- NEW: Define the backend URL and a user ID ---
    const BACKEND_URL = ''; // Use relative paths to connect to the same host
    const userId = 'default-user'; // In a real app, this would be dynamic

    let watchlistSymbols = []; // Now just an array of symbols
    let savedStrategies = [];
    let currentlySelectedSymbol = null; // NEW: Track the currently displayed stock

    // --- Strategy Management ---

    // Use a Map for allStocks for efficient updates and avoiding duplicates
    // Key: symbol, Value: stock object
    const allStocks = new Map();

    // Helper to convert allStocks Map to an array for display
    function getAllStocksArray() {
        return Array.from(allStocks.values());
    }

    // --- NEW: Watchlist API Functions ---
    async function fetchWatchlist() {
        try {
            const response = await fetch(`${BACKEND_URL}/api/watchlist/${userId}`);
            if (!response.ok) throw new Error('Failed to fetch watchlist');
            watchlistSymbols = await response.json();
            console.log('Fetched watchlist:', watchlistSymbols);
        } catch (error) {
            console.error("Error fetching watchlist:", error);
            updateStatus('Could not load watchlist.', 'error');
        }
    }

    async function addToWatchlist(symbol) {
        try {
            const response = await fetch(`${BACKEND_URL}/api/watchlist/${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol }),
            });
            if (!response.ok) throw new Error('Failed to add to watchlist');
            if (!watchlistSymbols.includes(symbol)) {
                watchlistSymbols.push(symbol);
            }
            updateWatchlistDisplay();
            updateStockTable(); // Refresh table to show 'Remove' button
        } catch (error) {
            console.error(`Error adding ${symbol} to watchlist:`, error);
            updateStatus(`Failed to add ${symbol} to watchlist.`, 'error');
        }
    }

    async function removeFromWatchlist(symbol) {
        try {
            const response = await fetch(`${BACKEND_URL}/api/watchlist/${userId}/${symbol}`, {
                method: 'DELETE',
            });
            if (!response.ok) throw new Error('Failed to remove from watchlist');
            watchlistSymbols = watchlistSymbols.filter(s => s !== symbol);
            updateWatchlistDisplay();
            updateStockTable(); // Refresh table to show 'Add' button
        } catch (error) {
            console.error(`Error removing ${symbol} from watchlist:`, error);
            updateStatus(`Failed to remove ${symbol} from watchlist.`, 'error');
        }
    }

    // Helper to format price with the correct currency symbol (e.g., $ or ₹)
    function formatPrice(price, currency) {
        const options = {
            style: 'currency',
            currency: currency || 'USD', // Default to USD if currency is not provided
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        };
        // Intl.NumberFormat is a standard browser API for currency formatting.
        // It will use the correct symbol (e.g., ₹ for INR) based on the currency code.
        return new Intl.NumberFormat('en-US', options).format(price || 0);
    }

    // --- NEW: Helper to format indicator values ---
    function formatIndicator(value, precision = 2) {
        // Check for null, undefined, or NaN
        if (value === null || typeof value === 'undefined' || isNaN(value)) {
            return '---';
        }
        return Number(value).toFixed(precision);
    }

    function displayStockInfo(stock) {
        const changeClass = stock.change >= 0 ? 'positive' : 'negative';
        currentlySelectedSymbol = stock.symbol; // Set the currently selected symbol
        stockInfo.innerHTML = `
            <h3>${stock.name} (${stock.symbol})</h3>
            <p>Price: ${formatPrice(stock.price, stock.currency)}</p>
            <p class="${changeClass}">Change: ${(stock.change || 0).toFixed(2)}%</p>
        `;
    }    

    function updateWatchlistDisplay() {
        watchlist.innerHTML = ''; // Clear previous items

        // Get full stock objects from allStocks map for display
        const stocksToDisplay = watchlistSymbols
            .map(symbol => allStocks.get(symbol))
            .filter(stock => stock); // Filter out any undefined stocks

        stocksToDisplay.forEach((stock) => {
            const li = document.createElement('li');
            li.textContent = `${stock.name} (${stock.symbol}) `;
            const removeButton = document.createElement('button');
            removeButton.textContent = 'Remove';
            removeButton.classList.add('remove');
            removeButton.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent li click event from firing
                removeFromWatchlist(stock.symbol);
            });
            li.appendChild(removeButton);
            li.addEventListener('click', () => { displayStockInfo(stock); });
            watchlist.appendChild(li);
        });
    }

    function displayStockTable(stocks) {
        stockTableBody.innerHTML = ''; // Clear previous data
        stocks.sort((a, b) => a.name.localeCompare(b.name)).forEach((stock) => {
            const changeClass = stock.change >= 0 ? 'positive' : 'negative';
            const signalClass = stock.signal ? (stock.signal === 'BUY' ? 'signal-buy' : 'signal-sell') : '';
            const recommendedSignalClass = stock.recommendedSignal ? (stock.recommendedSignal === 'STRONG BUY' ? 'signal-strong-buy' : 'signal-strong-sell') : '';
            const tr = document.createElement('tr');
            tr.innerHTML = `
            <td>${stock.name} (${stock.symbol})</td>
            <td>${formatPrice(stock.price, stock.currency)}</td>
            <td class="${changeClass}">${(stock.change || 0).toFixed(2)}%</td>
            <td>${formatIndicator(stock.indicators?.rsi)}</td>
            <td>${formatIndicator(stock.indicators?.sma20, 2)}</td>
            <td>${formatIndicator(stock.indicators?.sma50, 2)}</td>
            <td class="${signalClass}">${stock.signal || '---'}</td>
            <td class="${recommendedSignalClass}">${stock.recommendedSignal || '---'}</td>
            <td class="actions"></td>
            `;
            const actionsTd = tr.querySelector('.actions');

            const isWatchlisted = watchlistSymbols.includes(stock.symbol);

            if (!isWatchlisted) {
                const addButton = document.createElement('button');
                addButton.textContent = 'Add';
                addButton.classList.add('add');
                addButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    addToWatchlist(stock.symbol);
                });
                actionsTd.appendChild(addButton);
            } else {
                const removeButton = document.createElement('button');
                removeButton.textContent = 'Remove';
                removeButton.classList.add('remove');
                removeButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeFromWatchlist(stock.symbol);
                });
                actionsTd.appendChild(removeButton);
            }

            // Add event listener to display stock details when clicked
            tr.addEventListener('click', () => { displayStockInfo(stock); });

            stockTableBody.appendChild(tr);
        });
    }

    // --- NEW: Debounced search function ---
    async function searchStocks(query) {
        if (!query) {
            // If search is cleared, show the default/watchlist stocks
            displayStockTable(getAllStocksArray());
            return;
        }

        console.log(`Searching for: ${query}`);
        try {
            const response = await fetch(`${BACKEND_URL}/api/search?query=${query}`);
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`Search API request failed: ${response.status} ${response.statusText}`, errorText);
                stockTableBody.innerHTML = `<tr><td colspan="9" class="error-message">Error searching for "${query}". The server reported an error.</td></tr>`;
                return;
            }
            const searchResults = await response.json();

            // Add or update these search results in our main `allStocks` map
            searchResults.forEach(stock => allStocks.set(stock.symbol, stock));

            // Display only the search results in the table
            displayStockTable(searchResults);
        } catch (error) {
            console.error("Error searching for stocks:", error);
            stockTableBody.innerHTML = `<tr><td colspan="9" class="error-message">Could not perform search. Is the backend server running?</td></tr>`;
        }
    }

    // Function to update the stock table with the latest prices
    function updateStockTable() {
        displayStockTable(getAllStocksArray());
    }

    // --- NEW: Function to display top recommendations ---
    function displayRecommendations(recommendations) {
        const { buys, sells } = recommendations;

        // Helper function to populate a table
        const populateTable = (tableBody, stocks, message) => {
            tableBody.innerHTML = ''; // Clear previous data
            if (!stocks || stocks.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="4">${message}</td></tr>`;
                return;
            }
            stocks.forEach((stock) => {
                const changeClass = stock.change >= 0 ? 'positive' : 'negative';
                const recommendedSignalClass = stock.recommendedSignal === 'STRONG BUY' ? 'signal-strong-buy' : 'signal-strong-sell';
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${stock.name} (${stock.symbol})</td>
                    <td>${formatPrice(stock.price, stock.currency)}</td>
                    <td class="${changeClass}">${(stock.change || 0).toFixed(2)}%</td>
                    <td class="${recommendedSignalClass}">${stock.recommendedSignal}</td>
                `;
                tableBody.appendChild(tr);
            });
        };

        populateTable(recommendationsBuyTableBody, buys, 'No strong buy signals at the moment.');
        populateTable(recommendationsSellTableBody, sells, 'No strong sell signals at the moment.');
    }

    // --- NEW: Function to display Volume/Price strategy results ---
    function displayVolumePriceGainers(stocks) {
        const tableBody = volumePriceTableBody;
        const message = 'No stocks matching the Volume/Price strategy at the moment.';

        tableBody.innerHTML = ''; // Clear previous data
        if (!stocks || stocks.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="4">${message}</td></tr>`;
            return;
        }
        stocks.forEach((stock) => {
            const changeClass = stock.change >= 0 ? 'positive' : 'negative';
            const tr = document.createElement('tr');
            // Format volume with commas for readability
            const formattedVolume = stock.volume ? stock.volume.toLocaleString('en-IN') : '---';
            tr.innerHTML = `
                <td>${stock.name} (${stock.symbol})</td>
                <td>${formatPrice(stock.price, stock.currency)}</td>
                <td class="${changeClass}">${(stock.change || 0).toFixed(2)}%</td>
                <td>${formattedVolume}</td>
            `;
            tableBody.appendChild(tr);
        });
    }

    // --- NEW: Function to display Fast Volume Accumulators ---
    function displayFastAccumulators(stocks) {
        const tableBody = fastAccumulatorsTableBody;
        const message = 'No F&O stocks with positive momentum found right now.';

        tableBody.innerHTML = '';
        if (!stocks || stocks.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="4">${message}</td></tr>`;
            return;
        }
        stocks.forEach((stock) => {
            const changeClass = stock.change >= 0 ? 'positive' : 'negative';
            const tr = document.createElement('tr');

            // Calculate volume ratio for display
            const volumeRatio = (stock.volume && stock.indicators?.avgVolume20)
                ? (stock.volume / stock.indicators.avgVolume20).toFixed(2) + 'x'
                : '---';

            tr.innerHTML = `
                <td>${stock.name} (${stock.symbol})</td>
                <td>${formatPrice(stock.price, stock.currency)}</td>
                <td class="${changeClass}">${(stock.change || 0).toFixed(2)}%</td>
                <td>${volumeRatio}</td>
            `;
            tableBody.appendChild(tr);
        });
    }

    // --- NEW: Function to update the connection status bar ---
    function updateStatus(message, type) {
        statusDisplay.textContent = message;
        statusDisplay.className = `status-bar status-${type}`;
    }

    function debounce(func, delay) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), delay);
        };
    }

    const debouncedSearch = debounce(searchStocks, 500);

    searchInput.addEventListener('input', (event) => {
        debouncedSearch(event.target.value.trim());
    });

    // --- Strategy Functions ---

    async function fetchStrategies() {
        try {
            const response = await fetch(`${BACKEND_URL}/api/strategies`);
            savedStrategies = await response.json();
            displayStrategies();
        } catch (error) {
            console.error("Error fetching strategies:", error);
        }
    }

    function displayStrategies() {
        strategyList.innerHTML = '';
        savedStrategies.forEach(strategy => {
            const li = document.createElement('li');
            li.textContent = `${strategy.name}: IF ${strategy.field} ${strategy.operator} ${strategy.value} THEN ${strategy.signal}`;
            const removeButton = document.createElement('button');
            removeButton.textContent = 'Delete';
            removeButton.classList.add('remove');
            removeButton.addEventListener('click', () => handleDeleteStrategy(strategy.id));
            li.appendChild(removeButton);
            strategyList.appendChild(li);
        });
    }

    async function handleStrategySubmit(event) {
        event.preventDefault();
        const newStrategy = {
            name: document.getElementById('strategy-name').value,
            field: document.getElementById('strategy-field').value,
            operator: document.getElementById('strategy-operator').value,
            value: document.getElementById('strategy-value').value,
            signal: document.getElementById('strategy-signal').value,
        };

        try {
            const response = await fetch(`${BACKEND_URL}/api/strategies`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newStrategy),
            });
            if (response.ok) {
                strategyForm.reset();
                fetchStrategies(); // Refresh the list
            }
        } catch (error) {
            console.error("Error creating strategy:", error);
        }
    }

    async function handleDeleteStrategy(strategyId) {
        try {
            const response = await fetch(`${BACKEND_URL}/api/strategies/${strategyId}`, { method: 'DELETE' });
            if (response.ok) {
                fetchStrategies(); // Refresh the list
            } else {
                console.error(`Failed to delete strategy ${strategyId}`);
                updateStatus(`Failed to delete strategy.`, 'error');
            }
        } catch (error) {
            console.error("Error deleting strategy:", error);
            updateStatus(`Error deleting strategy.`, 'error');
        }
    }

    // Initialize the dashboard
    async function initializeDashboard() {
        updateStatus('Connecting...', 'connecting');

        const urlParams = new URLSearchParams(window.location.search);
        const symbolFromUrl = urlParams.get('symbol');

        // Fetch the user's watchlist from the database
        await fetchWatchlist();

        // The initial data will be pushed by the server via WebSocket upon connection.
        // We can display the watchlist shell and an empty table for now.
        updateWatchlistDisplay();
        displayStockTable(getAllStocksArray()); // Will be empty initially

        if (symbolFromUrl) {
            // If a symbol was passed in the URL, display a loading message for it.
            // The 'stockUpdate' event will populate the real data later.
            stockInfo.innerHTML = `<h3>Loading details for ${symbolFromUrl}...</h3>`;
            currentlySelectedSymbol = symbolFromUrl; // Set this so the update handler knows what to display
        }

        // Fetch and display strategies
        fetchStrategies();
        strategyForm.addEventListener('submit', handleStrategySubmit);

        // --- Connect to the WebSocket server for real-time updates ---
        socket = io({ // With an empty URL, it connects to the host that served the page
            reconnection: true,
            reconnectionAttempts: 10, // More attempts
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            randomizationFactor: 0.5
        });

        socket.on("connect", () => {
            console.log("Connected to real-time update server.");
            updateStatus('Live connection established.', 'connected');
        });

        // --- NEW: Listen for scan status updates from the server ---
        socket.on('scanStatus', (data) => {
            const { message, step } = data;
            let statusType = 'connecting'; // Default to a neutral/in-progress style

            if (step === 'error') {
                statusType = 'error';
            } else if (step === 'done') {
                statusType = 'connected';
                // Hide the message after a short delay and revert to the default connected message
                setTimeout(() => {
                    if (statusDisplay.textContent.includes('Scan complete')) {
                        updateStatus('Live connection established.', 'connected');
                    }
                }, 3000);
            }
            
            // The message from the server already includes the percentage
            // so we can just display it directly.
            updateStatus(message, statusType);
        });

        socket.on("stockUpdate", (freshData) => {
            console.log("Received real-time stock update:", freshData);

            if (!freshData || freshData.length === 0) {
                console.log("Update contained no data. Skipping UI refresh.");
                return;
            }

            // The 'stockUpdate' event contains the full, refreshed list of all tracked stocks.
            // We clear the map and repopulate it to ensure our client state matches the server's.
            allStocks.clear();
            freshData.forEach(stock => allStocks.set(stock.symbol, stock));

            // Re-render the UI, preserving the current search filter
            const searchTerm = searchInput.value.trim().toLowerCase();

            if (searchTerm) {
                const searchResults = freshData.filter(stock => 
                    stock.symbol.toLowerCase().includes(searchTerm) || 
                    stock.name.toLowerCase().includes(searchTerm)
                );
                displayStockTable(searchResults);
            } else {
                updateStockTable();
            }
            updateWatchlistDisplay();

            // Update the details view if a stock is currently displayed
            if (currentlySelectedSymbol) {
                const updatedSelectedStock = allStocks.get(currentlySelectedSymbol);
                if (updatedSelectedStock) {
                    displayStockInfo(updatedSelectedStock);
                } else if (symbolFromUrl && !allStocks.has(symbolFromUrl)) {
                    // If the symbol from the URL was not in the update, it might be invalid.
                    stockInfo.innerHTML = `<h3>Could not find data for symbol: ${symbolFromUrl}</h3>`;
                }
            }
        });

        // --- NEW: Listen for custom strategy updates (from strategies.html) ---
        socket.on("customStrategiesUpdate", (data) => {
            console.log("Received custom strategies update on main page:", data);
            // This event contains results for all built-in strategies.
            // We extract the 'F&O Volume & Price Gainers' for the dedicated table on this page.
            if (data && data.strategies && data.strategies['F&O Volume & Price Gainers']) {
                const volumeGainers = data.strategies['F&O Volume & Price Gainers'].stocks;
                displayVolumePriceGainers(volumeGainers);
            }
        });

        // --- NEW: Listen for top recommendations ---
        socket.on("topRecommendationsUpdate", (recommendations) => {
            console.log("Received top recommendations:", recommendations);
            displayRecommendations(recommendations);
        });

        // --- NEW: Listen for Fast Volume Accumulators ---
        socket.on("fastVolumeAccumulatorsUpdate", (stocks) => {
            console.log("Received Fast Volume Accumulators update:", stocks);
            displayFastAccumulators(stocks);
        });

        // --- NEW: Listen for Python service health updates ---
        socket.on('pythonHealthUpdate', (data) => {
            const pythonStatusDisplay = document.getElementById('python-status-display');
            if (!pythonStatusDisplay) return;

            if (data.isHealthy) {
                pythonStatusDisplay.textContent = ' | Analysis Service: Online';
                pythonStatusDisplay.className = 'status-extra status-connected';
            } else {
                pythonStatusDisplay.textContent = ' | Analysis Service: OFFLINE';
                pythonStatusDisplay.className = 'status-extra status-error';
            }
        });

        socket.on("disconnect", (reason) => {
            console.log(`Disconnected from real-time update server: ${reason}`);
            if (reason === 'io server disconnect') {
                updateStatus('Disconnected by server. Please refresh.', 'disconnected');
            } else {
                updateStatus(`Connection lost: ${reason}. Reconnecting...`, 'reconnecting');
            }
        });

        socket.on('reconnect_attempt', (attempt) => {
            console.log(`Reconnection attempt #${attempt}`);
            updateStatus(`Reconnection attempt #${attempt}...`, 'reconnecting');
        });

        socket.on('reconnect', (attempt) => {
            console.log(`Successfully reconnected after ${attempt} attempts.`);
            updateStatus('Reconnected!', 'connected');
        });

        socket.on('fetchError', (data) => {
            console.error('Backend fetch error:', data.error);
            updateStatus(`Server Error: ${data.error}`, 'error');
        });
    }

    initializeDashboard();
});