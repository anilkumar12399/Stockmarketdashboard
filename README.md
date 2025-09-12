# Stock Market Dashboard

A full-stack, real-time stock market analysis and strategy dashboard. This application provides live data updates, technical indicator analysis, and a platform for creating and viewing trading strategies. It's built with a resilient microservice architecture, featuring a Node.js backend for data orchestration and a dedicated Python service for heavy computational analysis.

## Features

*   **Real-Time Data:** Live stock price updates using WebSockets, ensuring the dashboard reflects market changes instantly.
*   **Customizable Watchlist:** Users can add and remove stocks from their personal watchlist, which persists in a database.
*   **Comprehensive Technical Analysis:** The backend calculates key technical indicators for each stock, including:
    *   Relative Strength Index (RSI)
    *   Simple Moving Averages (SMA20, SMA50)
    *   MACD, Bollinger Bands, and more.
*   **Strategy Engine:**
    *   **Built-in Strategies:** Comes with pre-defined strategies like "F&O Volume & Price Gainers", "SMA Crossovers", and "RSI Oversold/Overbought".
    *   **User-Defined Strategies:** Users can create and save their own simple trading strategies based on price or percentage change.
*   **Top Recommendations:** A composite model analyzes multiple indicators to generate "STRONG BUY" and "STRONG SELL" signals for top-performing stocks.
*   **Dedicated Strategy Page:** A separate view (`strategies.html`) to display the results of all built-in strategies in a clean, card-based layout.
*   **Stock Search:** Instantly search for any stock symbol to get its latest quote.
*   **Resilient Architecture:** Implements a **Circuit Breaker** pattern to gracefully handle failures or slowdowns from the Python analysis service, preventing cascading failures.

## Tech Stack

This project is composed of two main services that work together.

### 1. Frontend & Node.js Backend

*   **Frontend:** Vanilla HTML, CSS, and JavaScript.
*   **Web Server:** Express.js for serving static files and handling API requests.
*   **Real-Time Communication:** Socket.IO for pushing live data from the server to the client.
*   **Database:** SQLite (via `sqlite` and `sqlite3` packages) for storing user watchlists and custom strategies.
*   **Data Fetching:** yahoo-finance2 for fetching quotes and historical stock data.
*   **Resilience:** Opossum for implementing the circuit breaker pattern.
*   **Performance:** agentkeepalive for reusing TCP connections to the Python service, significantly improving performance.

### 2. Python Analysis Service

*   **API Framework:** Flask to create the `/analyze` endpoint.
*   **Numerical Analysis:** Pandas for data manipulation and `pandas-ta` for calculating a wide range of technical indicators.
*   **Web Server:** Waitress as a production-grade WSGI server to handle concurrent analysis requests from the Node.js backend.

## Architecture Overview

The application is designed as a set of communicating services to ensure scalability and resilience.

1.  **Frontend (Client):** The user's browser loads the HTML/JS/CSS files. It establishes a WebSocket connection to the Node.js server to receive all data updates.
2.  **Node.js Server (`server.js`):** This is the central orchestrator.
    *   It serves the frontend application.
    *   It manages the SQLite database for user-specific data.
    *   It fetches raw quote and historical data from the Yahoo Finance API.
    *   For each stock, it packages the data and sends it to the Python Analysis Service for computation.
    *   It receives the computed analysis (indicators, signals) back from the Python service.
    *   It aggregates all the data and broadcasts it to all connected clients via WebSockets.
3.  **Python Analysis Service (`analysis_service.py`):** This is the computational workhorse.
    *   It exposes a single API endpoint (`/analyze`).
    *   It receives stock data from the Node.js server.
    *   It uses Pandas and `pandas-ta` to perform all the heavy calculations (RSI, SMA, etc.) and evaluate trading strategies.
    *   It returns a JSON object with the full analysis back to the Node.js server.

This separation ensures that the Node.js server remains non-blocking and responsive, even when performing analysis on hundreds of stocks, as all the CPU-intensive work is offloaded to a separate process.

## Local Setup and Installation

Follow these steps to run the project on your local machine.

### Prerequisites

*   Node.js (v16 or later recommended)
*   Python (v3.8 or later recommended) and `pip`

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd <repository-folder>
```

### 2. Install Dependencies

First, install the Node.js dependencies:

```bash
npm install
```

Next, install the Python dependencies:

```bash
pip install -r requirements.txt
```

### 3. Run the Application

You need to start both the Python service and the Node.js server in separate terminal windows.

**Terminal 1: Start the Python Analysis Service**

```bash
python analysis_service.py
```

You should see output indicating the Waitress server is running on `http://0.0.0.0:5000`.

**Terminal 2: Start the Node.js Server**

```bash
npm start
```

You should see output indicating the server is running on port `3001`.

### 4. View the Dashboard

Open your web browser and navigate to:

**`http://localhost:3001`**

You can also view the dedicated strategies page at:

**`http://localhost:3001/strategies.html`**

## Deployment

This is a full-stack application and cannot be deployed on simple static hosting (like GitHub Pages). It requires a hosting environment that can run persistent Node.js and Python processes.

A **Platform as a Service (PaaS)** like **Render** is highly recommended for its ease of use.

### Deploying on Render

1.  **Push to GitHub:** Ensure your project is in a GitHub repository.
2.  **Deploy Python Service:**
    *   Create a new **Web Service** on Render and connect your repository.
    *   Set the **Runtime** to `Python 3`.
    *   **Build Command:** `pip install -r requirements.txt`
    *   **Start Command:** `python analysis_service.py`
    *   Deploy it and copy the `.onrender.com` URL it is assigned.
3.  **Deploy Node.js Service:**
    *   Create another **Web Service** on Render.
    *   Set the **Runtime** to `Node`.
    *   **Build Command:** `npm install`
    *   **Start Command:** `npm start`
    *   Go to the **Environment** tab and add two environment variables:
        *   `PYTHON_API_URL`: The URL of your deployed Python service (e.g., `https://your-python-app.onrender.com/analyze`).
        *   `DATABASE_PATH`: `/data/database.db`
    *   Go to the **Disks** tab and add a new Persistent Disk with a Mount Path of `/data`. This is crucial to ensure your SQLite database is not erased on every deploy.
4.  **Connect Domain:** Add your custom domain (`www.intradaytrades.in`) in the settings for the Node.js service and follow the instructions to update your DNS records.

---