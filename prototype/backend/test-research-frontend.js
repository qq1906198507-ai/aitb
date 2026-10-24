const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.resolve(__dirname, '..', 'research-app.js');
const ACTIVE_KEY = 'justright-active-research-task-v1';
const STORAGE_KEY = 'justright-local-research-v1';
const PROFILE_KEY = 'justright-research-participant-v1';
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };

function harness({ storage = new Map(), failures = new Map(), apiOverrides = {}, fileCapture = [], tabId = null } = {}) {
    const elements = new Map();
    const documentListeners = new Map();
    let uuid = 0;
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            id, value: id === 'method' ? 'manual' : '', textContent: '', innerHTML: '', hidden: false,
            disabled: false, dataset: {}, listeners: {}, classList: { add() {}, remove() {}, toggle() {} },
            addEventListener(name, fn) { this.listeners[name] = fn; },
            querySelectorAll() { return []; }, scrollIntoView() {}, focus() {}, click() { this.listeners.click?.({ target: this }); },
            append(...nodes) { for (const node of nodes) if (node?.id) elements.set(node.id, node); },
        });
        return elements.get(id);
    }
    const tasks = [
        { id: 'saving', title: '满减场景', goal: '降低实付', baseline: { subtotal: 48, total: 35, orderable: true, minimumOrderGap: 0 },
            currentItems: [{ id: 'p1', name: '套餐', emoji: '🍱', price: 48, quantity: 1 }],
            recommendItems: [{ id: 'r4', name: '米饭', emoji: '🍚', price: 2, stock: 20 }],
            promotions: { minimumOrder: 20, fullReduction: [{ threshold: 50, discount: 5 }], coupons: [], delivery: {} } },
        { id: 'minimum-order', title: '起送场景', goal: '达到起送价', baseline: { subtotal: 20, total: 20, orderable: false, minimumOrderGap: 5 },
            currentItems: [{ id: 'p2', name: '便当', emoji: '🍱', price: 20, quantity: 1 }], recommendItems: [],
            promotions: { minimumOrder: 25, fullReduction: [], coupons: [], delivery: {} } },
    ];
    const plan = { taskId: 'saving', suggestions: [{ items: [{ id: 'r4', name: '米饭', quantity: 1 }], newTotal: 32, netSaving: 3, additionCost: 2 }] };
    const evaluated = { newTotal: 35, additionCost: 0, paymentChange: 0, netSaving: 0, objectiveMet: false };
    const calls = [];
    const files = fileCapture;
    const session = new Map();
    if (tabId) session.set(`${ACTIVE_KEY}:tab`, tabId);
    const tabActiveKey = tabId ? `${ACTIVE_KEY}:${tabId}` : ACTIVE_KEY;
    const localStorage = {
        getItem(key) { return storage.get(key) ?? null; },
        get length() { return storage.size; },
        key(index) { return [...storage.keys()][index] ?? null; },
        setItem(key, value) {
            const left = failures.get(key) || 0;
            if (left) { failures.set(key, left - 1); throw new Error('QuotaExceededError'); }
            storage.set(key, String(value));
        },
        removeItem(key) {
            const left = failures.get(`remove:${key}`) || 0;
            if (left) { failures.set(`remove:${key}`, left - 1); throw new Error('Storage unavailable'); }
            storage.delete(key);
        },
    };
    const URL = { createObjectURL(blob) { files.push({ blob, name: '' }); return 'blob:test'; }, revokeObjectURL() {} };
    const context = vm.createContext({
        console, Date, Map, JSON, Math, Number, String, Array, Object, Promise, Error, Set,
        crypto: { randomUUID() { uuid += 1; return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`; } },
        document: {
            hidden: false,
            addEventListener(name, fn) { documentListeners.set(name, fn); },
            getElementById: element,
            querySelectorAll(selector) {
                if (selector === '[data-task]') {
                    return [...element('taskCards').innerHTML.matchAll(/data-task="([^"]+)"/g)].map(match => {
                        const button = element(`task-${match[1]}`); button.dataset.task = match[1]; return button;
                    });
                }
                return [];
            },
            createElement(tag) {
                if (tag === 'a') return { href: '', download: '', click() { files.push({ name: this.download }); } };
                return element(`created-${tag}`);
            },
            body: { append() {} },
        },
        window: { addEventListener() {} },
        navigator: {},
        sessionStorage: tabId ? {
            getItem(key) { return session.get(key) ?? null; },
            setItem(key, value) { session.set(key, String(value)); },
        } : { getItem() { throw new Error('session storage unavailable in this single-tab harness'); }, setItem() { throw new Error('session storage unavailable'); } },
        localStorage, URL,
        Blob: class { constructor(parts, options) { this.parts = parts; this.type = options?.type; } async text() { return this.parts.join(''); } },
        setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {},
        confirm() { return true; },
        fetch: async (url, options = {}) => {
            const body = options.body ? JSON.parse(options.body) : undefined;
            calls.push({ url, body });
            if (apiOverrides[url]) return apiOverrides[url](body, calls);
            if (url === '/api/research/tasks') return { ok: true, json: async () => ({ version: '1', fixedTime: '2026-10-20T07:00:00.000Z', notice: '演示数据', tasks }) };
            if (url === '/api/research/solve') return { ok: true, json: async () => plan };
            if (url === '/api/research/evaluate') return { ok: true, json: async () => evaluated };
            throw new Error(`Unexpected route ${url}`);
        },
    });
    const source = fs.readFileSync(appPath, 'utf8').replace(/\}\)\(\);\s*$/, `globalThis.__researchTest = {
        state,
        finishDecision: typeof finishDecision === 'function' ? finishDecision : null,
        retryRecovery: typeof retryRecovery === 'function' ? retryRecovery : null,
        discardRecovery: typeof discardRecovery === 'function' ? discardRecovery : null,
        restoreActiveTask: typeof restoreActiveTask === 'function' ? restoreActiveTask : null,
        retryEvaluation: typeof retryEvaluation === 'function' ? retryEvaluation : null,
        saveRecord: typeof saveRecord === 'function' ? saveRecord : null,
        exportRecords: typeof exportRecords === 'function' ? exportRecords : null,
    };
})();`);
    vm.runInContext(source, context, { filename: appPath });
    return {
        context, storage, failures, calls, files, el: element, documentListeners, tabActiveKey,
        async ready() { await flush(); },
        async prepare(taskId = 'saving') { element(`task-${taskId}`).click(); await flush(); },
        async begin() { element('beginTask').click(); await flush(); },
        async decide(decision = 'keep') { element(decision === 'add' ? 'finishAdd' : decision === 'keep' ? 'finishKeep' : 'finishAbandon').click(); await flush(); },
        async submit() { const fn = context.__researchTest.saveRecord; const result = fn?.(); await flush(); return result; },
        async reload(overrides) { return harness({ storage, failures, apiOverrides: overrides || {}, fileCapture: files, tabId }); },
    };
}

test('研究任务从准备到反馈保存，记录匿名编号与固定任务元数据', async () => {
    const env = harness();
    await env.ready();
    await env.prepare();
    await env.begin();
    await env.decide('keep');
    assert.equal(env.el('resultForm').hidden, false);
    await env.submit();
    const records = JSON.parse(env.storage.get(STORAGE_KEY));
    assert.equal(records.length, 1);
    assert.equal(records[0].participantId, env.el('participantId').value);
    assert.equal(records[0].taskVersion, '1');
    assert.equal(records[0].fixedTime, '2026-10-20T07:00:00.000Z');
    assert.ok(records[0].recordId);
});

test('复算失败时保留任务和选择以便重试，重试后恢复反馈', async () => {
    let failOnce = true;
    const env = harness({ apiOverrides: { '/api/research/evaluate': async () => {
        if (failOnce) { failOnce = false; return { ok: false, json: async () => ({ error: '临时故障' }) }; }
        return { ok: true, json: async () => ({ newTotal: 35, additionCost: 0, paymentChange: 0, netSaving: 0, objectiveMet: false }) };
    } } });
    await env.ready(); await env.prepare(); await env.begin(); await env.decide('keep');
    const pending = JSON.parse(env.storage.get(ACTIVE_KEY));
    assert.equal(JSON.parse(env.storage.get(ACTIVE_KEY)).decision, 'keep');
    assert.ok(pending.decidedAt);
    assert.equal(env.el('resultForm').hidden, false);
    assert.equal(typeof env.el('retryEvaluation').listeners.click, 'function');
    await env.context.__researchTest.retryEvaluation();
    await flush();
    assert.ok(env.context.__researchTest.state.evaluation);
    const restored = await env.reload(); await restored.ready();
    assert.equal(restored.el('resultForm').hidden, false);
    assert.equal(restored.el('workspace').hidden, true);
});

test('智能任务恢复求解失败时提供退出或重试入口，不会永久锁住任务列表', async () => {
    const storage = new Map([[ACTIVE_KEY, JSON.stringify({ recordId: 'r-1', taskVersion: '1', taskId: 'saving', method: 'assisted',
        additions: [], startedAt: '2026-10-20T07:00:00.000Z', elapsedMs: 0, interruptions: 0, decision: null })]]);
    let failOnce = true;
    const env = harness({ storage, apiOverrides: { '/api/research/solve': async () => {
        if (failOnce) { failOnce = false; return { ok: false, json: async () => ({ error: '暂时不可用' }) }; }
        return { ok: true, json: async () => ({ suggestions: [] }) };
    } } });
    await env.ready();
    assert.match(env.el('resultForm').innerHTML, /重试|放弃|返回任务列表/);
    assert.equal(env.el('taskCards').innerHTML.includes('disabled'), true);
    assert.ok(env.el('retryRecovery').listeners.click || env.el('discardRecovery').listeners.click,
        'recovery error state must expose a retry or discard action');
    if (env.el('retryRecovery').listeners.click) {
        env.el('retryRecovery').click();
        await flush();
        assert.equal(env.context.__researchTest.state.solution?.suggestions?.length || 0, 0);
    } else {
        env.el('discardRecovery').click();
        assert.equal(env.storage.has(ACTIVE_KEY), false);
        assert.equal(env.el('taskCards').innerHTML.includes('disabled'), false);
    }
});

test('任务版本不一致保留明确恢复入口，丢弃旧进度后解锁任务列表', async () => {
    const storage = new Map([[ACTIVE_KEY, JSON.stringify({ recordId: 'old', taskVersion: '0', taskId: 'saving', method: 'manual',
        additions: [], startedAt: '2026-10-20T07:00:00.000Z', elapsedMs: 0, interruptions: 0, decision: null })]]);
    const env = harness({ storage }); await env.ready();
    assert.match(env.el('resultForm').innerHTML, /版本与当前冻结任务不一致/);
    assert.equal(env.storage.has(ACTIVE_KEY), true);
    env.el('discardRecovery').click();
    assert.equal(env.context.__researchTest.state.active, null);
    assert.equal(env.storage.has(ACTIVE_KEY), false);
    assert.equal(env.el('taskCards').innerHTML.includes('disabled'), false);
});

test('反馈期切换标签不计入任务决策中断次数', async () => {
    const env = harness(); await env.ready(); await env.prepare(); await env.begin(); await env.decide('keep');
    const before = JSON.parse(env.storage.get(ACTIVE_KEY)).interruptions;
    env.context.document.hidden = true; env.documentListeners.get('visibilitychange')();
    env.context.document.hidden = false; env.documentListeners.get('visibilitychange')();
    assert.equal(JSON.parse(env.storage.get(ACTIVE_KEY)).interruptions, before);
});

test('本地记录写入失败可重试，活动记录清除失败后按 recordId 幂等保存', async () => {
    const env = harness(); await env.ready(); await env.prepare(); await env.begin(); await env.decide('keep');
    const active = JSON.parse(env.storage.get(ACTIVE_KEY));
    env.failures.set(`${STORAGE_KEY}:${active.recordId}`, 1);
    await env.submit();
    assert.ok(env.storage.has(ACTIVE_KEY), '写入失败时应保留活动记录供重试');
    await env.submit();
    assert.equal(JSON.parse(env.storage.get(STORAGE_KEY)).length, 1);

    assert.equal(active.decision, 'keep');
    env.storage.set(ACTIVE_KEY, JSON.stringify(active));
    env.failures.set(`remove:${ACTIVE_KEY}`, 2);
    env.context.__researchTest.state.active = active;
    env.context.__researchTest.state.evaluation = { newTotal: 35, additionCost: 0, paymentChange: 0, netSaving: 0, objectiveMet: false };
    await env.context.__researchTest.saveRecord();
    assert.ok(env.storage.has(ACTIVE_KEY), 'deleting the completed active item may fail without deleting it');
    const records = JSON.parse(env.storage.get(STORAGE_KEY));
    const stale = harness({ storage: new Map([[STORAGE_KEY, JSON.stringify(records)], [ACTIVE_KEY, JSON.stringify(active)], [PROFILE_KEY, records[0].participantId]]), failures: env.failures });
    await stale.ready();
    assert.match(stale.el('resultForm').innerHTML, /任务已保存|已保存/);
    assert.equal(JSON.parse(stale.storage.get(STORAGE_KEY)).length, 1);
    stale.failures.set(`remove:${ACTIVE_KEY}`, 0);
    stale.el('retryRecovery').click();
    await flush();
    assert.equal(stale.storage.has(ACTIVE_KEY), false);
    await stale.submit();
    assert.equal(JSON.parse(stale.storage.get(STORAGE_KEY)).length, 1);
});

test('复算期间锁定提交，只请求一次并保留相同选择', async () => {
    let resolveResponse;
    const env = harness({ apiOverrides: { '/api/research/evaluate': () => new Promise(resolve => { resolveResponse = resolve; }) } });
    await env.ready(); await env.prepare(); await env.begin();
    const first = env.context.__researchTest.finishDecision('keep');
    await env.context.__researchTest.finishDecision('abandon');
    assert.equal(env.calls.filter(call => call.url.endsWith('/evaluate')).length, 1);
    assert.equal(env.context.__researchTest.state.submitting, true);
    resolveResponse({ ok: true, json: async () => ({ newTotal: 35, additionCost: 0, paymentChange: 0, netSaving: 0, objectiveMet: false }) });
    await first;
    assert.equal(JSON.parse(env.storage.get(ACTIVE_KEY)).decision, 'keep');
});

test('放弃任务刷新恢复反馈不请求复算，预估误差始终为空', async () => {
    const env = harness(); await env.ready(); await env.prepare(); await env.begin(); await env.decide('abandon');
    assert.equal(env.calls.filter(call => call.url.endsWith('/evaluate')).length, 0);
    const restored = await env.reload(); await restored.ready();
    assert.equal(restored.calls.filter(call => call.url.endsWith('/evaluate')).length, 0);
    restored.el('estimatedTotal').value = '25';
    await restored.submit();
    const record = JSON.parse(restored.storage.get(STORAGE_KEY))[0];
    assert.equal(record.decision, 'abandon');
    assert.equal(record.newTotal, null);
    assert.equal(record.estimateError, null);
});

test('开始计时时保存失败仍停留准备态，存储恢复后可重新开始', async () => {
    const env = harness(); await env.ready(); await env.prepare();
    env.failures.set(ACTIVE_KEY, 1); await env.begin();
    assert.equal(env.context.__researchTest.state.active.startedAt, null);
    assert.equal(env.el('participantId').disabled, false);
    await env.begin();
    assert.ok(env.context.__researchTest.state.active.startedAt);
    assert.equal(env.el('participantId').disabled, true);
});

test('CSV 包含可审计任务字段，并转义以公式字符开头的匿名编号', async () => {
    const row = { schemaVersion: 1, recordId: 'r1', taskVersion: '1', fixedTime: '2026-10-20T07:00:00.000Z', abandonReason: 'interrupted',
        participantId: '=1+1', method: 'manual', taskId: 'saving', startedAt: '', finishedAt: '', elapsedMs: 1, interruptions: 1,
        decision: 'abandon', estimatedTotal: null, estimateError: null, wouldBuyWithoutPromotion: 'unsure', effort: null, baselineTotal: 35,
        baselineOrderable: true, additionCost: 0, newTotal: null, paymentChange: null, netSaving: null, objectiveMet: null, additions: [] };
    const env = harness({ storage: new Map([[STORAGE_KEY, JSON.stringify([row])]]) }); await env.ready();
    env.el('exportCsv').click(); await flush();
    const blob = env.files.find(file => file.blob)?.blob;
    assert.ok(blob);
    const csv = await blob.text();
    for (const column of ['recordId', 'taskVersion', 'fixedTime', 'abandonReason']) assert.ok(csv.includes(column));
    assert.match(csv, /'=1\+1/);
    assert.doesNotMatch(csv, /"null"/, '可选空值应导出为空白单元格');
});

test('两个页面共享本机存储时，不同任务记录均可导出并刷新读回', async () => {
    const storage = new Map();
    const first = harness({ storage, tabId: 'tab-a' });
    const second = harness({ storage, tabId: 'tab-b', fileCapture: first.files });
    await first.ready(); await second.ready();
    await first.prepare(); await first.begin(); await first.decide('keep'); await first.submit();
    await second.prepare('minimum-order'); await second.begin(); await second.decide('keep'); await second.submit();

    const saved = [...storage.entries()].filter(([key]) => key.startsWith(`${STORAGE_KEY}:`)).map(([, value]) => JSON.parse(value));
    assert.equal(saved.length, 2);
    assert.notEqual(saved[0].recordId, saved[1].recordId);
    const refreshed = harness({ storage, tabId: 'tab-c', fileCapture: first.files });
    await refreshed.ready();
    assert.deepEqual([...refreshed.context.__researchTest.state.records].map(row => row.recordId).sort(), saved.map(row => row.recordId).sort());
    refreshed.el('exportCsv').click(); await flush();
    const csv = await refreshed.files.find(file => file.blob)?.blob.text();
    assert.ok(csv);
    for (const row of saved) assert.ok(csv.includes(row.recordId));
});

test('聚合 STORAGE_KEY 快照写入失败时，分条记录仍可在刷新后读回', async () => {
    const env = harness(); await env.ready(); await env.prepare(); await env.begin(); await env.decide('keep');
    const active = JSON.parse(env.storage.get(env.tabActiveKey));
    env.failures.set(STORAGE_KEY, 1);
    await env.submit();
    const rowKey = `${STORAGE_KEY}:${active.recordId}`;
    assert.ok(env.storage.has(rowKey), '权威分条记录应先于聚合快照写入');
    assert.equal(env.storage.has(STORAGE_KEY), false, '注入的聚合快照写入失败应保持可见');
    const refreshed = harness({ storage: env.storage }); await refreshed.ready();
    assert.equal(refreshed.context.__researchTest.state.records.length, 1);
    assert.equal(refreshed.context.__researchTest.state.records[0].recordId, active.recordId);
});
