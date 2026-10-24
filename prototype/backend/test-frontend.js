// 真实故障回归：异步响应、持久化恢复、撤销和备选方案切换。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function environment(storage = new Map()) {
    const elements = new Map();
    const timers = [];
    const alerts = [];
    function element(id) {
        if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', innerHTML: '', disabled: false,
            classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, setAttribute() {}, focus() {}, querySelectorAll() { return []; } });
        return elements.get(id);
    }
    const context = vm.createContext({ console, performance, AbortController,
        document: { addEventListener() {}, getElementById: element, querySelector: () => element('query'), querySelectorAll: () => [], createElement: () => element('created') },
        setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval() {},
        localStorage: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, String(value)); } },
        alert(message) { alerts.push(message); }
    });
    return { context, timers, alerts, storage, run: (code) => vm.runInContext(code, context), load(file) { vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }); } };
}

for (const app of ['app.js', 'mobile-app.js']) {
    test(`${app}: 采纳后提示使用原建议，移除重加不重复，空车不推荐`, () => {
        const env = environment();
        ['data.js', 'algorithm.js', app].forEach(file => env.load(file));
        env.run('checkNetSaving(); acceptSuggestion();');
        env.timers.splice(0).forEach(fn => fn());
        assert.match(env.alerts[0], /米饭.*3.00/);
        assert.equal(env.run('currentSuggestion'), null);
        assert.equal(env.run('calcPriceBreakdown(cartState.items).total'), '35.00');
        env.run("updateItemQuantity('r4', -1); acceptSuggestion();");
        env.timers.splice(0).forEach(fn => fn());
        assert.equal(env.run("cartState.items.filter(i => i.id === 'r4').length"), 1);
        assert.equal(env.run('calcPriceBreakdown(cartState.items).subtotal'), '50.00');
        env.run('cartState.items.forEach(i => { i.inCart = false; i.quantity = 0; }); checkNetSaving();');
        assert.equal(env.run('calcPriceBreakdown(cartState.items).total'), '0.00');
        assert.equal(env.run('currentSuggestion'), null);
    });
}

test('API版：快速改动忽略旧响应，计算开始即清除旧建议', async () => {
    const env = environment();
    const requests = [];
    env.context.fetch = () => new Promise(resolve => requests.push(resolve));
    env.load('mobile-api-app.js');
    env.run("state.cart = [{id:'p1',quantity:1,price:28}]; state.suggestion = {id:'stale'};");
    const first = env.run('recalc()');
    assert.equal(env.run('state.suggestion'), null);
    const second = env.run('recalc()');
    const response = (total) => ({ ok: true, json: async () => ({ breakdown: { subtotal: total, total, deliveryFee: 0, fullReduction: 0, coupon: 0 }, suggestion: null, performance: {} }) });
    requests[1](response('20.00')); await second;
    requests[0](response('99.00')); await first;
    assert.equal(env.run('state.breakdown.total'), '20.00');
    assert.equal(env.run('state.calculating'), false);
});

test('API版：统计保存失败不加购，重试成功后组合一次性加入', async () => {
    const env = environment();
    env.load('mobile-api-app.js');
    env.run("state.cart = [{id:'p1',quantity:1}]; state.pool = [{id:'p1',name:'套餐',price:28},{id:'r1',name:'卤蛋',price:1},{id:'r4',name:'米饭',price:1}]; state.modal = {shown:true,suggestion:{id:'quote',items:[{id:'r1',name:'卤蛋',quantity:1},{id:'r4',name:'米饭',quantity:1}],netSaving:3}};");
    env.context.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'write failure' }) });
    await env.run("decide('accepted')");
    assert.equal(env.run('state.cart.length'), 1);
    assert.equal(env.run('state.modal.shown'), true);
    assert.equal(env.run('state.modal.pendingType'), 'accepted');
    assert.equal(env.run("document.getElementById('rejectBtn').disabled"), true);
    await env.run("decide('rejected')");
    assert.equal(env.run('state.modal.pendingType'), 'accepted');
    env.context.fetch = async (url, options = {}) => ({ ok: true, json: async () => url.endsWith('/api/events')
        ? { event: { type: JSON.parse(options.body).type }, currentDecision: JSON.parse(options.body).type }
        : { breakdown: { subtotal: '50.00', total: '32.00', deliveryFee: '0.00', fullReduction: '10.00', coupon: '8.00' }, suggestion: null, performance: {} } });
    await env.run("decide('accepted')");
    assert.equal(env.run('state.cart.length'), 3);
    assert.equal(env.run('state.modal'), null);
    assert.equal(env.run('state.deciding'), false);
    await env.run("decide('accepted')");
    assert.equal(env.run('state.cart.length'), 3);
});

test('API版：后台期间折扣过期，回到前台后重新计算', () => {
    const env = environment();
    env.load('mobile-api-app.js');
    env.run("state.pool = [{id:'r2',price:6,flashSale:{salePrice:4,endTime:Date.now()-1000}}]; lastPriceCheck=Date.now()-2000; document.hidden=true; let recalcCalls=0; recalc=()=>{recalcCalls++}; tickClock(); document.hidden=false; tickClock();");
    assert.equal(env.run('recalcCalls'), 1);
});

test('API版：恢复示例期间旧建议失效，不能同时采纳', async () => {
    const env = environment();
    env.load('mobile-api-app.js');
    let finish;
    env.context.fetch = () => new Promise(resolve => { finish = resolve; });
    env.run("state.suggestion={id:'old'}; recalc=async()=>{};");
    const reset = env.run('resetCart()');
    assert.equal(env.run('state.suggestion'), null);
    assert.equal(env.run('state.resetting'), true);
    await env.run('openModal()');
    assert.equal(env.run('state.modal'), null);
    finish({ ok: true, json: async () => ({ currentItems: [{ id: 'p1', quantity: 1 }], recommendItems: [] }) });
    await reset;
    assert.equal(env.run('state.resetting'), false);
});

const sessionKey = 'netsave-demo-session-v2';
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
const flushPromises = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** Contract fake with independent server decisions, shared across simulated reloads. */
function lifecycleApi() {
    const base = { id: 'p1', name: '套餐', price: 28, quantity: 1, stock: 99, inCart: true };
    const egg = { id: 'r1', name: '卤蛋', price: 3, stock: 99 };
    const rice = { id: 'r4', name: '米饭', price: 2, stock: 99 };
    const breakdown = { subtotal: '48.00', total: '35.00', deliveryFee: '0.00', fullReduction: '5.00', coupon: '8.00' };
    const makePlan = (id, product, saving) => ({ id, groupId: 'group-1', createdAt: new Date().toISOString(),
        expiresAt: Date.now() + 300000, title: `加购${product.name}`, detail: '计入加购成本',
        items: [{ ...product, actualPrice: product.price, quantity: 1 }], item: product,
        itemCount: 1, additionCost: product.price, netSaving: saving, currentTotal: 35, newTotal: 35 - saving,
        calculation: { steps: Array.from({ length: 3 }, () => ({ label: '计算', value: '35', detail: '明细' })),
            result: { label: '预计净省', value: String(saving), formula: '35 - 32 = 3' } } });
    const plans = [makePlan('quote-rice', rice, 3), makePlan('quote-egg', egg, 2)];
    const decisions = new Map();
    const events = new Map();
    const shown = new Set();
    const calls = [];
    const failures = [];
    const held = new Map();
    const holds = new Set();
    let commits = { accepted: 0, rejected: 0, reverted: 0 };
    const fetch = async (url, options = {}) => {
        const route = url.replace('http://127.0.0.1:3000', '');
        const body = options.body && JSON.parse(options.body);
        calls.push({ route, body });
        if (route === '/api/cart/default') return response({ currentItems: [base], recommendItems: [egg, rice] });
        if (route === '/api/promotions') return response({ fullReduction: [], delivery: { baseFee: 5, freeThreshold: 50 } });
        if (route === '/api/calculate') return response({ breakdown, suggestion: plans[0], alternatives: plans,
            performance: { calcTimeMs: '1.0', candidateCount: 2, combinationCount: 5, p99Ms: '1.0', sampleCount: 1 } });
        if (route.startsWith('/api/suggestions/')) {
            const id = decodeURIComponent(route.slice('/api/suggestions/'.length));
            const suggestion = plans.find(plan => plan.id === id);
            return suggestion ? response({ suggestion, decision: decisions.get(id) || null, shown: shown.has(id) })
                : response({ error: 'Unknown suggestion' }, 404);
        }
        if (route !== '/api/events') throw new Error(`Unexpected request ${route}`);
        const { recommendationId: id, type } = body;
        const failureIndex = failures.findIndex(failure => failure.type === type);
        const failure = failureIndex >= 0 ? failures.splice(failureIndex, 1)[0].mode : null;
        if (failure === 'before') return response({ error: 'Disk unavailable' }, 503);
        const key = `${id}:${type}`;
        const duplicate = events.has(key);
        if (!duplicate) {
            if (type === 'shown') shown.add(id);
            else {
                if (type === 'reverted' && decisions.get(id) !== 'accepted') return response({ error: 'Not accepted' }, 409);
                if (type !== 'reverted' && decisions.has(id)) return response({ error: 'Already decided' }, 409);
                decisions.set(id, type); commits[type]++;
            }
            events.set(key, { id: `${id}-${type}`, recommendationId: id, type });
        }
        if (failure === 'after') throw new TypeError('Network response lost after server commit');
        const receipt = response({ event: events.get(key), duplicate, currentDecision: decisions.get(id) || null });
        if (type === 'shown' && holds.has(id)) return new Promise(resolve => held.set(id, { resolve, receipt }));
        return receipt;
    };
    return { plans, fetch, calls, failures, decisions, commits, held, holds,
        eventCalls: type => calls.filter(call => call.route === '/api/events' && call.body.type === type),
        release(id, status = 200) { const wait = held.get(id); assert.ok(wait, `No held request for ${id}`);
            held.delete(id); wait.resolve(status === 200 ? wait.receipt : response({ error: 'Late failure' }, status)); } };
}

async function mobileSession(remote, storage) {
    const env = environment(storage);
    env.context.fetch = remote.fetch;
    env.load('mobile-api-app.js');
    await env.run('init()');
    return env;
}

async function acceptFirst(env) {
    await env.run('openModal()');
    await env.run("decide('accepted')");
}

test('API v1.2：采纳响应丢失后刷新按服务端恢复，两次刷新都不重复加购', async () => {
    const remote = lifecycleApi();
    const storage = new Map();
    const first = await mobileSession(remote, storage);
    remote.failures.push({ type: 'accepted', mode: 'after' });
    await acceptFirst(first);
    assert.equal(remote.commits.accepted, 1);
    assert.equal(first.run('state.cart.length'), 1, 'Unconfirmed response does not mutate the local cart');
    assert.equal(first.run('state.pending.type'), 'accepted');
    const pendingSession = JSON.parse(storage.get(sessionKey));
    assert.equal(pendingSession.cart.length, 1);
    assert.equal(pendingSession.pending.recommendationId, remote.plans[0].id);

    const recovered = await mobileSession(remote, storage);
    assert.equal(recovered.run('state.pending'), null);
    assert.equal(recovered.run("state.cart.filter(i => i.id === 'r4').length"), 1);
    assert.equal(recovered.run("state.cart.find(i => i.id === 'r4').quantity"), 1);
    assert.equal(recovered.run('state.undo.recommendationId'), remote.plans[0].id);
    assert.equal(remote.eventCalls('accepted').length, 1, 'Recovery reads the committed decision');
    const again = await mobileSession(remote, storage);
    assert.equal(again.run("state.cart.find(i => i.id === 'r4').quantity"), 1);
    assert.equal(again.run('state.undo.recommendationId'), remote.plans[0].id, 'Undo survives a regular reload');
    assert.equal(remote.commits.accepted, 1);
});

test('API v1.2：撤销写入失败保留购物车，丢失响应后重试按权威状态幂等恢复', async () => {
    const remote = lifecycleApi();
    const env = await mobileSession(remote);
    await acceptFirst(env);
    remote.failures.push({ type: 'reverted', mode: 'before' });
    await env.run('undoSuggestion()');
    assert.equal(env.run('state.cart.length'), 2);
    assert.equal(env.run('state.pending.type'), 'reverted');
    assert.equal(env.run('state.undoing'), false);
    assert.equal(remote.commits.reverted, 0);
    assert.match(env.run("document.getElementById('undoBtn').textContent"), /重试/);
    remote.failures.push({ type: 'reverted', mode: 'after' });
    await env.run('undoSuggestion()');
    assert.equal(env.run('state.cart.length'), 2);
    assert.equal(remote.commits.reverted, 1);
    await env.run('undoSuggestion()');
    assert.equal(env.run('state.cart.length'), 1);
    assert.equal(env.run('state.cart[0].id'), 'p1');
    assert.equal(env.run('state.pending'), null);
    assert.equal(env.run('state.undo'), null);
    assert.equal(remote.eventCalls('reverted').length, 3);
    await env.run('undoSuggestion()');
    assert.equal(remote.eventCalls('reverted').length, 3);
    assert.equal(remote.commits.reverted, 1);
});

test('API v1.2：撤销响应丢失后刷新恢复原购物车，再刷新仍保持已撤销', async () => {
    const remote = lifecycleApi();
    const storage = new Map();
    const env = await mobileSession(remote, storage);
    await acceptFirst(env);
    remote.failures.push({ type: 'reverted', mode: 'after' });
    await env.run('undoSuggestion()');
    assert.equal(env.run('state.pending.type'), 'reverted');
    assert.equal(JSON.parse(storage.get(sessionKey)).cart.length, 2);
    const recovered = await mobileSession(remote, storage);
    assert.equal(recovered.run('state.cart.length'), 1);
    assert.equal(recovered.run('state.undo'), null);
    assert.equal(recovered.run('state.pending'), null);
    assert.equal(remote.eventCalls('reverted').length, 1);
    const again = await mobileSession(remote, storage);
    assert.equal(again.run('state.cart.length'), 1);
    assert.equal(again.run('state.undo'), null);
    assert.equal(remote.commits.reverted, 1);
});

test('API v1.2：手工改车立即使原撤销失效，刷新后不再恢复撤销入口', async () => {
    const remote = lifecycleApi();
    const storage = new Map();
    const env = await mobileSession(remote, storage);
    await acceptFirst(env);
    env.run('recalc = async () => {}; changeQuantity("p1", 1);');
    assert.equal(env.run('state.undo'), null);
    assert.equal(JSON.parse(storage.get(sessionKey)).undo, null);
    await env.run('undoSuggestion()');
    assert.equal(remote.eventCalls('reverted').length, 0);
    const reloaded = await mobileSession(remote, storage);
    assert.equal(reloaded.run("state.cart.find(i => i.id === 'p1').quantity"), 2);
    assert.equal(reloaded.run("state.cart.find(i => i.id === 'r4').quantity"), 1);
    assert.equal(reloaded.run('state.undo'), null);
    assert.equal(reloaded.run("document.getElementById('undoBar').style.display"), 'none');
});

test('API v1.2：切换备选使用所选ID，旧展示请求迟到失败不覆盖新弹窗', async () => {
    const remote = lifecycleApi();
    const env = await mobileSession(remote);
    const [first, second] = remote.plans;
    remote.holds.add(first.id); remote.holds.add(second.id);
    const oldOpen = env.run('openModal()');
    env.run(`selectPlan('${second.id}')`);
    assert.equal(env.run('state.modal.suggestion.id'), second.id);
    assert.equal(env.run('state.modal.shown'), false);
    remote.release(second.id);
    await flushPromises();
    assert.equal(env.run('state.modal.shown'), true);
    assert.equal(env.run("document.getElementById('acceptBtn').disabled"), false);
    const newStatus = env.run("document.getElementById('modalStatus').textContent");
    remote.release(first.id, 503);
    await oldOpen;
    assert.equal(env.run('state.modal.suggestion.id'), second.id);
    assert.equal(env.run('state.suggestion.id'), second.id);
    assert.equal(env.run("document.getElementById('modalStatus').textContent"), newStatus);
    assert.equal(env.run("document.getElementById('acceptBtn').disabled"), false);
    await env.run("decide('accepted')");
    assert.equal(remote.eventCalls('accepted')[0].body.recommendationId, second.id);
    assert.equal(env.run("state.cart.some(i => i.id === 'r1')"), true);
    assert.equal(env.run("state.cart.some(i => i.id === 'r4')"), false);
});

test('API v1.2：报价过期禁采纳，仍可保留原购物车', async () => {
    const remote = lifecycleApi();
    remote.plans[0].expiresAt = Date.now() - 1000;
    const env = await mobileSession(remote);
    await env.run('openModal()');
    env.run('updateExpiry()');
    assert.equal(env.run("document.getElementById('acceptBtn').disabled"), true);
    assert.equal(env.run("document.getElementById('rejectBtn').disabled"), false);
    assert.match(env.run("document.getElementById('quoteExpiry').textContent"), /过期/);
    await env.run("decide('accepted')");
    assert.equal(remote.eventCalls('accepted').length, 0);
    assert.equal(env.run('state.cart.length'), 1);
    await env.run("decide('rejected')");
    assert.equal(remote.eventCalls('rejected').length, 1);
    assert.equal(env.run('state.cart.length'), 1);
});

test('API v1.2：已提交采纳在报价过期后仍能重试确认，权威已撤销结果不会再加购', async () => {
    const remote = lifecycleApi();
    const env = await mobileSession(remote);
    remote.failures.push({ type: 'accepted', mode: 'after' });
    await acceptFirst(env);
    env.run('state.modal.suggestion.expiresAt = Date.now() - 1000; updateExpiry();');
    assert.equal(env.run("document.getElementById('acceptBtn').disabled"), false);
    remote.decisions.set(remote.plans[0].id, 'reverted');
    await env.run("decide('accepted')");
    assert.equal(env.run('state.cart.length'), 1);
    assert.equal(env.run('state.undo'), null);
    assert.equal(env.run('state.pending'), null);
    assert.equal(env.run('state.modal'), null);
    assert.equal(remote.eventCalls('accepted').length, 2);
    assert.equal(remote.commits.accepted, 1);
});

test('API v1.3：起送补单展示新实付与增支，采纳及刷新撤销不会显示为零元净省', async () => {
    const remote = lifecycleApi();
    const storage = new Map();
    Object.assign(remote.plans[0], { kind: 'minimum-order', netSaving: 0, currentTotal: 35, newTotal: 37, paymentChange: 2 });
    const env = await mobileSession(remote, storage);
    env.run("state.mode='minimum-order'; state.breakdown.orderable=false; state.breakdown.minimumOrder=25; state.breakdown.minimumOrderGap=5; state.alternatives=[state.suggestion]; renderAll();");
    assert.match(env.run("document.getElementById('orderStatus').innerHTML"), /还差.*5\.00.*起送/);
    assert.match(env.run("document.getElementById('alternativePlans').innerHTML"), /补单后.*37\.00/);
    assert.match(env.run("document.getElementById('alternativePlans').innerHTML"), /多付.*2\.00/);
    assert.doesNotMatch(env.run("document.getElementById('alternativePlans').innerHTML"), /净省.*0\.00/);
    await acceptFirst(env);
    assert.equal(env.run('state.undo.kind'), 'minimum-order');
    assert.match(env.run("document.getElementById('undoText').textContent"), /补单后实付.*37\.00/);
    assert.doesNotMatch(env.run("document.getElementById('undoText').textContent"), /净省/);
    const recovered = await mobileSession(remote, storage);
    assert.equal(recovered.run('state.undo.kind'), 'minimum-order');
    await recovered.run('undoSuggestion()');
    assert.equal(recovered.run('state.cart.length'), 1);
    assert.match(recovered.run("document.getElementById('toast').textContent"), /撤销补单/);
});

test('API v1.3：修改偏好立即关闭旧报价、把约束交给服务端并持久保存', async () => {
    const remote = lifecycleApi();
    const storage = new Map();
    const env = await mobileSession(remote, storage);
    await env.run('openModal()');
    env.run("document.getElementById('budgetInput').value='2.50'; document.getElementById('maxItemsInput').value='4'; document.getElementById('strategyInput').value='fewer'; document.querySelectorAll=()=>[{dataset:{excludeId:'r1'}}]; applyPreferences();");
    await flushPromises();
    assert.equal(env.run('state.modal'), null);
    const input = remote.calls.filter(c => c.route === '/api/calculate').at(-1).body;
    assert.deepEqual(input.preferences, { maxItems: 4, maxAdditionCost: 2.5, excludeIds: ['r1'], strategy: 'fewer' });
    assert.deepEqual(JSON.parse(storage.get(sessionKey)).preferences, input.preferences);
    const refreshed = await mobileSession(remote, storage);
    assert.equal(refreshed.run('state.preferences.maxItems'), 4);
    assert.equal(refreshed.run('state.preferences.excludeIds[0]'), 'r1');
});

test('API v1.3：非法预算使旧报价不可采纳，修正或不加购后重新计算', async () => {
    const remote = lifecycleApi();
    const env = await mobileSession(remote);
    await env.run('openModal()');
    const before = remote.calls.length;
    env.run("document.getElementById('budgetInput').value='-1'; document.getElementById('maxItemsInput').value='3'; document.getElementById('strategyInput').value='saving'; applyPreferences();");
    assert.equal(env.run('state.modal'), null);
    assert.equal(env.run('state.suggestion'), null);
    assert.equal(env.run('state.preferencesInvalid'), true);
    assert.equal(env.run("document.getElementById('checkoutBtn').disabled"), true);
    assert.equal(remote.calls.length, before);
    await env.run("decide('accepted')");
    assert.equal(remote.eventCalls('accepted').length, 0);
    env.run("document.getElementById('budgetInput').value=''; document.getElementById('maxItemsInput').value='0'; applyPreferences();");
    await flushPromises();
    assert.equal(env.run('state.preferencesInvalid'), false);
    assert.equal(remote.calls.filter(c => c.route === '/api/calculate').at(-1).body.preferences.maxItems, 0);
    assert.equal(env.run('state.preferences.maxAdditionCost'), null);
});

test('API v1.2：待确认操作重试时本地存储失败保留原意图和选项锁', async () => {
    const remote = lifecycleApi();
    const env = await mobileSession(remote);
    remote.failures.push({ type: 'accepted', mode: 'after' });
    await acceptFirst(env);
    const originalSetItem = env.context.localStorage.setItem;
    const savedPending = env.run('JSON.stringify(state.pending)');
    env.context.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
    await env.run("decide('accepted')");
    assert.equal(env.run('JSON.stringify(state.pending)'), savedPending);
    assert.equal(env.run('state.modal.pendingType'), 'accepted');
    assert.equal(env.run("document.getElementById('rejectBtn').disabled"), true);
    assert.equal(env.run("document.getElementById('modalClose').disabled"), true);
    assert.equal(env.run('state.cart.length'), 1);
    assert.equal(env.run('locked()'), true);
    await env.run("decide('rejected')");
    env.run('closeModal(); changeQuantity("p1", 1);');
    assert.equal(env.run('state.modal.pendingType'), 'accepted');
    assert.equal(env.run('state.cart[0].quantity'), 1);
    assert.equal(remote.eventCalls('accepted').length, 1, 'Failed intent persistence must not send another decision');
    assert.equal(remote.eventCalls('rejected').length, 0);
    env.context.localStorage.setItem = originalSetItem;
    await env.run("decide('accepted')");
    assert.equal(env.run('state.cart.length'), 2);
    assert.equal(env.run('state.pending'), null);
    assert.equal(remote.commits.accepted, 1);

    remote.failures.push({ type: 'reverted', mode: 'before' });
    await env.run('undoSuggestion()');
    const savedUndoPending = env.run('JSON.stringify(state.pending)');
    env.context.localStorage.setItem = () => { throw new Error('Quota exceeded'); };
    await env.run('undoSuggestion()');
    assert.equal(env.run('JSON.stringify(state.pending)'), savedUndoPending);
    assert.equal(env.run('state.pending.type'), 'reverted');
    assert.equal(env.run('state.cart.length'), 2);
    assert.equal(env.run('locked()'), true);
    assert.equal(remote.eventCalls('reverted').length, 1);
    env.context.localStorage.setItem = originalSetItem;
    await env.run('undoSuggestion()');
    assert.equal(env.run('state.pending'), null);
    assert.equal(env.run('state.cart.length'), 1);
    assert.equal(remote.commits.reverted, 1);
});

test('API v1.2：采纳待确认恢复读取权威拒绝，清除锁且保留原购物车', async () => {
    const remote = lifecycleApi();
    const storage = new Map();
    const first = await mobileSession(remote, storage);
    remote.failures.push({ type: 'accepted', mode: 'before' });
    await acceptFirst(first);
    assert.equal(first.run('state.pending.type'), 'accepted');
    // Another client has already decided; recovery must use the stored server outcome.
    remote.decisions.set(remote.plans[0].id, 'rejected');
    const recovered = await mobileSession(remote, storage);
    assert.equal(recovered.run('state.cart.length'), 1);
    assert.equal(recovered.run('state.cart[0].id'), 'p1');
    assert.equal(recovered.run('state.pending'), null);
    assert.equal(recovered.run('state.undo'), null);
    assert.equal(recovered.run('state.recovering'), false);
    assert.equal(recovered.run('locked()'), false);
    assert.equal(recovered.run('state.connected'), true);
    assert.equal(JSON.parse(storage.get(sessionKey)).pending, null);
    assert.equal(remote.eventCalls('accepted').length, 1);
    assert.equal(remote.eventCalls('rejected').length, 0, 'Authoritative rejection needs no repeated write');
});

test('API v1.2：损坏购物车缓存仍先恢复有效待确认意图，非法撤销快照被忽略', async () => {
    const remote = lifecycleApi();
    const id = remote.plans[0].id;
    remote.decisions.set(id, 'accepted');
    const storage = new Map([[sessionKey, JSON.stringify({ version: 2,
        cart: [{ id: 'p1', quantity: 1 }, { id: 'p1', quantity: 2 }],
        pending: { recommendationId: id, type: 'accepted', beforeCart: [{ id: 'p1', quantity: 1 }] },
        undo: { recommendationId: 'invalid-undo', beforeCart: [null], afterCart: [{ id: 'missing', quantity: 1 }],
            itemNames: '无效商品', netSaving: 3 }
    })]]);
    const env = environment(storage);
    let checkedRestoredIntent = false;
    env.context.fetch = async (url, options) => {
        if (url.includes('/api/suggestions/')) {
            assert.equal(env.run('state.undo'), null, 'Malformed undo is discarded before recovery');
            assert.equal(env.run('state.pending.recommendationId'), id);
            assert.equal(env.run('state.cart.length'), 1, 'Invalid saved cart falls back to the default cart');
            checkedRestoredIntent = true;
        }
        return remote.fetch(url, options);
    };
    env.load('mobile-api-app.js');
    await env.run('init()');
    assert.equal(checkedRestoredIntent, true);
    assert.equal(env.run('state.pending'), null);
    assert.equal(env.run("state.cart.find(i => i.id === 'r4').quantity"), 1);
    assert.equal(env.run('state.undo.recommendationId'), id);
    assert.equal(env.run('locked()'), false);
    assert.equal(remote.eventCalls('accepted').length, 0);

    const saved = JSON.parse(storage.get(sessionKey));
    saved.undo = { ...saved.undo, afterCart: [{ id: 'r4', quantity: -1 }] };
    storage.set(sessionKey, JSON.stringify(saved));
    const reloaded = await mobileSession(remote, storage);
    assert.equal(reloaded.run('state.undo'), null);
    assert.equal(reloaded.run('state.cart.length'), 2, 'Discarding malformed undo preserves the valid cart');
    assert.equal(reloaded.run("document.getElementById('undoBar').style.display"), 'none');
    assert.equal(reloaded.run('locked()'), false);
});
