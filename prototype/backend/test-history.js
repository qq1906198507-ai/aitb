// 用户可见故障回归：历史筛选并发、分页恢复、撤销金额与旧看板响应。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function environment(file) {
    const elements = new Map();
    const requests = [];
    const blobs = [];
    function element(id) {
        if (elements.has(id)) return elements.get(id);
        const listeners = new Map();
        const attributes = new Map();
        const classes = new Set();
        const result = { textContent: '', innerHTML: '', disabled: false, hidden: false, style: {}, dataset: {},
            addEventListener(name, fn) { listeners.set(name, fn); },
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name); },
            classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
            fire(name = 'click') { return listeners.get(name)?.(); }, click() {}, remove() {} };
        elements.set(id, result);
        return result;
    }
    const filters = ['all', 'accepted', 'rejected', 'reverted'].map((type) => {
        const button = element(`filter-${type}`);
        button.dataset.type = type;
        return button;
    });
    const document = { hidden: false, getElementById: element, querySelectorAll: () => filters,
        createElement: () => element('download'), body: { appendChild() {} }, addEventListener() {} };
    const context = vm.createContext({ console, AbortController, URLSearchParams, Blob, document,
        window: { addEventListener() {} }, setTimeout: () => 1, clearTimeout() {},
        URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:report'; }, revokeObjectURL() {} },
        fetch(url, options) { return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })); }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    return { element, requests, blobs, filters,
        respond(index, data) { requests[index].resolve({ ok: true, json: async () => data }); },
        fail(index) { requests[index].reject(new Error('network unavailable')); } };
}

const flush = () => new Promise(setImmediate);
const event = (id, overrides = {}) => ({ id, recommendationId: `quote-${id}`, type: 'accepted',
    createdAt: '2026-10-20T02:00:00.000Z', itemNames: [`商品${id}`], saved: 3, ...overrides });
const page = (events, nextCursor = null, total = events.length) => ({ events, total, nextCursor });

test('历史：快速切换筛选后，旧请求后到也不会覆盖当前记录', async () => {
    const env = environment('history-app.js');
    env.element('filter-accepted').fire();
    assert.equal(env.requests.length, 2);
    assert.match(env.requests[1].url, /type=accepted/);
    assert.equal(env.requests[0].options.signal.aborted, true);
    env.respond(1, page([event('current')]));
    await flush();
    env.respond(0, page([event('stale', { type: 'rejected' })]));
    await flush();
    assert.match(env.element('historyList').innerHTML, /商品current/);
    assert.doesNotMatch(env.element('historyList').innerHTML, /商品stale/);
    assert.equal(env.element('filter-accepted').getAttribute('aria-pressed'), 'true');
    assert.equal(env.element('filter-all').getAttribute('aria-pressed'), 'false');
    assert.equal(env.element('historyRefreshBtn').disabled, false);
});

test('历史：分页失败保留记录，重试同一游标并去重，连点不发重复请求', async () => {
    const env = environment('history-app.js');
    env.respond(0, page([event('a'), event('b')], 'b', 3));
    await flush();
    env.element('historyMoreBtn').fire();
    env.element('historyMoreBtn').fire();
    assert.equal(env.requests.length, 2);
    assert.match(env.requests[1].url, /before=b/);
    env.fail(1);
    await flush();
    assert.match(env.element('historyList').innerHTML, /商品a/);
    assert.match(env.element('historyList').innerHTML, /商品b/);
    assert.match(env.element('historyMessage').textContent, /已显示的内容保留/);
    assert.equal(env.element('historyRetryBtn').hidden, false);
    env.element('historyRetryBtn').fire();
    assert.match(env.requests[2].url, /before=b/);
    env.respond(2, page([event('b'), event('c')], null, 3));
    await flush();
    assert.equal((env.element('historyList').innerHTML.match(/role="listitem"/g) || []).length, 3);
    assert.match(env.element('historyCount').textContent, /共 3 条操作记录 · 已显示 3 条/);
    assert.equal(env.element('historyMoreBtn').hidden, true);
    assert.match(env.element('historyEndNote').textContent, /全部记录/);
});

test('历史：刷新失败标明旧快照，重试成功后替换为最新第一页', async () => {
    const env = environment('history-app.js');
    env.respond(0, page([event('old')], 'old', 2));
    await flush();
    env.element('historyRefreshBtn').fire();
    env.fail(1);
    await flush();
    assert.match(env.element('historyList').innerHTML, /商品old/);
    assert.match(env.element('historyConnection').textContent, /保留上次成功获取/);
    env.element('historyRetryBtn').fire();
    assert.doesNotMatch(env.requests[2].url, /before=/);
    env.respond(2, page([event('new')]));
    await flush();
    assert.match(env.element('historyList').innerHTML, /商品new/);
    assert.doesNotMatch(env.element('historyList').innerHTML, /商品old/);
    assert.equal(env.element('historyRetryBtn').hidden, true);
});

test('历史：撤销扣回和原采纳标记准确，商品名以文本展示', async () => {
    const env = environment('history-app.js');
    env.respond(0, page([
        event('undo', { type: 'reverted', saved: -3, itemNames: ['<img src=x onerror="alert(1)">'] }),
        event('original', { reverted: true }), event('active', { saved: 1 })
    ]));
    await flush();
    const html = env.element('historyList').innerHTML;
    assert.match(html, /¥3\.00<\/span><small>已扣回预计净省/);
    assert.match(html, /<del>¥3\.00<\/del><small>已撤销 · 不计入当前净省/);
    assert.match(html, /\+¥1\.00/);
    assert.doesNotMatch(html, /\+¥3\.00|¥-3|<img /);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

function dashboard(overrides = {}) {
    return { source: 'local-demo',
        summary: { shownCount: 2, acceptedCount: 1, rejectedCount: 0, pendingCount: 1,
            totalSaved: 3, averageSaving: 3, adoptionRate: 1 },
        performance: { sampleCount: 1, averageMs: 0.1, p99Ms: 0.1 },
        trend: [{ date: '2026-10-20', saved: 3, acceptedCount: 1 }],
        recentEvents: [event('active')], ...overrides };
}

test('看板：兼容没有撤销计数的旧响应，撤销后使用服务端有效汇总', async () => {
    const env = environment('dashboard-app.js');
    env.respond(0, dashboard());
    await flush();
    assert.equal(env.element('totalSaved').textContent, '¥3.00');
    assert.match(env.element('revertedDetail').textContent, /已撤销 0 次/);
    assert.match(env.element('acceptedKindsDetail').textContent, /净省采纳 1 次 · 起送转化 0 次/);
    assert.equal(env.element('exportBtn').disabled, false);
    env.element('refreshBtn').fire();
    const afterUndo = dashboard({ summary: { shownCount: 2, acceptedCount: 0, rejectedCount: 0,
        pendingCount: 1, totalSaved: 0, averageSaving: 0, adoptionRate: null, revertedCount: 1 },
        trend: [{ date: '2026-10-20', saved: 0, acceptedCount: 0 }],
        recentEvents: [event('undo', { type: 'reverted', saved: -3 }), event('original', { reverted: true })] });
    env.respond(1, afterUndo);
    await flush();
    assert.equal(env.element('totalSaved').textContent, '¥0.00');
    assert.equal(env.element('adoptionRate').textContent, '—');
    assert.match(env.element('revertedDetail').textContent, /已撤销 1 次/);
    assert.match(env.element('trendHint').innerHTML, /尚无有效净省金额/);
    const html = env.element('eventsList').innerHTML;
    assert.match(html, /已撤销加购/);
    assert.match(html, /已采纳后撤销/);
    assert.match(html, /<del>¥3\.00<\/del>/);
    assert.doesNotMatch(html, /\+¥3|¥-3/);
});

test('看板：CSV 保留负数扣回金额，并转义以公式开头的商品名', async () => {
    const env = environment('dashboard-app.js');
    env.respond(0, dashboard({ recentEvents: [event('undo', { type: 'reverted', saved: -3, itemNames: ['=SUM(1)'] }),
        event('original', { reverted: true }), event('minimum', { kind: 'minimum-order', saved: 0,
            newTotal: 29, additionCost: 4, paymentChange: 2 })] }));
    await flush();
    env.element('exportFormat').value = 'csv';
    env.element('exportBtn').fire();
    const csv = await env.blobs[0].text();
    assert.match(csv, /"采纳是否已撤销"/);
    assert.match(csv, /"'=SUM\(1\)","-3",""/);
    assert.match(csv, /"accepted","商品original","3","是"/);
    assert.match(csv, /"起送补单","29","4","2"/);
    assert.doesNotMatch(csv, /"'-3"/);
});

for (const [file, listId] of [['history-app.js', 'historyList'], ['dashboard-app.js', 'eventsList']]) {
    test(`${file}：起送补单展示实付和有符号估算变化，采纳及撤销不宣传净省`, async () => {
        const env = environment(file);
        const minimum = (id, overrides = {}) => event(id, { kind: 'minimum-order', saved: 0,
            newTotal: 30.8, additionCost: 3, paymentChange: 2.8, ...overrides });
        const events = [minimum('active'), minimum('reduced', { newTotal: 21, paymentChange: -1 }),
            minimum('original', { reverted: true }), minimum('undo', { type: 'reverted' }),
            minimum('ignored', { type: 'rejected' })];
        env.respond(0, file === 'history-app.js' ? page(events) : dashboard({
            summary: { shownCount: 5, acceptedCount: 2, savingAcceptedCount: 0, minimumOrderAcceptedCount: 2,
                rejectedCount: 1, pendingCount: 1, totalSaved: 0, averageSaving: 0, adoptionRate: 2 / 3, revertedCount: 1 },
            trend: [{ date: '2026-10-20', saved: 0, acceptedCount: 2 }], recentEvents: events }));
        await flush();
        const html = env.element(listId).innerHTML;
        assert.match(html, /已采纳起送补单/);
        assert.match(html, /¥30\.80/);
        assert.match(html, /补单后实付/);
        assert.match(html, /额外增支 ¥2\.80/);
        assert.match(html, /估算减少 ¥1\.00/);
        assert.match(html, /原车不可下单/);
        assert.match(html, /已撤销补单/);
        assert.match(html, /<del>¥30\.80<\/del>/);
        assert.doesNotMatch(html, /\+¥0|已扣回预计净省|<small>预计净省|¥-1/);
        if (file === 'dashboard-app.js') {
            assert.equal(env.element('totalSaved').textContent, '¥0.00');
            assert.equal(env.element('avgSaving').textContent, '¥0.00');
            assert.match(env.element('acceptedKindsDetail').textContent, /净省采纳 0 次 · 起送转化 2 次/);
        }
    });
}

test('看板：混合采纳的平均净省按全部有效采纳计算，保留服务端口径', async () => {
    const env = environment('dashboard-app.js');
    env.respond(0, dashboard({ summary: { shownCount: 3, acceptedCount: 3, savingAcceptedCount: 1,
        minimumOrderAcceptedCount: 2, rejectedCount: 0, pendingCount: 0, totalSaved: 3,
        averageSaving: 1, adoptionRate: 1, revertedCount: 0 } }));
    await flush();
    assert.equal(env.element('acceptedCount').textContent, 3);
    assert.equal(env.element('avgSaving').textContent, '¥1.00');
    assert.match(env.element('acceptedKindsDetail').textContent, /净省采纳 1 次 · 起送转化 2 次/);
});
