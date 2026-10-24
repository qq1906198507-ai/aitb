/** 按分计价：在加购约束内穷举起送方案或有正净省的方案。 */
const LATENCY_WINDOW = 1000;
const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100);
const yuan = (value) => value / 100;
const money = (value) => yuan(value).toFixed(2);

class NetSaveEngine {
    constructor(config = {}) {
        this.promotions = config.promotions || {};
        this.latencySamples = [];
        this.now = config.now || Date.now;
        this.lastCombinationCount = 0;
    }

    recordLatency(ms) {
        if (!Number.isFinite(ms) || ms < 0) return;
        this.latencySamples.push(ms);
        if (this.latencySamples.length > LATENCY_WINDOW) this.latencySamples.shift();
    }

    getP99() {
        if (!this.latencySamples.length) return 0;
        const sorted = [...this.latencySamples].sort((a, b) => a - b);
        return sorted[Math.ceil(sorted.length * 0.99) - 1];
    }

    getMetrics() {
        const count = this.latencySamples.length;
        return {
            sampleCount: count,
            avgCalcTime: count ? this.latencySamples.reduce((sum, ms) => sum + ms, 0) / count : null,
            p99CalcTime: count ? this.getP99() : null
        };
    }

    resetMetrics() {
        this.latencySamples = [];
    }

    getActualPrice(item, now = this.now()) {
        const price = item.flashSale && item.flashSale.endTime > now
            ? item.flashSale.salePrice : item.price;
        return yuan(cents(price));
    }

    getCartSubtotal(items, now = this.now()) {
        return yuan(items.reduce((sum, item) => {
            if (!item.inCart || item.quantity <= 0) return sum;
            return sum + cents(this.getActualPrice(item, now)) * item.quantity;
        }, 0));
    }

    normalizePreferences(preferences = {}) {
        const invalid = () => Object.assign(new Error('加购偏好无效：件数须为0至4、预算须为0至1000，且排除列表不可重复'), { statusCode: 400 });
        if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw invalid();
        const { maxItems = 2, maxAdditionCost = null, excludeIds = [], strategy = 'saving' } = preferences;
        if (!Number.isInteger(maxItems) || maxItems < 0 || maxItems > 4
            || (maxAdditionCost !== null && (typeof maxAdditionCost !== 'number' || !Number.isFinite(maxAdditionCost) || maxAdditionCost < 0 || maxAdditionCost > 1000))
            || !Array.isArray(excludeIds) || excludeIds.length > 100 || !excludeIds.every(id => typeof id === 'string')
            || new Set(excludeIds).size !== excludeIds.length || !['saving', 'fewer', 'preference'].includes(strategy)) throw invalid();
        return { maxItems, maxAdditionCost, excludeIds: [...excludeIds], strategy };
    }

    calcDeliveryFee(subtotal, now = this.now()) {
        const delivery = this.promotions.delivery || {};
        let fee = cents(subtotal) < cents(delivery.freeThreshold || 0)
            ? cents(delivery.baseFee || 0) : 0;
        if (delivery.peakHours && delivery.peakHours.enabled) {
            const date = new Date(now);
            const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
            if ((delivery.peakHours.timeRanges || []).some(({ start, end }) => time >= start && time <= end)) {
                fee += cents(delivery.peakHours.extraFee || 0);
            }
        }
        return yuan(fee);
    }

    calcFullReduction(subtotal) {
        const best = (this.promotions.fullReduction || [])
            .filter(rule => cents(subtotal) >= cents(rule.threshold))
            .sort((a, b) => cents(b.discount) - cents(a.discount))[0];
        return best ? { discount: yuan(cents(best.discount)), label: best.label }
            : { discount: 0, label: '暂无满减' };
    }

    // 本地商品规则：所有可叠加券 + 一张最大面值的不可叠加券。
    calcOptimalCoupons(subtotal, items, now = this.now()) {
        const available = (this.promotions.coupons || []).filter(coupon => {
            if (cents(subtotal) < cents(coupon.threshold || 0)) return false;
            if (coupon.startTime !== undefined && coupon.startTime > now) return false;
            if (coupon.endTime !== undefined && coupon.endTime <= now) return false;
            return !coupon.category || items.some(item => item.inCart && item.quantity > 0 && item.category === coupon.category);
        });
        const stackable = available.filter(coupon => coupon.stackable === true);
        const exclusive = available.filter(coupon => coupon.stackable !== true)
            .sort((a, b) => cents(b.discount) - cents(a.discount))[0];
        const selected = exclusive ? [...stackable, exclusive] : stackable;
        return {
            discount: yuan(selected.reduce((sum, coupon) => sum + cents(coupon.discount), 0)),
            label: selected.map(coupon => coupon.label).join(' + ') || '暂无优惠券'
        };
    }

    calcPriceBreakdown(items, now = this.now()) {
        const active = items.filter(item => item.inCart && item.quantity > 0);
        const subtotal = cents(this.getCartSubtotal(active, now));
        const packaging = active.reduce((sum, item) => sum + cents(item.packagingFee || 0) * item.quantity, 0);
        return this.breakdownFromTotals(active, subtotal, packaging, now);
    }

    breakdownFromTotals(active, subtotal, packaging, now) {
        const minimumOrder = Math.max(0, cents(this.promotions.minimumOrder || 0));
        const minimum = { minimumOrder: yuan(minimumOrder), minimumOrderGap: yuan(Math.max(0, minimumOrder - subtotal)),
            orderable: active.length > 0 && subtotal >= minimumOrder };
        if (!active.length) {
            return { subtotal: '0.00', deliveryFee: '0.00', packagingFee: '0.00', fullReduction: '0.00',
                fullReductionLabel: '暂无满减', coupon: '0.00', couponLabel: '暂无优惠券', total: '0.00', ...minimum };
        }
        const delivery = cents(this.calcDeliveryFee(yuan(subtotal), now));
        const reduction = this.calcFullReduction(yuan(subtotal));
        const coupon = this.calcOptimalCoupons(yuan(subtotal), active, now);
        // 优惠不能令实付为负；同时约束明细，让展示公式始终成立。
        const reductionCents = Math.min(subtotal, Math.max(0, cents(reduction.discount)));
        const couponCents = Math.min(subtotal + delivery + packaging - reductionCents, Math.max(0, cents(coupon.discount)));
        return {
            subtotal: money(subtotal), deliveryFee: money(delivery), packagingFee: money(packaging),
            fullReduction: money(reductionCents), fullReductionLabel: reduction.label,
            coupon: money(couponCents), couponLabel: coupon.label,
            total: money(subtotal + delivery + packaging - reductionCents - couponCents), ...minimum
        };
    }

    getCandidates(currentItems, recommendItems, preferences = {}) {
        const seen = new Set(currentItems.filter(item => item.inCart && item.quantity > 0).map(item => item.id));
        const excluded = new Set(preferences.excludeIds || []);
        return recommendItems.filter(item => {
            if (item.inCart || seen.has(item.id) || excluded.has(item.id)) return false;
            seen.add(item.id);
            return (item.stock === undefined || item.stock >= 1)
                && Number.isFinite(item.price) && item.price >= 0;
        });
    }

    rankSuggestions(currentItems, recommendItems, now = this.now(), preferences = {}) {
        const prefs = this.normalizePreferences(preferences);
        this.lastCombinationCount = 0;
        const active = currentItems.filter(item => item.inCart && item.quantity > 0);
        if (!active.length || !prefs.maxItems) return [];
        const currentBreakdown = this.calcPriceBreakdown(currentItems, now);
        const kind = currentBreakdown.orderable ? 'saving' : 'minimum-order';
        const currentSubtotalCents = cents(currentBreakdown.subtotal);
        const currentPackagingCents = cents(currentBreakdown.packagingFee);
        const currentTotalCents = cents(currentBreakdown.total);
        const candidates = this.getCandidates(currentItems, recommendItems, prefs);
        const suggestions = [];
        const evaluate = (additions, itemCount, additionCostCents, packagingCents) => {
            this.lastCombinationCount++;
            if (kind === 'minimum-order' && currentSubtotalCents + additionCostCents < cents(currentBreakdown.minimumOrder)) return;
            const testBreakdown = this.breakdownFromTotals([...active, ...additions], currentSubtotalCents + additionCostCents,
                currentPackagingCents + packagingCents, now);
            const newTotalCents = cents(testBreakdown.total);
            const savingCents = currentTotalCents - newTotalCents;
            if (!testBreakdown.orderable || (kind === 'saving' && savingCents <= 0)) return;
            const items = additions.map(item => ({
                id: item.id, name: item.name, desc: item.desc, price: item.price,
                actualPrice: this.getActualPrice(item, now), emoji: item.emoji,
                category: item.category, stock: item.stock, quantity: item.quantity, packagingFee: item.packagingFee || 0
            }));
            suggestions.push({
                item: items[0], items, itemCount, additionCost: yuan(additionCostCents), kind,
                netSaving: kind === 'saving' ? yuan(savingCents) : 0,
                paymentChange: yuan(newTotalCents - currentTotalCents), currentTotal: yuan(currentTotalCents),
                newTotal: yuan(newTotalCents), currentBreakdown, testBreakdown
            });
        };
        // Increasing candidate indices enumerate each multiset once, including mixed quantities.
        const visit = (start, additions, itemCount, additionCostCents, packagingCents) => {
            for (let index = start; index < candidates.length; index++) {
                const item = candidates[index];
                const unitPrice = cents(this.getActualPrice(item, now));
                const unitPackaging = cents(item.packagingFee || 0);
                const available = Math.min(prefs.maxItems - itemCount, item.stock ?? prefs.maxItems);
                for (let quantity = 1; quantity <= available; quantity++) {
                    const cost = additionCostCents + unitPrice * quantity;
                    if (prefs.maxAdditionCost !== null && yuan(cost) > prefs.maxAdditionCost) break;
                    const count = itemCount + quantity;
                    const packaging = packagingCents + unitPackaging * quantity;
                    const next = [...additions, { ...item, quantity, inCart: true }];
                    evaluate(next, count, cost, packaging);
                    if (count < prefs.maxItems) visit(index + 1, next, count, cost, packaging);
                }
            }
        };
        visit(0, [], 0, 0, 0);
        return suggestions.sort((a, b) => (prefs.strategy === 'fewer'
            ? a.itemCount - b.itemCount || a.newTotal - b.newTotal
            : a.newTotal - b.newTotal || a.itemCount - b.itemCount)
            || a.additionCost - b.additionCost || a.items.map(item => `${item.id}x${item.quantity}`).join(',')
                .localeCompare(b.items.map(item => `${item.id}x${item.quantity}`).join(',')));
    }

    calculateNetSaving(currentItems, recommendItems, now = this.now(), preferences = {}) {
        return this.rankSuggestions(currentItems, recommendItems, now, preferences)[0] || null;
    }

    describeItems(suggestion) {
        return suggestion.items.map(item => `${item.name}${item.quantity > 1 ? `×${item.quantity}` : ''}`).join(' + ');
    }

    generateCalculationSteps(suggestion) {
        const detail = (breakdown) => `商品¥${breakdown.subtotal} + 包装¥${breakdown.packagingFee || '0.00'} + 配送¥${breakdown.deliveryFee} - 优惠¥${money(cents(breakdown.fullReduction) + cents(breakdown.coupon))}`;
        const minimum = suggestion.kind === 'minimum-order';
        return {
            steps: [
                { label: minimum ? '当前估算（未达起送）' : '当前实付', value: `¥${suggestion.currentTotal.toFixed(2)}`, detail: detail(suggestion.currentBreakdown) },
                { label: '加购商品', value: `${this.describeItems(suggestion)} ¥${suggestion.additionCost.toFixed(2)}`, detail: `共${suggestion.itemCount}件，已计入加购成本` },
                { label: '加购后实付', value: `¥${suggestion.newTotal.toFixed(2)}`, detail: detail(suggestion.testBreakdown) }
            ],
            result: minimum ? { label: '达起送后预计实付', value: `¥${suggestion.newTotal.toFixed(2)}`,
                formula: `商品¥${suggestion.testBreakdown.subtotal} ≥ 起送¥${suggestion.testBreakdown.minimumOrder.toFixed(2)}；支付变化${suggestion.paymentChange >= 0 ? '+' : ''}${suggestion.paymentChange.toFixed(2)}，不计净省` }
                : { label: '预计净省金额', value: `¥${suggestion.netSaving.toFixed(2)}`,
                    formula: `${suggestion.currentTotal.toFixed(2)} - ${suggestion.newTotal.toFixed(2)} = ${suggestion.netSaving.toFixed(2)}` }
        };
    }

    generateSuggestionText(suggestion) {
        const name = this.describeItems(suggestion);
        if (suggestion.kind === 'minimum-order') {
            const description = `加购 ${name}（共${suggestion.itemCount}件，商品¥${suggestion.additionCost.toFixed(2)}）后达到起送，预计实付¥${suggestion.newTotal.toFixed(2)}；本方案不计预计净省。`;
            return { title: `加购「${name}」达到起送`, description, detail: description };
        }
        const saving = suggestion.netSaving.toFixed(2);
        const description = `加购 ${name}（共${suggestion.itemCount}件，¥${suggestion.additionCost.toFixed(2)}）后，预计实付减少${saving}元。`;
        return { title: `加购「${name}」可净省${saving}元`, description, detail: description };
    }

    calculate(input) {
        const started = process.hrtime.bigint();
        const now = this.now();
        const currentItems = input.currentItems || [];
        const recommendItems = input.recommendItems || [];
        const preferences = this.normalizePreferences(input.preferences);
        const breakdown = this.calcPriceBreakdown(currentItems, now);
        const mode = currentItems.some(item => item.inCart && item.quantity > 0) && !breakdown.orderable ? 'minimum-order' : 'saving';
        const candidates = this.getCandidates(currentItems, recommendItems, preferences);
        const alternatives = this.rankSuggestions(currentItems, recommendItems, now, preferences).slice(0, 3).map(plan => ({
            ...this.generateSuggestionText(plan), calculation: this.generateCalculationSteps(plan),
            item: plan.item, items: plan.items, itemCount: plan.itemCount, additionCost: plan.additionCost,
            netSaving: plan.netSaving, currentTotal: plan.currentTotal, newTotal: plan.newTotal,
            kind: plan.kind, paymentChange: plan.paymentChange,
            currentBreakdown: plan.currentBreakdown, testBreakdown: plan.testBreakdown
        }));
        const suggestion = alternatives[0] || null;
        const reason = !currentItems.some(item => item.inCart && item.quantity > 0) ? '购物车为空，请先选择商品。'
            : !preferences.maxItems ? '已关闭加购推荐，可调整最多加购件数。'
            : !candidates.length ? '没有符合库存和排除条件的可加购商品。'
            : !suggestion ? mode === 'minimum-order' ? '在当前件数、预算和商品范围内，没有达到起送门槛的方案。' : '在当前件数、预算和商品范围内，没有能减少实付的方案。'
            : mode === 'minimum-order' ? '当前未达起送门槛；以下比较达到起送后的实付，不计预计净省。' : '';
        const calcTimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        this.recordLatency(calcTimeMs);
        const metrics = this.getMetrics();
        return {
            breakdown, suggestion, alternatives, mode, reason, preferences,
            search: { maxItems: preferences.maxItems, candidateCount: candidates.length, evaluatedCount: this.lastCombinationCount,
                exhaustive: true, scope: `最多${preferences.maxItems}件加购，不调整原购物车；仅搜索当前商品和约束范围` },
            performance: {
                calcTimeMs: calcTimeMs.toFixed(3), candidateCount: candidates.length,
                combinationCount: this.lastCombinationCount, avgMs: metrics.avgCalcTime.toFixed(3),
                p99Ms: metrics.p99CalcTime.toFixed(3), sampleCount: metrics.sampleCount
            }
        };
    }
}

module.exports = NetSaveEngine;
