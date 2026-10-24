'use strict';

(() => {
    const API_URL = 'http://127.0.0.1:3000/api/history';
    const $ = (id) => document.getElementById(id);
    const filters = [...document.querySelectorAll('.filter-btn')];
    const dateFormat = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const state = { type: 'all', events: [], total: 0, nextCursor: null, loaded: false,
        loading: false, error: false, failedReset: true, lastSuccess: null };
    let sequence = 0;
    let activeController;
    const money = (value) => `¥${Math.abs(Number(value)).toFixed(2)}`;
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const time = (value) => dateFormat.format(new Date(value));
    const labels = { all: '全部', accepted: '采纳', rejected: '忽略', reverted: '撤销' };

    function validate(data) {
        if (!data || !Array.isArray(data.events) || !Number.isInteger(data.total) || data.total < 0
            || (data.nextCursor !== null && typeof data.nextCursor !== 'string')) throw new Error('Invalid history response');
        for (const event of data.events) {
            if (!event || typeof event.id !== 'string' || !event.id
                || !['accepted', 'rejected', 'reverted'].includes(event.type)
                || !Array.isArray(event.itemNames) || event.itemNames.some((name) => typeof name !== 'string')
                || !Number.isFinite(event.saved) || !Number.isFinite(Date.parse(event.createdAt))
                || (event.kind !== undefined && !['saving', 'minimum-order'].includes(event.kind))
                || ['newTotal', 'additionCost'].some((key) => event[key] !== undefined && (!Number.isFinite(event[key]) || event[key] < 0))
                || (event.paymentChange !== undefined && !Number.isFinite(event.paymentChange))
                || (event.kind === 'minimum-order' && event.saved !== 0)
                || (event.reverted !== undefined && typeof event.reverted !== 'boolean')) throw new Error('Invalid history event');
        }
        return data;
    }

    function minimumOrderResult(event, accepted, undone, reverted) {
        const total = Number.isFinite(event.newTotal) ? money(event.newTotal) : '金额未记录';
        if (reverted || undone) return `<del>${total}</del><small>原补单后实付 · 已撤销</small>`;
        const change = !Number.isFinite(event.paymentChange) ? '估算变化未记录'
            : event.paymentChange > 0 ? `额外增支 ${money(event.paymentChange)}`
            : event.paymentChange < 0 ? `估算减少 ${money(event.paymentChange)}` : '估算实付不变';
        return `<span>${total}</span><small>${accepted ? '补单后实付' : '补单方案实付 · 未采纳'}</small><small>${change}<br>原车不可下单</small>`;
    }

    function renderEvents() {
        if (!state.events.length) {
            const waiting = !state.loaded && state.loading;
            const title = waiting ? '正在读取记录…' : state.error && !state.loaded ? '暂时无法读取记录' : state.type === 'all' ? '还没有做出过选择' : `还没有${labels[state.type]}记录`;
            const detail = waiting ? '正在获取本机保存的演示操作。' : state.error && !state.loaded ? '请确认本地服务已启动，再点击重试。' : '在联动演示中查看建议并选择采纳或忽略，记录就会出现在这里。';
            $('historyList').innerHTML = `<div class="empty-state"><strong>${title}</strong><p>${detail}</p>${waiting ? '' : '<a href="mobile-api.html">去体验凑单 →</a>'}</div>`;
            return;
        }
        $('historyList').innerHTML = state.events.map((event) => {
            const accepted = event.type === 'accepted';
            const reverted = event.type === 'reverted';
            const undone = accepted && event.reverted;
            const minimumOrder = event.kind === 'minimum-order';
            const icon = reverted || undone ? '↶' : accepted ? '✓' : '−';
            const title = minimumOrder ? (reverted ? '已撤销补单' : accepted ? '已采纳起送补单' : '已忽略起送补单')
                : reverted ? '已撤销加购' : accepted ? '已采纳建议' : '已忽略建议';
            const tone = reverted || undone ? 'reverted' : accepted ? 'accepted' : '';
            const result = minimumOrder ? minimumOrderResult(event, accepted, undone, reverted)
                : reverted ? `<span>${money(event.saved)}</span><small>已扣回预计净省</small>`
                : undone ? `<del>${money(event.saved)}</del><small>已撤销 · 不计入当前净省</small>`
                : accepted ? `+${money(event.saved)}<small>预计净省</small>` : '保留原购物车';
            return `<article class="history-item" role="listitem">
                <div class="history-info"><span class="history-icon ${tone}" aria-hidden="true">${icon}</span>
                    <div><div class="history-title">${title}${undone ? '<span class="history-badge">后续已撤销</span>' : ''}</div>
                        <div class="history-products">${esc(event.itemNames.join(' + ') || '凑单商品')}</div>
                        <div class="history-date">${esc(time(event.createdAt))} · 北京时间</div>
                    </div>
                </div>
                <div class="history-result${reverted ? ' reverted' : minimumOrder || undone || !accepted ? ' neutral' : ''}">${result}</div>
            </article>`;
        }).join('');
    }

    function render() {
        filters.forEach((button) => {
            const selected = button.dataset.type === state.type;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        $('historyRefreshBtn').disabled = state.loading;
        $('historyRefreshBtn').textContent = state.loading ? '读取中…' : '刷新记录';
        $('historyMoreBtn').hidden = !state.nextCursor || state.error;
        $('historyMoreBtn').disabled = state.loading;
        $('historyMoreBtn').textContent = state.loading ? '加载中…' : '加载更多';
        $('historyRetryBtn').hidden = !state.error;
        $('historyRetryBtn').disabled = state.loading;
        $('historyCount').textContent = state.loaded ? `共 ${state.total} 条${state.type === 'all' ? '操作' : labels[state.type]}记录 · 已显示 ${state.events.length} 条` : `正在获取${labels[state.type]}记录`;
        $('historyEndNote').textContent = state.loaded && !state.nextCursor && state.events.length && !state.error ? '已经看到全部记录；采纳后撤销的操作会分别保留。' : '';
        $('historyUpdatedAt').textContent = state.lastSuccess ? `最近成功获取：${time(state.lastSuccess)} · 进入页面或刷新时更新` : '进入页面或点击刷新时获取最新记录 · 北京时间';
        renderEvents();
    }

    async function load(reset = true, clear = false) {
        if (!reset && (state.loading || !state.nextCursor)) return;
        const request = ++sequence;
        if (activeController) activeController.abort();
        const controller = new AbortController();
        activeController = controller;
        if (clear) { state.events = []; state.total = 0; state.nextCursor = null; state.loaded = false; state.lastSuccess = null; }
        state.loading = true; state.error = false;
        $('historyMessage').className = 'history-message';
        $('historyMessage').textContent = state.events.length ? (reset ? '正在获取最新记录，以下内容为上次读取结果。' : '正在加载更早的记录…') : '';
        render();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
            const query = new URLSearchParams({ type: state.type, limit: '20' });
            if (!reset) query.set('before', state.nextCursor);
            const response = await fetch(`${API_URL}?${query}`, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = validate(await response.json());
            if (request !== sequence) return;
            const unique = new Map((reset ? [] : state.events).map((event) => [event.id, event]));
            data.events.forEach((event) => unique.set(event.id, event));
            state.events = [...unique.values()]; state.total = data.total;
            state.nextCursor = data.nextCursor; state.loaded = true; state.lastSuccess = new Date().toISOString();
            $('historyConnection').className = 'connection online';
            $('historyConnection').textContent = '本地记录已连接 · 历史操作已保存';
            $('historyMessage').textContent = '';
        } catch (_) {
            if (request !== sequence) return;
            state.error = true; state.failedReset = reset;
            $('historyConnection').className = 'connection offline';
            $('historyConnection').textContent = state.events.length ? '读取失败 · 当前保留上次成功获取的记录' : '暂未连接本地服务';
            $('historyMessage').className = 'history-message error';
            $('historyMessage').textContent = reset ? '未能获取最新记录，请确认后端已启动后重试。' : '更早的记录未能加载，已显示的内容保留。可点击重试继续加载。';
        } finally {
            clearTimeout(timeout);
            if (request === sequence) { state.loading = false; activeController = null; render(); }
        }
    }

    filters.forEach((button) => button.addEventListener('click', () => {
        if (button.dataset.type === state.type) return;
        state.type = button.dataset.type; load(true, true);
    }));
    $('historyRefreshBtn').addEventListener('click', () => load(true));
    $('historyMoreBtn').addEventListener('click', () => load(false));
    $('historyRetryBtn').addEventListener('click', () => load(state.failedReset));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
    window.addEventListener('pagehide', () => { ++sequence; if (activeController) activeController.abort(); });
    // 演示中心切回本页时触发，替代部分环境不派发的 iframe 可见性事件
    window.__hubRefresh = () => load(true);
    load();
})();
