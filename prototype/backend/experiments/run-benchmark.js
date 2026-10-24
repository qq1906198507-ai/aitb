'use strict';

// Independent synthetic verification. Never imports server/store or touches demo events.
process.env.TZ = 'Asia/Shanghai';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const Engine = require('../engine');

const FIXED_NOW = Date.parse('2026-10-20T12:00:00+08:00');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const integerArg = (key, fallback, min, max) => {
    const value = args.has(key) ? Number(args.get(key)) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer in ${min}..${max}`);
    return value;
};
const seed = integerArg('--seed', 20261020, 0, 0xffffffff);
const randomCases = integerArg('--cases', 240, 1, 5000);
const perfSamples = integerArg('--perf-samples', 40, 5, 300);
const outputFile = path.resolve(args.get('--output') || path.join(__dirname, 'results', 'v13-benchmark.json'));
const reportFile = path.resolve(__dirname, '..', '..', 'docs', 'EXPERIMENT_REPORT.md');
let randomState = seed;
function random() { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x100000000; }
const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1));
const clone = (value) => JSON.parse(JSON.stringify(value));

// Separate implementation from engine.js: decimal text -> integer cents, independent pricing,
// and product-by-product quantity-vector enumeration (engine uses selected-item traversal).
function cent(value) {
    const [whole, fraction] = Number(value || 0).toFixed(2).split('.');
    return Number(whole) * 100 + (Number(value) < 0 ? -Number(fraction) : Number(fraction));
}
const yuan = (value) => value / 100;
function actual(item, now) { return cent(item.flashSale && now < item.flashSale.endTime ? item.flashSale.salePrice : item.price); }
function independentPrice(items, rules, now) {
    const active = items.filter((item) => item.inCart && item.quantity > 0);
    const minimum = cent(rules.minimumOrder || 0);
    if (!active.length) return { subtotal: 0, packagingFee: 0, deliveryFee: 0, fullReduction: 0, coupon: 0, total: 0, minimumOrder: minimum, minimumOrderGap: minimum, orderable: false };
    const subtotal = active.reduce((sum, item) => sum + actual(item, now) * item.quantity, 0);
    const packagingFee = active.reduce((sum, item) => sum + cent(item.packagingFee || 0) * item.quantity, 0);
    const delivery = rules.delivery || {};
    let deliveryFee = subtotal < cent(delivery.freeThreshold || 0) ? cent(delivery.baseFee || 0) : 0;
    const peak = delivery.peakHours || {};
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
    if (peak.enabled && (peak.timeRanges || []).some((range) => range.start <= clock && clock <= range.end)) deliveryFee += cent(peak.extraFee || 0);
    let fullReduction = 0;
    for (const rule of rules.fullReduction || []) if (subtotal >= cent(rule.threshold)) fullReduction = Math.max(fullReduction, cent(rule.discount));
    fullReduction = Math.min(subtotal, fullReduction);
    let stacking = 0, exclusive = 0;
    for (const coupon of rules.coupons || []) {
        if (subtotal < cent(coupon.threshold || 0) || (coupon.startTime !== undefined && now < coupon.startTime)
            || (coupon.endTime !== undefined && now >= coupon.endTime)
            || (coupon.category && !active.some((item) => item.category === coupon.category))) continue;
        if (coupon.stackable === true) stacking += cent(coupon.discount);
        else exclusive = Math.max(exclusive, cent(coupon.discount));
    }
    const coupon = Math.min(subtotal + packagingFee + deliveryFee - fullReduction, stacking + exclusive);
    return { subtotal, packagingFee, deliveryFee, fullReduction, coupon,
        total: subtotal + packagingFee + deliveryFee - fullReduction - coupon,
        minimumOrder: minimum, minimumOrderGap: Math.max(0, minimum - subtotal), orderable: subtotal >= minimum };
}

function independentContext(scenario) {
    const { currentItems, recommendItems, preferences = {} } = scenario.input;
    const prefs = { maxItems: 2, maxAdditionCost: null, excludeIds: [], strategy: 'saving', ...preferences };
    const cart = currentItems.filter((item) => item.inCart && item.quantity > 0);
    const forbidden = new Set([...cart.map((item) => item.id), ...prefs.excludeIds]);
    const candidates = [];
    for (const item of recommendItems) {
        if (item.inCart || forbidden.has(item.id)) continue;
        forbidden.add(item.id);
        if ((item.stock === undefined || item.stock >= 1) && Number.isFinite(item.price) && item.price >= 0) candidates.push(item);
    }
    const before = independentPrice(cart, scenario.promotions, scenario.now);
    const mode = cart.length && !before.orderable ? 'minimum-order' : 'saving';
    return { cart, candidates, prefs, before, mode, budget: prefs.maxAdditionCost === null ? Infinity : cent(prefs.maxAdditionCost) };
}

function objective(plan, strategy) { return strategy === 'fewer' ? [plan.count, plan.total, plan.cost] : [plan.total, plan.count, plan.cost]; }
function compare(a, b, strategy) {
    const left = objective(a, strategy), right = objective(b, strategy);
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
}
function evaluateSelection(scenario, context, items) {
    if (!items.length || !context.cart.length) return null;
    const count = items.reduce((sum, item) => sum + item.quantity, 0);
    const cost = items.reduce((sum, item) => sum + actual(item, scenario.now) * item.quantity, 0);
    if (count > context.prefs.maxItems || cost > context.budget) return null;
    const after = independentPrice([...context.cart, ...items.map((item) => ({ ...item, inCart: true }))], scenario.promotions, scenario.now);
    if (!after.orderable || (context.mode === 'saving' && after.total >= context.before.total)) return null;
    return { items: items.map((item) => ({ id: item.id, quantity: item.quantity })), count, cost, total: after.total,
        saved: context.mode === 'saving' ? context.before.total - after.total : 0,
        paymentChange: after.total - context.before.total, after };
}

function oracle(scenario, context = independentContext(scenario)) {
    let best = null, visited = 0;
    const quantities = Array(context.candidates.length).fill(0);
    function visit(index, count, cost) {
        if (index === context.candidates.length) {
            if (!count) return;
            visited++;
            const items = context.candidates.flatMap((item, i) => quantities[i] ? [{ ...item, quantity: quantities[i] }] : []);
            const plan = evaluateSelection(scenario, context, items);
            if (plan && (!best || compare(plan, best, context.prefs.strategy) < 0)) best = plan;
            return;
        }
        const item = context.candidates[index];
        const unitPrice = actual(item, scenario.now);
        const stock = item.stock === undefined ? context.prefs.maxItems : item.stock;
        for (let quantity = 0; quantity <= Math.min(stock, context.prefs.maxItems - count); quantity++) {
            const nextCost = cost + unitPrice * quantity;
            if (nextCost > context.budget) break;
            quantities[index] = quantity;
            visit(index + 1, count + quantity, nextCost);
        }
        quantities[index] = 0;
    }
    visit(0, 0, 0);
    return { best, visited };
}

function singleBaseline(scenario, context) {
    let best = null;
    for (const item of context.candidates) {
        const plan = evaluateSelection(scenario, context, [{ ...item, quantity: 1 }]);
        if (plan && (!best || compare(plan, best, context.prefs.strategy) < 0)) best = plan;
    }
    return best;
}
function greedyBaseline(scenario, context) {
    const sorted = context.candidates.slice().sort((a, b) => actual(a, scenario.now) - actual(b, scenario.now) || a.id.localeCompare(b.id));
    const selected = new Map();
    let count = 0, cost = 0, best = null;
    while (count < context.prefs.maxItems) {
        const item = sorted.find((candidate) => (selected.get(candidate.id)?.quantity || 0) < (candidate.stock ?? context.prefs.maxItems)
            && cost + actual(candidate, scenario.now) <= context.budget);
        if (!item) break;
        const quantity = (selected.get(item.id)?.quantity || 0) + 1;
        selected.set(item.id, { ...item, quantity }); count++; cost += actual(item, scenario.now);
        const plan = evaluateSelection(scenario, context, [...selected.values()]);
        if (plan && (!best || compare(plan, best, context.prefs.strategy) < 0)) best = plan;
    }
    return best;
}

function assessEnginePlan(scenario, context, suggestion) {
    if (!suggestion) return { plan: null, violations: [] };
    const violations = [], ids = new Set();
    const items = [];
    for (const supplied of suggestion.items || []) {
        const product = context.candidates.find((item) => item.id === supplied.id);
        if (!product || ids.has(supplied.id) || !Number.isInteger(supplied.quantity) || supplied.quantity < 1
            || supplied.quantity > (product.stock ?? context.prefs.maxItems)) { violations.push('unknown/excluded/duplicate/out-of-stock item'); continue; }
        ids.add(supplied.id); items.push({ ...product, quantity: supplied.quantity });
    }
    const plan = evaluateSelection(scenario, context, items);
    if (!plan) violations.push('plan violates budget/count/orderability/positive-saving constraints');
    if (plan && (cent(suggestion.newTotal) !== plan.total || cent(suggestion.currentTotal) !== context.before.total
        || cent(suggestion.additionCost) !== plan.cost || cent(suggestion.netSaving) !== plan.saved
        || cent(suggestion.paymentChange) !== plan.paymentChange || suggestion.itemCount !== plan.count || suggestion.kind !== context.mode)) violations.push('amount/count/kind differs from independent calculator');
    return { plan, violations };
}

const product = (id, price, stock = 4, extra = {}) => ({ id, name: id, price, quantity: 1, stock, inCart: false, ...extra });
const cart = (price, extra = {}) => [product('main', price, 100, { inCart: true, ...extra })];
const preferences = (extra = {}) => ({ maxItems: 4, maxAdditionCost: null, excludeIds: [], strategy: 'saving', ...extra });
function scenario(name, currentItems, recommendItems, promotions, prefs = preferences(), now = FIXED_NOW) {
    return { name, now, promotions, input: { currentItems, recommendItems, preferences: prefs } };
}
function boundaryCases() {
    const full = { fullReduction: [{ threshold: 50, discount: 10 }] };
    return [
        scenario('起送18加2达到20', cart(18), [product('side', 2)], { minimumOrder: 20 }),
        scenario('47加三件1元跨50门槛', cart(47), [product('side', 1, 3)], full),
        scenario('三件方案受两件上限约束', cart(47), [product('side', 1, 3)], full, preferences({ maxItems: 2 })),
        scenario('46加四件1元跨50门槛', cart(46), [product('side', 1, 4)], full),
        scenario('四件方案受三件上限约束', cart(46), [product('side', 1, 4)], full, preferences({ maxItems: 3 })),
        scenario('同品库存不足', cart(47), [product('side', 1, 2)], full),
        scenario('异品三件组合', cart(47), [product('a', 1, 1), product('b', 1, 1), product('c', 1, 1)], full),
        scenario('预算不足无法起送', cart(18), [product('side', 2)], { minimumOrder: 20 }, preferences({ maxAdditionCost: 1.99 })),
        scenario('预算边界允许2元', cart(18), [product('side', 2)], { minimumOrder: 20 }, preferences({ maxAdditionCost: 2 })),
        scenario('排除唯一可行商品', cart(18), [product('side', 2)], { minimumOrder: 20 }, preferences({ excludeIds: ['side'] })),
        scenario('用户最多加购零件', cart(18), [product('side', 2)], { minimumOrder: 20 }, preferences({ maxItems: 0 })),
        scenario('空车不劝购', [], [product('side', 2)], { minimumOrder: 20 }),
        scenario('包装配送不计起送', cart(18, { packagingFee: 2 }), [product('side', 2, 3, { packagingFee: 0.5 })], { minimumOrder: 20, delivery: { baseFee: 5, freeThreshold: 40 } }),
        scenario('无收益保持原车', cart(50), [product('side', 2)], full),
        scenario('最低支出与少买偏好不同', cart(47), [product('small', 1, 4), product('big', 4, 1)], full),
        scenario('少买优先选一件', cart(47), [product('small', 1, 4), product('big', 4, 1)], full, preferences({ strategy: 'fewer' })),
        scenario('分钱门槛', cart(0.2), [product('side', 0.1, 1)], { fullReduction: [{ threshold: 0.3, discount: 0.11 }] }),
        scenario('有效闪购与券叠加', cart(48), [product('side', 4, 3, { flashSale: { salePrice: 2, endTime: FIXED_NOW + 1 } })], { ...full, coupons: [{ discount: 1, stackable: true, endTime: FIXED_NOW + 1 }, { discount: 2 }, { discount: 3 }] }),
        scenario('闪购和券在结束时刻失效', cart(48), [product('side', 4, 3, { flashSale: { salePrice: 2, endTime: FIXED_NOW } })], { ...full, coupons: [{ discount: 20, stackable: true, endTime: FIXED_NOW }] }),
        scenario('品类券仅在类别出现时适用', cart(48), [product('side', 2, 1, { category: 'drink' })], { ...full, coupons: [{ discount: 2, category: 'drink', stackable: true }] }),
        scenario('高峰附加费与免配送独立', cart(38), [product('side', 2)], { delivery: { baseFee: 5, freeThreshold: 40, peakHours: { enabled: true, extraFee: 2, timeRanges: [{ start: '11:00', end: '13:00' }] } } }),
        scenario('零元商品和零预算', cart(18), [product('free', 0), product('side', 2)], { minimumOrder: 20 }, preferences({ maxAdditionCost: 0 }))
    ];
}

function randomScenario(index) {
    const size = randomInt(2, 9);
    const price = randomInt(1000, 6900) / 100;
    const candidates = Array.from({ length: size }, (_, i) => {
        const base = randomInt(10, 1000) / 100;
        const item = product(`r${i}`, base, randomInt(0, 4), { category: i % 2 ? 'drink' : 'food', packagingFee: randomInt(0, 2) ? 0 : 0.5 });
        if (randomInt(0, 3) === 0) item.flashSale = { salePrice: Math.max(0, base - randomInt(1, 100) / 100), endTime: FIXED_NOW + (index % 2 ? 1 : 0) };
        return item;
    });
    const minimum = index % 2 === 0 ? Math.round((price + randomInt(100, 900) / 100) * 100) / 100 : Math.max(0, price - 5);
    const threshold = Math.round((price + randomInt(50, 1000) / 100) * 100) / 100;
    const rules = { minimumOrder: minimum, fullReduction: [{ threshold, discount: randomInt(100, 1600) / 100 }, { threshold: threshold + 10, discount: randomInt(1000, 2200) / 100 }],
        coupons: [{ threshold: 0, discount: randomInt(0, 300) / 100, label: 'exclusive-small' }, { threshold: threshold - 5, discount: randomInt(100, 600) / 100, label: 'exclusive-large' },
            { threshold: threshold - 2, discount: randomInt(50, 200) / 100, stackable: true, label: 'stacking' },
            { threshold: 0, discount: 1, stackable: true, category: 'drink', endTime: FIXED_NOW + (index % 3 ? 1 : 0), label: 'category' }],
        delivery: { baseFee: 5, freeThreshold: threshold + 3, peakHours: { enabled: index % 4 === 0, extraFee: 2, timeRanges: [{ start: '11:00', end: '13:00' }] } } };
    const prefs = preferences({ maxItems: index % 19 === 0 ? 0 : randomInt(1, 4), maxAdditionCost: index % 3 === 0 ? null : randomInt(100, 2000) / 100,
        excludeIds: index % 5 === 0 ? [candidates[0].id] : [], strategy: index % 4 === 0 ? 'fewer' : 'saving' });
    return scenario(`seed-${seed}-${index}`, cart(price, { category: 'food', packagingFee: index % 4 === 0 ? 1 : 0 }), candidates, rules, prefs);
}

const scenarios = [...boundaryCases(), ...Array.from({ length: randomCases }, (_, i) => randomScenario(i))];
const results = [];
for (const testCase of scenarios) {
    const context = independentContext(testCase);
    const expected = oracle(testCase, context);
    const engine = new Engine({ promotions: clone(testCase.promotions), now: () => testCase.now });
    const output = engine.calculate(clone(testCase.input));
    const checked = assessEnginePlan(testCase, context, output.suggestion);
    if ((output.alternatives || []).length > 3) checked.violations.push('more than three alternatives returned');
    for (const [index, alternative] of (output.alternatives || []).entries()) {
        const assessment = assessEnginePlan(testCase, context, alternative);
        checked.violations.push(...assessment.violations.map((message) => `alternative ${index + 1}: ${message}`));
    }
    const breakdown = output.breakdown;
    for (const key of ['subtotal', 'packagingFee', 'deliveryFee', 'fullReduction', 'coupon', 'total']) {
        if (cent(breakdown[key]) !== context.before[key]) checked.violations.push(`current ${key} differs from oracle`);
    }
    if (breakdown.orderable !== context.before.orderable || cent(breakdown.minimumOrder) !== context.before.minimumOrder
        || cent(breakdown.minimumOrderGap) !== context.before.minimumOrderGap) checked.violations.push('current eligibility differs from oracle');
    if (output.mode !== context.mode) checked.violations.push('mode differs from oracle');
    const baselines = { 'no-add': null, single: singleBaseline(testCase, context), greedy: greedyBaseline(testCase, context), engine: checked.plan };
    const objectiveMatch = (!expected.best && !checked.plan) || (expected.best && checked.plan && compare(expected.best, checked.plan, context.prefs.strategy) === 0);
    results.push({ name: testCase.name, mode: context.mode, strategy: context.prefs.strategy, input: testCase,
        oracle: expected, methods: baselines, objectiveMatch: Boolean(objectiveMatch), violations: checked.violations,
        returnedAlternatives: output.alternatives?.length ?? 0 });
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function aggregate(mode, method) {
    const rows = results.filter((row) => row.mode === mode);
    const feasible = rows.filter((row) => row.oracle.best);
    const selected = rows.filter((row) => row.methods[method]);
    const comparable = feasible.filter((row) => row.strategy === 'saving' && row.methods[method]);
    return { scenarios: rows.length, oracleFeasible: feasible.length, selected: selected.length,
        feasibleCoverage: feasible.length ? selected.length / feasible.length : null,
        objectiveHits: feasible.filter((row) => row.methods[method] && compare(row.oracle.best, row.methods[method], row.strategy) === 0).length,
        meanSavedAllScenarios: mean(rows.map((row) => yuan(row.methods[method]?.saved || 0))),
        meanAddedUnitsSelected: mean(selected.map((row) => row.methods[method].count)),
        meanAdditionCostSelected: mean(selected.map((row) => yuan(row.methods[method].cost))),
        meanPaymentChangeSelected: mean(selected.map((row) => yuan(row.methods[method].paymentChange))),
        meanPaymentGapWhenComparable: mean(comparable.map((row) => yuan(row.methods[method].total - row.oracle.best.total))) };
}

function quantile(values, q) { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]; }
const timings = [];
for (const size of [5, 10, 20]) {
    const perfCase = scenario(`performance-${size}`, cart(47), Array.from({ length: size }, (_, i) => product(`p${i}`, 0.5 + (i % 7) * 0.25, 4)),
        { minimumOrder: 25, fullReduction: [{ threshold: 50, discount: 10 }, { threshold: 55, discount: 14 }], coupons: [{ threshold: 40, discount: 3, stackable: true }] });
    const engine = new Engine({ promotions: perfCase.promotions, now: () => FIXED_NOW });
    for (let i = 0; i < 5; i++) engine.calculate(perfCase.input);
    const samples = [], internal = [], evaluated = [];
    for (let i = 0; i < perfSamples; i++) {
        const start = performance.now();
        const output = engine.calculate(perfCase.input);
        samples.push(performance.now() - start); internal.push(Number(output.performance.calcTimeMs)); evaluated.push(output.search?.evaluatedCount ?? output.performance.combinationCount);
    }
    timings.push({ candidates: size, maxItems: 4, budget: null, warmup: 5, samples: samples.length,
        evaluatedMin: Math.min(...evaluated), evaluatedMax: Math.max(...evaluated), meanMs: mean(samples),
        p50Ms: quantile(samples, 0.5), p95Ms: quantile(samples, 0.95), p99Ms: quantile(samples, 0.99), maximumMs: Math.max(...samples),
        internalMeanMs: mean(internal), rawMs: samples });
}

const summary = { total: results.length, random: randomCases, boundary: boundaryCases().length,
    objectiveMatches: results.filter((row) => row.objectiveMatch).length,
    violatingScenarios: results.filter((row) => row.violations.length).length,
    byMaxItems: Object.fromEntries([0, 1, 2, 3, 4].map((maxItems) => {
        const rows = results.filter((row) => row.input.input.preferences.maxItems === maxItems);
        return [maxItems, { scenarios: rows.length, objectiveMatches: rows.filter((row) => row.objectiveMatch).length,
            violatingScenarios: rows.filter((row) => row.violations.length).length }];
    })),
    byMode: Object.fromEntries(['minimum-order', 'saving'].map((mode) => [mode, Object.fromEntries(['no-add', 'single', 'greedy', 'engine'].map((method) => [method, aggregate(mode, method)]))])) };
const result = { schemaVersion: 1, productVersion: '1.3.0', generatedAt: new Date().toISOString(), seed, fixedBusinessTime: new Date(FIXED_NOW).toISOString(),
    environment: { node: process.version, platform: `${os.platform()} ${os.release()}`, architecture: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length },
    sourceSha256: { engine: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'engine.js'))).digest('hex'), experiment: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') },
    summary, timings, scenarios: results };
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n', 'utf8');

const percent = (value) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const number = (value, digits = 2) => value === null ? '—' : value.toFixed(digits);
const labels = { 'no-add': '不加购', single: '单件择优', greedy: '最低单价前缀贪心', engine: 'v1.3 约束枚举' };
const modeTable = (mode) => Object.entries(summary.byMode[mode]).map(([method, row]) => `| ${labels[method]} | ${row.oracleFeasible} | ${row.selected} / ${percent(row.feasibleCoverage)} | ${row.objectiveHits} | ${number(row.meanSavedAllScenarios)} | ${number(row.meanAddedUnitsSelected)} | ${number(row.meanAdditionCostSelected)} | ${number(row.meanPaymentChangeSelected)} |`).join('\n');
const failures = results.filter((row) => !row.objectiveMatch || row.violations.length);
const failureText = failures.length ? failures.slice(0, 12).map((row) => `- ${row.name}：目标匹配=${row.objectiveMatch}；${row.violations.join('；') || '目标函数不一致'}`).join('\n') : '本次场景中未发现目标不一致、金额不一致或约束违规。';
const report = `# 智能凑单 v1.3 可复现实验报告

本报告由 \`backend/experiments/run-benchmark.js\` 自动生成。生成时间（UTC）：${result.generatedAt}。所有业务计价固定在北京时间 2026-10-20 12:00:00，避免闪购和券到期使结果随运行时间变化。

## 研究问题与边界

验证给定候选、库存、加购预算、排除项、策略和最多四件限制下，起送达标方案或正净省方案是否满足约束、计价是否可复算、排序目标是否与独立穷举一致。同时观察不同规模下的本机计算耗时。本实验使用构造及伪随机数据，没有真实用户、订单、支付或平台数据；不能证明转化率、满意度或交易规模提升。

## 复现

需要 Node.js 20+。在 \`prototype/backend\` 运行：

\`\`\`powershell
node experiments/run-benchmark.js --seed ${seed} --cases ${randomCases} --perf-samples ${perfSamples}
\`\`\`

结果：\`backend/experiments/results/v13-benchmark.json\`，包含输入、独立最优方案、各基线、违规项、原始耗时和源码 SHA-256。可用 \`--output\` 改 JSON 路径。脚本仅加载引擎，不启动服务，不读取或修改 \`storage/events.json\`。

## 场景与独立校验

固定随机种子 **${seed}**，${summary.boundary} 个专项边界场景 + ${summary.random} 个伪随机场景，共 **${summary.total}** 个。随机场景含 2–9 个候选、0–4 件上限、有限或不限预算、库存、排除商品、少买优先、满减、叠加和非叠加券、品类资格、到期边界、配送高峰及包装费。

独立校验器不调用引擎的计价、候选筛选、排名或求解函数：自行将金额转为整数分，重算实付与门槛，并按每种商品 0…库存数量的向量枚举合法解。对第一推荐核验全局最优目标或无解结论，对全部返回方案核验计价与约束。比较目标为实付/件数/加购商品价的字典序；少买优先时交换前两项。等目标多解不要求商品 ID 相同；本实验不证明第二、第三推荐分别为全空间的次优和第三优。

结果：**${summary.objectiveMatches}/${summary.total}** 个场景的最优目标或无解结论一致；**${summary.violatingScenarios}** 个场景出现计价/门槛/约束违规。${summary.objectiveMatches === summary.total && !summary.violatingScenarios ? '结果支持本次受测范围内的实现一致性，不是对所有输入的形式化证明。' : '存在失败，不能将当前版本标为通过，需按 JSON 中失败输入修复。'}

${failureText}

按最多加购件数分层核对，专项场景另含“必须三件才能触发满减”和“必须四件才能触发满减”及上限不足时无解：

| 最多加购件数 | 场景数 | 最优目标或无解一致 | 违规场景 |
| ---: | ---: | ---: | ---: |
${Object.entries(summary.byMaxItems).map(([cap, row]) => `| ${cap} | ${row.scenarios} | ${row.objectiveMatches} | ${row.violatingScenarios} |`).join('\n')}

## 基线与指标

不加购为控制组，不产生推荐；单件择优只搜索一件；贪心按当前活动单价从低到高逐件加购，在预算、库存和件数范围内比较每个前缀。所有方法遵守同一用户约束。\“覆盖率\”分母为独立穷举存在合法推荐的场景；\“最优目标命中\”按用户策略比较完整目标。平均件数、商品加购金额和支付变化仅对已找到推荐的场景计算，不能脱离覆盖率单独比较。平均净省覆盖该模式全部场景，未推荐记 0。

起送模式的原车不可下单，支付变化仅是补单后实付减原车估算额，允许为负；**所有起送方案的净省记 0**。加购预算只限制活动商品价，包装/配送变化单列计入实付。以下金额单位为元。

### 起送未达标

| 方法 | 可解场景 | 找到推荐 / 覆盖率 | 最优目标命中 | 平均净省（全部） | 平均加购件数 | 平均加购商品金额 | 平均支付变化 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${modeTable('minimum-order')}

### 净省分支（含空车不推荐控制）

| 方法 | 可解场景 | 找到推荐 / 覆盖率 | 最优目标命中 | 平均净省（全部） | 平均加购件数 | 平均加购商品金额 | 平均支付变化 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${modeTable('saving')}

## 本机性能

环境：${result.environment.node}；${result.environment.platform} ${result.environment.architecture}；CPU：${result.environment.cpu}。每种规模预热 5 次后测 ${perfSamples} 次；最多四件、不限预算、每品库存四件，计时范围为 \`calculate\` 的同步调用，包含结果构建，不含 HTTP、落盘和浏览器。分位数用 nearest-rank。小样本的 P99 接近最大样本，不能视作生产尾延迟承诺。

| 候选数 | 合法加购组合数范围 | 样本 | 平均 ms | P50 ms | P95 ms | P99 ms | 最大 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${timings.map((row) => `| ${row.candidates} | ${row.evaluatedMin}–${row.evaluatedMax} | ${row.samples} | ${number(row.meanMs, 3)} | ${number(row.p50Ms, 3)} | ${number(row.p95Ms, 3)} | ${number(row.p99Ms, 3)} | ${number(row.maximumMs, 3)} |`).join('\n')}

## 局限与下一步

本次最优性只针对给定候选、最多四件、原购物车不变以及当前简化优惠规则。性能仅测试 5、10、20 个候选，未覆盖 API 商品数组的 50 项上限。未包含跨店、复杂优惠互斥组、满减与券的多种门槛口径、真实库存预留和账户资格，也未测多用户并发、网络或长期运行。固定种子场景集有助复现，不代表真实商品/优惠分布。下一步应补独立真实规则样例、平台对账数据与用户任务实验，并按起送和净省两类目的分别评估。
`;
fs.writeFileSync(reportFile, report.replace(/\\“/g, '“').replace(/\\”/g, '”'), 'utf8');
console.log(JSON.stringify({ summary, performance: timings.map(({ rawMs, ...row }) => row), outputFile, reportFile }, null, 2));
if (summary.objectiveMatches !== summary.total || summary.violatingScenarios) process.exitCode = 1;
