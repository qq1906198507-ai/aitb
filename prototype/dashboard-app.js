'use strict';

(() => {
    const API_URL = 'http://127.0.0.1:3000/api/dashboard';
    const POLL_MS = 2000;
    const $ = (id) => document.getElementById(id);
    const dateFormat = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    let latest = null;
    let lastSuccess = null;
    let inFlight = false;
    let timer = null;

    const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
        (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    const money = (value) => `¥${Number(value).toFixed(2)}`;
    const rate = (value) => value === null ? '—' : `${(value * 100).toFixed(0)}%`;
    const time = (value) => {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? dateFormat.format(date) : '—';
    };

    function validate(data) {
        if (!data || data.source !== 'local-demo' || !data.summary || !data.performance
            || !Array.isArray(data.trend) || !Array.isArray(data.recentEvents)) throw new Error('Unsupported dashboard response');
        for (const key of ['shownCount', 'acceptedCount', 'rejectedCount', 'pendingCount', 'totalSaved', 'averageSaving']) {
            if (!Number.isFinite(data.summary[key]) || data.summary[key] < 0) throw new Error('Invalid summary');
        }
        for (const key of ['revertedCount', 'savingAcceptedCount', 'minimumOrderAcceptedCount']) {
            if (data.summary[key] !== undefined && (!Number.isFinite(data.summary[key]) || data.summary[key] < 0)) throw new Error('Invalid decision count');
        }
        const adoption = data.summary.adoptionRate;
        if (adoption !== null && (!Number.isFinite(adoption) || adoption < 0 || adoption > 1)) throw new Error('Invalid rate');
        if (!Number.isFinite(data.performance.sampleCount) || data.performance.sampleCount < 0) throw new Error('Invalid samples');
        for (const key of ['averageMs', 'p99Ms']) {
            const value = data.performance[key];
            if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid performance');
        }
        if (data.trend.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(day.saved) || day.saved < 0)) throw new Error('Invalid trend');
        if (data.recentEvents.some((event) => !event || !['shown', 'accepted', 'rejected', 'reverted'].includes(event.type)
            || !Array.isArray(event.itemNames) || event.itemNames.some((name) => typeof name !== 'string')
            || !Number.isFinite(event.saved) || (event.kind !== undefined && !['saving', 'minimum-order'].includes(event.kind))
            || ['newTotal', 'additionCost'].some((key) => event[key] !== undefined && (!Number.isFinite(event[key]) || event[key] < 0))
            || (event.paymentChange !== undefined && !Number.isFinite(event.paymentChange))
            || (event.kind === 'minimum-order' && event.saved !== 0)
            || (event.reverted !== undefined && typeof event.reverted !== 'boolean'))) throw new Error('Invalid events');
        return data;
    }

    function renderTrend(trend) {
        const days = trend.slice(-7);
        const maximum = Math.max(1, ...days.map((day) => day.saved));
        $('trendChart').setAttribute('aria-label', days.length
            ? days.map((day) => `${day.date}：预计净省${money(day.saved)}`).join('；') : '暂无趋势数据');
        $('trendChart').innerHTML = days.length ? days.map((day) => `
            <div class="bar-item" title="${esc(day.date)} · 预计净省 ${money(day.saved)}">
                <div class="bar-plot"><div class="bar${day.saved === 0 ? ' zero' : ''}" style="height:${day.saved / maximum * 100}%">
                    <span class="bar-value">${money(day.saved)}</span>
                </div></div><div class="bar-label">${esc(day.date.slice(5).replace('-', '/'))}</div>
            </div>`).join('') : '<div class="chart-loading">暂无趋势数据</div>';
        $('trendHint').innerHTML = days.some((day) => day.saved > 0)
            ? '金额仅来自未撤销的净省方案，起送补单不贡献净省；未计入真实支付。'
            : '尚无有效净省金额，起送补单不计为净省。<a href="mobile-api.html">去体验一次凑单 →</a>';
    }

    function minimumOrderResult(event, adopted, undone, reversal) {
        const total = Number.isFinite(event.newTotal) ? money(event.newTotal) : '金额未记录';
        if (reversal || undone) return `<div class="event-result neutral"><del>${total}</del><small>原补单后实付 · 已撤销</small></div>`;
        const change = !Number.isFinite(event.paymentChange) ? '估算变化未记录'
            : event.paymentChange > 0 ? `额外增支 ${money(event.paymentChange)}`
            : event.paymentChange < 0 ? `估算减少 ${money(Math.abs(event.paymentChange))}` : '估算实付不变';
        return `<div class="event-result neutral">${total}<small>${adopted ? '补单后实付' : '补单方案实付'}</small><small>${change}<br>原车不可下单</small></div>`;
    }

    function renderEvents(events) {
        if (!events.length) {
            $('eventsList').innerHTML = '<div class="empty-state"><strong>第一条凑单记录，等你开始。</strong><p>在联动演示中查看建议，再选择采纳或忽略，记录将自动出现在这里。</p><a href="mobile-api.html">打开联动演示 →</a></div>';
            return;
        }
        const labels = { shown: '查看了净省建议', accepted: '已采纳建议', rejected: '已忽略建议', reverted: '已撤销加购' };
        $('eventsList').innerHTML = events.slice(0, 20).map((event) => {
            const undone = event.type === 'accepted' && event.reverted;
            const reversal = event.type === 'reverted';
            const adopted = event.type === 'accepted' && !undone;
            const minimumOrder = event.kind === 'minimum-order';
            const names = event.itemNames.join('、');
            const iconClass = reversal || undone ? ' reverted-event' : adopted ? ' accepted-event' : '';
            const icon = reversal || undone ? '↶' : adopted ? '✓' : event.type === 'shown' ? '↗' : '−';
            const minimumLabels = { shown: '查看了起送补单', accepted: undone ? '起送补单采纳后撤销' : '已采纳起送补单', rejected: '已忽略起送补单', reverted: '已撤销补单' };
            const title = minimumOrder ? minimumLabels[event.type] : undone ? '已采纳后撤销' : labels[event.type];
            const result = minimumOrder ? minimumOrderResult(event, adopted, undone, reversal)
                : reversal ? `<div class="event-result reverted">${money(Math.abs(event.saved))}<small>已扣回预计净省</small></div>`
                : undone ? `<div class="event-result neutral"><del>${money(event.saved)}</del><small>已撤销 · 不计入当前净省</small></div>`
                : adopted ? `<div class="event-result">+${money(event.saved)}<small>预计净省</small></div>`
                : `<div class="event-result neutral">${event.type === 'shown' ? '建议已展示' : '保留原购物车'}</div>`;
            return `<article class="event">
                <div class="event-info"><span class="event-icon${iconClass}" aria-hidden="true">${icon}</span>
                    <div><div class="event-title">${title}${names ? ` · ${esc(names)}` : ''}</div><div class="event-date">${esc(time(event.createdAt))}</div></div>
                </div>
                ${result}
            </article>`;
        }).join('');
    }

    function render(data) {
        const summary = data.summary;
        $('totalSaved').textContent = money(summary.totalSaved);
        $('avgSaving').textContent = summary.acceptedCount ? money(summary.averageSaving) : '—';
        $('adoptionRate').textContent = rate(summary.adoptionRate);
        $('acceptedCount').textContent = summary.acceptedCount;
        const minimumOrderAccepted = summary.minimumOrderAcceptedCount ?? 0;
        const savingAccepted = summary.savingAcceptedCount ?? Math.max(0, summary.acceptedCount - minimumOrderAccepted);
        $('acceptedKindsDetail').textContent = `净省采纳 ${savingAccepted} 次 · 起送转化 ${minimumOrderAccepted} 次`;
        $('shownDetail').textContent = `展示 ${summary.shownCount} 次 · 未决定 ${summary.pendingCount} 次`;
        $('revertedDetail').textContent = `已撤销 ${summary.revertedCount ?? 0} 次 · 原记录仍保留`;
        $('pieValue').textContent = rate(summary.adoptionRate);
        $('acceptedLegend').textContent = summary.acceptedCount;
        $('rejectedLegend').textContent = summary.rejectedCount;
        const degrees = (summary.adoptionRate ?? 0) * 360;
        $('adoptionChart').style.background = `conic-gradient(#10b981 0deg ${degrees}deg, #e6ecf4 ${degrees}deg 360deg)`;
        $('adoptionChart').setAttribute('aria-label', summary.adoptionRate === null ? '暂无决策样本'
            : `有效采纳${summary.acceptedCount}次，忽略${summary.rejectedCount}次，采纳率${rate(summary.adoptionRate)}`);
        $('decisionHint').textContent = summary.adoptionRate === null ? '尚无有效采纳或忽略记录'
            : `共 ${summary.acceptedCount + summary.rejectedCount} 次有效决定 · ${summary.pendingCount} 条建议未决定`;
        const performance = data.performance;
        $('avgCalcTime').textContent = performance.averageMs === null ? '—' : performance.averageMs.toFixed(3);
        $('p99CalcTime').textContent = performance.p99Ms === null ? '—' : performance.p99Ms.toFixed(3);
        $('sampleCount').textContent = performance.sampleCount;
        $('performanceBadge').textContent = performance.sampleCount ? '服务端实测' : '等待实测样本';
        renderTrend(data.trend);
        renderEvents(data.recentEvents);
    }

    function showConnection(connected) {
        $('connectionStatus').className = `connection ${connected ? 'online' : 'offline'}`;
        $('connectionStatus').textContent = connected ? '本地服务已连接 · 自动更新中'
            : latest ? '连接中断 · 当前显示上次成功获取的数据' : '暂未连接本地服务 · 请先启动后端';
        $('updatedAt').textContent = lastSuccess
            ? `最近成功获取：${time(lastSuccess)} · ${connected ? '每 2 秒更新' : '正在自动重试'}`
            : '尚未获取数据 · 双击 start-demo.bat 启动服务后，点击刷新';
        if (!connected) $('performanceBadge').textContent = latest ? '连接中断 · 历史快照' : '未连接';
    }

    async function refresh() {
        clearTimeout(timer);
        if (inFlight) return;
        inFlight = true;
        $('refreshBtn').disabled = true;
        $('refreshBtn').textContent = '更新中…';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
            const response = await fetch(API_URL, { signal: controller.signal, cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = validate(await response.json());
            render(data);
            latest = data;
            lastSuccess = new Date().toISOString();
            $('exportBtn').disabled = false;
            $('resetBtn').disabled = false;
            showConnection(true);
        } catch (_) {
            showConnection(false);
            if (!latest) $('eventsList').innerHTML = '<div class="empty-state"><strong>暂时无法读取演示记录</strong><p>请确认后端已启动，再点击刷新。连接恢复后会自动加载，不会填入示例数据。</p><a href="mobile-api.html">前往联动演示检查连接 →</a></div>';
        } finally {
            clearTimeout(timeout);
            inFlight = false;
            $('refreshBtn').disabled = false;
            $('refreshBtn').textContent = '刷新';
            if (!document.hidden) timer = setTimeout(refresh, POLL_MS);
        }
    }

    function exportData() {
        if (!latest) return;
        const format = $('exportFormat').value;
        const note = '本地演示行为记录；预计净省不代表真实支付。起送补单原车不可下单，不计为净省；平均净省除以全部未撤销采纳数，含起送补单的0贡献。paymentChange为新实付减旧估算。性能为当前进程最近最多1000次计算。';
        const report = { ...latest, fetchedAt: lastSuccess, note };
        let content = JSON.stringify(report, null, 2);
        let mime = 'application/json;charset=utf-8';
        if (format === 'csv') {
            const rows = [['本地演示数据', note], ['获取时间', lastSuccess],
                ['指标', '数值'], ...Object.entries(latest.summary), ['性能指标', '数值'], ...Object.entries(latest.performance),
                [], ['日期', '预计净省', '采纳次数'], ...latest.trend.map((day) => [day.date, day.saved, day.acceptedCount]),
                [], ['时间', '类型', '商品', '预计净省（撤销为负）', '采纳是否已撤销', '方案类别', '方案实付', '加购成本', '实付变化（新实付减旧估算）'],
                ...latest.recentEvents.map((event) => [event.createdAt, event.type, event.itemNames.join('、'), event.saved,
                    event.type === 'accepted' ? (event.reverted ? '是' : '否') : '', event.kind === 'minimum-order' ? '起送补单' : '净省方案',
                    event.newTotal, event.additionCost, event.paymentChange])];
            const cell = (value) => {
                let text = value === null || value === undefined ? '' : String(value);
                if (typeof value === 'string' && /^[=+@-]/.test(text)) text = `'${text}`;
                return `"${text.replace(/"/g, '""')}"`;
            };
            content = '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
            mime = 'text/csv;charset=utf-8';
        }
        const url = URL.createObjectURL(new Blob([content], { type: mime }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `刚好_本地演示数据_${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    $('refreshBtn').addEventListener('click', refresh);
    $('exportBtn').addEventListener('click', exportData);

    const RESET_URL = 'http://127.0.0.1:3000/api/demo/reset';
    let resetTimer = null;

    function resetButtonState(text, confirming, disabled) {
        const button = $('resetBtn');
        button.textContent = text;
        button.classList.toggle('confirming', confirming);
        button.disabled = disabled;
    }

    async function resetData() {
        clearTimeout(resetTimer);
        const button = $('resetBtn');
        if (!button.classList.contains('confirming')) {
            resetButtonState('再点一次确认清空', true, false);
            resetTimer = setTimeout(() => resetButtonState('清空演示数据', false, false), 6000);
            return;
        }
        resetButtonState('清空中…', true, true);
        try {
            const response = await fetch(RESET_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: '清空演示数据' }),
                cache: 'no-store'
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            resetButtonState('已清空 ✓', false, false);
            refresh();
        } catch (_) {
            resetButtonState('清空失败 · 原数据保留', false, false);
        }
        resetTimer = setTimeout(() => resetButtonState('清空演示数据', false, false), 2500);
    }
    $('resetBtn').addEventListener('click', resetData);

    document.addEventListener('visibilitychange', () => {
        clearTimeout(timer);
        if (!document.hidden) refresh();
    });
    window.addEventListener('pagehide', () => clearTimeout(timer));
    refresh();
})();
