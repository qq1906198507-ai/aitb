const test = require('node:test');
const assert = require('node:assert/strict');
const NetSaveEngine = require('./engine');
const { PRODUCTS, PROMOTIONS } = require('./data');

const cart = (price, id = 'cart') => [{ id, name: '主餐', price, quantity: 1, inCart: true }];
const candidate = (id, price, stock = 5) => ({ id, name: id, price, stock, inCart: false });
const rules = { fullReduction: [{ threshold: 50, discount: 10 }, { threshold: 30, discount: 5 }], delivery: { baseFee: 5, freeThreshold: 40 } };
const create = (promotions = rules) => new NetSaveEngine({ promotions });

test('默认购物车加购米饭净省3元；耗时来自实际计算', () => {
    const engine = create(PROMOTIONS);
    const result = engine.calculate({ currentItems: cart(48), recommendItems: PRODUCTS.recommend });
    assert.equal(result.suggestion.item.id, 'r4');
    assert.equal(result.suggestion.items.length, 1);
    assert.equal(result.suggestion.itemCount, 1);
    assert.equal(result.suggestion.netSaving, 3);
    assert.equal(result.suggestion.currentTotal - result.suggestion.newTotal, 3);
    assert.equal(result.performance.sampleCount, 1);
    assert.ok(result.performance.combinationCount > result.performance.candidateCount);
    assert.ok(Number(result.performance.calcTimeMs) >= 0);
    assert.ok(result.alternatives.length > 1 && result.alternatives.length <= 3);
    assert.equal(result.suggestion, result.alternatives[0]);
    assert.ok(result.alternatives.every((plan, index, plans) => plan.netSaving > 0
        && (!index || plan.netSaving <= plans[index - 1].netSaving)));
});

test('两个不同商品合购才触发满减，排名与最优建议一致', () => {
    const engine = create();
    const rec = [candidate('a', 1, 1), candidate('b', 1, 1)];
    const ranked = engine.rankSuggestions(cart(48), rec);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].items.length, 2);
    assert.equal(ranked[0].itemCount, 2);
    assert.equal(ranked[0].additionCost, 2);
    assert.equal(ranked[0].netSaving, 3);
    assert.deepEqual(engine.calculateNetSaving(cart(48), rec), ranked[0]);
    const result = engine.calculate({ currentItems: cart(48), recommendItems: rec });
    assert.match(result.suggestion.title, /a \+ b/);
    assert.match(result.suggestion.calculation.steps[1].value, /2\.00/);
});

test('同种商品允许两件加购，库存不足时不推荐该方案', () => {
    const engine = create();
    const enough = engine.calculateNetSaving(cart(48), [candidate('a', 1, 2)]);
    assert.equal(enough.items[0].quantity, 2);
    assert.equal(enough.netSaving, 3);
    assert.match(engine.generateSuggestionText(enough).title, /a×2/);
    assert.equal(engine.calculateNetSaving(cart(48), [candidate('a', 1, 1)]), null);
    assert.equal(engine.calculateNetSaving(cart(48), [candidate('a', 2, 0)]), null);
});

test('不会重复推荐已在购物车的ID，同ID候选只搜索一次', () => {
    const engine = create();
    const rec = [candidate('cart', 2), candidate('a', 2, 1), candidate('a', 2, 1)];
    assert.equal(engine.getCandidates(cart(48), rec).length, 1);
    assert.equal(engine.rankSuggestions(cart(48), rec).length, 1);
});

test('同样净省优先一件，成本更低优先', () => {
    const engine = create();
    const ranked = engine.rankSuggestions(cart(48), [candidate('a', 1, 2), candidate('b', 2)]);
    assert.equal(ranked[0].items[0].id, 'b');
    assert.equal(ranked[0].itemCount, 1);
});

test('没有正收益时无推荐，空购物车实付0且不发券或加收配送费', () => {
    const engine = create(PROMOTIONS);
    assert.equal(engine.calculateNetSaving(cart(50), [candidate('a', 2)]), null);
    const empty = engine.calculate({ currentItems: [], recommendItems: PRODUCTS.recommend });
    assert.equal(empty.suggestion, null);
    assert.deepEqual(empty.alternatives, []);
    assert.equal(empty.breakdown.total, '0.00');
    assert.equal(empty.breakdown.deliveryFee, '0.00');
    assert.equal(empty.breakdown.coupon, '0.00');
});

test('备选方案含完整计算明细，并共享一次搜索和一个计时样本', () => {
    const engine = create();
    let searches = 0;
    const originalRank = engine.rankSuggestions.bind(engine);
    engine.rankSuggestions = (...args) => { searches++; return originalRank(...args); };
    const result = engine.calculate({ currentItems: cart(48), recommendItems: [candidate('a', 2), candidate('b', 3), candidate('c', 4)] });
    assert.equal(searches, 1);
    assert.equal(result.performance.sampleCount, 1);
    assert.equal(result.alternatives.length, 3);
    for (const plan of result.alternatives) {
        assert.equal(plan.calculation.steps.length, 3);
        assert.equal(plan.currentTotal - plan.newTotal, plan.netSaving);
        assert.equal(plan.currentBreakdown.total, '43.00');
        assert.ok(plan.title && plan.detail && plan.items.length);
    }
});

test('限时价格和优惠券按同一个计算时刻生效，过期后失效', () => {
    let now = 1000;
    const promotions = { coupons: [{ discount: 1, threshold: 0, stackable: true, endTime: 1500, label: '限时券' }] };
    const engine = new NetSaveEngine({ promotions, now: () => now });
    const items = [{ ...cart(5)[0], flashSale: { salePrice: 2, endTime: 1500 } }];
    assert.equal(engine.calcPriceBreakdown(items).total, '1.00');
    now = 1500;
    assert.equal(engine.calcPriceBreakdown(items).total, '5.00');
});

test('以分计算门槛及1分钱收益，实付不为负且明细可复算', () => {
    const engine = create({ fullReduction: [{ threshold: 0.3, discount: 0.21 }], coupons: [] });
    const result = engine.calculateNetSaving(cart(0.2), [candidate('a', 0.1, 1)]);
    assert.equal(result.netSaving, 0.11);
    assert.equal(result.testBreakdown.subtotal, '0.30');
    const over = create({ coupons: [{ threshold: 0, discount: 10 }] }).calcPriceBreakdown(cart(2));
    assert.equal(over.total, '0.00');
    assert.equal(Number(over.subtotal) + Number(over.deliveryFee) - Number(over.fullReduction) - Number(over.coupon), 0);
    const penny = create({ fullReduction: [{ threshold: 0.3, discount: 0.11 }] });
    assert.equal(penny.calculateNetSaving(cart(0.2), [candidate('a', 0.1, 1)]).netSaving, 0.01);
});

test('优惠券组合为可叠加券加一张最大非叠加券；类别券不误用', () => {
    const engine = create({ coupons: [
        { discount: 2, stackable: false, label: '小券' },
        { discount: 3, stackable: false, label: '大券' },
        { discount: 1, stackable: true, label: '叠加券' },
        { discount: 20, stackable: true, category: 'drink', label: '饮料券' }
    ] });
    assert.equal(engine.calcOptimalCoupons(48, cart(48)).discount, 4);
});

test('P99使用最近1000个有效样本，无样本时看板显示缺失值', () => {
    const engine = create();
    assert.deepEqual(engine.getMetrics(), { sampleCount: 0, avgCalcTime: null, p99CalcTime: null });
    engine.recordLatency(NaN);
    engine.recordLatency(-1);
    for (let i = 1; i <= 1001; i++) engine.recordLatency(i);
    const metrics = engine.getMetrics();
    assert.equal(metrics.sampleCount, 1000);
    assert.equal(metrics.p99CalcTime, 991);
    assert.equal(metrics.avgCalcTime, 501.5);
});

test('未达起送按达标后实付排序，支付增加和支付下降均不计净省', () => {
    const engine = create({ minimumOrder: 25, fullReduction: [{ threshold: 25, discount: 10 }], delivery: { baseFee: 5, freeThreshold: 100 } });
    const result = engine.calculate({ currentItems: cart(24), recommendItems: [candidate('a', 1), candidate('b', 2)] });
    assert.equal(result.mode, 'minimum-order');
    assert.equal(result.breakdown.minimumOrderGap, 1);
    assert.equal(result.breakdown.orderable, false);
    assert.equal(result.suggestion.kind, 'minimum-order');
    assert.equal(result.suggestion.netSaving, 0);
    assert.equal(result.suggestion.paymentChange, -9);
    assert.equal(result.suggestion.testBreakdown.orderable, true);
    assert.match(result.suggestion.title, /起送/);
    assert.match(result.reason, /不计预计净省/);
    const increase = create({ minimumOrder: 25 }).calculate({ currentItems: cart(24), recommendItems: [candidate('a', 2)] });
    assert.equal(increase.suggestion.paymentChange, 2);
    assert.equal(increase.suggestion.netSaving, 0);
    const exact = engine.calculate({ currentItems: cart(25), recommendItems: [candidate('a', 1)] });
    assert.equal(exact.mode, 'saving');
    assert.equal(exact.breakdown.minimumOrderGap, 0);
    assert.equal(exact.breakdown.orderable, true);
});

test('显式三件和四件覆盖同品异品混合，缺省两件的反例可解释', () => {
    const engine = create({ minimumOrder: 25 });
    const currentItems = cart(19);
    const recommendItems = [candidate('a', 2, 2), candidate('b', 2, 1)];
    const limited = engine.calculate({ currentItems, recommendItems });
    assert.equal(limited.suggestion, null);
    assert.match(limited.reason, /没有达到起送/);
    const three = engine.calculate({ currentItems, recommendItems, preferences: { maxItems: 3 } });
    assert.equal(three.suggestion.itemCount, 3);
    assert.deepEqual(three.suggestion.items.map(i => [i.id, i.quantity]), [['a', 2], ['b', 1]]);
    assert.equal(three.search.exhaustive, true);
    assert.equal(three.search.maxItems, 3);
    const four = engine.calculate({ currentItems: cart(17), recommendItems: [candidate('a', 2, 4)], preferences: { maxItems: 4 } });
    assert.equal(four.suggestion.items[0].quantity, 4);
    assert.equal(four.suggestion.itemCount, 4);
    assert.equal(four.suggestion.testBreakdown.subtotal, '25.00');
});

test('预算、排除、库存、零件数和少件策略约束完整生效', () => {
    const engine = create({ fullReduction: [{ threshold: 50, discount: 10 }, { threshold: 51, discount: 15 }] });
    const currentItems = cart(48), recommendItems = [candidate('a', 2, 1), candidate('b', 1, 4)];
    const saving = engine.calculate({ currentItems, recommendItems, preferences: { maxItems: 3 } });
    assert.equal(saving.suggestion.newTotal, 36);
    assert.equal(saving.suggestion.itemCount, 2);
    const fewer = engine.calculate({ currentItems, recommendItems, preferences: { maxItems: 3, strategy: 'fewer' } });
    assert.equal(fewer.suggestion.itemCount, 1);
    assert.equal(fewer.suggestion.newTotal, 40);
    const constrained = engine.calculate({ currentItems, recommendItems, preferences: { maxItems: 4, maxAdditionCost: 2, excludeIds: ['a'] } });
    assert.equal(constrained.suggestion.items[0].id, 'b');
    assert.equal(constrained.suggestion.items[0].quantity, 2);
    assert.equal(constrained.suggestion.additionCost, 2);
    assert.equal(engine.calculate({ currentItems, recommendItems, preferences: { maxItems: 0 } }).suggestion, null);
    assert.equal(engine.calculate({ currentItems, recommendItems, preferences: { maxAdditionCost: 0 } }).suggestion, null);
    assert.equal(engine.calculate({ currentItems, recommendItems, preferences: { maxAdditionCost: 1.999 } }).suggestion, null,
        'A budget with sub-cent precision must not be rounded up past its actual limit');
    for (const preferences of [{ maxItems: -1 }, { maxItems: 5 }, { maxItems: 1.5 }, { maxAdditionCost: Infinity },
        { maxAdditionCost: -1 }, { excludeIds: ['a', 'a'] }, { strategy: 'unknown' }, null]) {
        assert.throws(() => engine.calculate({ currentItems, recommendItems, preferences }), { statusCode: 400 });
    }
});

test('实时预算：目录超限按活动价剪枝并如实标注降级，返回方案仍为正净省', () => {
    const engine = create(rules);
    engine.searchCandidateLimit = 3;
    const recommendItems = Array.from({ length: 8 }, (_, i) => candidate(`c${i}`, 6 - i * 0.5, 4));
    const result = engine.calculate({ currentItems: cart(48), recommendItems });
    assert.equal(result.search.degraded, true);
    assert.equal(result.search.exhaustive, false);
    assert.equal(result.search.degradation.pruned, true);
    assert.equal(result.search.degradation.truncated, false);
    assert.ok(result.search.evaluatedCount > 0);
    assert.match(result.search.scope, /剪枝/);
    assert.ok(result.suggestion);
    assert.ok(result.suggestion.netSaving > 0);
    assert.ok(result.suggestion.items.every(item => ['c5', 'c6', 'c7'].includes(item.id)),
        '剪枝按活动价升序保留最低价候选');
});

test('实时预算：搜索超时截断不阻塞返回，耗时受预算约束', () => {
    const engine = new NetSaveEngine({ promotions: rules, searchBudgetMs: 0.001, searchCandidateLimit: 24 });
    const recommendItems = Array.from({ length: 40 }, (_, i) => candidate(`x${i}`, 1 + (i % 5), 4));
    const result = engine.calculate({ currentItems: cart(48), recommendItems });
    assert.equal(result.search.degraded, true);
    assert.equal(result.search.degradation.truncated, true);
    assert.ok(result.search.degradation.elapsedMs < 500, '截断后应在预算量级内返回而非穷举数万组合');
    assert.ok(result.search.evaluatedCount < 30000);
});

test('包装按件计费且不算起送、满减和配送门槛，限时活动价决定商品小计', () => {
    const engine = new NetSaveEngine({ promotions: { minimumOrder: 25, fullReduction: [{ threshold: 25, discount: 5 }],
        delivery: { baseFee: 5, freeThreshold: 25 } }, now: () => 1000 });
    const item = { ...cart(30)[0], packagingFee: 5, flashSale: { salePrice: 12, endTime: 2000 }, quantity: 2 };
    const b = engine.calcPriceBreakdown([item]);
    assert.equal(b.subtotal, '24.00');
    assert.equal(b.packagingFee, '10.00');
    assert.equal(b.minimumOrderGap, 1);
    assert.equal(b.orderable, false);
    assert.equal(b.fullReduction, '0.00');
    assert.equal(b.deliveryFee, '5.00');
    assert.equal(b.total, '39.00');
    const plan = engine.calculate({ currentItems: [item], recommendItems: [{ ...candidate('a', 1, 1), packagingFee: 2 }] }).suggestion;
    assert.equal(plan.additionCost, 1);
    assert.equal(plan.paymentChange, -7);
    assert.equal(plan.testBreakdown.packagingFee, '12.00');
    assert.equal(plan.testBreakdown.total, '32.00');
    assert.match(plan.calculation.steps[2].detail, /包装¥12.00/);
    assert.equal(create({}).calcPriceBreakdown(cart(1)).minimumOrder, 0);
    assert.equal(create({}).calcPriceBreakdown(cart(1)).orderable, true);
});
