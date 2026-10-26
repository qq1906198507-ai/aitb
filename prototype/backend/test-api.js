/** Isolated integration tests. Uses temporary files and a random local port. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netsave-api-'));
process.env.NETSAVE_DATA_DIR = path.join(temporaryRoot, 'default');
const { createApp } = require('./server');
const { DemoStore } = require('./store');
const NetSaveEngine = require('./engine');
const { PROMOTIONS, PRODUCTS } = require('./data');
const promotions = structuredClone(PROMOTIONS);
promotions.delivery.peakHours.enabled = false;
let assertionGroups = 0;

async function withServer(app, work) {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, body, status = 200) {
        const response = await fetch(base + route, body === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const result = await response.json();
        assert.equal(response.status, status, `${route}: ${JSON.stringify(result)}`);
        return result;
    }
    request.raw = (route, options) => fetch(base + route, options);
    try { await work(request); } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

(async () => {
    const dataDir = path.join(temporaryRoot, 'main');
    let clock = Date.now();
    const app = createApp({ dataDir, promotions, now: () => clock });
    let savedId;
    await withServer(app, async request => {
        assert.equal((await request('/health')).status, 'ok');
        for (const route of ['/demo.html', '/mobile-api.html', '/dashboard.html', '/index.html', '/mobile.html']) {
            const response = await request.raw(route);
            assert.equal(response.status, 200, route);
            assert.match(response.headers.get('content-type'), /text\/html/);
            assert.match(await response.text(), /<!DOCTYPE html>/i);
        }
        for (const route of ['/dashboard-app.js', '/dashboard.css', '/demo-nav.css', '/mobile-api-app.js']) {
            assert.equal((await request.raw(route)).status, 200, route);
        }
        const redirect = await request.raw('/', { redirect: 'manual' });
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.get('location'), '/demo.html');
        for (const route of ['/backend/storage/events.json', '/backend/server.js', '/api/unknown', '/unknown-page']) {
            const result = await request(route, undefined, 404);
            assert.equal(result.success, false);
        }
        assertionGroups++;
        const empty = await request('/api/dashboard');
        assert.equal(empty.source, 'local-demo');
        assert.equal(empty.summary.shownCount, 0);
        assert.equal(empty.performance.sampleCount, 0);
        assert.equal(empty.performance.averageMs, null);
        assert.equal(empty.performance.p99Ms, null);
        assert.equal(empty.summary.adoptionRate, null);
        assert.equal(empty.trend.length, 7);
        assertionGroups++;

        const input = await request('/api/cart/default');
        assert.ok((await request('/api/products/recommend')).length > 0);
        assert.ok((await request('/api/promotions')).fullReduction.length > 0);
        const result = await request('/api/calculate', input);
        assert.equal(result.suggestion.item.id, 'r4');
        assert.equal(result.suggestion.netSaving, 3);
        assert.equal(result.breakdown.total, '35.00');
        assert.ok(result.suggestion.id);
        assert.ok(result.performance.sampleCount >= 1);
        assert.equal(result.search.degraded, false, '小目录默认不降级');
        assert.equal((await request('/api/dashboard')).summary.shownCount, 0, 'Calculation is not an impression');
        const batch = await request('/api/calculate/batch', input);
        assert.equal(batch.suggestions[0].netSaving, 3);
        assertionGroups++;

        const tampered = structuredClone(input);
        tampered.currentItems[0].price = 0.01;
        tampered.recommendItems.find(item => item.id === 'r4').price = 0;
        tampered.recommendItems[0].stock = 999;
        const canonical = await request('/api/calculate', tampered);
        assert.equal(canonical.breakdown.total, result.breakdown.total);
        assert.equal(canonical.suggestion.netSaving, 3);
        const badInputs = [
            {}, { ...input, currentItems: {} }, { ...input, recommendItems: null },
            { ...input, currentItems: [{ id: 'unknown', quantity: 1 }] },
            { ...input, currentItems: [{ id: 'p1', quantity: 0 }] },
            { ...input, currentItems: [{ id: 'p1', quantity: 1.5 }] },
            { ...input, currentItems: [{ id: 'p1', quantity: 1, price: -1 }] },
            { ...input, currentItems: [{ id: 'p1', quantity: 1, price: Infinity }] },
            { ...input, currentItems: [{ id: 'p1', quantity: 1 }, { id: 'p1', quantity: 1 }] },
            { ...input, currentItems: [{ id: 'r5', quantity: 4 }] }
        ];
        for (const body of badInputs) await request('/api/calculate', body, 400);
        const noCart = await request('/api/calculate', { currentItems: [], recommendItems: input.recommendItems });
        assert.equal(noCart.suggestion, null);
        assert.equal(noCart.breakdown.total, '0.00');
        assertionGroups++;

        savedId = result.suggestion.id;
        const event = type => ({ recommendationId: savedId, type, saved: 9999 });
        await request('/api/events', event('accepted'), 409);
        await request('/api/events', { recommendationId: 'bad', type: 'shown' }, 400);
        await request('/api/events', { recommendationId: '00000000-0000-0000-0000-000000000000', type: 'shown' }, 404);
        assert.equal((await request('/api/events', event('shown'))).duplicate, false);
        assert.equal((await request('/api/events', event('shown'))).duplicate, true);
        assert.equal((await request('/api/events', event('accepted'))).event.saved, 3);
        assert.equal((await request('/api/events', event('accepted'))).duplicate, true);
        await request('/api/events', event('rejected'), 409);
        let dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.shownCount, 1);
        assert.equal(dashboard.summary.acceptedCount, 1);
        assert.equal(dashboard.summary.totalSaved, 3);
        assert.equal(dashboard.summary.averageSaving, 3);
        assert.equal(dashboard.summary.adoptionRate, 1);
        assert.equal(dashboard.summary.pendingCount, 0);
        assert.equal(dashboard.trend.reduce((sum, day) => sum + day.saved, 0), 3);
        assert.equal(dashboard.recentEvents[0].type, 'accepted');
        assertionGroups++;

        const rejected = (await request('/api/calculate', input)).suggestion.id;
        await request('/api/events', { recommendationId: rejected, type: 'shown' });
        await request('/api/events', { recommendationId: rejected, type: 'rejected' });
        dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.rejectedCount, 1);
        assert.equal(dashboard.summary.adoptionRate, 0.5);
        assert.equal(dashboard.summary.totalSaved, 3);
        assertionGroups++;

        const expired = (await request('/api/calculate', input)).suggestion.id;
        await request('/api/events', { recommendationId: expired, type: 'shown' });
        clock += 5 * 60 * 1000 + 1;
        assert.equal((await request('/api/events', { recommendationId: expired, type: 'shown' })).duplicate, true);
        await request('/api/events', { recommendationId: expired, type: 'accepted' }, 409);
        await request('/api/events', { recommendationId: expired, type: 'rejected' });
        const unshown = (await request('/api/calculate', input)).suggestion.id;
        clock += 5 * 60 * 1000 + 1;
        await request('/api/events', { recommendationId: unshown, type: 'shown' }, 409);
        assertionGroups++;

        // A failed disk write must not mutate counters or claim success.
        const writeTestId = (await request('/api/calculate', input)).suggestion.id;
        await request('/api/events', { recommendationId: writeTestId, type: 'shown' });
        const originalFile = app.locals.store.file;
        app.locals.store.file = path.join(dataDir, 'blocked');
        fs.mkdirSync(app.locals.store.file);
        await request('/api/events', { recommendationId: writeTestId, type: 'accepted' }, 503);
        assert.equal((await request('/api/dashboard')).summary.acceptedCount, 1);
        app.locals.store.file = originalFile;
        await request('/api/events', { recommendationId: writeTestId, type: 'accepted' });
        assertionGroups++;
    });

    await withServer(createApp({ dataDir, promotions }), async request => {
        const dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.acceptedCount, 2);
        assert.equal(dashboard.summary.totalSaved, 6);
        assert.equal(dashboard.performance.sampleCount, 0, 'Performance samples reset on restart');
        assert.equal((await request('/api/events', { recommendationId: savedId, type: 'accepted' })).duplicate, true);
        assert.equal((await request('/api/dashboard')).summary.totalSaved, 6);
        assertionGroups++;
    });

    await withServer(createApp({ dataDir: path.join(temporaryRoot, 'reset'), promotions, now: () => clock }), async request => {
        const input = await request('/api/cart/default');
        const suggestion = (await request('/api/calculate', input)).suggestion;
        await request('/api/events', { recommendationId: suggestion.id, type: 'shown' });
        await request('/api/events', { recommendationId: suggestion.id, type: 'accepted' });
        assert.equal((await request('/api/dashboard')).summary.acceptedCount, 1);
        assert.ok((await request('/api/dashboard')).performance.sampleCount >= 1);
        // 清零必须显式确认；成功后事件与同进程性能样本一起清空。
        await request('/api/demo/reset', {}, 400);
        assert.equal((await request('/api/dashboard')).summary.acceptedCount, 1);
        assert.ok((await request('/api/demo/reset', { confirm: '清空演示数据' })).success);
        const cleared = await request('/api/dashboard');
        assert.equal(cleared.summary.shownCount, 0);
        assert.equal(cleared.summary.acceptedCount, 0);
        assert.equal(cleared.summary.totalSaved, 0);
        assert.equal(cleared.performance.sampleCount, 0);
        assert.equal((await request('/api/history')).events.length, 0);
        assertionGroups++;
    });

    await withServer(createApp({ dataDir: path.join(temporaryRoot, 'preference'), promotions, now: () => clock }), async request => {
        const input = await request('/api/cart/default');
        // 两次采纳饮品方案（可乐，净省 ¥2.5），本机历史给「饮品」+2 权重
        for (let round = 0; round < 2; round++) {
            const plans = (await request('/api/calculate', input)).alternatives;
            const cola = plans.find(plan => plan.item.id === 'r5');
            await request('/api/events', { recommendationId: cola.id, type: 'shown' });
            await request('/api/events', { recommendationId: cola.id, type: 'accepted' });
        }
        assert.equal((await request('/api/dashboard')).summary.acceptedCount, 2);
        const preferenceInput = { ...input, preferences: { maxItems: 3, maxAdditionCost: 10, excludeIds: [], strategy: 'preference' } };
        const ranked = await request('/api/calculate', preferenceInput);
        // 净省最多的米饭（¥3）在偏好权重下让位于饮品方案（¥2.5 + 偏好加成）
        assert.equal(ranked.alternatives[0].item.id, 'r5');
        assert.equal(ranked.alternatives[0].items[0].category, '饮品');
        assert.equal(ranked.preference.applied, true);
        assert.equal(ranked.preference.affinity['饮品'], 2);
        const control = await request('/api/calculate', input);
        assert.equal(control.suggestion.item.id, 'r4', '非偏好策略仍按净省最多排序');
        assert.equal(control.preference.applied, false);
        assert.equal((await request('/api/calculate/batch', preferenceInput)).suggestions[0].item.id, 'r5');
        const history = await request('/api/history');
        assert.deepEqual(history.events[0].itemCategories, ['饮品']);
        assertionGroups++;
    });

    await withServer(createApp({ dataDir: path.join(temporaryRoot, 'degrade'), promotions,
        engine: new NetSaveEngine({ promotions, now: () => clock, searchCandidateLimit: 3, searchBudgetMs: 0 }) }), async request => {
        const input = await request('/api/cart/default');
        const result = await request('/api/calculate', input);
        assert.equal(result.search.degraded, true, '候选超限应如实标注降级');
        assert.equal(result.search.exhaustive, false);
        assert.equal(result.search.degradation.pruned, true);
        assert.match(result.search.scope, /剪枝/);
        const batch = await request('/api/calculate/batch', input);
        assert.equal(batch.search.degraded, true);
        assert.ok(batch.search.degradation);
        assertionGroups++;
    });

    const defaultInput = {
        currentItems: [{ id: 'p1', quantity: 1 }, { id: 'p2', quantity: 1 }, { id: 'p3', quantity: 1 }],
        recommendItems: PRODUCTS.recommend
    };
    const catalog = structuredClone([
        { id: 'p1', price: 28 }, { id: 'p2', price: 12 }, { id: 'p3', price: 8 }, ...PRODUCTS.recommend
    ]);
    await withServer(createApp({ dataDir: path.join(temporaryRoot, 'prices'), promotions, catalog }), async request => {
        const id = (await request('/api/calculate', defaultInput)).suggestion.id;
        await request('/api/events', { recommendationId: id, type: 'shown' });
        catalog.find(item => item.id === 'r4').price = 3;
        await request('/api/events', { recommendationId: id, type: 'accepted' }, 409);
        assert.equal((await request('/api/dashboard')).summary.totalSaved, 0);
        assertionGroups++;
    });

    const soldOutCatalog = structuredClone(catalog);
    soldOutCatalog.find(item => item.id === 'r4').stock = 0;
    await withServer(createApp({ dataDir: path.join(temporaryRoot, 'sold-out'), promotions, catalog: soldOutCatalog }), async request => {
        const result = await request('/api/calculate', defaultInput);
        assert.ok(!result.suggestion || !result.suggestion.items.some(item => item.id === 'r4'));
        await request('/api/calculate', { ...defaultInput, currentItems: [{ id: 'r4', quantity: 1 }] }, 400);
        assertionGroups++;
    });

    let saleClock = Date.now();
    const flashCatalog = structuredClone(catalog);
    flashCatalog.find(item => item.id === 'p3').price = 9;
    const flashRice = flashCatalog.find(item => item.id === 'r4');
    flashRice.price = 2;
    flashRice.flashSale = { salePrice: 1, endTime: saleClock + 60000 };
    await withServer(createApp({
        dataDir: path.join(temporaryRoot, 'sale-clock'), promotions, catalog: flashCatalog, now: () => saleClock
    }), async request => {
        const result = await request('/api/calculate', defaultInput);
        assert.equal(result.suggestion.netSaving, 4);
        await request('/api/events', { recommendationId: result.suggestion.id, type: 'shown' });
        saleClock += 60001;
        await request('/api/events', { recommendationId: result.suggestion.id, type: 'accepted' }, 409);
        assert.equal((await request('/api/dashboard')).summary.totalSaved, 0);
        assertionGroups++;
    });

    // v1.2 lifecycle uses its own files and a fixed clock to exercise tied timestamps.
    const lifecycleDir = path.join(temporaryRoot, 'lifecycle');
    const lifecycleClock = Date.now();
    const lifecycleApp = createApp({ dataDir: lifecycleDir, promotions, now: () => lifecycleClock });
    let lifecyclePlans;
    let lifecycleInput;
    let originalAcceptance;
    let lastAcceptance;
    let expectedHistoryIds;
    await withServer(lifecycleApp, async request => {
        assert.equal((await request('/health')).version, '1.5.0');
        lifecycleInput = await request('/api/cart/default');
        const result = await request('/api/calculate', lifecycleInput);
        lifecyclePlans = result.alternatives;
        assert.equal(lifecyclePlans.length, 3);
        assert.deepEqual(result.suggestion, lifecyclePlans[0], 'Best suggestion remains backward compatible');
        assert.equal(new Set(lifecyclePlans.map(plan => plan.id)).size, 3);
        assert.equal(new Set(lifecyclePlans.map(plan => plan.groupId)).size, 1);
        for (const plan of lifecyclePlans) {
            assert.equal(plan.createdAt, new Date(lifecycleClock).toISOString());
            assert.equal(plan.expiresAt, lifecycleClock + 5 * 60 * 1000);
            assert.ok(plan.items.length > 0 && plan.itemCount >= 1);
            assert.ok(plan.title && plan.description && plan.detail);
            assert.equal(plan.calculation.steps.length, 3);
            assert.equal(Number(plan.currentBreakdown.total), plan.currentTotal);
            assert.equal(Number(plan.testBreakdown.total), plan.newTotal);
            const snapshot = await request(`/api/suggestions/${plan.id}`);
            assert.deepEqual(snapshot.suggestion, plan);
            assert.equal(snapshot.decision, null);
            assert.equal(snapshot.shown, false);
            assert.equal(snapshot.groupId, plan.groupId);
            assert.equal(snapshot.expiresAt, plan.expiresAt);
        }
        await request('/api/suggestions/bad', undefined, 400);
        await request('/api/suggestions/------------------------------------', undefined, 400);
        await request('/api/suggestions/00000000-0000-0000-0000-000000000000', undefined, 404);
        assert.deepEqual((await request('/api/calculate', { currentItems: [], recommendItems: [] })).alternatives, []);
        assertionGroups++;

        const [chosen, rival, third] = lifecyclePlans;
        const event = (plan, type) => ({ recommendationId: plan.id, type, saved: 9999 });
        await request('/api/events', event(chosen, 'reverted'), 409);
        await request('/api/events', event(chosen, 'shown'));
        assert.equal((await request(`/api/suggestions/${chosen.id}`)).shown, true);
        originalAcceptance = await request('/api/events', event(chosen, 'accepted'));
        assert.equal(originalAcceptance.currentDecision, 'accepted');
        assert.equal(originalAcceptance.event.saved, chosen.netSaving);
        assert.equal((await request(`/api/suggestions/${chosen.id}`)).decision, 'accepted');
        await request('/api/events', event(rival, 'shown'));
        await request('/api/events', event(rival, 'accepted'), 409);
        const rejectedRival = await request('/api/events', event(rival, 'rejected'));
        assert.equal(rejectedRival.currentDecision, 'rejected');
        assertionGroups++;

        // An unavailable file must roll back both an undo and a whole quote batch.
        const originalFile = lifecycleApp.locals.store.file;
        const quotesBeforeFailure = Object.keys(lifecycleApp.locals.store.data.quotes);
        lifecycleApp.locals.store.file = path.join(lifecycleDir, 'blocked');
        fs.mkdirSync(lifecycleApp.locals.store.file);
        await request('/api/events', event(chosen, 'reverted'), 503);
        assert.equal((await request(`/api/suggestions/${chosen.id}`)).decision, 'accepted');
        assert.equal((await request('/api/dashboard')).summary.acceptedCount, 1);
        await request('/api/calculate', lifecycleInput, 503);
        assert.deepEqual(Object.keys(lifecycleApp.locals.store.data.quotes), quotesBeforeFailure);
        lifecycleApp.locals.store.file = originalFile;
        const reverted = await request('/api/events', event(chosen, 'reverted'));
        assert.equal(reverted.currentDecision, 'reverted');
        assert.equal(reverted.event.saved, -chosen.netSaving);
        const duplicateUndo = await request('/api/events', event(chosen, 'reverted'));
        assert.equal(duplicateUndo.duplicate, true);
        assert.equal(duplicateUndo.event.id, reverted.event.id);
        const replay = await request('/api/events', event(chosen, 'accepted'));
        assert.equal(replay.duplicate, true);
        assert.equal(replay.event.id, originalAcceptance.event.id);
        assert.equal(replay.currentDecision, 'reverted', 'A replay must not reapply an undone acceptance');
        assert.equal((await request(`/api/suggestions/${chosen.id}`)).decision, 'reverted');
        let dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.acceptedCount, 0);
        assert.equal(dashboard.summary.revertedCount, 1);
        assert.equal(dashboard.summary.totalSaved, 0);
        assert.equal(dashboard.summary.averageSaving, 0);
        assert.equal(dashboard.summary.adoptionRate, 0);
        assert.equal(dashboard.summary.pendingCount, 0, 'Undo does not create another pending decision');
        assert.equal(dashboard.trend.reduce((sum, day) => sum + day.saved, 0), 0);
        assert.equal(dashboard.recentEvents.find(row => row.id === originalAcceptance.event.id).reverted, true);
        await request('/api/events', event(third, 'shown'));
        await request('/api/events', event(third, 'accepted'), 409);
        const rejectedThird = await request('/api/events', event(third, 'rejected'));
        await request('/api/events', event(third, 'reverted'), 409);
        assertionGroups++;

        const fresh = (await request('/api/calculate', lifecycleInput)).suggestion;
        assert.notEqual(fresh.groupId, chosen.groupId);
        await request('/api/events', event(fresh, 'shown'));
        lastAcceptance = await request('/api/events', event(fresh, 'accepted'));
        dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.acceptedCount, 1);
        assert.equal(dashboard.summary.totalSaved, fresh.netSaving);
        assert.equal(dashboard.summary.revertedCount, 1);
        assert.equal(dashboard.summary.pendingCount, 0);
        expectedHistoryIds = [lastAcceptance.event.id, rejectedThird.event.id, reverted.event.id,
            rejectedRival.event.id, originalAcceptance.event.id];
        const all = await request('/api/history');
        assert.deepEqual(all.events.map(row => row.id), expectedHistoryIds);
        assert.equal(all.total, 5);
        assert.equal(all.nextCursor, null);
        assert.ok(all.events.every(row => row.type !== 'shown'));
        assert.equal(new Set(all.events.map(row => row.createdAt)).size, 1, 'Fixed clock creates equal timestamps');
        const acceptedHistory = await request('/api/history?type=accepted');
        assert.equal(acceptedHistory.total, 2);
        assert.deepEqual(acceptedHistory.events.map(row => row.reverted), [false, true]);
        assert.equal((await request('/api/history?type=reverted')).events[0].saved, -chosen.netSaving);
        assert.equal((await request('/api/history?type=rejected')).total, 2);
        const firstPage = await request('/api/history?limit=2');
        const secondPage = await request(`/api/history?limit=2&before=${firstPage.nextCursor}`);
        const thirdPage = await request(`/api/history?limit=2&before=${secondPage.nextCursor}`);
        assert.deepEqual([...firstPage.events, ...secondPage.events, ...thirdPage.events].map(row => row.id), expectedHistoryIds);
        assert.equal(secondPage.total, 5);
        assert.equal(thirdPage.nextCursor, null);
        for (const query of ['type=shown', 'type=bad', 'limit=0', 'limit=101', 'limit=1.5', 'limit=abc',
            'limit=2&limit=3', 'type=all&type=accepted', 'before=bad', 'before=------------------------------------',
            'before=00000000-0000-0000-0000-000000000000']) {
            await request(`/api/history?${query}`, undefined, 400);
        }
        assertionGroups++;
    });

    await withServer(createApp({ dataDir: lifecycleDir, promotions, now: () => lifecycleClock }), async request => {
        const [chosen, rival] = lifecyclePlans;
        assert.equal((await request(`/api/suggestions/${chosen.id}`)).decision, 'reverted');
        assert.equal((await request('/api/dashboard')).summary.revertedCount, 1);
        assert.deepEqual((await request('/api/history')).events.map(row => row.id), expectedHistoryIds);
        const replay = await request('/api/events', { recommendationId: chosen.id, type: 'accepted' });
        assert.equal(replay.currentDecision, 'reverted');
        assert.equal(replay.event.id, originalAcceptance.event.id);
        await request('/api/events', { recommendationId: rival.id, type: 'accepted' }, 409);
        assert.equal((await request('/api/events', {
            recommendationId: lastAcceptance.event.recommendationId, type: 'accepted'
        })).duplicate, true);
        assertionGroups++;
    });

    // Existing v1.1 quotes have no groupId; their own ID becomes their group.
    const legacyDir = path.join(temporaryRoot, 'legacy');
    const legacySource = lifecycleApp.locals.store.data;
    const legacyId = lifecyclePlans[0].id;
    const legacyQuote = structuredClone(legacySource.quotes[legacyId]);
    delete legacyQuote.groupId;
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, 'events.json'), JSON.stringify({
        version: 1, quotes: { [legacyId]: legacyQuote },
        events: legacySource.events.filter(event => event.recommendationId === legacyId && event.type !== 'reverted')
    }));
    await withServer(createApp({ dataDir: legacyDir, promotions, now: () => lifecycleClock }), async request => {
        const snapshot = await request(`/api/suggestions/${legacyId}`);
        assert.equal(snapshot.groupId, legacyId);
        assert.equal(snapshot.suggestion.groupId, legacyId);
        assert.equal(snapshot.decision, 'accepted');
        await request('/api/events', { recommendationId: legacyId, type: 'reverted' });
        const dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.acceptedCount, 0);
        assert.equal(dashboard.summary.totalSaved, 0);
        assert.equal((await request('/api/history?type=accepted')).events[0].reverted, true);
        assertionGroups++;
    });

    const v13Dir = path.join(temporaryRoot, 'v13');
    const v13Promotions = { minimumOrder: 25, fullReduction: [{ threshold: 40, discount: 10, label: '满40减10' }] };
    const v13Catalog = [
        { id: 'p1', name: '主餐', price: 19, packagingFee: 0.5, stock: 99 },
        { id: 'r1', name: '卤蛋', price: 2, packagingFee: 0.25, stock: 2 },
        { id: 'r4', name: '米饭', price: 2, packagingFee: 0.5, stock: 1 },
        { id: 'r2', name: '小菜', price: 7, packagingFee: 0, stock: 1 }
    ];
    const v13Input = { currentItems: [{ id: 'p1', quantity: 1 }],
        recommendItems: [{ id: 'r1' }, { id: 'r4' }, { id: 'r2' }],
        preferences: { maxItems: 3, maxAdditionCost: 6, excludeIds: ['r2'], strategy: 'saving' } };
    const v13App = createApp({ dataDir: v13Dir, promotions: v13Promotions, catalog: v13Catalog });
    let minimumId, savingId, savingAmount;
    await withServer(v13App, async request => {
        const result = await request('/api/calculate', v13Input);
        minimumId = result.suggestion.id;
        assert.equal(result.mode, 'minimum-order');
        assert.deepEqual(result.preferences, v13Input.preferences);
        assert.equal(result.breakdown.subtotal, '19.00');
        assert.equal(result.breakdown.packagingFee, '0.50');
        assert.equal(result.breakdown.minimumOrder, 25);
        assert.equal(result.breakdown.minimumOrderGap, 6);
        assert.equal(result.breakdown.orderable, false);
        assert.equal(result.search.maxItems, 3);
        assert.equal(result.search.candidateCount, 2);
        assert.equal(result.search.exhaustive, true);
        const plan = result.suggestion;
        assert.equal(plan.kind, 'minimum-order');
        assert.equal(plan.itemCount, 3);
        assert.equal(plan.additionCost, 6);
        assert.equal(plan.netSaving, 0);
        assert.equal(plan.paymentChange, 7);
        assert.equal(plan.newTotal, 26.5);
        assert.equal(plan.testBreakdown.packagingFee, '1.50');
        assert.equal(plan.testBreakdown.orderable, true);
        assert.deepEqual(plan.items.map(item => [item.id, item.quantity]), [['r1', 2], ['r4', 1]]);
        assert.deepEqual(v13App.locals.store.data.quotes[minimumId].input.preferences, v13Input.preferences);
        const batch = await request('/api/calculate/batch', v13Input);
        assert.deepEqual(batch.preferences, v13Input.preferences);
        assert.equal(batch.mode, 'minimum-order');
        assert.equal(batch.suggestions[0].itemCount, 3);
        assert.equal(batch.suggestions[0].newTotal, plan.newTotal);
        assert.equal((await request('/api/calculate', { ...v13Input, preferences: { ...v13Input.preferences, maxItems: 2 } })).suggestion, null);
        assert.equal((await request('/api/calculate', { ...v13Input, preferences: { ...v13Input.preferences, maxAdditionCost: 5.99 } })).suggestion, null);
        assert.equal((await request('/api/calculate', { ...v13Input, preferences: { ...v13Input.preferences, maxAdditionCost: 5.999 } })).suggestion, null);
        const off = await request('/api/calculate', { ...v13Input, preferences: { maxItems: 0 } });
        assert.equal(off.suggestion, null);
        assert.match(off.reason, /关闭加购/);
        assertionGroups++;

        for (const preferences of [null, [], { maxItems: -1 }, { maxItems: 5 }, { maxItems: 2.1 }, { maxItems: '3' },
            { maxAdditionCost: -1 }, { maxAdditionCost: 1000.01 }, { maxAdditionCost: '6' },
            { excludeIds: ['missing'] }, { excludeIds: ['r1', 'r1'] }, { excludeIds: [1] }, { excludeIds: {} },
            { strategy: 'unknown' }]) {
            await request('/api/calculate', { ...v13Input, preferences }, 400);
            await request('/api/calculate/batch', { ...v13Input, preferences }, 400);
        }
        const tampered = structuredClone(v13Input);
        tampered.currentItems[0].packagingFee = 0;
        tampered.recommendItems[0].price = 0;
        tampered.recommendItems[0].stock = 100;
        tampered.recommendItems[0].packagingFee = 0;
        const canonical = await request('/api/calculate', tampered);
        assert.equal(canonical.suggestion.newTotal, plan.newTotal);
        assert.equal(canonical.breakdown.packagingFee, '0.50');
        await request('/api/calculate', { ...v13Input, currentItems: [{ id: 'p1', quantity: 1, packagingFee: -1 }] }, 400);
        assertionGroups++;

        await request('/api/events', { recommendationId: minimumId, type: 'shown' });
        const accepted = await request('/api/events', { recommendationId: minimumId, type: 'accepted', saved: 100 });
        assert.equal(accepted.event.kind, 'minimum-order');
        assert.equal(accepted.event.saved, 0);
        assert.equal(accepted.event.newTotal, 26.5);
        assert.equal(accepted.event.additionCost, 6);
        assert.equal(accepted.event.paymentChange, 7);
        let dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.acceptedCount, 1);
        assert.equal(dashboard.summary.minimumOrderAcceptedCount, 1);
        assert.equal(dashboard.summary.savingAcceptedCount, 0);
        assert.equal(dashboard.summary.totalSaved, 0);
        assert.equal(dashboard.summary.averageSaving, 0);
        assert.equal(dashboard.trend.reduce((sum, day) => sum + day.saved, 0), 0);

        const saving = await request('/api/calculate', { ...v13Input, currentItems: [{ id: 'p1', quantity: 2 }] });
        savingId = saving.suggestion.id; savingAmount = saving.suggestion.netSaving;
        assert.equal(saving.mode, 'saving');
        assert.equal(saving.suggestion.kind, 'saving');
        assert.ok(savingAmount > 0);
        assert.equal(saving.suggestion.paymentChange, -savingAmount);
        await request('/api/events', { recommendationId: savingId, type: 'shown' });
        await request('/api/events', { recommendationId: savingId, type: 'accepted' });
        dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.acceptedCount, 2);
        assert.equal(dashboard.summary.minimumOrderAcceptedCount, 1);
        assert.equal(dashboard.summary.savingAcceptedCount, 1);
        assert.equal(dashboard.summary.totalSaved, savingAmount);
        assert.equal(dashboard.summary.averageSaving, savingAmount / 2);
        const history = await request('/api/history?type=accepted');
        assert.deepEqual(history.events.map(event => event.kind), ['saving', 'minimum-order']);
        assertionGroups++;
    });

    await withServer(createApp({ dataDir: v13Dir, promotions: v13Promotions, catalog: v13Catalog }), async request => {
        const quote = await request(`/api/suggestions/${minimumId}`);
        assert.equal(quote.suggestion.kind, 'minimum-order');
        assert.equal(quote.suggestion.paymentChange, 7);
        assert.equal(quote.decision, 'accepted');
        assert.equal((await request('/api/dashboard')).summary.minimumOrderAcceptedCount, 1);
        const undo = await request('/api/events', { recommendationId: minimumId, type: 'reverted' });
        assert.equal(undo.event.saved, 0);
        assert.equal(undo.event.kind, 'minimum-order');
        assert.equal(undo.event.paymentChange, 7);
        assert.equal(undo.event.newTotal, 26.5);
        assert.equal((await request('/api/events', { recommendationId: minimumId, type: 'reverted' })).duplicate, true);
        const dashboard = await request('/api/dashboard');
        assert.equal(dashboard.summary.acceptedCount, 1);
        assert.equal(dashboard.summary.minimumOrderAcceptedCount, 0);
        assert.equal(dashboard.summary.savingAcceptedCount, 1);
        assert.equal(dashboard.summary.totalSaved, savingAmount);
        assert.equal(dashboard.summary.averageSaving, savingAmount);
        assertionGroups++;
    });

    const acceptanceCatalog = structuredClone(v13Catalog);
    const acceptancePromotions = structuredClone(v13Promotions);
    const recheckApp = createApp({ dataDir: path.join(temporaryRoot, 'recheck'), catalog: acceptanceCatalog, promotions: acceptancePromotions });
    await withServer(recheckApp, async request => {
        async function freshQuote() {
            const quote = (await request('/api/calculate', v13Input)).suggestion;
            await request('/api/events', { recommendationId: quote.id, type: 'shown' });
            return quote;
        }
        async function rejectChangedQuote(change, restore) {
            const quote = await freshQuote(); change(quote);
            await request('/api/events', { recommendationId: quote.id, type: 'accepted' }, 409);
            restore?.();
        }
        await rejectChangedQuote(() => { acceptanceCatalog[1].packagingFee = 1; }, () => { acceptanceCatalog[1].packagingFee = 0.25; });
        await rejectChangedQuote(() => { acceptanceCatalog[1].price = 3; }, () => { acceptanceCatalog[1].price = 2; });
        await rejectChangedQuote(() => { acceptanceCatalog[1].stock = 1; }, () => { acceptanceCatalog[1].stock = 2; });
        await rejectChangedQuote(() => { acceptancePromotions.minimumOrder = 26; }, () => { acceptancePromotions.minimumOrder = 25; });
        // Stored quotes also retain and recheck normalized constraints; external tampering cannot bypass them.
        await rejectChangedQuote(quote => { recheckApp.locals.store.data.quotes[quote.id].input.preferences.maxItems = 2; });
        await rejectChangedQuote(quote => { recheckApp.locals.store.data.quotes[quote.id].input.preferences.maxAdditionCost = 5; });
        await rejectChangedQuote(quote => { recheckApp.locals.store.data.quotes[quote.id].input.preferences.excludeIds = ['r1']; });
        await rejectChangedQuote(quote => { recheckApp.locals.store.data.quotes[quote.id].suggestion.kind = 'saving'; });
        await rejectChangedQuote(quote => { recheckApp.locals.store.data.quotes[quote.id].suggestion.paymentChange = 0; });
        const valid = await freshQuote();
        await request('/api/events', { recommendationId: valid.id, type: 'accepted' });
        assert.equal((await request('/api/dashboard')).summary.totalSaved, 0);
        assert.equal((await request('/api/dashboard')).summary.minimumOrderAcceptedCount, 1);
        assertionGroups++;
    });

    const corruptDir = path.join(temporaryRoot, 'corrupt');
    fs.mkdirSync(corruptDir);
    fs.writeFileSync(path.join(corruptDir, 'events.json'), '{broken');
    assert.throws(() => new DemoStore(corruptDir), /原文件已保留/);
    assert.equal(fs.readFileSync(path.join(corruptDir, 'events.json'), 'utf8'), '{broken');
    assertionGroups++;
    console.log(`API integration: PASS (${assertionGroups} groups; alternatives, undo, history, recovery, validation, persistence, file failure)`);
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    // Validate the exact generated target before recursively removing our isolated test files.
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('netsave-api-')) {
        fs.rmSync(resolved, { recursive: true, force: true });
    }
});
