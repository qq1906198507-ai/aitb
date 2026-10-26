// 本机联动演示：价格由服务端计算，展示和决策由服务端去重记录。
const API_BASE = 'http://127.0.0.1:3000';
const CART_KEY = 'netsave-demo-cart-v1';
const SESSION_KEY = 'netsave-demo-session-v2';
const defaultPreferences = () => ({ maxItems: 3, maxAdditionCost: 10, excludeIds: [], strategy: 'saving' });
const state = { cart: [], pool: [], breakdown: null, suggestion: null, performance: null,
    alternatives: [], promotions: null, undo: null, pending: null, recovering: false, undoing: false, storageWarning: false,
    preferences: defaultPreferences(), preferencesInvalid: false, mode: 'saving', reason: '', search: null,
    roundTripMs: null, connected: false, calculating: false, deciding: false, resetting: false, modal: null };
let calcSeq = 0, toastTimer, lastFocus;
let lastPriceCheck = Date.now();
const $ = (id) => document.getElementById(id);
const money = (n) => `¥${Number(n).toFixed(2)}`;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const suggestionItems = (s) => s.items || [{ ...s.item, quantity: 1 }];
const itemNames = (s) => suggestionItems(s).map((i) => `${i.name}${i.quantity > 1 ? `×${i.quantity}` : ''}`).join(' + ');
const actualPrice = (i) => i.flashSale && i.flashSale.endTime > Date.now() ? i.flashSale.salePrice : i.price;
const snapshot = (cart) => cart.map(({ id, quantity }) => ({ id, quantity }));
const fingerprint = (cart) => JSON.stringify(snapshot(cart).sort((a, b) => a.id.localeCompare(b.id)));
const locked = () => state.deciding || state.resetting || state.recovering || state.undoing || Boolean(state.pending);
const minimumPlan = (s) => s?.kind === 'minimum-order';
const planBenefit = (s) => minimumPlan(s) ? `补单后 ${money(s.newTotal)}` : `净省 ${money(s.netSaving)}`;
const paymentChangeText = (s) => Number(s.paymentChange) > 0 ? `比原车估算多付 ${money(s.paymentChange)}` : Number(s.paymentChange) < 0 ? `比原车估算少付 ${money(-s.paymentChange)}` : '与原车估算相同';

async function api(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
        const res = await fetch(`${API_BASE}${path}`, { ...options,
            headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
            signal: controller.signal, cache: 'no-store' });
        const result = await res.json();
        if (!res.ok) { const error = new Error(result.error || `HTTP ${res.status}`); error.status = res.status; throw error; }
        return result;
    } finally { clearTimeout(timer); }
}

function setStatus(kind, text, retryable = false) {
    const el = $('apiStatus');
    el.className = `api-status ${kind}`;
    el.innerHTML = `<span>${kind === 'error' ? '⚠️' : kind === 'loading' ? '⏳' : '✅'}</span><span>${esc(text)}</span>`
        + (retryable ? '<button class="retry-btn" id="retryBtn" type="button">重试</button>' : '');
    if (retryable) $('retryBtn').addEventListener('click', retry);
}

function toast(message) {
    let el = $('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.querySelector('.phone-screen').appendChild(el); }
    el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function persistCart() {
    try {
        // 单次写入同时保存购物车与未确认操作，避免刷新时只恢复一半。
        localStorage.setItem(SESSION_KEY, JSON.stringify({ version: 2, cart: snapshot(state.cart), undo: state.undo, pending: state.pending, preferences: state.preferences }));
        state.storageWarning = false;
        return true;
    } catch { state.storageWarning = true; return false; }
}

function restoreCart(data) {
    try {
        const session = JSON.parse(localStorage.getItem(SESSION_KEY));
        const saved = session && session.version === 2 ? session.cart : JSON.parse(localStorage.getItem(CART_KEY));
        const catalog = new Map([...data.currentItems, ...data.recommendItems].map((i) => [i.id, i]));
        const validSnapshot = (items) => Array.isArray(items) && items.length <= catalog.size && new Set(items.map((i) => i?.id)).size === items.length && items.every((i) => i && catalog.has(i.id) && Number.isInteger(i.quantity) && i.quantity > 0 && i.quantity <= (catalog.get(i.id).stock ?? 100));
        if (session && session.version === 2) {
            state.undo = session.undo && typeof session.undo.recommendationId === 'string' && validSnapshot(session.undo.beforeCart) && validSnapshot(session.undo.afterCart) && Number.isFinite(session.undo.netSaving) && typeof session.undo.itemNames === 'string' ? session.undo : null;
            state.pending = session.pending && typeof session.pending.recommendationId === 'string' && ['accepted', 'rejected', 'reverted'].includes(session.pending.type) && validSnapshot(session.pending.beforeCart) ? session.pending : null;
            if (validPreferences(session.preferences, catalog)) state.preferences = session.preferences;
        }
        if (!validSnapshot(saved)) return data.currentItems;
        const restored = saved.map(({ id, quantity }) => {
            const product = catalog.get(id);
            if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > (product.stock ?? 99)) throw new Error('Invalid saved cart');
            return { ...product, quantity, inCart: true };
        });
        return restored;
    } catch { return data.currentItems; }
}

function validPreferences(p, catalog = new Map(state.pool.map((i) => [i.id, i]))) {
    return p && Number.isInteger(p.maxItems) && p.maxItems >= 0 && p.maxItems <= 4
        && (p.maxAdditionCost === null || (typeof p.maxAdditionCost === 'number' && Number.isFinite(p.maxAdditionCost) && p.maxAdditionCost >= 0 && p.maxAdditionCost <= 1000))
        && ['saving', 'fewer', 'preference'].includes(p.strategy) && Array.isArray(p.excludeIds)
        && new Set(p.excludeIds).size === p.excludeIds.length && p.excludeIds.every((id) => typeof id === 'string' && catalog.has(id));
}

function renderPreferenceControls() {
    const p = state.preferences;
    $('budgetInput').value = p.maxAdditionCost === null ? '' : p.maxAdditionCost;
    $('maxItemsInput').value = String(p.maxItems); $('strategyInput').value = p.strategy;
    $('excludedProducts').innerHTML = state.pool.map((i) => `<label><input type="checkbox" data-exclude-id="${esc(i.id)}" ${p.excludeIds.includes(i.id) ? 'checked' : ''}>${esc(i.name)}</label>`).join('');
    renderPreferenceSummary();
}

function renderPreferenceSummary() {
    const p = state.preferences;
    $('preferencesSummary').textContent = `少买偏好 · ${p.maxItems ? `最多${p.maxItems}件` : '不加购'} · ${p.maxAdditionCost === null ? '不限预算' : `${money(p.maxAdditionCost)}内`}${p.excludeIds.length ? ` · 排除${p.excludeIds.length}种` : ''}`;
    $('preferenceFields').disabled = locked();
}

function applyPreferences() {
    if (locked()) return;
    if (state.modal) closeModal();
    const budget = String($('budgetInput').value).trim();
    const preferences = { maxItems: Number($('maxItemsInput').value), maxAdditionCost: budget === '' ? null : Number(budget),
        strategy: $('strategyInput').value, excludeIds: [...document.querySelectorAll('[data-exclude-id]:checked')].map((el) => el.dataset.excludeId) };
    if (!validPreferences(preferences)) {
        ++calcSeq; state.calculating = false; state.preferencesInvalid = true; state.suggestion = null; state.alternatives = [];
        $('preferencesError').textContent = '请填写 0–1000 元预算，件数限制为 0–4 件。';
        state.reason = '偏好尚未应用，请先修正输入。'; renderSummary(); renderHint(); renderRecommendations(); return;
    }
    preferences.maxAdditionCost = preferences.maxAdditionCost === null ? null : Math.round(preferences.maxAdditionCost * 100) / 100;
    state.preferences = preferences; state.preferencesInvalid = false; $('preferencesError').textContent = '';
    persistCart(); renderPreferenceSummary(); recalc();
}

function availableRecommendations() {
    const ids = new Set(state.cart.map((i) => i.id));
    return state.pool.filter((i) => !ids.has(i.id) && (i.stock === undefined || i.stock > 0));
}

function priceHtml(i) { const p = actualPrice(i); return `${money(p)}${p !== i.price ? `<s class="origin-price">${money(i.price)}</s>` : ''}`; }

function renderCart() {
    $('itemCount').textContent = `${state.cart.reduce((sum, i) => sum + i.quantity, 0)}件`;
    $('cartList').innerHTML = state.cart.map((i) => `
        <div class="cart-item" data-id="${esc(i.id)}"><div class="item-image">${esc(i.emoji)}</div>
            <div class="item-info"><div class="item-name">${esc(i.name)}${actualPrice(i) !== i.price ? '<span class="flash-tag">限时</span>' : ''}</div>
                <div class="item-desc">${esc(i.desc)}</div>
                <div class="item-bottom"><div class="item-price">${priceHtml(i)}</div><div class="item-quantity">
                    <button class="qty-btn minus-btn" type="button" data-id="${esc(i.id)}" aria-label="减少${esc(i.name)}" ${locked() ? 'disabled' : ''}>−</button>
                    <span class="qty-value">${i.quantity}</span>
                    <button class="qty-btn plus-btn" type="button" data-id="${esc(i.id)}" aria-label="增加${esc(i.name)}" ${locked() ? 'disabled' : ''}>+</button>
                </div></div>
            </div>
        </div>`).join('') || '<div class="empty-tip">购物车是空的，可加购下方商品或恢复示例</div>';
}

function renderRecommendations() {
    const s = state.suggestion;
    const ids = new Set(s ? suggestionItems(s).map((i) => i.id) : []);
    const combo = s && (s.itemCount || 1) > 1;
    $('recommendList').innerHTML = availableRecommendations().map((i) => `
        <button type="button" class="recommend-item${ids.has(i.id) ? ' suggested' : ''}" data-id="${esc(i.id)}" aria-label="加购${esc(i.name)}" ${locked() ? 'disabled' : ''}>
            ${ids.has(i.id) ? `<span class="save-badge">${minimumPlan(s) ? '起送补单' : `${combo ? '组合' : ''}净省${money(s.netSaving)}`}</span>` : ''}
            <div class="recommend-image">${esc(i.emoji)}</div><div class="recommend-name">${esc(i.name)}</div><div class="recommend-price">${priceHtml(i)}</div>
        </button>`).join('') || '<div class="empty-tip" style="grid-column:1/-1">没有更多推荐商品</div>';
}

function renderSummary() {
    const b = state.breakdown;
    $('subtotal').textContent = b ? `¥${b.subtotal}` : '--';
    $('delivery').textContent = b ? (Number(b.deliveryFee) ? `+配送¥${b.deliveryFee}` : '免配送费') : '';
    $('discount').textContent = b ? `-${money(Number(b.fullReduction) + Number(b.coupon))}` : '--';
    $('total').textContent = b ? `¥${b.total}` : '--';
    $('totalLabel').textContent = b?.orderable === false ? '估算：' : '实付：';
    $('checkoutBtn').disabled = state.calculating || locked() || state.preferencesInvalid || !state.connected || !state.cart.length || !b;
    $('checkoutBtn').textContent = state.calculating ? '计算中…' : minimumPlan(state.suggestion) ? '查看补单方案' : state.suggestion ? (state.alternatives[0]?.id === state.suggestion.id ? '查看最省方案' : '查看所选方案') : b?.orderable === false ? '查看未达标原因' : '查看结果';
    $('resetCartBtn').disabled = locked();
    $('minimumCartBtn').disabled = locked() || !state.pool.length;
    renderPreferenceSummary(); renderOrderStatus(); renderPriceDetails(); renderPlans(); renderUndo();
}

function renderOrderStatus() {
    const b = state.breakdown;
    $('orderStatus').className = `order-status${b?.orderable === false ? ' unmet' : ''}`;
    $('orderStatus').innerHTML = !b ? '正在核对起送门槛…' : !state.cart.length ? '先选择商品，再核对是否满足起送。'
        : b.orderable === false ? `<strong>还差 ${money(b.minimumOrderGap)} 起送</strong><small>起送价 ${money(b.minimumOrder)} · 按活动后商品金额计算，包装、配送与券后金额不计入门槛。</small>`
        : `<strong>已满足 ${money(b.minimumOrder ?? state.promotions?.minimumOrder ?? 0)} 起送</strong><small>继续比较加购是否能减少实付；也可保留原购物车。</small>`;
}

function renderPriceDetails() {
    const b = state.breakdown;
    $('priceBreakdown').innerHTML = b ? [
        ['商品小计', money(b.subtotal)], ['包装费', money(b.packagingFee || 0)], ['配送及附加费', money(b.deliveryFee)],
        [b.fullReductionLabel || '满减', `-${money(b.fullReduction)}`],
        [b.couponLabel || '优惠券', `-${money(b.coupon)}`], [b.orderable === false ? '原车估算（未达起送）' : '当前实付', money(b.total)]
    ].map(([label, value], i) => `<div class="breakdown-row ${i === 5 ? 'is-total' : i > 2 ? 'is-discount' : ''}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('')
        : '<p class="empty-tip">计算完成后显示明细</p>';
    const p = state.promotions;
    $('promotionRules').innerHTML = p ? `<p>起送价 ${money(p.minimumOrder || 0)}，按活动后商品小计判断；包装费、配送费和券后金额不计入起送门槛。</p><p>满减选择符合门槛且优惠金额最大的一档：</p><div class="rule-list">${(p.fullReduction || []).map((r) => `<span class="rule-chip">${esc(r.label)}</span>`).join('')}</div><p>优惠券：</p><div class="rule-list">${(p.coupons || []).map((r) => `<span class="rule-chip">${esc(r.label)}（${r.stackable ? '可叠加' : '同类择优一张'}）</span>`).join('')}</div><p>可叠加券可与一张最优非叠加券同时使用。优惠抵扣最多为应付金额。</p><p>包装费按每件商品的包装单价累加，本地示例商品均为 ${money(0)}。</p><p>配送费 ${money(p.delivery?.baseFee || 0)}，商品满 ${money(p.delivery?.freeThreshold || 0)} 免基础配送费。</p><p>${p.delivery?.peakHours?.enabled ? `高峰时段 ${esc((p.delivery.peakHours.timeRanges || []).map((r) => `${r.start}–${r.end}`).join('、'))} 加收 ${money(p.delivery.peakHours.extraFee)}；` : ''}优惠按当前购物车自动计算，限时价以询价时为准。</p>` : '';
}

function renderPlans() {
    const minimum = state.mode === 'minimum-order';
    const degraded = Boolean(state.search && state.search.degraded);
    $('plansTitle').textContent = minimum ? '起送补单方案' : '可选凑单方案';
    $('plansKicker').textContent = (state.preferences.strategy === 'preference'
        ? (state.preference?.applied ? '按你的本机历史偏好排序 · 演示级' : '暂无本机历史记录，先按支出更低排序')
        : state.preferences.strategy === 'fewer' ? '在满足条件的方案中少买优先' : minimum ? '满足起送后支出更低' : '只推荐实付更低的方案')
        + (degraded ? ' · 目录较大，实时预算内求解' : '');
    $('plansStatus').textContent = state.calculating ? '正在按你的偏好比较…' : !state.breakdown ? '连接后显示可选方案' : !state.cart.length ? '先选商品，再帮你比较' : !state.alternatives.length ? state.reason || '已比较当前候选，暂没有能减少实付的方案，无需加购。' : minimum ? `找到 ${state.alternatives.length} 套达标方案。原车无法下单，以下补单未计为净省，请确认额外支出。` : `找到 ${state.alternatives.length} 套可选方案；净省已扣除加购成本。`;
    $('alternativePlans').innerHTML = state.alternatives.map((s, index) => `<button type="button" class="plan-card${minimumPlan(s) ? ' minimum-plan' : ''}${s.id === state.suggestion?.id ? ' selected' : ''}" data-plan-id="${esc(s.id)}" aria-pressed="${s.id === state.suggestion?.id}" ${locked() || state.calculating || state.preferencesInvalid ? 'disabled' : ''} aria-label="查看方案${index + 1}：${esc(itemNames(s))}，${esc(planBenefit(s))}">
        <span class="plan-row"><span class="plan-name"><span class="plan-badge">${index ? `备选 ${index}` : state.preferences.strategy === 'preference' ? '智能推荐' : state.preferences.strategy === 'fewer' ? '少买优先' : minimumPlan(s) ? '支出最少' : '净省最多'}</span>${esc(itemNames(s))}</span><strong class="plan-saving">${esc(planBenefit(s))}</strong></span><span class="plan-row"><span class="plan-cost">加购 ${money(s.additionCost)} · 共${s.itemCount}件</span><span class="plan-total">${minimumPlan(s) ? esc(paymentChangeText(s)) : `实付 ${money(s.currentTotal)} → <strong>${money(s.newTotal)}</strong>`}</span></span><span class="plan-actions">查看计算与选择此方案 →</span></button>`).join('');
    $('planChoice').innerHTML = state.alternatives.map((s, index) => `<button type="button" class="plan-choice-btn" data-plan-id="${esc(s.id)}" ${locked() ? 'disabled' : ''} aria-pressed="${state.modal?.suggestion.id === s.id}">方案 ${index + 1} · ${minimumPlan(s) ? `实付${money(s.newTotal)}` : `省${money(s.netSaving)}`}</button>`).join('');
}

function renderUndo() {
    const undo = state.undo;
    const valid = undo && fingerprint(state.cart) === fingerprint(undo.afterCart);
    $('undoBar').style.display = valid || state.pending?.type === 'reverted' ? 'block' : 'none';
    $('undoText').textContent = undo ? `刚${minimumPlan(undo) ? '补单' : '采纳'}「${undo.itemNames}」，${minimumPlan(undo) ? `补单后实付${money(undo.newTotal)}` : `预计净省${money(undo.netSaving)}`}` : '';
    $('undoDescription').textContent = minimumPlan(undo) ? '撤销后恢复未达起送的原购物车；这次补单未计入净省。' : '撤销后恢复原购物车，看板同步调整预计净省。';
    $('undoBtn').disabled = state.undoing || state.deciding || state.recovering || state.resetting || (state.pending && state.pending.type !== 'reverted');
    $('undoBtn').textContent = state.undoing ? '撤销中…' : state.pending?.type === 'reverted' ? '重试撤销' : '撤销上次加购';
}

function renderHint() {
    const s = state.suggestion;
    $('progressHint').style.display = s ? 'flex' : 'none';
    if (s) $('hintText').textContent = minimumPlan(s) ? `加购「${itemNames(s)}」可达起送，实付${money(s.newTotal)}` : `加购「${itemNames(s)}」可净省${money(s.netSaving)}`;
}
function renderAll() { renderCart(); renderRecommendations(); renderSummary(); renderHint(); }

async function recalc() {
    if (state.pending || state.recovering || state.preferencesInvalid) return;
    const seq = ++calcSeq;
    state.calculating = true; state.suggestion = null; state.alternatives = []; state.breakdown = null; state.performance = null;
    renderSummary(); renderHint(); renderRecommendations();
    const started = performance.now();
    try {
        const result = await api('/api/calculate', { method: 'POST', body: JSON.stringify({
            currentItems: state.cart.map((i) => ({ ...i, inCart: true })), recommendItems: availableRecommendations(), preferences: state.preferences }) });
        if (seq !== calcSeq) return;
        state.breakdown = result.breakdown; state.suggestion = result.suggestion;
        state.alternatives = result.alternatives || (result.suggestion ? [result.suggestion] : []);
        state.performance = result.performance;
        state.preference = result.preference || null;
        state.mode = result.mode || 'saving'; state.reason = result.reason || ''; state.search = result.search || null;
        state.roundTripMs = performance.now() - started; state.connected = true;
        $('calcHint').textContent = `服务端计算 · 本次${state.performance.calcTimeMs}ms${result.search?.degraded ? ' · 已降级' : ''}`;
        if (state.storageWarning) setStatus('error', '已连接；浏览器未能保存当前状态，请检查存储后重试', true);
        else setStatus('', '已连接 · 按起送门槛与少买偏好计算');
    } catch (error) {
        if (seq !== calcSeq) return;
        state.connected = false; setStatus('error', error.status === 400 ? error.message : '计算失败，请确认后端服务已启动后重试', true);
    } finally {
        if (seq === calcSeq) { state.calculating = false; renderSummary(); renderHint(); renderRecommendations(); }
    }
}

function onCartChanged() { if (state.modal) closeModal(); state.undo = null; persistCart(); renderCart(); recalc(); }
function changeQuantity(id, delta) {
    if (locked()) return;
    const i = state.cart.find((i) => i.id === id); if (!i) return;
    const next = i.quantity + delta;
    if (next > (i.stock ?? 99)) { toast(`「${i.name}」最多可选${i.stock ?? 99}件`); return; }
    if (next <= 0) state.cart = state.cart.filter((i) => i.id !== id); else i.quantity = next;
    onCartChanged();
}
function addToCart(id) {
    if (locked() || state.cart.some((i) => i.id === id)) return;
    const source = state.pool.find((i) => i.id === id); if (!source || source.stock <= 0) return;
    state.cart.push({ ...source, quantity: 1, inCart: true }); onCartChanged();
}

function setModalStatus(text, retryAction, isError = false) {
    $('modalStatus').className = `modal-status${isError ? ' error' : ''}`; $('modalStatus').textContent = text;
    if (retryAction) { const b = document.createElement('button'); b.type = 'button'; b.textContent = '重试'; b.addEventListener('click', retryAction); $('modalStatus').appendChild(b); }
}
function setDecisionButtons(disabled) {
    const pending = state.modal && state.modal.pendingType;
    const expired = state.modal && state.modal.suggestion.expiresAt && Date.now() >= state.modal.suggestion.expiresAt;
    $('acceptBtn').disabled = disabled || pending === 'rejected' || (expired && !pending);
    $('rejectBtn').disabled = disabled || pending === 'accepted';
    $('modalClose').disabled = state.deciding || Boolean(pending);
}
async function recordShown(modal) {
    setDecisionButtons(true); setModalStatus('正在准备建议…');
    try {
        await api('/api/events', { method: 'POST', body: JSON.stringify({ recommendationId: modal.suggestion.id, type: 'shown' }) });
        if (state.modal !== modal) return;
        modal.shown = true; setModalStatus('本次选择会更新到看板。关闭弹窗表示暂不决定。'); setDecisionButtons(false); $('acceptBtn').focus();
    } catch (error) {
        if (state.modal !== modal) return;
        if (error.status === 409 || error.status === 404) setModalStatus('建议已失效，请重新计算。', () => { closeModal(); recalc(); }, true);
        else setModalStatus('建议暂时无法同步，请重试。', () => recordShown(modal), true);
    }
}
async function openModal() {
    if (!state.suggestion || state.calculating || locked() || state.preferencesInvalid || state.modal) return;
    const modal = { suggestion: state.suggestion, shown: false }; state.modal = modal; lastFocus = document.activeElement;
    const s = modal.suggestion;
    $('modalTitle').textContent = minimumPlan(s) ? '🛒 起送补单' : '💰 净省建议';
    $('acceptBtn').textContent = minimumPlan(s) ? '确认补单' : '采纳建议';
    $('suggestionTitle').textContent = s.title; $('suggestionDetail').textContent = s.detail;
    s.calculation.steps.forEach((step, i) => { $(`calcStep${i + 1}`).innerHTML = `<strong>${esc(step.label)}：</strong>${esc(step.value)}<br><small>${esc(step.detail)}</small>`; });
    const r = s.calculation.result;
    $('calcResult').innerHTML = `<strong>${esc(r.label)}：</strong>${esc(r.value)}<br><small>${esc(r.formula)}</small>`;
    const p = state.performance;
    $('calcTime').textContent = `${p.calcTimeMs}ms`;
    $('candidateCount').textContent = `${p.candidateCount}种 / ${p.combinationCount ?? p.candidateCount}个方案`;
    $('p99Time').textContent = `${p.p99Ms}ms · 近${p.sampleCount}次`;
    $('roundTrip').textContent = `${state.roundTripMs.toFixed(1)}ms`;
    renderPlans(); updateExpiry();
    $('netsaveModal').style.display = 'flex'; $('modalClose').focus(); await recordShown(modal);
}

function selectPlan(id) {
    if (locked() || state.calculating || state.preferencesInvalid) return;
    const chosen = state.alternatives.find((s) => s.id === id);
    if (!chosen) return;
    if (state.modal?.suggestion.id === id) return;
    closeModal(); state.suggestion = chosen;
    renderSummary(); renderHint(); renderRecommendations(); openModal();
}

function updateExpiry() {
    const s = state.modal?.suggestion;
    if (!s) return;
    const remaining = Math.max(0, Math.ceil((s.expiresAt - Date.now()) / 1000));
    $('quoteExpiry').textContent = state.modal.pendingType ? '正在确认操作结果，请保留页面或稍后重试。' : Number.isFinite(remaining) ? remaining ? `方案还剩 ${Math.floor(remaining / 60)} 分 ${String(remaining % 60).padStart(2, '0')} 秒有效，采纳时会再次核价。` : '方案已过期，请重新计算后再采纳。' : '采纳时会重新核对价格。';
    if (!remaining && Number.isFinite(remaining) && !state.modal.pendingType && state.modal.shown) {
        setDecisionButtons(false);
        setModalStatus('方案已过期，可保留原购物车，或重新计算。', () => { closeModal(); recalc(); });
    }
}
function closeModal() {
    if (state.deciding || (state.modal && state.modal.pendingType)) return;
    $('netsaveModal').style.display = 'none'; state.modal = null;
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
}
async function decide(type) {
    const modal = state.modal;
    if (!modal || !modal.shown || state.deciding || state.preferencesInvalid || (modal.pendingType && modal.pendingType !== type)) return;
    if (!modal.pendingType && type === 'accepted' && modal.suggestion.expiresAt && Date.now() >= modal.suggestion.expiresAt) { updateExpiry(); return; }
    const previousPending = state.pending;
    modal.pendingType = type;
    state.pending = state.pending || { recommendationId: modal.suggestion.id, type, beforeCart: snapshot(state.cart) };
    // 先保存意图；响应丢失或刷新后，按服务端结果恢复，不重复加购。
    if (!persistCart()) {
        state.pending = previousPending; modal.pendingType = previousPending?.type || null; setDecisionButtons(false);
        setModalStatus('浏览器未能保存操作，请确认本地存储可用后重试。', null, true); return;
    }
    state.deciding = true; setDecisionButtons(true); setModalStatus('正在保存本次选择…');
    renderCart(); renderSummary(); renderRecommendations();
    try {
        const receipt = await api('/api/events', { method: 'POST', body: JSON.stringify({ recommendationId: modal.suggestion.id, type }) });
        const s = modal.suggestion;
        const decision = receipt.currentDecision || receipt.event?.type || type;
        applyDecision(state.pending, s, decision);
        state.deciding = false; modal.pendingType = null; closeModal(); renderAll();
        toast(decision === 'reverted' ? '这次采纳已撤销，已恢复加购前购物车' : decision === 'accepted' ? minimumPlan(s) ? `已补到起送，实付${money(s.newTotal)}；本次未计为净省` : `已加购「${itemNames(s)}」，预计净省${money(s.netSaving)}` : '已保留原购物车，本次选择已记录');
        await recalc();
    } catch (error) {
        state.deciding = false;
        if ([400, 404, 409].includes(error.status)) { modal.pendingType = null; state.pending = null; persistCart(); setDecisionButtons(true); setModalStatus('方案已失效或已处理，请重新计算。', () => { closeModal(); recalc(); }, true); }
        else { setDecisionButtons(false); setModalStatus('保存结果尚未确认。请再次点击原选项重试，确认前暂不能更换选择。', null, true); }
        renderCart(); renderSummary(); renderRecommendations();
    }
}

function fromSnapshot(items) {
    const invalid = () => Object.assign(new Error('商品或库存已变化，请重新选择'), { status: 409 });
    if (!Array.isArray(items)) throw invalid();
    const seen = new Set();
    return items.map(({ id, quantity }) => {
        const product = state.pool.find((i) => i.id === id);
        if (!product || seen.has(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > (product.stock ?? 100)) throw invalid();
        seen.add(id); return { ...product, quantity, inCart: true };
    });
}

function applyDecision(pending, suggestion, decision) {
    if (decision === 'accepted' && pending.type !== 'reverted' && suggestion) {
        const before = fromSnapshot(pending.beforeCart);
        const after = fromSnapshot([...pending.beforeCart, ...suggestionItems(suggestion).map((i) => ({ id: i.id, quantity: i.quantity || 1 }))]);
        state.cart = after;
        state.undo = { recommendationId: pending.recommendationId, beforeCart: snapshot(before), afterCart: snapshot(after), itemNames: itemNames(suggestion), netSaving: suggestion.netSaving,
            kind: suggestion.kind || 'saving', newTotal: suggestion.newTotal, paymentChange: suggestion.paymentChange };
    } else if (decision === 'reverted') {
        state.cart = fromSnapshot(pending.beforeCart); state.undo = null;
    } else if (decision === 'rejected') {
        state.undo = null;
    } else {
        throw Object.assign(new Error('服务端结果与本次选择不一致，请重新计算'), { status: 409 });
    }
    state.pending = null;
    if (!persistCart()) setStatus('error', '操作已记录；浏览器保存未完成，请刷新恢复结果', true);
}

async function undoSuggestion() {
    if (state.undoing || state.deciding || state.recovering || state.resetting || (state.pending && state.pending.type !== 'reverted')) return;
    const undo = state.undo;
    if (!undo || fingerprint(state.cart) !== fingerprint(undo.afterCart)) return;
    const previousPending = state.pending;
    state.pending = state.pending || { recommendationId: undo.recommendationId, type: 'reverted', beforeCart: undo.beforeCart };
    if (!persistCart()) { state.pending = previousPending; $('undoStatus').textContent = '浏览器未能保存操作，请重试。'; return; }
    state.undoing = true; renderAll(); $('undoStatus').textContent = '正在撤销…';
    try {
        const receipt = await api('/api/events', { method: 'POST', body: JSON.stringify({ recommendationId: undo.recommendationId, type: 'reverted' }) });
        applyDecision(state.pending, null, receipt.currentDecision || receipt.event?.type || 'reverted');
        state.undoing = false; renderAll(); toast(minimumPlan(undo) ? '已撤销补单，恢复原购物车；净省统计未增加' : '已撤销加购，看板预计净省已扣回'); await recalc();
    } catch (error) {
        state.undoing = false;
        const invalid = [400, 404, 409].includes(error.status);
        if (invalid) { state.pending = null; state.undo = null; persistCart(); }
        renderAll();
        if (invalid) { toast('原采纳记录已失效，已保留购物车'); await recalc(); }
        else $('undoStatus').textContent = '撤销尚未确认，购物车保持不变，请点击重试。';
    }
}

async function recoverPending() {
    const pending = state.pending;
    if (!pending) return true;
    state.recovering = true; setStatus('loading', '正在恢复上次未确认的操作…'); renderAll();
    try {
        const quote = await api(`/api/suggestions/${encodeURIComponent(pending.recommendationId)}`);
        let decision = quote.decision;
        if (!decision || (pending.type === 'reverted' && decision === 'accepted')) {
            const receipt = await api('/api/events', { method: 'POST', body: JSON.stringify({ recommendationId: pending.recommendationId, type: pending.type }) });
            decision = receipt.currentDecision || receipt.event?.type || pending.type;
        }
        applyDecision(pending, quote.suggestion, decision);
        toast('已按服务端记录恢复上次操作');
        return true;
    } catch (error) {
        if ([400, 404, 409].includes(error.status)) {
            state.pending = null; persistCart(); toast('原方案已失效，已保留购物车并重新计算'); return true;
        }
        state.connected = false; setStatus('error', '上次操作结果待确认，请恢复连接后重试', true); return false;
    } finally { state.recovering = false; renderAll(); }
}

async function init() {
    setStatus('loading', '正在连接后端服务…');
    try {
        const [data, promotions] = await Promise.all([api('/api/cart/default'), api('/api/promotions')]);
        state.promotions = promotions;
        state.pool = [...data.currentItems, ...data.recommendItems];
        state.cart = restoreCart(data).map((i) => ({ ...i, inCart: true })); state.connected = true;
        renderPreferenceControls(); renderAll();
        if (await recoverPending()) await recalc();
    } catch { state.connected = false; renderAll(); setStatus('error', '尚未连接。请运行 start-demo.bat 后重试。', true); }
}
async function retry() {
    if (!state.pool.length) return init();
    if (state.storageWarning) persistCart();
    setStatus('loading', '正在重新连接…');
    if (await recoverPending()) await recalc();
}
async function resetCart() {
    if (locked()) return;
    closeModal();
    ++calcSeq;
    state.resetting = true; state.calculating = true;
    state.suggestion = null; state.alternatives = []; state.breakdown = null;
    renderAll();
    try {
        const data = await api('/api/cart/default'); state.pool = [...data.currentItems, ...data.recommendItems];
        state.cart = data.currentItems.map((i) => ({ ...i, inCart: true }));
        state.resetting = false;
        onCartChanged(); toast('已恢复示例购物车；看板历史保留');
    } catch {
        state.resetting = false;
        toast('恢复失败，正在重新获取当前购物车价格');
        recalc();
    }
}
function loadMinimumScenario() {
    if (locked()) return;
    const items = ['p2', 'p3'].map((id) => state.pool.find((i) => i.id === id));
    if (items.some((i) => !i)) { toast('请先连接后端，加载完整示例商品'); return; }
    state.cart = items.map((i) => ({ ...i, quantity: 1, inCart: true }));
    onCartChanged(); toast('已切换：商品20元、起送25元；补单会明确显示增加的费用');
}
function tickClock() {
    document.querySelector('.status-bar .time').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    if (state.modal) updateExpiry();
    if (document.hidden || state.modal || locked() || state.calculating) return;
    const now = Date.now();
    if (state.pool.some((i) => i.flashSale && i.flashSale.endTime > lastPriceCheck && i.flashSale.endTime <= now)) { renderCart(); recalc(); }
    lastPriceCheck = now;
}
document.addEventListener('DOMContentLoaded', () => {
    tickClock(); setInterval(tickClock, 1000);
    document.addEventListener('visibilitychange', tickClock);
    $('cartList').addEventListener('click', (e) => { const b = e.target.closest('.qty-btn'); if (b) changeQuantity(b.dataset.id, b.classList.contains('plus-btn') ? 1 : -1); });
    $('recommendList').addEventListener('click', (e) => { const b = e.target.closest('.recommend-item'); if (b) addToCart(b.dataset.id); });
    $('hintAction').addEventListener('click', openModal);
    $('alternativePlans').addEventListener('click', (e) => { const button = e.target.closest('[data-plan-id]'); if (button) selectPlan(button.dataset.planId); });
    $('planChoice').addEventListener('click', (e) => { const button = e.target.closest('[data-plan-id]'); if (button) selectPlan(button.dataset.planId); });
    $('undoBtn').addEventListener('click', undoSuggestion);
    $('checkoutBtn').addEventListener('click', () => state.suggestion ? openModal() : toast(state.reason || '当前没有能减少实付的加购方案，保留原购物车即可'));
    $('preferencesForm').addEventListener('submit', (e) => { e.preventDefault(); applyPreferences(); });
    $('preferencesForm').addEventListener('change', applyPreferences);
    $('minimumCartBtn').addEventListener('click', loadMinimumScenario);
    $('resetCartBtn').addEventListener('click', resetCart); $('modalClose').addEventListener('click', closeModal); $('modalOverlay').addEventListener('click', closeModal);
    $('acceptBtn').addEventListener('click', () => decide('accepted')); $('rejectBtn').addEventListener('click', () => decide('rejected'));
    document.addEventListener('keydown', (e) => {
        if (!state.modal) return;
        if (e.key === 'Escape') closeModal();
        if (e.key === 'Tab') {
            const buttons = [...$('netsaveModal').querySelectorAll('button:not(:disabled)')]; const first = buttons[0], last = buttons[buttons.length - 1];
            if (!first) { e.preventDefault(); return; }
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    init();
});
