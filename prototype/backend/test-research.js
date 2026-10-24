const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
const { registerResearchRoutes } = require('./research');
const { createApp } = require('./server');

async function withApi(run) {
    const app = express();
    app.use(express.json());
    registerResearchRoutes(app);
    app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(path, body) {
        const response = await fetch(base + path, body === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        return { status: response.status, data: await response.json() };
    }
    try { await run(request, app); } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('research fixtures are frozen, explicit, and do not attach the business store', () => withApi(async (request, app) => {
    const first = await request('/api/research/tasks');
    assert.equal(first.status, 200);
    assert.equal(first.data.version, '1');
    assert.equal(first.data.fixedTime, '2026-10-20T07:00:00.000Z');
    assert.match(first.data.notice, /演示数据/);
    assert.deepEqual(first.data.preferences, { maxItems: 3, maxAdditionCost: 10, excludeIds: [], strategy: 'saving' });
    assert.equal(app.locals.store, undefined);
    assert.equal(app.locals.engine, undefined);
    const [saving, minimum] = first.data.tasks;
    assert.deepEqual(first.data.tasks.map(task => task.id), ['saving', 'minimum-order']);
    assert.equal(saving.currentItems.reduce((sum, item) => sum + item.price * item.quantity, 0), 48);
    assert.equal(minimum.currentItems.reduce((sum, item) => sum + item.price * item.quantity, 0), 20);
    assert.equal(saving.baseline.total, '35.00');
    assert.equal(saving.baseline.orderable, true);
    assert.equal(minimum.baseline.total, '20.00');
    assert.equal(minimum.baseline.orderable, false);
    assert.equal(minimum.baseline.minimumOrderGap, 5);
    assert.equal(saving.promotions.delivery.peakHours.enabled, false);
    assert.ok(saving.currentItems.every(item => item.inCart && item.quantity === 1 && item.stock >= 1 && item.packagingFee === 0));
    assert.deepEqual(saving.recommendItems.map(item => [item.id, item.price, item.stock]), [['r1', 3, 10], ['r2', 4, 5], ['r3', 5, 8], ['r4', 2, 20], ['r5', 2.5, 3]]);
    assert.ok(saving.recommendItems.every(item => item.flashSale === null && item.packagingFee === 0));
    saving.currentItems[0].price = -100;
    saving.recommendItems[0].stock = 0;
    const again = await request('/api/research/tasks');
    assert.equal(again.data.tasks[0].currentItems[0].price, 28);
    assert.equal(again.data.tasks[0].recommendItems[0].stock, 10);
    first.data.tasks[0].currentItems[0].price = 28;
    first.data.tasks[0].recommendItems[0].stock = 10;
    assert.deepEqual(again.data, first.data);
}));

test('saving evaluation uses authoritative totals and distinguishes no gain', () => withApi(async request => {
    const result = await request('/api/research/evaluate', { taskId: 'saving', additions: [{ id: 'r4', quantity: 1 }] });
    assert.equal(result.status, 200);
    assert.equal(result.data.newTotal, 32);
    assert.equal(result.data.netSaving, 3);
    assert.equal(result.data.paymentChange, -3);
    assert.equal(result.data.additionCost, 2);
    assert.equal(result.data.itemCount, 1);
    assert.equal(result.data.kind, 'saving');
    assert.equal(result.data.objectiveMet, true);
    assert.equal(result.data.additions[0].name, '米饭');
    assert.equal(result.data.additions[0].inCart, true);
    assert.equal(result.data.fixedTime, '2026-10-20T07:00:00.000Z');
    const unchanged = await request('/api/research/evaluate', { taskId: 'saving', additions: [{ id: 'r3', quantity: 1 }] });
    assert.equal(unchanged.data.newTotal, 35);
    assert.equal(unchanged.data.netSaving, 0);
    assert.equal(unchanged.data.objectiveMet, false);
}));

test('minimum-order evaluation never calls the infeasible baseline a saving', () => withApi(async request => {
    const result = await request('/api/research/evaluate', { taskId: 'minimum-order', additions: [{ id: 'r1', quantity: 1 }, { id: 'r4', quantity: 1 }] });
    assert.equal(result.status, 200);
    assert.equal(result.data.baseline.orderable, false);
    assert.equal(result.data.breakdown.orderable, true);
    assert.equal(result.data.newTotal, 25);
    assert.equal(result.data.netSaving, 0);
    assert.equal(result.data.paymentChange, 5);
    assert.equal(result.data.objectiveMet, true);
    assert.equal(result.data.kind, 'minimum-order');
    const half = await request('/api/research/evaluate', { taskId: 'minimum-order', additions: [{ id: 'r5', quantity: 1 }, { id: 'r4', quantity: 1 }] });
    assert.equal(half.data.additionCost, 4.5);
    assert.equal(half.data.newTotal, 24.5);
    assert.equal(half.data.paymentChange, 4.5);
    assert.equal(half.data.objectiveMet, false);
    assert.equal(half.data.netSaving, 0);
}));

test('zero additions are valid and preserve each baseline without claiming a goal', () => withApi(async request => {
    for (const taskId of ['saving', 'minimum-order']) {
        const result = await request('/api/research/evaluate', { taskId, additions: [] });
        assert.equal(result.status, 200);
        assert.equal(result.data.objectiveMet, false);
        assert.equal(result.data.itemCount, 0);
        assert.equal(result.data.additionCost, 0);
        assert.equal(result.data.paymentChange, 0);
        assert.equal(result.data.netSaving, 0);
        assert.deepEqual(result.data.breakdown, result.data.baseline);
    }
}));

test('all recommended plans can be independently submitted to evaluation with equal totals', () => withApi(async request => {
    for (const taskId of ['saving', 'minimum-order']) {
        const result = await request('/api/research/solve', { taskId });
        assert.equal(result.status, 200);
        assert.equal(result.data.taskId, taskId);
        assert.equal(result.data.mode, taskId);
        assert.equal(result.data.version, '1');
        assert.equal(result.data.fixedTime, '2026-10-20T07:00:00.000Z');
        assert.equal(result.data.suggestions.length, 3);
        for (const suggestion of result.data.suggestions) {
            assert.equal(suggestion.id, undefined, 'research solver must not create adoptable quotes');
            assert.equal(suggestion.groupId, undefined);
            const evaluated = await request('/api/research/evaluate', { taskId, additions: suggestion.items.map(({ id, quantity }) => ({ id, quantity })) });
            assert.equal(evaluated.status, 200);
            assert.equal(evaluated.data.objectiveMet, true);
            for (const key of ['newTotal', 'netSaving', 'paymentChange', 'itemCount', 'additionCost', 'kind']) {
                assert.equal(evaluated.data[key], suggestion[key], `${taskId}: ${key}`);
            }
            assert.deepEqual(evaluated.data.breakdown, suggestion.testBreakdown);
        }
        const repeated = await request('/api/research/solve', { taskId });
        assert.deepEqual(repeated.data, result.data);
    }
}));

test('evaluate rejects malformed identities, quantities, duplicate and injected fields', () => withApi(async request => {
    const invalidBodies = [null, [], {}, { taskId: 'saving' },
        { taskId: 'invalid', additions: [] }, { taskId: 1, additions: [] },
        { taskId: {}, additions: [] }, { taskId: 'saving', additions: null },
        { taskId: 'saving', additions: {} }, { taskId: 'saving', additions: [], preferences: {} },
        { taskId: 'saving', additions: [null] }, { taskId: 'saving', additions: [[]] },
        { taskId: 'saving', additions: [{}] }, { taskId: 'saving', additions: [{ id: 'p1', quantity: 1 }] },
        { taskId: 'saving', additions: [{ id: 'unknown', quantity: 1 }] },
        { taskId: 'saving', additions: [{ id: '__proto__', quantity: 1 }] },
        { taskId: 'saving', additions: [{ id: 'r1', quantity: 1 }, { id: 'r1', quantity: 1 }] },
        ...[0, -1, 0.5, '1', null, 11].map(quantity => ({ taskId: 'saving', additions: [{ id: 'r1', quantity }] })),
        { taskId: 'saving', additions: [{ id: 'r5', quantity: 4 }] },
        { taskId: 'saving', additions: [{ id: 'r1', quantity: 1, price: 0 }] },
        { taskId: 'saving', additions: [{ id: 'r1', quantity: 1, inCart: false }] }
    ];
    for (const body of invalidBodies) {
        const result = await request('/api/research/evaluate', body);
        assert.equal(result.status, 400, JSON.stringify(body));
        assert.equal(typeof result.data.error, 'string');
    }
}));

test('evaluate enforces total pieces and budget in integer cents', () => withApi(async request => {
    const tooMany = await request('/api/research/evaluate', { taskId: 'saving', additions: [{ id: 'r4', quantity: 3 }, { id: 'r1', quantity: 1 }] });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /3件/);
    const budget = await request('/api/research/evaluate', { taskId: 'saving', additions: [{ id: 'r2', quantity: 3 }] });
    assert.equal(budget.status, 400);
    assert.match(budget.data.error, /10元/);
    const exact = await request('/api/research/evaluate', { taskId: 'saving', additions: [{ id: 'r3', quantity: 2 }] });
    assert.equal(exact.status, 200);
    assert.equal(exact.data.additionCost, 10);
}));

test('solve accepts only a known taskId', () => withApi(async request => {
    for (const body of [null, [], {}, { taskId: null }, { taskId: 'wrong' }, { taskId: 1 }, { taskId: 'saving', additions: [] }, { taskId: 'saving', currentItems: [] }]) {
        const result = await request('/api/research/solve', body);
        assert.equal(result.status, 400, JSON.stringify(body));
    }
}));

test('createApp serves research assets and keeps research activity out of business metrics', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netsave-research-integration-'));
    const fixedNow = Date.parse('2026-10-21T07:00:00.000Z');
    const app = createApp({ dataDir, now: () => fixedNow });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(route, body) {
        const response = await fetch(base + route, body === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        return { response, data: await response.json() };
    }

    try {
        for (const [route, contentType] of [
            ['/research.html', /text\/html/],
            ['/research.css', /text\/css/],
            ['/research-app.js', /javascript/]
        ]) {
            const response = await fetch(base + route);
            assert.equal(response.status, 200, route);
            assert.match(response.headers.get('content-type'), contentType, route);
            assert.ok((await response.text()).length > 0, route);
        }

        const cart = await request('/api/cart/default');
        const calculation = await request('/api/calculate', cart.data);
        assert.equal(calculation.response.status, 200);
        const recommendationId = calculation.data.suggestion.id;
        assert.equal((await request('/api/events', { recommendationId, type: 'shown' })).response.status, 200);
        assert.equal((await request('/api/events', { recommendationId, type: 'accepted' })).response.status, 200);

        const beforeDashboard = await request('/api/dashboard');
        assert.equal(beforeDashboard.response.status, 200);
        assert.equal(beforeDashboard.data.summary.shownCount, 1);
        assert.equal(beforeDashboard.data.summary.acceptedCount, 1);
        assert.ok(beforeDashboard.data.performance.sampleCount > 0);
        const beforeBusinessData = structuredClone(app.locals.store.data);
        const beforeLatencySamples = [...app.locals.engine.latencySamples];

        const tasks = await request('/api/research/tasks');
        assert.equal(tasks.response.status, 200);
        assert.deepEqual(tasks.data.tasks.map(task => task.id), ['saving', 'minimum-order']);
        for (const taskId of ['saving', 'minimum-order']) {
            const solved = await request('/api/research/solve', { taskId });
            assert.equal(solved.response.status, 200);
            assert.ok(solved.data.suggestions.length > 0, taskId);
            const additions = taskId === 'saving'
                ? [{ id: 'r4', quantity: 1 }]
                : [{ id: 'r1', quantity: 1 }, { id: 'r4', quantity: 1 }];
            const evaluated = await request('/api/research/evaluate', { taskId, additions });
            assert.equal(evaluated.response.status, 200);
            assert.equal(evaluated.data.objectiveMet, true, taskId);
        }

        const afterDashboard = await request('/api/dashboard');
        assert.deepEqual(afterDashboard.data.summary, beforeDashboard.data.summary);
        assert.deepEqual(afterDashboard.data.performance, beforeDashboard.data.performance);
        assert.deepEqual(app.locals.store.data, beforeBusinessData);
        assert.deepEqual(app.locals.engine.latencySamples, beforeLatencySamples);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
