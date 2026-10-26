/** Local NetSave API. All money, inventory and recorded savings are server-derived. */
const path = require('path');
const express = require('express');
const cors = require('cors');
const NetSaveEngine = require('./engine');
const { PRODUCTS, PROMOTIONS } = require('./data');
const { DemoStore, fail, cents } = require('./store');
const { registerResearchRoutes } = require('./research');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_CART = [
    { id: 'p1', name: '招牌红烧肉套餐', desc: '红烧肉 + 米饭 + 时蔬', price: 28, emoji: '🍖', quantity: 1, inCart: true },
    { id: 'p2', name: '酸辣土豆丝', desc: '酸辣开胃，分量足', price: 12, emoji: '🥔', quantity: 1, inCart: true },
    { id: 'p3', name: '柠檬茶', desc: '鲜榨柠檬，清爽解腻', price: 8, emoji: '🍋', quantity: 1, inCart: true }
];
DEFAULT_CART.forEach(item => { item.packagingFee = 0; });

function createApp(options = {}) {
    const app = express();
    const now = options.now || (() => Date.now());
    const promotions = options.promotions || PROMOTIONS;
    const engine = options.engine || new NetSaveEngine({ promotions, now });
    const catalog = new Map((options.catalog || [...DEFAULT_CART, ...PRODUCTS.recommend]).map(item => [item.id, item]));
    const store = new DemoStore(options.dataDir || process.env.NETSAVE_DATA_DIR || path.join(__dirname, 'storage'), now);
    app.locals.engine = engine;
    app.locals.store = store;
    app.use(cors());
    app.use(express.json({ limit: '64kb' }));
    app.use((req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    function normalizeItems(items, current) {
        if (!Array.isArray(items) || items.length > 50) throw fail(400, '商品列表必须是最多 50 项的数组');
        const ids = new Set();
        return items.map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string'
                || !catalog.has(item.id) || ids.has(item.id)) throw fail(400, '商品 ID 未知或重复');
            ids.add(item.id);
            for (const key of ['price', 'quantity', 'stock', 'packagingFee']) {
                if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0)) {
                    throw fail(400, '商品价格、数量和库存必须是有效的非负数');
                }
            }
            const source = catalog.get(item.id);
            const quantity = current ? item.quantity : 1;
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100
                || (current && source.stock !== undefined && quantity > source.stock)
                || (item.quantity !== undefined && (!Number.isInteger(item.quantity) || item.quantity < 1))) {
                throw fail(400, '商品数量无效或超过库存');
            }
            if (item.inCart !== undefined && typeof item.inCart !== 'boolean') throw fail(400, '购物车标记无效');
            return { ...structuredClone(source), packagingFee: source.packagingFee || 0, quantity, inCart: current ? item.inCart !== false : false };
        });
    }

    function normalizeInput(body) {
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, '请求必须是 JSON 对象');
        const preferences = engine.normalizePreferences(body.preferences);
        if (preferences.excludeIds.some(id => !catalog.has(id))) throw fail(400, '排除商品必须来自当前商品目录');
        return {
            currentItems: normalizeItems(body.currentItems, true),
            recommendItems: normalizeItems(body.recommendItems, false), preferences
        };
    }

    function validateAcceptance(quote) {
        if (quote.promotionSignature !== JSON.stringify(promotions)) throw fail(409, '优惠规则已变化，请重新计算');
        let input;
        try { input = normalizeInput(quote.input); } catch (_) { throw fail(409, '商品信息已变化，请重新计算'); }
        const acceptanceNow = now();
        const items = quote.suggestion.items || [quote.suggestion.item];
        if (!Array.isArray(items) || !items.length) throw fail(409, '加购方案无效，请重新计算');
        const currentIds = new Set(input.currentItems.filter(item => item.inCart && item.quantity > 0).map(item => item.id));
        const allowedIds = new Set(engine.getCandidates(input.currentItems, input.recommendItems, input.preferences).map(item => item.id));
        const seen = new Set();
        let itemCount = 0, additionCost = 0;
        const additions = items.map(item => {
            const source = catalog.get(item.id);
            const quantity = item.quantity || 1;
            if (!source || !Number.isInteger(quantity) || quantity < 1 || seen.has(item.id)
                || currentIds.has(item.id) || !allowedIds.has(item.id)
                || (source.stock !== undefined && source.stock < quantity)
                || cents(engine.getActualPrice(source, acceptanceNow)) !== cents(item.actualPrice)
                || cents(source.packagingFee || 0) !== cents(item.packagingFee || 0)) {
                throw fail(409, '商品价格或库存已变化，请重新计算');
            }
            seen.add(item.id); itemCount += quantity;
            additionCost += cents(engine.getActualPrice(source, acceptanceNow)) * quantity;
            return { ...source, inCart: true, quantity };
        });
        if (itemCount > input.preferences.maxItems || itemCount !== quote.suggestion.itemCount
            || (input.preferences.maxAdditionCost !== null && additionCost / 100 > input.preferences.maxAdditionCost)
            || additionCost !== cents(quote.suggestion.additionCost)) throw fail(409, '方案不符合加购件数、预算或排除条件，请重新计算');
        const current = engine.calcPriceBreakdown(input.currentItems, acceptanceNow);
        const updated = engine.calcPriceBreakdown([...input.currentItems, ...additions], acceptanceNow);
        const kind = quote.suggestion.kind || 'saving';
        const expectedKind = current.orderable ? 'saving' : 'minimum-order';
        const actualSaving = kind === 'minimum-order' ? 0 : cents(Number(current.total) - Number(updated.total));
        if (cents(current.total) !== cents(quote.suggestion.currentTotal)
            || cents(updated.total) !== cents(quote.suggestion.newTotal)
            || !updated.orderable || kind !== expectedKind || actualSaving !== cents(quote.suggestion.netSaving)
            || (kind === 'saving' && actualSaving <= 0)
            || (quote.suggestion.paymentChange !== undefined
                && cents(quote.suggestion.paymentChange) !== cents(Number(updated.total) - Number(current.total)))) {
            throw fail(409, '结算价格已变化，请重新计算');
        }
    }

    // 演示级偏好排序：在引擎给出的可行方案内，按本机历史品类权重微调次序；
    // 只影响展示顺序，不改变方案内容、金额或采纳复核结果。
    function applyPreferenceRanking(suggestions, affinity) {
        const boost = suggestion => suggestion.items.reduce(
            (sum, item) => sum + (affinity.get(item.category) || 0), 0) * 50;
        return [...suggestions].sort((a, b) => {
            const scoreA = (a.kind === 'minimum-order' ? -cents(a.paymentChange) : cents(a.netSaving)) + boost(a);
            const scoreB = (b.kind === 'minimum-order' ? -cents(b.paymentChange) : cents(b.netSaving)) + boost(b);
            return scoreB - scoreA || Number(a.newTotal) - Number(b.newTotal) || a.itemCount - b.itemCount
                || a.items.map(item => `${item.id}x${item.quantity}`).join(',').localeCompare(
                    b.items.map(item => `${item.id}x${item.quantity}`).join(','));
        });
    }

    function preferenceSummary(applied) {
        const affinity = store.categoryAffinity();
        return {
            applied: Boolean(applied) && [...affinity.values()].some(value => value !== 0),
            affinity: Object.fromEntries([...affinity].filter(([, value]) => value !== 0))
        };
    }

    app.get('/health', (req, res) => res.json({ status: 'ok', service: 'netsave-engine', version: '1.5.0', timestamp: new Date(now()).toISOString() }));
    app.get('/api/cart/default', (req, res) => res.json({ currentItems: DEFAULT_CART, recommendItems: PRODUCTS.recommend }));
    app.get('/api/products/recommend', (req, res) => res.json(PRODUCTS.recommend));
    app.get('/api/promotions', (req, res) => res.json(promotions));
    app.post('/api/calculate', (req, res, next) => {
        try {
            const input = normalizeInput(req.body);
            const result = engine.calculate(input);
            result.alternatives = store.addQuotes(result.alternatives || (result.suggestion ? [result.suggestion] : []), input, JSON.stringify(promotions));
            const usePreference = input.preferences.strategy === 'preference';
            if (usePreference) result.alternatives = applyPreferenceRanking(result.alternatives, store.categoryAffinity());
            result.preference = preferenceSummary(usePreference);
            result.suggestion = result.alternatives[0] || null;
            res.json({ success: true, ...result });
        } catch (error) { next(error); }
    });
    app.post('/api/calculate/batch', (req, res, next) => {
        try {
            const input = normalizeInput(req.body);
            const calculationNow = now();
            const breakdown = engine.calcPriceBreakdown(input.currentItems, calculationNow);
            let suggestions = engine.rankSuggestions(input.currentItems, input.recommendItems, calculationNow, input.preferences);
            const usePreference = input.preferences.strategy === 'preference';
            if (usePreference) suggestions = applyPreferenceRanking(suggestions, store.categoryAffinity());
            res.json({
                success: true, currentTotal: Number(breakdown.total), breakdown, preferences: input.preferences,
                mode: input.currentItems.some(item => item.inCart && item.quantity > 0) && !breakdown.orderable ? 'minimum-order' : 'saving',
                suggestions, preference: preferenceSummary(usePreference), search: { maxItems: input.preferences.maxItems,
                    candidateCount: engine.getCandidates(input.currentItems, input.recommendItems, input.preferences).length,
                    evaluatedCount: engine.lastCombinationCount, exhaustive: !engine.lastSearch.degraded, degraded: engine.lastSearch.degraded,
                    degradation: engine.lastSearch.degraded ? { ...engine.lastSearch, candidateLimit: engine.searchCandidateLimit } : null,
                    scope: `最多${input.preferences.maxItems}件加购，不调整原购物车；仅搜索当前商品和约束范围${engine.lastSearch.degraded ? '；目录较大，已在实时预算内剪枝/截断求解，不保证全空间最优' : ''}` }
            });
        } catch (error) { next(error); }
    });
    app.post('/api/events', (req, res, next) => {
        try {
            const { recommendationId, type } = req.body || {};
            if (typeof recommendationId !== 'string' || !UUID_PATTERN.test(recommendationId)
                || !['shown', 'accepted', 'rejected', 'reverted'].includes(type)) throw fail(400, '建议 ID 或事件类型无效');
            res.json({ success: true, ...store.record(recommendationId, type, validateAcceptance) });
        } catch (error) { next(error); }
    });
    app.get('/api/suggestions/:id', (req, res, next) => {
        try {
            if (!UUID_PATTERN.test(req.params.id)) throw fail(400, '建议 ID 无效');
            res.json(store.getSuggestion(req.params.id));
        } catch (error) { next(error); }
    });
    app.get('/api/history', (req, res, next) => {
        try {
            const { type = 'all', limit = '20', before } = req.query;
            if (typeof type !== 'string' || typeof limit !== 'string' || !/^(?:[1-9]\d?|100)$/.test(limit)
                || (before !== undefined && (typeof before !== 'string' || !UUID_PATTERN.test(before)))) {
                throw fail(400, '历史筛选或分页参数无效');
            }
            res.json(store.history({ type, limit: Number(limit), before }));
        } catch (error) { next(error); }
    });
    app.get('/api/dashboard', (req, res) => {
        const metrics = typeof engine.getMetrics === 'function' ? engine.getMetrics() : {
            sampleCount: engine.latencySamples.length,
            avgCalcTime: engine.latencySamples.length ? engine.latencySamples.reduce((a, b) => a + b, 0) / engine.latencySamples.length : null,
            p99CalcTime: engine.getP99 ? engine.getP99() : null
        };
        res.json(store.dashboard(metrics));
    });
    app.post('/api/demo/reset', (req, res, next) => {
        try {
            if (!req.body || typeof req.body !== 'object' || req.body.confirm !== '清空演示数据') {
                throw fail(400, '清空演示数据需要携带确认字段，避免误操作');
            }
            store.reset();
            if (typeof engine.resetMetrics === 'function') engine.resetMetrics();
            res.json({ success: true, clearedAt: new Date(now()).toISOString() });
        } catch (error) { next(error); }
    });

    registerResearchRoutes(app);

    // Explicit public files only; never expose source, stored events or dependencies.
    const publicRoot = path.resolve(__dirname, '..');
    const publicFiles = [
        'demo.html', 'index.html', 'mobile.html', 'mobile-api.html', 'dashboard.html',
        'algorithm.js', 'app.js', 'mobile-app.js', 'mobile-api-app.js', 'dashboard-app.js',
        'data.js', 'data-enhanced.js', 'styles.css', 'mobile-styles.css', 'dashboard.css', 'demo-nav.css',
        'history.html', 'history.css', 'history-app.js', 'mobile-api-extra.css',
        'research.html', 'research.css', 'research-app.js'
    ];
    app.get('/', (req, res) => res.redirect('/demo.html'));
    for (const filename of publicFiles) {
        app.get(`/${filename}`, (req, res, next) => {
            res.sendFile(path.join(publicRoot, filename), error => {
                if (error) next(error);
            });
        });
    }
    app.use((req, res) => res.status(404).json({ success: false, error: '未找到该接口或页面' }));
    app.use((error, req, res, next) => {
        const status = error.type === 'entity.parse.failed' ? 400 : error.statusCode || error.status || 500;
        res.status(status).json({ success: false, error: status === 500 ? '服务暂时无法完成请求，请重试' : error.message });
    });
    return app;
}

const app = createApp();
if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || '127.0.0.1';
    app.listen(port, host, () => console.log(`NetSave Engine v1.5.0: http://${host}:${port}`));
}
module.exports = app;
module.exports.createApp = createApp;
