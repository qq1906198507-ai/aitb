/** Frozen local research fixtures. These routes never create quotes or business events. */
const NetSaveEngine = require('./engine');

const VERSION = '1';
const FIXED_TIME = '2026-10-20T07:00:00.000Z';
const FIXED_TIMESTAMP = Date.parse(FIXED_TIME);
const PREFERENCES = { maxItems: 3, maxAdditionCost: 10, excludeIds: [], strategy: 'saving' };
const PROMOTIONS = {
    minimumOrder: 25,
    fullReduction: [
        { threshold: 80, discount: 20, label: '满80减20' },
        { threshold: 50, discount: 10, label: '满50减10' },
        { threshold: 30, discount: 5, label: '满30减5' }
    ],
    coupons: [
        { id: 'c1', threshold: 0, discount: 5, label: '5元券', stackable: false },
        { id: 'c2', threshold: 40, discount: 3, label: '满40减3元', stackable: true }
    ],
    delivery: { baseFee: 5, freeThreshold: 40, label: '配送费5元，满40免配送费', peakHours: { enabled: false } }
};
const CART = [
    { id: 'p1', name: '招牌红烧肉套餐', desc: '红烧肉 + 米饭 + 时蔬', emoji: '🍖', price: 28, stock: 10 },
    { id: 'p2', name: '酸辣土豆丝', desc: '酸辣开胃，分量足', emoji: '🥔', price: 12, stock: 10 },
    { id: 'p3', name: '柠檬茶', desc: '清爽解腻', emoji: '🍋', price: 8, stock: 10 }
].map(item => ({ ...item, packagingFee: 0, inCart: true, quantity: 1 }));
const CANDIDATES = [
    { id: 'r1', name: '卤蛋', desc: '秘制卤味', emoji: '🥚', price: 3, stock: 10 },
    { id: 'r2', name: '凉拌黄瓜', desc: '清爽小菜', emoji: '🥒', price: 4, stock: 5 },
    { id: 'r3', name: '酸梅汤', desc: '冰镇酸梅汤', emoji: '🧃', price: 5, stock: 8 },
    { id: 'r4', name: '米饭', desc: '东北大米', emoji: '🍚', price: 2, stock: 20 },
    { id: 'r5', name: '可乐', desc: '330ml', emoji: '🥤', price: 2.5, stock: 3 }
].map(item => ({ ...item, packagingFee: 0, flashSale: null, inCart: false, quantity: 1 }));
const TASKS = [
    { id: 'saving', title: '差一点享受满减', goal: '保留原购物车，在加购商品预算10元、最多3件内选择能降低实付的方案。', currentItems: CART },
    { id: 'minimum-order', title: '差一点到起送价', goal: '保留原购物车，在加购商品预算10元、最多3件内补到起送价，并判断补单后实付。', currentItems: CART.filter(item => item.id !== 'p1') }
];
const cents = value => Math.round((Number(value) + Number.EPSILON) * 100);
const invalid = message => Object.assign(new Error(message), { statusCode: 400 });

function exactObject(value, keys, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length
        || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
        || Object.keys(value).some(key => !keys.includes(key))) throw invalid(message);
}

function taskFor(id) {
    const task = typeof id === 'string' && TASKS.find(candidate => candidate.id === id);
    if (!task) throw invalid('研究任务 ID 无效');
    return structuredClone(task);
}

function registerResearchRoutes(app) {
    // Separate from the application's engine, including its latency statistics.
    const engine = new NetSaveEngine({ promotions: structuredClone(PROMOTIONS), now: () => FIXED_TIMESTAMP });
    const baselineFor = task => engine.calcPriceBreakdown(task.currentItems, FIXED_TIMESTAMP);
    const route = handler => (req, res, next) => {
        try { res.json(handler(req)); } catch (error) { next(error); }
    };

    app.get('/api/research/tasks', route(() => ({
        version: VERSION, fixedTime: FIXED_TIME,
        notice: '本地任务研究工具：商品、优惠和计价时间固定；不产生真实订单，不写入业务采纳或净省统计。未实际招募参与者的记录只能作为演示数据。',
        preferences: structuredClone(PREFERENCES),
        tasks: TASKS.map(source => {
            const task = structuredClone(source);
            return { ...task, recommendItems: structuredClone(CANDIDATES), promotions: structuredClone(PROMOTIONS), baseline: baselineFor(task) };
        })
    })));

    app.post('/api/research/solve', route(req => {
        exactObject(req.body, ['taskId'], '求解请求只能包含 taskId');
        const task = taskFor(req.body.taskId);
        const result = engine.calculate({ currentItems: task.currentItems, recommendItems: structuredClone(CANDIDATES), preferences: structuredClone(PREFERENCES) });
        return { taskId: task.id, version: VERSION, fixedTime: FIXED_TIME, mode: result.mode,
            baseline: result.breakdown, suggestions: result.alternatives, preferences: structuredClone(PREFERENCES) };
    }));

    app.post('/api/research/evaluate', route(req => {
        exactObject(req.body, ['taskId', 'additions'], '评估请求只能包含 taskId 和 additions');
        const task = taskFor(req.body.taskId);
        if (!Array.isArray(req.body.additions) || req.body.additions.length > CANDIDATES.length) throw invalid('加购商品必须是候选商品数组');
        const seen = new Set();
        let itemCount = 0;
        let additionCents = 0;
        const additions = req.body.additions.map(item => {
            exactObject(item, ['id', 'quantity'], '加购项只能包含 id 和 quantity');
            const source = typeof item.id === 'string' && CANDIDATES.find(candidate => candidate.id === item.id);
            if (!source || seen.has(item.id)) throw invalid('加购商品 ID 未知或重复');
            if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > source.stock) throw invalid('加购数量无效或超过库存');
            seen.add(item.id);
            itemCount += item.quantity;
            additionCents += cents(source.price) * item.quantity;
            return { ...structuredClone(source), inCart: true, quantity: item.quantity };
        });
        if (itemCount > PREFERENCES.maxItems) throw invalid('最多加购3件商品');
        if (additionCents > cents(PREFERENCES.maxAdditionCost)) throw invalid('加购商品金额不能超过10元');
        const baseline = baselineFor(task);
        const breakdown = engine.calcPriceBreakdown([...task.currentItems, ...additions], FIXED_TIMESTAMP);
        const paymentChangeCents = cents(breakdown.total) - cents(baseline.total);
        const kind = baseline.orderable ? 'saving' : 'minimum-order';
        const netSavingCents = baseline.orderable && breakdown.orderable ? Math.max(0, -paymentChangeCents) : 0;
        return { taskId: task.id, version: VERSION, fixedTime: FIXED_TIME, baseline, breakdown, additions, itemCount,
            additionCost: additionCents / 100, newTotal: cents(breakdown.total) / 100, netSaving: netSavingCents / 100,
            paymentChange: paymentChangeCents / 100, objectiveMet: kind === 'minimum-order' ? breakdown.orderable : breakdown.orderable && netSavingCents > 0, kind };
    }));
}

module.exports = { registerResearchRoutes };
