(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const STORAGE_KEY = 'justright-local-research-v1';
    const ACTIVE_KEY = 'justright-active-research-task-v1';
    const RECORD_PREFIX = `${STORAGE_KEY}:`;
    const PROFILE_KEY = 'justright-research-participant-v1';
    const state = { version: null, fixedTime: null, tasks: [], active: null, records: [], solution: null, evaluation: null, timer: null, preparing: false, submitting: false, saving: false, recovering: false, restoring: false };
    const money = value => `¥${Number(value || 0).toFixed(2)}`;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const activeTask = () => state.tasks.find(task => task.id === state.active?.taskId);
    const additionsFor = active => (active?.additions || []).filter(item => item.quantity > 0);
    function readRecords() {
        const rows = new Map();
        try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); if (Array.isArray(value)) for (const row of value) if (row?.schemaVersion === 1) rows.set(row.recordId || `legacy:${row.startedAt}:${row.finishedAt}:${row.taskId}`, row); } catch {}
        try { for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index); if (!key?.startsWith(RECORD_PREFIX)) continue; try { const row = JSON.parse(localStorage.getItem(key)); if (row?.schemaVersion === 1 && row.recordId) rows.set(row.recordId, row); } catch {} } } catch {}
        return [...rows.values()];
    }
    function writeActive() {
        try {
            if (state.active) localStorage.setItem(ACTIVE_KEY, JSON.stringify(state.active)); else localStorage.removeItem(ACTIVE_KEY);
            return true;
        } catch { setNotice('浏览器未能保存任务进度，请勿关闭页面。可在恢复存储空间后重试保存。', true); return false; }
    }
    function toast(message) { const node = document.createElement('div'); node.className = 'toast'; node.textContent = message; document.body.append(node); setTimeout(() => node.remove(), 2600); }
    async function api(url, body) {
        const response = await fetch(url, body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '本地接口暂不可用');
        return value;
    }
    function participant() {
        let id;
        try { id = localStorage.getItem(PROFILE_KEY); } catch {}
        if (!id) {
            id = `P-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
            try { localStorage.setItem(PROFILE_KEY, id); } catch { toast('浏览器存储不可用，请恢复存储权限后再开始任务。'); }
        }
        $('participantId').value = id;
    }
    function setNotice(message, error = false) { $('studyNotice').textContent = message; $('studyNotice').classList.toggle('error', error); }
    function renderTasks() {
        $('method').disabled = state.preparing || state.recovering || Boolean(state.active);
        $('participantId').disabled = Boolean(state.active?.startedAt);
        $('recordCount').textContent = `${state.records.length} 条记录`;
        $('taskCards').innerHTML = state.tasks.map(task => `<article class="task-card"><span class="task-icon" aria-hidden="true">${task.id === 'minimum-order' ? '🛵' : '🏷️'}</span><h3>${esc(task.title)}</h3><p>${esc(task.goal)}<br>基准购物车商品小计 ${money(task.baseline.subtotal)}；${task.baseline.orderable ? '当前可下单' : `还差 ${money(task.baseline.minimumOrderGap)} 起送`}。</p><button class="button secondary" type="button" data-task="${esc(task.id)}" ${state.active || state.preparing || state.recovering ? 'disabled' : ''}>准备此任务</button></article>`).join('');
        document.querySelectorAll('[data-task]').forEach(button => button.addEventListener('click', () => prepareTask(button.dataset.task)));
    }
    function renderRecords() {
        const rows = state.records.slice().reverse();
        $('recordCount').textContent = `${state.records.length} 条记录`;
        $('exportJson').disabled = $('exportCsv').disabled = $('clearRecords').disabled = rows.length === 0;
        if (!rows.length) {
            $('recordSummary').textContent = '尚无任务记录';
            $('recordTable').innerHTML = '<p class="empty-state">完成任务后，这里会显示本浏览器保存的记录。</p>';
            return;
        }
        const groups = new Map();
        for (const row of rows) { const key = `${row.method}|${row.taskId}`; const group = groups.get(key) || { count:0, seconds:0 }; group.count++; group.seconds += row.elapsedMs || 0; groups.set(key, group); }
        $('recordSummary').innerHTML = [...groups.entries()].map(([key, group]) => { const [method, task] = key.split('|'); return `<div><strong>${method === 'assisted' ? '智能方案' : '手动判断'} · ${task === 'saving' ? '满减场景' : '起送场景'}</strong><br>${group.count} 次 · 平均决策 ${Math.round(group.seconds / group.count / 1000)} 秒</div>`; }).join('');
        $('recordTable').innerHTML = `<table class="record-table"><thead><tr><th>时间</th><th>匿名编号</th><th>任务</th><th>方式</th><th>结果</th><th>耗时</th><th>用户预估</th><th>复算实付</th></tr></thead><tbody>${rows.slice(0, 30).map(row => `<tr><td>${esc(new Date(row.finishedAt).toLocaleString())}</td><td>${esc(row.participantId)}</td><td>${row.taskId === 'saving' ? '满减' : '起送'}</td><td>${row.method === 'assisted' ? '智能方案' : '手动判断'}</td><td>${row.decision === 'add' ? '加购' : row.decision === 'keep' ? '保留原车' : '放弃'}</td><td>${(row.elapsedMs / 1000).toFixed(1)} 秒</td><td>${row.estimatedTotal == null ? '—' : money(row.estimatedTotal)}</td><td>${row.newTotal == null ? '—' : money(row.newTotal)}</td></tr>`).join('')}</tbody></table>`;
    }
    function ruleSummary(task) {
        const rules = task.promotions;
        const chips = [`起送 ${money(rules.minimumOrder)}`, ...rules.fullReduction.map(item => `满${money(item.threshold)}减${money(item.discount)}`), ...rules.coupons.map(item => `优惠券 ${item.label}`), `加购预算 ${money(10)}`, '最多加购 3 件'];
        if (rules.delivery?.baseFee) chips.push(`${rules.delivery.label}`);
        return `<div class="rule-row">${chips.map(text => `<span class="rule-chip">${esc(text)}</span>`).join('')}</div><p class="field-hint">门槛均按商品小计判断；满减仅取最高可用档，5 元券可与满减及满 40 减 3 元券叠加。本任务商品包装费为 0。</p>`;
    }
    async function prepareTask(id) {
        const task = state.tasks.find(item => item.id === id);
        if (!task || state.active || state.preparing || state.recovering) return;
        const method = $('method').value;
        state.preparing = true; renderTasks();
        try {
            state.solution = method === 'assisted' ? await api('/api/research/solve', { taskId:id }) : null;
            state.active = { recordId:crypto.randomUUID(), taskVersion:state.version, fixedTime:state.fixedTime, taskId:id, method, additions:[], startedAt:null, elapsedMs:0, interruptions:0, hiddenAt:null, decision:null, decidedAt:null };
            state.evaluation = null; $('resultForm').hidden = true;
            if (!writeActive()) { state.active = null; state.solution = null; return; }
            renderWorkspace(false); $('workspace').scrollIntoView({ behavior:'smooth', block:'start' });
        } catch (error) { setNotice(`无法载入方案：${error.message}`, true); }
        finally { state.preparing = false; renderTasks(); }
    }
    function beginTask() {
        if (!state.active || state.active.startedAt || state.active.decision) return;
        const participantId = $('participantId').value.trim().slice(0,40);
        if (!participantId) { toast('请先填写匿名参与者编号'); $('participantId').focus(); return; }
        state.active.startedAt = new Date().toISOString();
        state.active.participantId = participantId;
        if (!writeActive()) { state.active.startedAt = null; state.active.participantId = null; renderTasks(); renderWorkspace(false); return; }
        renderTasks(); renderWorkspace(true);
    }
    function cancelPreparation() {
        if (!state.active || state.active.startedAt) return;
        if (!clearActive()) return;
        $('workspace').hidden = true; renderTasks(); setNotice('任务尚未开始，已返回任务列表。');
    }
    function clearActive() {
        try {
            let cached;
            try { cached = JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'); } catch {}
            const currentId = state.active?.recordId;
            if (cached && currentId && cached.recordId && cached.recordId !== currentId) { setNotice('任务进度已在其他标签页更新，请刷新此标签页后继续。', true); return false; }
            localStorage.removeItem(ACTIVE_KEY);
        }
        catch { setNotice('浏览器无法清理任务进度，请恢复存储权限后重试。', true); return false; }
        state.active = null; state.solution = null; state.evaluation = null; state.recovering = false;
        clearInterval(state.timer); state.timer = null;
        return true;
    }
    function renderRecovery(message, canRetry = true, cleanupOnly = false) {
        state.recovering = true;
        $('workspace').hidden = true;
        $('resultForm').hidden = false;
        $('resultForm').innerHTML = `<div class="panel-heading"><div><p class="eyebrow">任务恢复</p><h2>需要处理本地任务进度</h2></div><span class="local-pill">仅保存在此浏览器</span></div><p class="survey-summary">${esc(message)}</p><div class="finish-actions">${canRetry ? `<button class="button primary" id="retryRecovery" type="button">${cleanupOnly ? '重试清理任务标记' : '重试恢复'}</button>` : ''}<button class="button secondary" id="discardRecovery" type="button">${cleanupOnly ? '返回任务列表' : '丢弃恢复进度'}</button></div>`;
        if (canRetry) $('retryRecovery').addEventListener('click', () => cleanupOnly ? completeRecoveryCleanup() : restoreActiveTask(state.active));
        $('discardRecovery').addEventListener('click', () => {
            if (cleanupOnly) { completeRecoveryCleanup(); return; }
            if (confirm('丢弃这条未完成的本地任务进度？') && clearActive()) { $('resultForm').hidden = true; renderTasks(); setNotice('已丢弃未完成任务。'); }
        });
        renderTasks();
    }
    function completeRecoveryCleanup() {
        if (!clearActive()) return renderRecovery('浏览器仍无法清理任务标记。恢复存储权限后可以重试。', true, true);
        $('resultForm').hidden = true; renderTasks(); renderRecords(); setNotice('任务记录已保存。');
    }
    async function restoreActiveTask(active) {
        if (!active || state.restoring) return;
        state.restoring = true; state.active = active; state.recovering = true; renderTasks();
        try {
            state.solution = active.method === 'assisted' ? await api('/api/research/solve', {taskId:active.taskId}) : null;
            state.evaluation = active.decision && active.decision !== 'abandon'
                ? await api('/api/research/evaluate', {taskId:active.taskId, additions:active.chosenAdditions || []}) : null;
            state.restoring = false; state.recovering = false;
            $('participantId').value = active.participantId || $('participantId').value; $('method').value = active.method;
            if (active.decision) renderSurvey();
            else if (active.startedAt) {
                if (active.hiddenAt) { active.interruptions = (active.interruptions || 0) + 1; active.hiddenAt = null; writeActive(); }
                renderWorkspace(true); startTimer(); setNotice('已恢复进行中的任务。用时从开始时刻连续计算，包含离开页面与刷新时间。');
            } else { renderWorkspace(false); setNotice('已恢复尚未开始计时的任务。'); }
            renderTasks();
        } catch (error) {
            state.restoring = false;
            renderRecovery(`恢复本地任务失败：${error.message}。可重试接口，也可丢弃此进度后重新开始。`);
        }
    }
    function cartLines(task) { return task.currentItems.map(item => `<div>${esc(item.emoji)} ${esc(item.name)} × ${item.quantity} <span>${money(item.price * item.quantity)}</span></div>`).join(''); }
    function renderCandidates(task) {
        const selected = new Map(additionsFor(state.active).map(item => [item.id, item.quantity]));
        return task.recommendItems.map(item => `<article class="candidate"><span class="emoji" aria-hidden="true">${esc(item.emoji)}</span><h4 title="${esc(item.name)}">${esc(item.name)}</h4><div class="price">${money(item.price)} / 件</div>${state.active.method === 'manual' ? `<div class="qty-control"><button type="button" aria-label="减少${esc(item.name)}" data-qty="-1" data-id="${esc(item.id)}">−</button><span>${selected.get(item.id) || 0}</span><button type="button" aria-label="添加${esc(item.name)}" data-qty="1" data-id="${esc(item.id)}">+</button></div>` : ''}</article>`).join('');
    }
    function renderPlanChoices() {
        const plans = state.solution?.suggestions || [];
        if (!plans.length) return '<div class="mode-caption">当前固定规则下没有自动建议。仍可选择保留原车或放弃任务。</div>';
        return `<div class="plan-grid">${plans.map((plan,index) => {
            const picked = JSON.stringify(additionsFor(state.active).map(x => [x.id,x.quantity])) === JSON.stringify((plan.items || []).map(x => [x.id,x.quantity]));
            const names = (plan.items || []).map(item => `${item.name} ×${item.quantity}`).join('、');
            const info = plan.kind === 'minimum-order' ? `补单后实付 ${money(plan.newTotal)} · ${plan.paymentChange >= 0 ? '增支' : '估算减少'} ${money(Math.abs(plan.paymentChange))}` : `实付 ${money(plan.newTotal)} · 预计净省 ${money(plan.netSaving)}`;
            return `<button class="plan-option${picked ? ' selected' : ''}" type="button" data-plan="${index}"><strong>方案 ${index + 1} · ${esc(names)}</strong><span>${esc(info)}</span><em>${money(plan.additionCost)} 加购</em></button>`;
        }).join('')}</div>`;
    }
    function renderWorkspace(started) {
        const host = $('workspace');
        const task = activeTask();
        if (!task || !state.active) { host.hidden = true; return; }
        host.hidden = false;
        const active = state.active;
        if (!active.startedAt) {
            host.innerHTML = `<div class="workspace-top"><div><p class="eyebrow">${active.method === 'assisted' ? '显示智能方案' : '不显示推荐'}</p><h2>${esc(task.title)}</h2><p class="task-goal">${esc(task.goal)}</p><div class="task-meta">准备好后点击“开始计时”。计时开始后，任务方式将固定。</div></div></div><div class="mode-caption">${active.method === 'assisted' ? '开始后会显示系统建议；你可以选择一个方案，也可以保留原车或放弃。' : '开始后请根据购物车、起送价和优惠规则自行判断；系统会在提交后复算金额。'}</div><div class="finish-actions"><button class="button primary" id="beginTask" type="button">开始计时</button><button class="button secondary" id="cancelPreparation" type="button">返回任务列表</button></div>`;
            $('beginTask').addEventListener('click', beginTask);
            $('cancelPreparation').addEventListener('click', cancelPreparation);
            return;
        }
        const baseTotal = task.baseline.total;
        const elapsed = active.startedAt ? Date.now() - new Date(active.startedAt).getTime() : 0;
        host.innerHTML = `<div class="workspace-top"><div><p class="eyebrow">${active.method === 'assisted' ? '显示智能方案' : '不显示推荐'}</p><h2>${esc(task.title)}</h2><p class="task-goal">${esc(task.goal)}</p><div class="task-meta">计时包含离开页面或刷新时间；若中断，请在研究员记录中单独标记。</div></div><div><div class="timer" id="timer">${formatDuration(elapsed)}</div><div class="task-meta">决策用时</div></div></div><div class="order-box"><div><h3>当前购物车</h3><div class="item-lines">${cartLines(task)}</div></div><div class="order-total"><strong>${money(baseTotal)}</strong><span>${task.baseline.orderable ? '当前预计实付' : `当前不可下单 · 起送差额 ${money(task.baseline.minimumOrderGap)}`}</span></div></div>${ruleSummary(task)}<h3 class="candidate-title">可选加购商品</h3><div class="candidate-grid">${renderCandidates(task)}</div>${active.method === 'assisted' ? `<h3 class="candidate-title">智能方案</h3>${renderPlanChoices()}` : '<div class="mode-caption">请自行判断是否加购。此模式不会展示推荐排序；点击“提交我的选择”后，系统才会复算实际结算金额。</div>'}<div class="finish-actions">${active.method === 'manual' ? '<button class="button primary" id="finishAdd" type="button">提交我的加购选择</button>' : '<button class="button primary" id="finishAdd" type="button" '+(additionsFor(active).length ? '' : 'disabled')+'>采用所选智能方案</button>'}<button class="button secondary" id="finishKeep" type="button">不加购，保留原车</button><button class="button quiet" id="finishAbandon" type="button">放弃任务</button><button class="button quiet" id="cancelTask" type="button">退出并记录中断</button></div>`;
        host.querySelectorAll('[data-qty]').forEach(button => button.addEventListener('click', () => changeQuantity(button.dataset.id, Number(button.dataset.qty))));
        host.querySelectorAll('[data-plan]').forEach(button => button.addEventListener('click', () => selectPlan(Number(button.dataset.plan))));
        $('finishAdd').addEventListener('click', () => finishDecision('add'));
        $('finishKeep').addEventListener('click', () => finishDecision('keep'));
        $('finishAbandon').addEventListener('click', () => finishDecision('abandon'));
        $('cancelTask').addEventListener('click', cancelTask);
        if (started) startTimer();
    }
    function formatDuration(ms) { const seconds = Math.max(0,Math.floor(ms/1000)); return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`; }
    function startTimer() {
        clearInterval(state.timer); state.timer = setInterval(() => { const timer = $('timer'); if (timer && state.active?.startedAt) timer.textContent = formatDuration(Date.now()-new Date(state.active.startedAt).getTime()); }, 250);
    }
    function changeQuantity(id, delta) {
        if (!state.active?.startedAt || state.active.decision || state.submitting) return;
        const task = activeTask(), product = task?.recommendItems.find(item => item.id === id); if (!product) return;
        const entries = additionsFor(state.active); const current = entries.find(item => item.id === id)?.quantity || 0;
        const next = current + delta; const count = entries.reduce((sum,item)=>sum+item.quantity,0);
        if (next < 0 || next > product.stock || (delta > 0 && count >= 3)) return;
        state.active.additions = entries.filter(item=>item.id!==id); if (next) state.active.additions.push({id,quantity:next});
        const cost = state.active.additions.reduce((sum,item)=>sum+task.recommendItems.find(p=>p.id===item.id).price*item.quantity,0);
        if (cost > 10) { state.active.additions = entries; toast('已达到 10 元加购预算'); return; }
        if (!writeActive()) { state.active.additions = entries; return; }
        renderWorkspace(true);
    }
    function selectPlan(index) {
        if (!state.active?.startedAt || state.active.decision || state.submitting) return;
        const plan = state.solution?.suggestions?.[index]; if (!plan) return;
        const previous = state.active.additions;
        state.active.additions = (plan.items || []).map(item => ({id:item.id,quantity:item.quantity}));
        if (!writeActive()) { state.active.additions = previous; return; }
        renderWorkspace(true);
    }
    async function finishDecision(decision) {
        if (!state.active?.startedAt || state.active.decision || state.submitting) return;
        const taskId = state.active.taskId;
        let additions = decision === 'add' ? additionsFor(state.active) : [];
        if (decision === 'add' && !additions.length) { toast('请先选择加购方案'); return; }
        const decidedAt = new Date().toISOString();
        state.submitting = true;
        $('workspace').querySelectorAll('button').forEach(button => { button.disabled = true; });
        state.active.decision = decision; state.active.decidedAt = decidedAt;
        state.active.elapsedMs = Math.max(0, Date.parse(decidedAt) - Date.parse(state.active.startedAt));
        state.active.chosenAdditions = additions; state.active.abandonReason = decision === 'abandon' ? 'participant' : null;
        if (!writeActive()) {
            state.active.decision = null; state.active.decidedAt = null; state.active.elapsedMs = 0;
            state.active.chosenAdditions = null; state.active.abandonReason = null;
            state.submitting = false; renderWorkspace(true); return;
        }
        clearInterval(state.timer); state.timer = null;
        try {
            state.evaluation = decision === 'abandon' ? null : await api('/api/research/evaluate', {taskId, additions});
            renderSurvey();
        } catch (error) { state.evaluation = null; toast(error.message); renderSurvey(); }
        finally { state.submitting = false; if (state.active && !state.active.decision) renderWorkspace(true); }
    }
    async function retryEvaluation() {
        const active = state.active;
        if (!active?.decision || active.decision === 'abandon' || state.submitting) return;
        state.submitting = true;
        const button = $('retryEvaluation'); if (button) button.disabled = true;
        try { state.evaluation = await api('/api/research/evaluate', {taskId:active.taskId, additions:active.chosenAdditions || []}); renderSurvey(); }
        catch (error) { const status = $('evaluationStatus'); if (status) status.textContent = `选择已保存，金额复算暂时失败：${error.message}`; if (button) button.disabled = false; }
        finally { state.submitting = false; }
    }
    function renderSurvey() {
        $('workspace').hidden = true;
        const active = state.active;
        $('resultForm').hidden = false;
        const decisionText = active.decision === 'add' ? '你选择了加购。' : active.decision === 'keep' ? '你选择保留原购物车，不加购。' : '你选择放弃本次任务。';
        $('resultForm').innerHTML = `<div class="panel-heading"><div><p class="eyebrow">决策已记录</p><h2>请先完成简短反馈</h2></div><span class="local-pill">本次 ${(active.elapsedMs/1000).toFixed(1)} 秒${active.interruptions ? ` · 中断 ${active.interruptions} 次` : ''}</span></div><p class="survey-summary">${decisionText} 请填写你当时估计的最终实付金额，再提交反馈；提交后才会显示系统复算结果。不确定可留空。</p><form id="surveyForm"><div class="survey-grid"><label>你当时估计最终实付（元，可留空）<input id="estimatedTotal" type="number" min="0" max="10000" step="0.01" placeholder="填写你的估计金额"></label><label>即使没有优惠，你原本就会买所选加购商品吗？<select id="wantedItems"><option value="unsure">不确定／未加购</option><option value="yes">会，原本就需要</option><option value="no">不会，只为达到优惠门槛</option></select></label><label>做出决定有多费力？<select id="effort"><option value="">请选择</option><option value="1">1 · 很轻松</option><option value="2">2 · 比较轻松</option><option value="3">3 · 一般</option><option value="4">4 · 比较费力</option><option value="5">5 · 很费力</option></select></label></div><div class="finish-actions"><button class="button primary" type="submit">提交反馈并保存记录</button><button class="button secondary" id="discardActive" type="button">丢弃本次记录</button></div></form>`;
        $('surveyForm').addEventListener('submit', event => { event.preventDefault(); saveRecord(); });
        if (active.decision !== 'abandon' && !state.evaluation) {
            $('surveyForm').querySelectorAll('[type="submit"]').forEach(button => { button.disabled = true; });
            const retry = document.createElement('button'); retry.id = 'retryEvaluation'; retry.type = 'button'; retry.className = 'button secondary'; retry.textContent = '重试金额复算';
            const status = document.createElement('p'); status.id = 'evaluationStatus'; status.className = 'field-hint'; status.textContent = '选择已保存，金额复算暂时失败。可重试或丢弃本次记录。';
            retry.addEventListener('click', retryEvaluation); $('surveyForm').append(status, retry);
        }
        $('discardActive').addEventListener('click', () => { if (!state.saving && confirm('丢弃本次任务及反馈？') && clearActive()) { $('resultForm').hidden=true; renderTasks(); } });
        $('resultForm').scrollIntoView({behavior:'smooth',block:'start'});
    }
    async function saveRecord() {
        const active = state.active, task = activeTask(), result = state.evaluation;
        if (!active || !task || state.saving || (active.decision !== 'abandon' && !result)) return;
        const answer = active.decision === 'add'
            ? (task.baseline.orderable
                ? `复算后预计实付 ${money(result.newTotal)}，净省 ${money(result.netSaving)}。`
                : `补单后预计实付 ${money(result.newTotal)}，支付变化 ${result.paymentChange >= 0 ? '增加' : '减少'} ${money(Math.abs(result.paymentChange))}；起送补单变化不计为净省。`)
            : active.decision === 'keep' ? '你保留了原购物车，本次没有加购。' : '本次任务以放弃或中断结束。';
        const rawEstimate = $('estimatedTotal').value;
        const estimate = rawEstimate === '' ? null : Number(rawEstimate);
        if (estimate !== null && (!Number.isFinite(estimate) || estimate < 0 || estimate > 10000)) { toast('请填写有效金额，或留空'); return; }
        const row = { schemaVersion:1, recordId:active.recordId, taskVersion:active.taskVersion, participantId:active.participantId, method:active.method,
            taskId:active.taskId, taskTitle:task.title, fixedTime:active.fixedTime || state.fixedTime, startedAt:active.startedAt, finishedAt:active.decidedAt,
            elapsedMs:active.elapsedMs, interruptions:active.interruptions, decision:active.decision, abandonReason:active.abandonReason || null, additions:active.chosenAdditions || [],
            estimatedTotal:estimate, estimateError:active.decision === 'abandon' || estimate === null || result?.newTotal == null ? null : Math.round((estimate-result.newTotal)*100)/100,
            wouldBuyWithoutPromotion:$('wantedItems').value, effort:$('effort').value ? Number($('effort').value) : null,
            baselineTotal:Number(task.baseline.total), baselineOrderable:task.baseline.orderable, additionCost:result?.additionCost ?? 0,
            newTotal:active.decision === 'abandon' ? null : result?.newTotal ?? Number(task.baseline.total), paymentChange:active.decision === 'abandon' ? null : result?.paymentChange ?? 0,
            netSaving:active.decision === 'abandon' ? null : result?.netSaving ?? 0, objectiveMet:active.decision === 'abandon' ? null : result?.objectiveMet ?? false };
        if (!row.participantId) { toast('请填写匿名参与者编号'); return; }
        state.saving = true;
        $('resultForm').querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
            const recordKey = `${RECORD_PREFIX}${row.recordId}`;
            if (!localStorage.getItem(recordKey)) localStorage.setItem(recordKey, JSON.stringify(row));
            state.records = readRecords();
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records)); } catch {}
            if (!state.records.some(item => item.recordId === row.recordId)) state.records.push(row);
        } catch {
            state.saving = false; $('resultForm').querySelectorAll('button').forEach(button => { button.disabled = false; });
            toast('浏览器无法保存记录。请保留此页面并清理本机存储空间后重试。'); return;
        }
        state.saving = false;
        if (!clearActive()) { renderRecords(); renderRecovery('记录已保存，但浏览器无法清理恢复标记。点击重试清理以完成本次任务。', true, true); return; }
        $('resultForm').innerHTML = `<div class="panel-heading"><div><p class="eyebrow">本次任务完成</p><h2>${esc(task.title)}</h2></div><span class="local-pill">记录仅保存在本浏览器</span></div><p class="survey-summary">${esc(answer)}</p><div class="answer-box"><strong>后台独立复算：</strong>原车 ${money(task.baseline.total)}${task.baseline.orderable ? '（可下单）' : '（不可下单，仅估算）'}；${active.decision === 'add' ? `本次新实付 ${money(result.newTotal)}，加购商品 ${money(result.additionCost)}，${task.baseline.orderable ? `净省 ${money(result.netSaving)}` : '净省固定为 ¥0'}${result.objectiveMet ? '，达到本场目标。' : '，未达到本场目标。'}` : '本次保留原车或以放弃结束。'}</div><div class="finish-actions"><button class="button primary" id="returnTasks" type="button">返回任务列表</button></div>`;
        $('resultForm').hidden=false; $('workspace').hidden=true; $('returnTasks').addEventListener('click',()=>{$('resultForm').hidden=true;}); setNotice('匿名任务记录已保存在本浏览器；它不会进入产品采纳率和净省看板。'); renderTasks(); renderRecords(); toast('本地任务记录已保存');
    }
    function cancelTask() {
        if (!state.active?.startedAt || state.active.decision || state.submitting) return;
        const priorInterruptions = state.active.interruptions, priorElapsed = state.active.elapsedMs;
        state.active.interruptions += 1; state.active.elapsedMs = Math.max(0,Date.now()-Date.parse(state.active.startedAt));
        state.active.decision='abandon'; state.active.abandonReason='interrupted'; state.active.decidedAt=new Date().toISOString(); state.active.chosenAdditions=[];
        state.evaluation=null;
        if (!writeActive()) { state.active.decision=null; state.active.abandonReason=null; state.active.decidedAt=null; state.active.chosenAdditions=null; state.active.interruptions=priorInterruptions; state.active.elapsedMs=priorElapsed; return; }
        clearInterval(state.timer); state.timer=null; renderSurvey();
    }
    function saveFile(name, content, type) { const blob=new Blob([content],{type}); const link=document.createElement('a'); link.href=URL.createObjectURL(blob); link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(link.href),1000); }
    function exportRecords(format) {
        const rows=state.records; if(!rows.length)return;
        if(format==='json') saveFile('刚好_任务评估_本机记录.json',JSON.stringify({notice:'本地研究记录，仅可用作实际招募参与者后的研究数据；未招募前属于演示数据。',records:rows},null,2),'application/json;charset=utf-8');
        else { const cols=['recordId','schemaVersion','taskVersion','fixedTime','participantId','method','taskId','taskTitle','startedAt','finishedAt','elapsedMs','interruptions','decision','abandonReason','estimatedTotal','estimateError','wouldBuyWithoutPromotion','effort','baselineTotal','baselineOrderable','additionCost','newTotal','paymentChange','netSaving','objectiveMet','additions']; const quote=(value,key)=>{let text=String(value??'');if(typeof value==='string'&&/^[\s]*[=+@-]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;}; const csv=[cols.join(','),...rows.map(row=>cols.map(key=>quote(row[key]!==null&&typeof row[key]==='object'?JSON.stringify(row[key]):row[key],key)).join(','))].join('\r\n'); saveFile('刚好_任务评估_本机记录.csv','\uFEFF'+csv,'text/csv;charset=utf-8'); }
    }
    document.addEventListener('visibilitychange',()=>{ if(!state.active?.startedAt || state.active.decision)return; if(document.hidden&&!state.active.hiddenAt) {state.active.hiddenAt=new Date().toISOString();writeActive();} else if(!document.hidden&&state.active.hiddenAt){state.active.interruptions += 1;state.active.hiddenAt=null;writeActive();} });
    $('participantId').addEventListener('change',()=>{if(state.active?.startedAt){$('participantId').value=state.active.participantId||'';toast('本任务参与者编号已固定');return;}const value=$('participantId').value.trim().slice(0,40);$('participantId').value=value;if(value)try{localStorage.setItem(PROFILE_KEY,value);}catch{toast('匿名编号暂未保存，请恢复浏览器存储权限。');}});
    $('method').addEventListener('change',()=>{ if(state.active){$('method').value=state.active.method;toast('本任务方式已固定，结束后再修改');} });
    $('exportJson').addEventListener('click',()=>exportRecords('json')); $('exportCsv').addEventListener('click',()=>exportRecords('csv'));
    $('clearRecords').addEventListener('click',async()=>{if(confirm('清除这个浏览器中保存的全部任务记录？此操作无法恢复。')){try{const clear=()=>{const keys=[];for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key?.startsWith(RECORD_PREFIX))keys.push(key);}for(const key of keys)localStorage.removeItem(key);localStorage.removeItem(STORAGE_KEY);};if(navigator.locks?.request)await navigator.locks.request('justright-research-records',clear);else clear();state.records=[];renderRecords();renderTasks();}catch{toast('浏览器无法清理记录，请恢复存储权限后重试。');}}});
    window.addEventListener('storage',event=>{if((event.key===STORAGE_KEY||event.key?.startsWith(RECORD_PREFIX))&&!state.saving){state.records=readRecords();renderRecords();renderTasks();}});
    (async function init(){
        participant(); state.records=readRecords(); renderRecords();
        try { const data=await api('/api/research/tasks'); state.version=data.version; state.fixedTime=data.fixedTime; state.tasks=data.tasks; $('fixtureVersion').textContent=data.version; setNotice(data.notice); renderTasks();
            try {
                const active=JSON.parse(localStorage.getItem(ACTIVE_KEY)||'null');
                if(active){
                    state.active=active;
                    let alreadySaved = state.records.some(row=>row.recordId&&row.recordId===active.recordId);
                    try { alreadySaved = alreadySaved || Boolean(localStorage.getItem(`${RECORD_PREFIX}${active.recordId}`)); } catch {}
                    if(alreadySaved){
                        if(clearActive())setNotice('该任务已保存，已清理重复恢复标记。');
                        else renderRecovery('该任务已保存，浏览器未能清理恢复标记。可重试清理，不会重复保存。',true,true);
                    } else if(active.taskVersion!==state.version||(active.fixedTime&&active.fixedTime!==state.fixedTime)){
                        renderRecovery('本地任务版本与当前冻结任务不一致。请丢弃旧进度并重新开始，避免使用新规则复算旧任务。',false);
                    } else if(!state.tasks.some(task=>task.id===active.taskId)||!['manual','assisted'].includes(active.method)
                        || typeof active.recordId!=='string'||!active.recordId||!Array.isArray(active.additions)
                        ||(active.startedAt&&!Number.isFinite(Date.parse(active.startedAt)))
                        ||(active.decision&&(!['add','keep','abandon'].includes(active.decision)||!active.startedAt||!Number.isFinite(Date.parse(active.decidedAt))||!Number.isFinite(active.elapsedMs)))
                        ||!Number.isInteger(active.interruptions)||active.interruptions<0){
                        renderRecovery('本地任务进度不完整或已损坏。请丢弃此进度并重新开始。',false);
                    } else {active.fixedTime=state.fixedTime;await restoreActiveTask(active);}
                    renderTasks();
                }
            } catch(error){ renderRecovery(`本地任务进度无法读取：${error.message}。可丢弃损坏的进度后重新开始。`,false); }
        } catch(error){setNotice(`无法载入研究任务：${error.message}`,true);$('taskCards').innerHTML='<p class="empty-state">请确认本机后端已启动后刷新页面。</p>';}
    })();
    // 演示中心切回本页时重读浏览器记录；不影响进行中任务的工作区
    window.__hubRefresh = () => { state.records=readRecords(); renderRecords(); renderTasks(); };
})();
