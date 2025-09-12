# analysis_service.py

from flask import Flask, request, jsonify
import pandas as pd
import pandas_ta as ta
import numpy as np
# NEW: Import logging for better debugging
import logging
# NEW: Import waitress for a production-grade server
from waitress import serve # pyright: ignore[reportMissingModuleSource]

app = Flask(__name__)

# --- NEW: Setup basic logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Built-in Strategy Registry (Python version) ---
# This mirrors the logic that was previously in server.js

def evaluate_fno_volume_price_gainers(stock, indicators):
    # This strategy is specifically for the F&O stock universe.
    # The Node.js server already filters by fnoSymbols, so we just apply the logic.
    required_keys = ['sma5', 'sma20', 'avg5DayVolume', 'avgVolume20']
    if not all(indicators.get(k) is not None for k in required_keys):
        return False

    # The stock quote from Node.js uses 'regularMarketPrice'
    price = stock.get('regularMarketPrice')
    if price is None:
        return False

    is_price_uptrend = price > indicators['sma5'] and price > indicators['sma20']
    # Ensure avgVolume20 is not zero to prevent potential division errors if logic changes
    if indicators['avgVolume20'] == 0: return False
    is_volume_surge = indicators['avg5DayVolume'] > (indicators['avgVolume20'] * 1.5)
    return is_price_uptrend and is_volume_surge

def evaluate_sma_bullish_crossover(stock, indicators):
    required_keys = ['sma20', 'sma50', 'prev_sma20', 'prev_sma50']
    if not all(indicators.get(k) is not None for k in required_keys):
        return False
    return indicators['prev_sma20'] <= indicators['prev_sma50'] and indicators['sma20'] > indicators['sma50']

def evaluate_sma_bearish_crossover(stock, indicators):
    required_keys = ['sma20', 'sma50', 'prev_sma20', 'prev_sma50']
    if not all(indicators.get(k) is not None for k in required_keys):
        return False
    return indicators['prev_sma20'] >= indicators['prev_sma50'] and indicators['sma20'] < indicators['sma50']


# --- NEW: Evaluation functions for the Mean Reversion strategy ---
def evaluate_mean_reversion_buy(stock, indicators):
    """
    Identifies a potential bullish mean reversion opportunity.
    Signal is triggered when the price hits the lower Bollinger Band and RSI confirms an oversold state.
    """
    # The stock quote from Node.js uses 'regularMarketPrice'
    price = stock.get('regularMarketPrice')
    bbands = indicators.get('bbands')
    rsi = indicators.get('rsi')

    if price is None or rsi is None or bbands is None or bbands.get('lower') is None:
        return False

    # Condition 1: Price is at or below the lower Bollinger Band (statistically low).
    is_price_low = price <= bbands.get('lower')
    # Condition 2: RSI is in the oversold territory (confirming weak momentum).
    is_rsi_oversold = rsi < 35

    return is_price_low and is_rsi_oversold

def evaluate_mean_reversion_sell(stock, indicators):
    """
    Identifies a potential bearish mean reversion opportunity.
    Signal is triggered when the price hits the upper Bollinger Band and RSI confirms an overbought state.
    """
    # The stock quote from Node.js uses 'regularMarketPrice'
    price = stock.get('regularMarketPrice')
    bbands = indicators.get('bbands')
    rsi = indicators.get('rsi')

    if price is None or rsi is None or bbands is None or bbands.get('upper') is None:
        return False

    # Condition 1: Price is at or above the upper Bollinger Band (statistically high).
    is_price_high = price >= bbands.get('upper')
    # Condition 2: RSI is in the overbought territory (confirming strong but potentially exhausted momentum).
    is_rsi_overbought = rsi > 65

    return is_price_high and is_rsi_overbought


CUSTOM_STRATEGY_REGISTRY = {
    'F&O Volume & Price Gainers': {
        'type': 'Bullish',
        'eval': evaluate_fno_volume_price_gainers
    },
    'Hitting 52-Week High': {
        'type': 'Bullish',
        'eval': lambda stock, i: stock.get('regularMarketPrice') and stock.get('fiftyTwoWeekHigh') and stock.get('regularMarketPrice') >= stock.get('fiftyTwoWeekHigh')
    },
    'SMA Bullish Crossover (20/50)': {
        'type': 'Bullish',
        'eval': evaluate_sma_bullish_crossover
    },
    'Bollinger Band Breakout (Bullish)': {
        'type': 'Bullish',
        'eval': lambda stock, i: i.get('bbands') and i['bbands'].get('upper') and stock.get('regularMarketPrice') and stock.get('regularMarketPrice') > i['bbands']['upper']
    },
    'RSI Oversold (< 30)': {
        'type': 'Bullish',
        'eval': lambda stock, i: i.get('rsi') and i['rsi'] < 30
    },
    # --- NEW STRATEGY ---
    'Mean Reversion Buy (RSI < 35 & on Lower BBand)': {
        'type': 'Bullish',
        'eval': evaluate_mean_reversion_buy
    },
    'Price Above 20-Day MA': {
        'type': 'Bullish',
        'eval': lambda stock, i: i.get('sma20') and stock.get('regularMarketPrice') and stock.get('regularMarketPrice') > i['sma20']
    },
    'Hitting 52-Week Low': {
        'type': 'Bearish',
        'eval': lambda stock, i: stock.get('regularMarketPrice') and stock.get('fiftyTwoWeekLow') and stock.get('regularMarketPrice') <= stock.get('fiftyTwoWeekLow')
    },
    'SMA Bearish Crossover (20/50)': {
        'type': 'Bearish',
        'eval': evaluate_sma_bearish_crossover
    },
    'Bollinger Band Breakout (Bearish)': {
        'type': 'Bearish',
        'eval': lambda stock, i: i.get('bbands') and i['bbands'].get('lower') and stock.get('regularMarketPrice') and stock.get('regularMarketPrice') < i['bbands']['lower']
    },
    # --- NEW STRATEGY ---
    'Mean Reversion Sell (RSI > 65 & on Upper BBand)': {
        'type': 'Bearish',
        'eval': evaluate_mean_reversion_sell
    },
    'Unusual Volume Spike': {
        'type': 'Neutral',
        'eval': lambda stock, i: stock.get('regularMarketVolume') and i.get('avgVolume20') and stock.get('regularMarketVolume') > (i['avgVolume20'] * 3)
    },
}

def _check_condition(stock_value, operator, target_value):
    """Helper to safely evaluate a single strategy condition."""
    if stock_value is None or operator is None or target_value is None:
        return False
    
    # Ensure target_value is a float for comparison
    try:
        target = float(target_value)
    except (ValueError, TypeError):
        return False

    if operator == '>': return stock_value > target
    if operator == '<': return stock_value < target
    if operator == '>=': return stock_value >= target
    if operator == '<=': return stock_value <= target
    if operator == '==': return stock_value == target
    return False


def evaluate_composite_strategy(stock, indicators):
    """Evaluates a composite strategy using a scoring model."""
    # The stock quote from Node.js uses 'regularMarketPrice'
    price = stock.get('regularMarketPrice')

    # Critical check: If price is missing, no analysis can be done.
    if price is None:
        return None

    # Ensure all required indicators for the composite model are present
    required_keys = ['rsi', 'macd', 'sma20', 'sma50', 'bbands', 'stochastic', 'obv']
    if not all(key in indicators and indicators[key] is not None for key in required_keys):
        return None

    bullish_score = 0
    bearish_score = 0

    # --- IMPROVED: All comparisons are now null-safe to prevent runtime errors ---

    # Trend Analysis
    if indicators['sma20'] is not None and price > indicators['sma20']: bullish_score += 1
    if indicators['sma50'] is not None and price > indicators['sma50']: bullish_score += 1
    if indicators['sma20'] is not None and price < indicators['sma20']: bearish_score += 1
    if indicators['sma50'] is not None and price < indicators['sma50']: bearish_score += 1
    if indicators['sma20'] is not None and indicators['sma50'] is not None:
        if indicators['sma20'] > indicators['sma50']: bullish_score += 2
        if indicators['sma20'] < indicators['sma50']: bearish_score += 2

    # Momentum Analysis
    if indicators['rsi'] is not None:
        if indicators['rsi'] < 30: bullish_score += 2
        if indicators['rsi'] > 70: bearish_score += 2
    if indicators['macd']['macd'] is not None and indicators['macd']['signal'] is not None:
        if indicators['macd']['macd'] > indicators['macd']['signal']: bullish_score += 1
        if indicators['macd']['macd'] < indicators['macd']['signal']: bearish_score += 1
    if indicators['stochastic']['k'] is not None and indicators['stochastic']['d'] is not None:
        if indicators['stochastic']['k'] > indicators['stochastic']['d']: bullish_score += 1
        if indicators['stochastic']['k'] < indicators['stochastic']['d']: bearish_score += 1
    if indicators['stochastic']['k'] is not None:
        if indicators['stochastic']['k'] < 20: bullish_score += 1
        if indicators['stochastic']['k'] > 80: bearish_score += 1

    # Volatility Analysis
    if indicators['bbands']['lower'] is not None and price < indicators['bbands']['lower']: bullish_score += 2
    if indicators['bbands']['upper'] is not None and price > indicators['bbands']['upper']: bearish_score += 2

    # Volume Analysis
    if indicators['obv']['obv'] is not None and indicators['obv']['prev_obv'] is not None:
        if indicators['obv']['obv'] > indicators['obv']['prev_obv']: bullish_score += 1
        if indicators['obv']['obv'] < indicators['obv']['prev_obv']: bearish_score += 1

    # --- IMPROVED: Final Signal Logic ---
    # A strong signal requires a high absolute score AND a significant
    # difference between bullish and bearish sentiment to reduce noise.
    if bullish_score >= 8 and (bullish_score - bearish_score) >= 4:
        return 'STRONG BUY'
    if bearish_score >= 8 and (bearish_score - bullish_score) >= 4:
        return 'STRONG SELL'
    
    return None

@app.route('/analyze', methods=['POST'])
def analyze():
    symbol = "UNKNOWN"
    try:
        data = request.get_json()
        if not data:
            logging.error("Request received with empty/invalid JSON body.")
            return jsonify({"error": "Invalid JSON body"}), 400

        # --- NEW: Validate incoming data structure ---
        stock_quote = data.get('quote')
        history = data.get('history')
        user_strategies = data.get('strategies')

        if not all([stock_quote, history, user_strategies is not None]):
            logging.error(f"Request missing required keys. Quote: {bool(stock_quote)}, History: {bool(history)}, Strategies: {user_strategies is not None}")
            return jsonify({"error": "Request body missing 'quote', 'history', or 'strategies'"}), 400

        symbol = stock_quote.get('symbol', 'UNKNOWN')
        logging.info(f"--- Analyzing symbol: {symbol} ---")

        if not history:
            logging.warning(f"No historical data for symbol: {symbol}. Skipping analysis.")
            return jsonify({"error": "Historical data is empty"}), 400

        # --- 1. Prepare DataFrame ---
        df = pd.DataFrame(history)
        df['date'] = pd.to_datetime(df['date'])
        df.set_index('date', inplace=True)
        
        # Ensure column names are lowercase for pandas-ta
        df.columns = [col.lower() for col in df.columns]

        # --- FIX: Add a check for sufficient data length ---
        # The longest period needed is for SMA(50). If we have fewer than 50 data points,
        # many indicators will fail to calculate, causing an error. It's better to
        # return a valid, empty analysis than to crash the request.
        MIN_HISTORY_LENGTH = 50
        if len(df) < MIN_HISTORY_LENGTH:
            logging.warning(f"Insufficient historical data for {symbol} (has {len(df)}, needs {MIN_HISTORY_LENGTH}). Skipping analysis.")
            # Return a valid structure with no analysis, so Node.js doesn't fail.
            return jsonify({
                'indicators': {},
                'recommendedSignal': None,
                'signal': None,
                'customStrategyMatches': []
            })

        try:
            # --- 2. Calculate Technical Indicators using pandas-ta ---
            # This is much cleaner and more powerful than the previous JS implementation.
            df.ta.rsi(length=14, append=True)
            df.ta.macd(fast=12, slow=26, signal=9, append=True)
            df.ta.sma(length=5, append=True)
            df.ta.sma(length=20, append=True)
            df.ta.sma(length=50, append=True)
            df.ta.bbands(length=20, std=2, append=True)
            df.ta.stoch(k=14, d=3, smooth_k=3, append=True)
            df.ta.obv(append=True)
            df.ta.atr(length=14, append=True)
        except Exception as e:
            # If any indicator calculation fails, return an error for this stock
            logging.error(f"Indicator calculation failed for {symbol}: {e}", exc_info=True)
            return jsonify({"error": f"Indicator calculation failed for {stock_quote.get('symbol', 'UNKNOWN')}: {str(e)}"}), 500

        # --- 3. Extract latest indicator values ---
        latest = df.iloc[-1]
        previous = df.iloc[-2] if len(df) > 1 else latest

        # Helper to safely get a value and convert NaN to None
        def get_val(series, key):
            val = series.get(key)
            return None if val is None or np.isnan(val) else val

        indicators = {
            'rsi': get_val(latest, 'RSI_14'),
            'atr': get_val(latest, 'ATRr_14'),
            'sma5': get_val(latest, 'SMA_5'),
            'sma20': get_val(latest, 'SMA_20'),
            'sma50': get_val(latest, 'SMA_50'),
            'prev_sma20': get_val(previous, 'SMA_20'),
            'prev_sma50': get_val(previous, 'SMA_50'),
            'macd': {
                'macd': get_val(latest, 'MACD_12_26_9'),
                'histogram': get_val(latest, 'MACDh_12_26_9'),
                'signal': get_val(latest, 'MACDs_12_26_9')
            } if 'MACD_12_26_9' in latest else None,
            'bbands': {
                'lower': get_val(latest, 'BBL_20_2.0'),
                'middle': get_val(latest, 'BBM_20_2.0'),
                'upper': get_val(latest, 'BBU_20_2.0')
            } if 'BBL_20_2.0' in latest else None,
            'stochastic': {
                'k': get_val(latest, 'STOCHk_14_3_3'),
                'd': get_val(latest, 'STOCHd_14_3_3')
            } if 'STOCHk_14_3_3' in latest else None,
            'obv': {
                'obv': get_val(latest, 'OBV'),
                'prev_obv': get_val(previous, 'OBV')
            } if 'OBV' in latest else None,
            'avgVolume20': df['volume'].tail(21).iloc[:-1].mean(),
            'avg5DayVolume': df['volume'].tail(6).iloc[:-1].mean()
        }

        # --- 4. Evaluate Strategies ---
        recommended_signal = evaluate_composite_strategy(stock_quote, indicators)
        user_signal = None
        # --- REFACTORED: Use a helper function for cleaner evaluation ---
        for strategy in user_strategies:
            field = strategy.get('field')
            stock_value = None
            if field == 'price': stock_value = stock_quote.get('regularMarketPrice')
            elif field == 'change': stock_value = stock_quote.get('regularMarketChangePercent')
            elif field in indicators: stock_value = indicators.get(field)

            if _check_condition(stock_value, strategy.get('operator'), strategy.get('value')):
                user_signal = strategy.get('signal')
                break # Stop after the first match
        custom_strategy_matches = [{'name': name, 'type': s['type']} for name, s in CUSTOM_STRATEGY_REGISTRY.items() if s['eval'](stock_quote, indicators)]

        # --- 5. Prepare and return response ---
        logging.info(f"Successfully analyzed symbol: {symbol}")
        return jsonify({
            'indicators': indicators,
            'recommendedSignal': recommended_signal,
            'signal': user_signal,
            'customStrategyMatches': custom_strategy_matches
        })

    except Exception as e:
        # This is a critical catch-all to prevent the entire service from crashing.
        # A crash would lead to the 'ECONNREFUSED' error in Node.js.
        # By catching the error and returning a 500, we allow the Node.js
        # server to continue its scan with other stocks.
        # Use exc_info=True to log the full stack trace.
        logging.error(f"CRITICAL ERROR analyzing {symbol}: {e}", exc_info=True)
        return jsonify({"error": f"An unexpected internal server error occurred while analyzing {symbol}: {str(e)}"}), 500

@app.route('/health', methods=['GET'])
def health_check():
    """A simple health check endpoint to confirm the service is running."""
    return jsonify({"status": "ok", "message": "Analysis service is running"}), 200

if __name__ == '__main__':
    # Use Waitress, a production-grade WSGI server that can handle concurrent requests.
    # The default Flask server is single-threaded and not suitable for production,
    # which can cause the "instability" and timeouts you're seeing when the
    # Node.js server sends many parallel analysis requests.
    # Waitress is a pure-Python server that works well on Windows, macOS, and Linux.
    print("Starting Python analysis service with Waitress server on http://0.0.0.0:5000")
    serve(app, host='0.0.0.0', port=5000, threads=8)