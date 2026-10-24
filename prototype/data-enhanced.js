// 增强版模拟数据 - 支持复杂场景

const PRODUCTS = {
    inCart: [
        {
            id: 'p1',
            name: '招牌红烧肉套餐',
            desc: '红烧肉 + 米饭 + 时蔬',
            price: 28.00,
            emoji: '🍖',
            quantity: 1
        },
        {
            id: 'p2',
            name: '酸辣土豆丝',
            desc: '酸辣开胃，分量足',
            price: 12.00,
            emoji: '🥔',
            quantity: 1
        },
        {
            id: 'p3',
            name: '柠檬茶',
            desc: '鲜榨柠檬，清爽解腻',
            price: 8.00,
            emoji: '🍋',
            quantity: 1
        }
    ],
    
    recommend: [
        {
            id: 'r1',
            name: '卤蛋',
            desc: '秘制卤味，Q弹入味',
            price: 3.00,
            emoji: '🥚',
            stock: 10,  // 库存
            flashSale: null  // 限时折扣
        },
        {
            id: 'r2',
            name: '凉拌黄瓜',
            desc: '清爽爽口，开胃小菜',
            price: 6.00,
            emoji: '🥒',
            stock: 5,
            flashSale: {
                originalPrice: 6.00,
                salePrice: 4.00,
                endTime: Date.now() + 30 * 60 * 1000,  // 30分钟后结束
                label: '限时特惠'
            }
        },
        {
            id: 'r3',
            name: '酸梅汤',
            desc: '传统酸梅汤，冰镇',
            price: 5.00,
            emoji: '🧃',
            stock: 8,
            flashSale: null
        },
        {
            id: 'r4',
            name: '米饭',
            desc: '东北大米，香甜软糯',
            price: 2.00,
            emoji: '🍚',
            stock: 20,
            flashSale: null
        },
        {
            id: 'r5',
            name: '可乐',
            desc: '冰镇可乐，330ml',
            price: 4.00,
            emoji: '🥤',
            stock: 3,  // 库存紧张
            flashSale: {
                originalPrice: 4.00,
                salePrice: 2.50,
                endTime: Date.now() + 15 * 60 * 1000,  // 15分钟后结束
                label: '闪购'
            }
        }
    ]
};

// 增强版优惠规则
const PROMOTIONS = {
    // 满减规则
    fullReduction: [
        { threshold: 80, discount: 20, label: '满80减20' },
        { threshold: 50, discount: 10, label: '满50减10' },
        { threshold: 30, discount: 5, label: '满30减5' }
    ],
    
    // 多张优惠券（用户可选择使用哪些）
    coupons: [
        {
            id: 'c1',
            name: '新人专享券',
            threshold: 0,
            discount: 5,
            label: '新人5元券',
            stackable: false  // 不可与其他券叠加
        },
        {
            id: 'c2',
            name: '满减叠加券',
            threshold: 40,
            discount: 3,
            label: '满40减3元',
            stackable: true  // 可叠加
        },
        {
            id: 'c3',
            name: '品类优惠券',
            threshold: 20,
            discount: 2,
            label: '饮品减2元',
            stackable: true,
            category: 'drink'  // 仅限饮品
        }
    ],
    
    // 配送费规则
    delivery: {
        baseFee: 5.00,
        freeThreshold: 40,
        label: '配送费5元，满40免配送费',
        peakHours: {
            // 高峰期配送费加价
            enabled: true,
            extraFee: 2.00,
            timeRanges: [
                { start: '11:00', end: '13:00' },
                { start: '17:00', end: '19:00' }
            ]
        }
    },
    
    // 限时折扣
    flashSales: [
        {
            productId: 'r2',
            originalPrice: 6.00,
            salePrice: 4.00,
            endTime: Date.now() + 30 * 60 * 1000,
            label: '限时特惠'
        },
        {
            productId: 'r5',
            originalPrice: 4.00,
            salePrice: 2.50,
            endTime: Date.now() + 15 * 60 * 1000,
            label: '闪购'
        }
    ]
};

// 用户历史数据（用于数据看板）
const USER_HISTORY = {
    totalOrders: 47,
    totalSaved: 156.80,
    averageSaving: 3.34,
    adoptionRate: 0.73,  // 73%的净省建议被采纳
    recentOrders: [
        {
            date: '2026-10-20',
            saved: 3.00,
            adopted: true,
            items: ['米饭']
        },
        {
            date: '2026-10-19',
            saved: 2.50,
            adopted: true,
            items: ['卤蛋']
        },
        {
            date: '2026-10-18',
            saved: 0,
            adopted: false,
            items: []
        },
        {
            date: '2026-10-17',
            saved: 4.00,
            adopted: true,
            items: ['凉拌黄瓜', '酸梅汤']
        }
    ]
};

// 算法性能指标
const ALGORITHM_METRICS = {
    avgCalcTime: 0.8,  // 平均计算耗时(ms)
    p99CalcTime: 2.3,  // P99计算耗时(ms)
    accuracy: 0.983,   // 准确率
    totalCalculations: 1247,  // 今日总计算次数
    successfulSuggestions: 892,  // 成功推荐次数
    adoptionRate: 0.73  // 用户采纳率
};

const INITIAL_CART = {
    items: PRODUCTS.inCart.map(item => ({
        ...item,
        inCart: true
    })),
    recommend: PRODUCTS.recommend.map(item => ({
        ...item,
        inCart: false
    }))
};

// 获取商品实际价格（考虑限时折扣）
function getActualPrice(item) {
    if (item.flashSale && item.flashSale.endTime > Date.now()) {
        return item.flashSale.salePrice;
    }
    return item.price;
}

// 计算购物车商品总价（考虑限时折扣）
function getCartSubtotal(items) {
    return items.reduce((sum, item) => {
        if (item.inCart) {
            const actualPrice = getActualPrice(item);
            return sum + actualPrice * item.quantity;
        }
        return sum;
    }, 0);
}

// 计算配送费（考虑高峰期加价）
function calcDeliveryFee(subtotal) {
    let fee = 0;
    
    if (subtotal < PROMOTIONS.delivery.freeThreshold) {
        fee = PROMOTIONS.delivery.baseFee;
    }
    
    // 检查是否在高峰期
    if (PROMOTIONS.delivery.peakHours.enabled) {
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        
        for (const range of PROMOTIONS.delivery.peakHours.timeRanges) {
            if (currentTime >= range.start && currentTime <= range.end) {
                fee += PROMOTIONS.delivery.peakHours.extraFee;
                break;
            }
        }
    }
    
    return fee;
}

// 计算满减优惠
function calcFullReduction(subtotal) {
    for (const rule of PROMOTIONS.fullReduction) {
        if (subtotal >= rule.threshold) {
            return {
                discount: rule.discount,
                label: rule.label
            };
        }
    }
    return { discount: 0, label: '暂无满减' };
}

// 计算最优优惠券组合
function calcOptimalCoupons(subtotal, items) {
    const availableCoupons = PROMOTIONS.coupons.filter(coupon => {
        if (subtotal < coupon.threshold) return false;
        if (coupon.category) {
            // 检查是否有对应品类的商品
            const hasCategory = items.some(item => 
                item.inCart && item.category === coupon.category
            );
            if (!hasCategory) return false;
        }
        return true;
    });
    
    // 简单策略：选择折扣最大的可叠加组合
    let totalDiscount = 0;
    let usedLabels = [];
    let hasNonStackable = false;
    
    for (const coupon of availableCoupons) {
        if (!coupon.stackable && hasNonStackable) continue;
        
        totalDiscount += coupon.discount;
        usedLabels.push(coupon.label);
        
        if (!coupon.stackable) {
            hasNonStackable = true;
        }
    }
    
    return {
        discount: totalDiscount,
        label: usedLabels.join(' + ') || '暂无优惠券'
    };
}

// 完整的价格计算（增强版）
function calcPriceBreakdown(items) {
    const subtotal = getCartSubtotal(items);
    const deliveryFee = calcDeliveryFee(subtotal);
    const fullReduction = calcFullReduction(subtotal);
    const coupon = calcOptimalCoupons(subtotal, items);
    
    const total = subtotal + deliveryFee - fullReduction.discount - coupon.discount;
    
    return {
        subtotal: subtotal.toFixed(2),
        deliveryFee: deliveryFee.toFixed(2),
        fullReduction: fullReduction.discount.toFixed(2),
        fullReductionLabel: fullReduction.label,
        coupon: coupon.discount.toFixed(2),
        couponLabel: coupon.label,
        total: total.toFixed(2)
    };
}

// 获取限时折扣倒计时
function getFlashSaleCountdown(item) {
    if (!item.flashSale || item.flashSale.endTime <= Date.now()) {
        return null;
    }
    
    const remaining = item.flashSale.endTime - Date.now();
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
