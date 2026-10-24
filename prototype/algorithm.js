// 净省凑单算法 - 核心逻辑

/**
 * 计算净省建议
 * @param {Array} currentItems - 当前购物车商品列表
 * @param {Array} recommendItems - 可推荐商品列表
 * @returns {Object|null} - 净省建议对象，无建议时返回null
 */
function calculateNetSaving(currentItems, recommendItems) {
    if (!currentItems.some(item => item.inCart && item.quantity > 0)) return null;
    // 计算当前购物车的实付金额
    const currentBreakdown = calcPriceBreakdown(currentItems);
    const currentTotal = parseFloat(currentBreakdown.total);
    const currentSubtotal = parseFloat(currentBreakdown.subtotal);
    const currentDelivery = parseFloat(currentBreakdown.deliveryFee);
    
    // 遍历所有可推荐商品，计算每个商品的净省效果
    const suggestions = [];
    
    for (const item of recommendItems) {
        if (item.inCart) continue; // 跳过已在购物车的商品
        
        // 模拟加购该商品后的购物车
        const testItems = [
            ...currentItems,
            { ...item, inCart: true, quantity: 1 }
        ];
        
        // 计算加购后的价格明细
        const testBreakdown = calcPriceBreakdown(testItems);
        const testTotal = parseFloat(testBreakdown.total);
        const testSubtotal = parseFloat(testBreakdown.subtotal);
        const testDelivery = parseFloat(testBreakdown.deliveryFee);
        
        // 计算各项变化
        const itemPrice = item.price;
        const subtotalIncrease = testSubtotal - currentSubtotal;
        const deliveryChange = testDelivery - currentDelivery;
        const discountIncrease = 
            (parseFloat(testBreakdown.fullReduction) + parseFloat(testBreakdown.coupon)) -
            (parseFloat(currentBreakdown.fullReduction) + parseFloat(currentBreakdown.coupon));
        
        // 净省 = 原实付 - 新实付
        const netSaving = currentTotal - testTotal;
        
        // 只有净省 > 0 才推荐
        if (netSaving > 0.01) { // 容差0.01元
            suggestions.push({
                item: item,
                netSaving: netSaving,
                currentTotal: currentTotal,
                newTotal: testTotal,
                breakdown: {
                    itemPrice: itemPrice,
                    subtotalIncrease: subtotalIncrease,
                    deliveryChange: deliveryChange,
                    discountIncrease: discountIncrease,
                    currentDiscount: parseFloat(currentBreakdown.fullReduction) + parseFloat(currentBreakdown.coupon),
                    newDiscount: parseFloat(testBreakdown.fullReduction) + parseFloat(testBreakdown.coupon)
                },
                currentBreakdown: currentBreakdown,
                testBreakdown: testBreakdown
            });
        }
    }
    
    // 按净省金额从高到低排序
    suggestions.sort((a, b) => b.netSaving - a.netSaving);
    
    // 返回最优建议（净省最大的）
    return suggestions.length > 0 ? suggestions[0] : null;
}

/**
 * 生成净省说明文案
 * @param {Object} suggestion - 净省建议对象
 * @returns {Object} - 包含标题和描述的文案对象
 */
function generateSuggestionText(suggestion) {
    const item = suggestion.item;
    const netSaving = suggestion.netSaving.toFixed(2);
    const itemPrice = item.price.toFixed(2);
    
    // 判断净省来源
    const discountDiff = suggestion.breakdown.discountIncrease;
    const deliveryDiff = suggestion.breakdown.deliveryChange;
    
    let reason = '';
    if (discountDiff > 0) {
        reason = `触发更高满减档位，优惠增加${discountDiff.toFixed(2)}元`;
    } else if (deliveryDiff < 0) {
        reason = `达到免配送费门槛，节省${Math.abs(deliveryDiff).toFixed(2)}元配送费`;
    } else {
        reason = `优惠组合优化，综合节省${netSaving}元`;
    }
    
    return {
        title: `加购「${item.name}」可净省${netSaving}元`,
        description: `${reason}。加购价${itemPrice}元，实付减少${netSaving}元。`,
        detail: `加购 ${item.name}（${itemPrice}元）后，${reason}。虽然商品总价增加，但优惠力度更大，最终实付反而减少${netSaving}元。`
    };
}

/**
 * 生成计算过程展示
 * @param {Object} suggestion - 净省建议对象
 * @returns {Array} - 计算步骤数组
 */
function generateCalculationSteps(suggestion) {
    const steps = [];
    
    // 步骤1：当前实付
    steps.push({
        label: '当前实付',
        value: `¥${suggestion.currentTotal.toFixed(2)}`,
        detail: `商品¥${parseFloat(suggestion.currentBreakdown.subtotal).toFixed(2)} + 配送¥${suggestion.currentBreakdown.deliveryFee} - 优惠¥${(parseFloat(suggestion.currentBreakdown.fullReduction) + parseFloat(suggestion.currentBreakdown.coupon)).toFixed(2)}`
    });
    
    // 步骤2：加购商品
    steps.push({
        label: '加购商品',
        value: `${suggestion.item.name} ¥${suggestion.item.price.toFixed(2)}`,
        detail: '购物车商品总价增加'
    });
    
    // 步骤3：新实付
    steps.push({
        label: '加购后实付',
        value: `¥${suggestion.newTotal.toFixed(2)}`,
        detail: `商品¥${parseFloat(suggestion.testBreakdown.subtotal).toFixed(2)} + 配送¥${suggestion.testBreakdown.deliveryFee} - 优惠¥${(parseFloat(suggestion.testBreakdown.fullReduction) + parseFloat(suggestion.testBreakdown.coupon)).toFixed(2)}`
    });
    
    // 结果：净省
    const result = {
        label: '净省金额',
        value: `¥${suggestion.netSaving.toFixed(2)}`,
        formula: `${suggestion.currentTotal.toFixed(2)} - ${suggestion.newTotal.toFixed(2)} = ${suggestion.netSaving.toFixed(2)}`
    };
    
    return { steps, result };
}

/**
 * 检查是否应该展示净省提示（在点击结算前）
 * @param {Object} suggestion - 净省建议对象
 * @returns {Object} - 是否展示及提示文案
 */
function shouldShowHint(suggestion) {
    if (!suggestion) {
        return { show: false };
    }
    
    const netSaving = suggestion.netSaving;
    
    // 净省金额大于1元才提示
    if (netSaving < 1) {
        return { show: false };
    }
    
    return {
        show: true,
        title: `💰 加购「${suggestion.item.name}」可省${netSaving.toFixed(2)}元`,
        desc: '点击结算查看详细说明'
    };
}
