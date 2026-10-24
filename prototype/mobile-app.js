// 移动端应用逻辑 - 增强版

let cartState = {
    items: [...INITIAL_CART.items],
    recommend: [...INITIAL_CART.recommend]
};

let currentSuggestion = null;
let lastCalcTime = 0;

document.addEventListener('DOMContentLoaded', () => {
    renderCart();
    renderRecommendations();
    updatePriceSummary();
    updateProgressHint();
    setupEventListeners();
});

function renderCart() {
    const cartListEl = document.getElementById('cartList');
    const itemCountEl = document.getElementById('itemCount');
    
    const itemsInCart = cartState.items.filter(item => item.inCart);
    itemCountEl.textContent = `${itemsInCart.reduce((sum, item) => sum + item.quantity, 0)}件`;
    
    cartListEl.innerHTML = itemsInCart.map(item => `
        <div class="cart-item" data-id="${item.id}">
            <div class="item-image">${item.emoji}</div>
            <div class="item-info">
                <div class="item-name">${item.name}</div>
                <div class="item-desc">${item.desc}</div>
                <div class="item-bottom">
                    <div class="item-price">¥${item.price.toFixed(2)}</div>
                    <div class="item-quantity">
                        <button class="qty-btn minus-btn" data-id="${item.id}">−</button>
                        <span class="qty-value">${item.quantity}</span>
                        <button class="qty-btn plus-btn" data-id="${item.id}">+</button>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

function renderRecommendations() {
    const recommendListEl = document.getElementById('recommendList');
    
    recommendListEl.innerHTML = cartState.recommend.filter(item => !item.inCart).map(item => `
        <div class="recommend-item" data-id="${item.id}">
            <div class="recommend-image">${item.emoji}</div>
            <div class="recommend-name">${item.name}</div>
            <div class="recommend-price">¥${item.price.toFixed(2)}</div>
        </div>
    `).join('');
}

function updatePriceSummary() {
    const breakdown = calcPriceBreakdown(cartState.items);
    
    document.getElementById('subtotal').textContent = `¥${breakdown.subtotal}`;
    document.getElementById('discount').textContent = `-¥${(parseFloat(breakdown.fullReduction) + parseFloat(breakdown.coupon)).toFixed(2)}`;
    document.getElementById('total').textContent = `¥${breakdown.total}`;
}

function updateProgressHint() {
    checkNetSaving();
    const hintEl = document.getElementById('progressHint');
    const hintTextEl = document.getElementById('hintText');
    const hint = shouldShowHint(currentSuggestion);
    if (hint.show) {
        hintTextEl.textContent = `加购「${currentSuggestion.item.name}」可净省¥${currentSuggestion.netSaving.toFixed(2)}`;
        hintEl.style.display = 'flex';
    } else {
        hintEl.style.display = 'none';
    }
    
}

function checkNetSaving() {
    const currentItems = cartState.items.filter(item => item.inCart);
    const recommendItems = cartState.recommend.filter(item => !item.inCart);
    
    const startTime = performance.now();
    currentSuggestion = calculateNetSaving(currentItems, recommendItems);
    const endTime = performance.now();
    lastCalcTime = endTime - startTime;
}

function setupEventListeners() {
    // 购物车数量操作
    document.getElementById('cartList').addEventListener('click', (e) => {
        if (e.target.classList.contains('minus-btn')) {
            updateItemQuantity(e.target.dataset.id, -1);
        } else if (e.target.classList.contains('plus-btn')) {
            updateItemQuantity(e.target.dataset.id, 1);
        }
    });
    
    // 推荐商品点击
    document.getElementById('recommendList').addEventListener('click', (e) => {
        const item = e.target.closest('.recommend-item');
        if (item) {
            toggleRecommendItem(item.dataset.id);
        }
    });
    
    // 进度提示条按钮
    document.getElementById('hintAction').addEventListener('click', () => {
        showNetSavingModal();
    });
    
    // 结算按钮
    document.getElementById('checkoutBtn').addEventListener('click', () => {
        showNetSavingModal();
    });
    
    // 算法说明折叠
    document.getElementById('infoHeader').addEventListener('click', () => {
        const content = document.getElementById('infoContent');
        const arrow = document.querySelector('.info-arrow');
        if (content.style.display === 'none') {
            content.style.display = 'block';
            arrow.style.transform = 'rotate(180deg)';
        } else {
            content.style.display = 'none';
            arrow.style.transform = 'rotate(0deg)';
        }
    });
    
    // 弹窗操作
    document.getElementById('modalClose').addEventListener('click', hideModal);
    document.getElementById('modalOverlay').addEventListener('click', hideModal);
    document.getElementById('acceptBtn').addEventListener('click', acceptSuggestion);
    document.getElementById('rejectBtn').addEventListener('click', rejectSuggestion);
}

function updateItemQuantity(itemId, delta) {
    const item = cartState.items.find(i => i.id === itemId);
    if (!item) return;
    
    const newQuantity = item.quantity + delta;
    
    if (newQuantity <= 0) {
        item.inCart = false;
        item.quantity = 0;
        const recommendItem = cartState.recommend.find(r => r.id === itemId);
        if (recommendItem) {
            recommendItem.inCart = false;
        }
    } else {
        item.quantity = newQuantity;
    }
    
    renderCart();
    renderRecommendations();
    updatePriceSummary();
    updateProgressHint();
}

function toggleRecommendItem(itemId) {
    const recommendItem = cartState.recommend.find(r => r.id === itemId);
    if (!recommendItem) return;
    
    recommendItem.inCart = true;
    
    const cartItem = cartState.items.find(i => i.id === itemId);
    if (cartItem) {
        cartItem.inCart = true;
        cartItem.quantity = 1;
    } else {
        cartState.items.push({
            ...recommendItem,
            inCart: true,
            quantity: 1
        });
    }
    
    renderCart();
    renderRecommendations();
    updatePriceSummary();
    updateProgressHint();
}

function showNetSavingModal() {
    if (!currentSuggestion) {
        alert('当前没有更优的凑单方案');
        return;
    }
    
    const modal = document.getElementById('netsaveModal');
    const text = generateSuggestionText(currentSuggestion);
    const calc = generateCalculationSteps(currentSuggestion);
    
    document.getElementById('suggestionTitle').textContent = text.title;
    document.getElementById('suggestionDetail').textContent = text.detail;
    
    document.getElementById('calcStep1').innerHTML = `
        <strong>${calc.steps[0].label}：</strong>${calc.steps[0].value}<br>
        <small>${calc.steps[0].detail}</small>
    `;
    
    document.getElementById('calcStep2').innerHTML = `
        <strong>${calc.steps[1].label}：</strong>${calc.steps[1].value}<br>
        <small>${calc.steps[1].detail}</small>
    `;
    
    document.getElementById('calcStep3').innerHTML = `
        <strong>${calc.steps[2].label}：</strong>${calc.steps[2].value}<br>
        <small>${calc.steps[2].detail}</small>
    `;
    
    document.getElementById('calcResult').innerHTML = `
        <strong>${calc.result.label}：</strong>${calc.result.value}<br>
        <small>${calc.result.formula}</small>
    `;
    
    // 填充性能指标
    document.getElementById('calcTime').textContent = `${lastCalcTime.toFixed(1)}ms`;
    document.getElementById('candidateCount').textContent = `${cartState.recommend.filter(i => !i.inCart).length}个`;
    document.getElementById('bestSaving').textContent = `¥${currentSuggestion.netSaving.toFixed(2)}`;
    
    modal.style.display = 'flex';
}

function hideModal() {
    document.getElementById('netsaveModal').style.display = 'none';
}

function acceptSuggestion() {
    if (!currentSuggestion) return;
    const acceptedSuggestion = currentSuggestion;
    const itemId = acceptedSuggestion.item.id;
    const recommendItem = cartState.recommend.find(r => r.id === itemId);
    
    if (recommendItem && !recommendItem.inCart) {
        recommendItem.inCart = true;
        const existingItem = cartState.items.find(item => item.id === itemId);
        if (existingItem) {
            existingItem.inCart = true;
            existingItem.quantity = 1;
        } else {
            cartState.items.push({ ...recommendItem, inCart: true, quantity: 1 });
        }
    }
    
    hideModal();
    renderCart();
    renderRecommendations();
    updatePriceSummary();
    updateProgressHint();
    
    setTimeout(() => {
        alert(`✓ 已加购「${acceptedSuggestion.item.name}」，净省${acceptedSuggestion.netSaving.toFixed(2)}元！`);
    }, 300);
}

function rejectSuggestion() {
    hideModal();
}
