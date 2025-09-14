// strategies.js

document.addEventListener('DOMContentLoaded', () => {
    const BACKEND_URL = ''; // Use relative paths to connect to the same host
    const statusDisplay = document.getElementById('connection-status');
    const resultsContainer = document.getElementById('strategy-results-container');
    const lastUpdatedDisplay = document.getElementById('last-updated-timestamp');

    function updateStatus(message, type) {
        statusDisplay.textContent = message;
        statusDisplay.className = `status-bar status-${type}`;
    }

    function formatPrice(price, currency) {
        const options = {
            style: 'currency',
            currency: currency || 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        };
        return new Intl.NumberFormat('en-US', options).format(price || 0);
    }

    function displayStrategyResults(data) {
        const { strategies, timestamp } = data;

        // Update the timestamp
        if (timestamp) {
            const date = new Date(timestamp);
            lastUpdatedDisplay.textContent = `Last updated: ${date.toLocaleTimeString()}`;
            lastUpdatedDisplay.classList.add('flash');
            setTimeout(() => lastUpdatedDisplay.classList.remove('flash'), 1000);
        }

        resultsContainer.innerHTML = ''; // Clear previous results

        if (!strategies || Object.keys(strategies).length === 0) {
            if (timestamp) {
                resultsContainer.innerHTML = '<p>Scan complete. No stocks are currently matching the active strategies. This can happen in certain market conditions. The next scan will run shortly.</p>';
            } else {
                resultsContainer.innerHTML = '<p>Connecting to server and waiting for the first scan results...</p>';
            }
            return;
        }

        // --- NEW: Group strategies by type (Bullish, Bearish, Neutral) ---
        const groupedStrategies = {
            'Bullish': {},
            'Bearish': {},
            'Neutral': {}
        };

        for (const strategyName in strategies) {
            const strategyData = strategies[strategyName];
            const type = strategyData.type || 'Neutral';
            if (!groupedStrategies[type]) { // In case a new type is added on the backend
                groupedStrategies[type] = {};
            }
            groupedStrategies[type][strategyName] = strategyData.stocks;
        }

        // --- NEW: Render each group and its cards ---
        const groupOrder = ['Bullish', 'Bearish', 'Neutral']; // Define the display order

        for (const groupName of groupOrder) {
            const group = groupedStrategies[groupName];
            const strategyNamesInGroup = Object.keys(group).sort();

            if (strategyNamesInGroup.length === 0) continue; // Skip empty groups

            // Create group container and title
            const groupContainer = document.createElement('div');
            groupContainer.className = 'strategy-group';
            const groupTitle = document.createElement('h2');
            groupTitle.className = `strategy-group-title ${groupName.toLowerCase()}`;
            groupTitle.textContent = `${groupName} Strategies`;
            groupContainer.appendChild(groupTitle);

            const grid = document.createElement('div');
            grid.className = 'strategy-results-grid';
            
            // Loop through each strategy within the group
            for (const strategyName of strategyNamesInGroup) {
                const stocks = group[strategyName];
                const card = document.createElement('div');
                card.className = 'strategy-card';

                const title = document.createElement('h2');
                title.textContent = strategyName;
                card.appendChild(title);

                const table = document.createElement('table');
                table.innerHTML = `
                    <thead>
                        <tr>
                            <th>Stock Name</th>
                            <th>Price</th>
                            <th>Change</th>
                            <th>Key Metric</th>
                        </tr>
                    </thead>
                    <tbody>
                    </tbody>
                `;
                const tableBody = table.querySelector('tbody');

                if (!stocks || stocks.length === 0) {
                    tableBody.innerHTML = `<tr><td colspan="4">No matches found.</td></tr>`;
                } else {
                    stocks.forEach(stock => {
                        const changeClass = (stock.change || 0) >= 0 ? 'positive' : 'negative';
                        const tr = document.createElement('tr');
                        tr.style.cursor = 'pointer'; // Make row clickable
                        tr.title = `Click to see more details for ${stock.symbol}`;

                        // --- NEW: Determine the relevant metric to display ---
                        let relevantMetric = '---';
                        const lowerCaseStrategyName = strategyName.toLowerCase();
                        if (lowerCaseStrategyName.includes('rsi')) {
                            relevantMetric = `RSI: ${stock.indicators?.rsi?.toFixed(2) || 'N/A'}`;
                        } else if (lowerCaseStrategyName.includes('volume')) {
                            const volumeRatio = (stock.volume && stock.indicators?.avgVolume20)
                                ? `${(stock.volume / stock.indicators.avgVolume20).toFixed(1)}x`
                                : 'N/A';
                            relevantMetric = `Vol: ${volumeRatio}`;
                        } else if (lowerCaseStrategyName.includes('crossover')) {
                            relevantMetric = `SMA20: ${stock.indicators?.sma20?.toFixed(2) || 'N/A'}`;
                        } else if (lowerCaseStrategyName.includes('bollinger')) {
                            relevantMetric = `Price: ${formatPrice(stock.price, stock.currency)}`;
                        }

                        tr.innerHTML = `
                            <td>${stock.name} (${stock.symbol})</td>
                            <td>${formatPrice(stock.price, stock.currency)}</td>
                            <td class="${changeClass}">${(stock.change || 0).toFixed(2)}%</td>
                            <td>${relevantMetric}</td>
                        `;
                        // Add click event listener to navigate to the main dashboard with the symbol
                        tr.addEventListener('click', () => {
                            window.location.href = `index.html?symbol=${stock.symbol}`;
                        });
                        tableBody.appendChild(tr);
                    });
                }
                card.appendChild(table);
                grid.appendChild(card);
            }

            groupContainer.appendChild(grid);
            resultsContainer.appendChild(groupContainer);
        }
    }

    function initialize() {
        updateStatus('Connecting...', 'connecting');

        // --- NEW: Create a dedicated element for Python service status ---
        const statusBarContainer = statusDisplay.parentElement;
        if (statusBarContainer) {
            const pythonStatusDisplay = document.createElement('span');
            pythonStatusDisplay.id = 'python-status-display';
            statusBarContainer.appendChild(pythonStatusDisplay);
        }

        const socket = io({ // With an empty URL, it connects to the host that served the page
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
        });

        socket.on("connect", () => {
            updateStatus('Live connection established.', 'connected');
        });

        socket.on("customStrategiesUpdate", (data) => {
            console.log("Received custom strategies update:", data);
            displayStrategyResults(data);
        });

        // --- NEW: Listen for Python service health updates ---
        socket.on('pythonHealthUpdate', (data) => {
            const pythonStatusDisplay = document.getElementById('python-status-display');
            if (!pythonStatusDisplay) return;

            if (data.isHealthy) {
                pythonStatusDisplay.textContent = ' | Analysis Service: Online';
                pythonStatusDisplay.className = 'status-extra status-connected';
            } else {
                pythonStatusDisplay.textContent = ' | Analysis Service: OFFLLINE';
                pythonStatusDisplay.className = 'status-extra status-error';
            }
        });

        socket.on("disconnect", (reason) => {
            updateStatus(`Connection lost: ${reason}. Reconnecting...`, 'reconnecting');
        });

        socket.on('fetchError', (data) => {
            // Also display the error in the main content area for better visibility
            resultsContainer.innerHTML = `<p class="error-message">Server Error: ${data.error}</p>`;
            updateStatus(`Server Error: ${data.error}`, 'error');
        });
    }

    initialize();
});