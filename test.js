import YahooFinance from 'yahoo-finance2';
import axios from 'axios';

const yahooFinance = new YahooFinance(
    {
        suppressNotices: ["ripHistorical","yahooSurvey"]
    }
);

async function test() {
    console.log("🔍 Starting API Test...");

    // 1. ทดสอบ Fear & Greed (Sentiment)
    try {
        const fng = await axios.get('https://api.alternative.me/fng/');
        console.log("✅ Fear & Greed API: Connected!");
        console.log("   Value:", fng.data.data[0].value);
    } catch (e) {
        console.log("❌ Fear & Greed API: Failed!", e.message);
    }

    // 2. ทดสอบ Yahoo Finance (Price & History)
    try {
        const symbol = 'BTC-USD';
        console.log(`\n🔍 Testing Yahoo Finance with ${symbol}...`);
        const quote = await yahooFinance.quote(symbol);
        console.log("✅ Yahoo Quote: Connected!");
        console.log("   Current Price:", quote.regularMarketPrice);

        const history = await yahooFinance.historical(symbol, {
            period1: new Date('2025-01-01'),
            period2: new Date(),
            interval: '1d'
        });
        console.log("✅ Yahoo Historical: Connected!");
        console.log("   Data Points:", history.length);
    } catch (e) {
        console.log("❌ Yahoo Finance: Failed!");
        console.log("   Reason:", e.message);
    }
}

test();