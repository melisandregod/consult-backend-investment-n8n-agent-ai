import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import YahooFinance from 'yahoo-finance2';
import { RSI, EMA } from 'technicalindicators';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const yahooFinance = new YahooFinance({ suppressNotices: ["ripHistorical","yahooSurvey"] });
const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3001', 10);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT || 'service_account.json';

if (!SPREADSHEET_ID) {
    throw new Error('Missing SPREADSHEET_ID in environment variables.');
}

const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// Helper: ล้าง String ให้เป็นตัวเลข
const cleanNum = (val) => {
    if (!val) return 0;
    const cleaned = String(val).replace(/[^0-9.-]+/g, "");
    return parseFloat(cleaned) || 0;
};

async function getPortfolioSummary() {
    const client = await auth.getClient();
    const gs = google.sheets({ version: 'v4', auth: client });
    const res = await gs.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Portfolio_Summary!A2:H' });
    const rows = res.data.values;
    if (!rows) return [];

    return rows.map(r => {
        const symbol = r[0];
        // 🔴 แก้ไข Index ตรงนี้ให้ตรงกับไฟล์ CSV
        const avg_cost = cleanNum(r[4]);      // คอลัมน์ E (Index 4) คือ Average Cost
        const current_alloc = cleanNum(r[6]) / 100; // คอลัมน์ G (Index 6)
        const target_alloc = cleanNum(r[7]) / 100;  // คอลัมน์ H (Index 7)

        console.log(`[Data] ${symbol} | Real AvgCost: ${avg_cost} | Target: ${target_alloc*100}%`);

        return { symbol, avg_cost, current_alloc, target_alloc };
    }).filter(i => i.symbol);
}

async function getRemainingBudget() {
    const client = await auth.getClient();
    const gs = google.sheets({ version: 'v4', auth: client });
    const res = await gs.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Budget_Log!A2:D' });
    const rows = res.data.values;
    if (!rows || rows.length === 0) return 300;
    return cleanNum(rows[rows.length - 1][3]); // คอลัมน์ D: Remaining
}

async function getMarketInfo(symbol, options = {}) {
    const { days = 365, includeQuote = true } = options;
    try {
        let ySym = symbol.trim().toUpperCase();
        if (['BTC', 'ETH', 'SOL'].includes(ySym)) ySym += '-USD';
        const history = await yahooFinance.historical(ySym, {
            period1: new Date(new Date().setDate(new Date().getDate() - days)),
            period2: new Date(),
            interval: '1d'
        });
        const closes = history.map(c => c.close).filter(v => v != null);
        let price = closes[closes.length - 1] || 0;
        if (includeQuote) {
            const quote = await yahooFinance.quote(ySym);
            price = quote?.regularMarketPrice || quote?.price || price;
        }
        return { price, closes, history };
    } catch (e) { return { price: 0, closes: [], history: [] }; }
}

function computeDecision({ price, closes, avg_cost, current_alloc, target_alloc, fng, budget = 0, history = null }) {
    let score = 0;
    let reasons = [];

    const avgCostAvailable = avg_cost > 0;
    const avgCostDiffAbs = avgCostAvailable ? (price - avg_cost) : null;
    const avgCostDiffPct = avgCostAvailable ? ((price - avg_cost) / avg_cost) * 100 : null;
    const isAboveAvgCost = avgCostAvailable ? price > avg_cost : null;

    // 1. Technical (30%) - RSI & Trend
    const rsiArr = RSI.calculate({ values: closes, period: 14 });
    const emaArr = EMA.calculate({ values: closes, period: 200 });
    const rsi = rsiArr[rsiArr.length - 1];
    const ema200 = emaArr[emaArr.length - 1];
    if (rsi == null || ema200 == null) {
        return { score: 0, reasons: ["⚠️ Insufficient indicator data"], action: "WAIT", recommend_usd: 0, status: "Insufficient Data" };
    }

    // 1.1 Volume Shock (20-day)
    let volumeShockPct = null;
    let volumeShock = null;
    if (history && history.length) {
        const volumes = history.map(h => h.volume).filter(v => v != null);
        if (volumes.length >= 20) {
            const lastVol = volumes[volumes.length - 1];
            const avg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            if (avg20 > 0 && lastVol != null) {
                volumeShockPct = ((lastVol - avg20) / avg20) * 100;
                volumeShock = Math.abs(volumeShockPct) >= 50;
                volumeShockPct = Math.round(volumeShockPct * 100) / 100;
            }
        }
    }

    // 1.2 Distance from ATH
    const ath = Math.max(...closes);
    const distFromAthPct = ath > 0 ? Math.round((((price - ath) / ath) * 100) * 100) / 100 : null;

    // 1.3 Risk/Reward vs Support (60-day low)
    const supportLookback = Math.min(60, closes.length);
    const support = Math.min(...closes.slice(-supportLookback));
    const supportDistance = (supportLookback && support > 0) ? Math.round((price - support) * 100) / 100 : null;
    const downside = supportDistance != null ? supportDistance : null;
    const upside = Math.round(Math.abs(ema200 - price) * 100) / 100;
    const riskRewardRatio = (downside != null && downside > 0) ? Math.round((upside / downside) * 100) / 100 : null;

    // 2. Valuation (30%) - เทียบกับกราฟ (EMA200)
    const priceDiff = ((price - ema200) / ema200) * 100;
    if (priceDiff < -5) { score += 30; reasons.push(`✅ Below EMA200 >5% (${priceDiff.toFixed(1)}%)`); }
    else if (priceDiff < 0) { score += 20; reasons.push(`✅ Below EMA200 (${priceDiff.toFixed(1)}%)`); }
    else if (priceDiff < 10) { score += 10; reasons.push(`⚠️ Slightly Above EMA200 (+${priceDiff.toFixed(1)}%)`); }
    else { reasons.push(`❌ Over EMA200 (+${priceDiff.toFixed(1)}%)`); }

    if (rsi < 30) { score += 15; reasons.push(`✅ RSI Oversold (${rsi.toFixed(0)})`); }
    else if (rsi < 50) { score += 10; reasons.push(`⚠️ RSI Low (${rsi.toFixed(0)})`); }

    if (price > ema200) { score += 15; reasons.push("✅ Uptrend (Above EMA200)"); }
    else { reasons.push("⚠️ Downtrend (Below EMA200)"); }

    // 3. Sentiment (20%) - Fear & Greed
    if (fng < 25) { score += 20; reasons.push(`✅ Extreme Fear (${fng})`); }
    else if (fng < 45) { score += 10; reasons.push(`⚠️ Market Fear (${fng})`); }

    // 4. Allocation (20%) - วินัยตามเป้าหมาย
    const allocGap = (target_alloc - current_alloc) * 100;
    if (allocGap > 5) { 
        score += 20; 
        reasons.push(`✅ Below Target >5% (Gap: ${allocGap.toFixed(1)}%)`); 
    } else if (allocGap > 0) {
        score += 10;
        reasons.push(`⚠️ Below Target (Gap: ${allocGap.toFixed(1)}%)`);
    }

    let action = "WAIT";
    let rec_usd = 0;
    if (score >= 85) { action = "STRONG_BUY 🚀"; rec_usd = budget + 100; }
    else if (score >= 60) { action = "BUY ✅"; rec_usd = budget; }
    else if (score >= 40) { action = "ACCUMULATE ⚠️"; rec_usd = budget * 0.5; }

    return {
        score,
        reasons,
        action,
        recommend_usd: Math.round(rec_usd),
        avg_cost_available: avgCostAvailable,
        avg_cost_diff_abs: avgCostAvailable ? Math.round(avgCostDiffAbs * 100) / 100 : null,
        avg_cost_diff_pct: avgCostAvailable ? Math.round(avgCostDiffPct * 100) / 100 : null,
        is_above_avg_cost: isAboveAvgCost,
        rsi: Math.round(rsi * 100) / 100,
        ema200: Math.round(ema200 * 100) / 100,
        volume_shock_pct: volumeShockPct,
        volume_shock: volumeShock,
        dist_from_ath_pct: distFromAthPct,
        support_distance: supportDistance,
        risk_reward_ratio: riskRewardRatio
    };
}

function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function analyze(asset, budget, fng) {
    const { symbol, avg_cost, current_alloc, target_alloc } = asset;
    const { price, closes, history } = await getMarketInfo(symbol);

    if (price === 0 || closes.length < 200) return { symbol, status: "Insufficient Data" };

    const decision = computeDecision({ price, closes, avg_cost, current_alloc, target_alloc, fng, budget, history });
    if (decision.status === "Insufficient Data") return { symbol, status: "Insufficient Data" };

    return {
        symbol,
        price,
        score: decision.score,
        action: decision.action,
        recommend_usd: decision.recommend_usd,
        reasons: decision.reasons,
        avg_cost_available: decision.avg_cost_available,
        avg_cost_diff_abs: decision.avg_cost_diff_abs,
        avg_cost_diff_pct: decision.avg_cost_diff_pct,
        is_above_avg_cost: decision.is_above_avg_cost,
        rsi: decision.rsi,
        ema200: decision.ema200,
        volume_shock_pct: decision.volume_shock_pct,
        volume_shock: decision.volume_shock,
        dist_from_ath_pct: decision.dist_from_ath_pct,
        support_distance: decision.support_distance,
        risk_reward_ratio: decision.risk_reward_ratio
    };
}

async function backtestSymbol(asset, fng, lookaheadDays, days) {
    const { symbol, avg_cost, current_alloc, target_alloc } = asset;
    const { history } = await getMarketInfo(symbol, { days, includeQuote: false });
    if (!history || history.length < 220) {
        return { symbol, signals: 0, hit_rate: 0, avg_return_pct: 0, median_return_pct: 0 };
    }

    const returns = [];
    for (let i = 200; i < history.length - lookaheadDays; i++) {
        const slice = history.slice(0, i + 1);
        const closes = slice.map(c => c.close).filter(v => v != null);
        const price = history[i].close;
        if (!price || closes.length < 200) continue;

        const decision = computeDecision({ price, closes, avg_cost, current_alloc, target_alloc, fng, budget: 0 });
        if (decision.status === "Insufficient Data") continue;
        if (decision.action === "WAIT") continue;

        const future = history[i + lookaheadDays]?.close;
        if (!future) continue;
        const ret = (future - price) / price;
        returns.push(ret);
    }

    const signals = returns.length;
    const hitRate = signals ? (returns.filter(r => r > 0).length / signals) : 0;
    const avgReturn = signals ? (returns.reduce((a, b) => a + b, 0) / signals) : 0;
    const medReturn = median(returns);

    return {
        symbol,
        signals,
        hit_rate: Math.round(hitRate * 1000) / 10,
        avg_return_pct: Math.round(avgReturn * 1000) / 10,
        median_return_pct: Math.round(medReturn * 1000) / 10
    };
}

app.get('/analyze', async (req, res) => {
    try {
        const [portfolio, budget, fngRes] = await Promise.all([
            getPortfolioSummary(), getRemainingBudget(), axios.get('https://api.alternative.me/fng/')
        ]);
        const fng = parseInt(fngRes.data.data[0].value);
        const results = await Promise.all(portfolio.map(a => analyze(a, budget, fng)));
        res.json({ budget_remaining: budget, fear_greed: fng, analysis: results });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/backtest', async (req, res) => {
    try {
        const lookahead = parseInt(req.query.lookahead || '20');
        const days = parseInt(req.query.days || '720');
        const [portfolio, fngRes] = await Promise.all([
            getPortfolioSummary(), axios.get('https://api.alternative.me/fng/')
        ]);
        const fng = parseInt(fngRes.data.data[0].value);
        const results = await Promise.all(portfolio.map(a => backtestSymbol(a, fng, lookahead, days)));

        const allSignals = results.reduce((sum, r) => sum + r.signals, 0);
        const avgHitRate = results.length ? (results.reduce((sum, r) => sum + r.hit_rate, 0) / results.length) : 0;
        const avgReturn = results.length ? (results.reduce((sum, r) => sum + r.avg_return_pct, 0) / results.length) : 0;
        const avgMedian = results.length ? (results.reduce((sum, r) => sum + r.median_return_pct, 0) / results.length) : 0;

        res.json({
            lookahead_days: lookahead,
            history_days: days,
            fear_greed: fng,
            total_signals: allSignals,
            avg_hit_rate_pct: Math.round(avgHitRate * 10) / 10,
            avg_return_pct: Math.round(avgReturn * 10) / 10,
            avg_median_return_pct: Math.round(avgMedian * 10) / 10,
            per_symbol: results
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Brain running at http://localhost:${PORT}`));
