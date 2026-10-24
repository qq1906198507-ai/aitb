// 主应用逻辑 - 页面交互与状态管理

// 全局状态
let cartState = {
    items: [...INITIAL_CART.items],
    recommend: [...INITIAL_CART.recommend]
};

let currentSuggestion = null;

// 页面初始化
document.addEventListener('DOMContentLoaded', () => {
    renderCart();
    renderRecommendations();
    updatePriceSummary();
    setupEventListeners();
    checkNetSaving();
});

// 渲染购物车商品
function renderCart() {
    const cartItemsEl = document.getElementById('cartItems');
    const cartCountEl = document.getElementById('cartCount');
    
    const itemsInCart = cartState.items.filter(item => item.inCart);
    cartCountEl.textContent = `${itemsInCart.reduce((sum, item) => sum + item.quantity, 0)}件商品`;
    
    cartItemsEl.innerHTML = itemsInCart.map(item => `
        <div class="cart-item" data-id="${item.id}">
            <div class="item-image">${item.emoji}</div>
            <div class="item-info">
                <div class="item-name">${item.name}</div>
                <div class="item-desc">${item.desc}</div>
                <div class="item-price">¥${item.price.toFixed(2)}</div>
            </div>
            <div class="item-quantity">
                <button class="qty-btn minus-btn" data-id="${item.id}">−</button>
                <span class="qty-value">${item.quantity}</span>
                <button class="qty-btn plus-btn" data-id="${item.id}">+</button>
            </div>
        </div>
    `).join('');
}

// 渲染推荐商品
function renderRecommendations() {
    const recommendItemsEl = document.getElementById('recommendItems');
    
    recommendItemsEl.innerHTML = cartState.recommend.map(item => {
        const inCartClass = item.inCart ? 'in-cart' : '';
        const statusText = item.inCart ? '✓ 已加购' : '+ 加购';
        
        return `
            <div class="recommend-item ${inCartClass}" data-id="${item.id}">
                <div class="recommend-image">${item.emoji}</div>
                <div class="recommend-name">${item.name}</div>
                <div class="recommend-price">¥${item.price.toFixed(2)}</div>
            </div>
        `;
    }).join('');
}

// 更新价格明细
function updatePriceSummary() {
    const breakdown = calcPriceBreakdown(cartState.items);
    
    document.getElementById('originalPrice').textContent = `¥${breakdown.subtotal}`;
    document.getElementById('deliveryFee').textContent = `¥${breakdown.deliveryFee}`;
    document.getElementById('fullReduction').textContent = `-¥${breakdown.fullReduction}`;
    document.getElementById('coupon').textContent = `-¥${breakdown.coupon}`;
    document.getElementById('totalPrice').textContent = `¥${breakdown.total}`;
    
    // 更新优惠说明
    const promotionInfoEl = document.getElementById('promotionInfo');
    promotionInfoEl.innerHTML = `
        <div class="promotion-item">🎁 ${breakdown.fullReductionLabel}</div>
        <div class="promotion-item">🎫 ${breakdown.couponLabel}</div>
        <div class="promotion-item">🚚 ${PROMOTIONS.delivery.label}</div>
    `;
}

// 设置事件监听
function setupEventListeners() {
    // 购物车商品数量增减
    document.getElementById('cartItems').addEventListener('click', (e) => {
        if (e.target.classList.contains('minus-btn')) {
            const itemId = e.target.dataset.id;
            updateItemQuantity(itemId, -1);
        } else if (e.target.classList.contains('plus-btn')) {
            const itemId = e.target.dataset.id;
            updateItemQuantity(itemId, 1);
        }
    });
    
    // 推荐商品点击
    document.getElementById('recommendItems').addEventListener('click', (e) => {
        const recommendItem = e.target.closest('.recommend-item');
        if (recommendItem) {
            const itemId = recommendItem.dataset.id;
            toggleRecommendItem(itemId);
        }
    });
    
    // 结算按钮
    document.getElementById('checkoutBtn').addEventListener('click', () => {
        showNetSavingModal();
    });
    
    // 弹窗关闭
    document.getElementById('modalClose').addEventListener('click', hideModal);
    document.querySelector('.modal-overlay').addEventListener('click', hideModal);
    
    // 弹窗按钮
    document.getElementById('acceptBtn').addEventListener('click', acceptSuggestion);
    document.getElementById('rejectBtn').addEventListener('click', rejectSuggestion);
}

// 更新商品数量
function updateItemQuantity(itemId, delta) {
    const item = cartState.items.find(i => i.id === itemId);
    if (!item) return;
    
    const newQuantity = item.quantity + delta;
    
    if (newQuantity <= 0) {
        // 移除商品
        item.inCart = false;
        item.quantity = 0;
        
        // 移到推荐列表
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
    checkNetSaving();
}

// 切换推荐商品加购状态
function toggleRecommendItem(itemId) {
    const recommendItem = cartState.recommend.find(r => r.id === itemId);
    if (!recommendItem) return;
    
    if (recommendItem.inCart) {
        // 从购物车移除
        recommendItem.inCart = false;
        const cartItem = cartState.items.find(i => i.id === itemId);
        if (cartItem) {
            cartItem.inCart = false;
            cartItem.quantity = 0;
        }
    } else {
        // 加入购物车
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
    }
    
    renderCart();
    renderRecommendations();
    updatePriceSummary();
    checkNetSaving();
}

// 检查净省建议
function checkNetSaving() {
    const currentItems = cartState.items.filter(item => item.inCart);
    const recommendItems = cartState.recommend.filter(item => !item.inCart);
    
    currentSuggestion = calculateNetSaving(currentItems, recommendItems);
    
    const hintEl = document.getElementById('netsaveHint');
    const hintData = shouldShowHint(currentSuggestion);
    
    if (hintData.show) {
        document.getElementById('hintTitle').textContent = hintData.title;
        document.getElementById('hintDesc').textContent = hintData.desc;
        hintEl.style.display = 'flex';
    } else {
        hintEl.style.display = 'none';
    }
}

// 显示净省建议弹窗
function showNetSavingModal() {
    if (!currentSuggestion) {
        alert('当前没有更优的凑单方案');
        return;
    }
    
    const modal = document.getElementById('netsaveModal');
    const text = generateSuggestionText(currentSuggestion);
    const calc = generateCalculationSteps(currentSuggestion);
    
    // 填充建议内容
    document.getElementById('suggestionTitle').textContent = text.title;
    document.getElementById('suggestionDetail').textContent = text.detail;
    
    // 填充计算过程
    document.getElementById('calcStep1').innerHTML = `
        <strong>${calc.steps[0].label}：</strong>${calc.steps[0].value}<br>
        <small style="color: #94A3B8;">${calc.steps[0].detail}</small>
    `;
    
    document.getElementById('calcStep2').innerHTML = `
        <strong>${calc.steps[1].label}：</strong>${calc.steps[1].value}<br>
        <small style="color: #94A3B8;">${calc.steps[1].detail}</small>
    `;
    
    document.getElementById('calcStep3').innerHTML = `
        <strong>${calc.steps[2].label}：</strong>${calc.steps[2].value}<br>
        <small style="color: #94A3B8;">${calc.steps[2].detail}</small>
    `;
    
    document.getElementById('calcResult').innerHTML = `
        <strong>${calc.result.label}：</strong>${calc.result.value}<br>
        <small style="color: #64748B;">${calc.result.formula}</small>
    `;
    
    modal.style.display = 'flex';
}

// 隐藏弹窗
function hideModal() {
    document.getElementById('netsaveModal').style.display = 'none';
}

// 采纳建议
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
    checkNetSaving();
    
    // 显示成功提示
    setTimeout(() => {
        alert(`✓ 已加购「${acceptedSuggestion.item.name}」，净省${acceptedSuggestion.netSaving.toFixed(2)}元！`);
    }, 300);
}

// 拒绝建议
function rejectSuggestion() {
    hideModal();
    // 用户选择不加购，保持现状
}
