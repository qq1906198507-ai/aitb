// 模拟数据 - 外卖场景

// 商品库
const PRODUCTS = {
    // 购物车内商品
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
    
    // 可推荐加购商品
    recommend: [
        {
            id: 'r1',
            name: '卤蛋',
            desc: '秘制卤味，Q弹入味',
            price: 3.00,
            emoji: '🥚'
        },
        {
            id: 'r2',
            name: '凉拌黄瓜',
            desc: '清爽爽口，开胃小菜',
            price: 6.00,
            emoji: '🥒'
        },
        {
            id: 'r3',
            name: '酸梅汤',
            desc: '传统酸梅汤，冰镇',
            price: 5.00,
            emoji: '🧃'
        },
        {
            id: 'r4',
            name: '米饭',
            desc: '东北大米，香甜软糯',
            price: 2.00,
            emoji: '🍚'
        }
    ]
};

// 优惠规则
const PROMOTIONS = {
    // 满减规则（按门槛从高到低排序）
    fullReduction: [
        { threshold: 80, discount: 20, label: '满80减20' },
        { threshold: 50, discount: 10, label: '满50减10' },
        { threshold: 30, discount: 5, label: '满30减5' }
    ],
    
    // 优惠券
    coupons: [
        {
            id: 'c1',
            name: '新人专享券',
            threshold: 0,  // 0表示无门槛
            discount: 5,
            label: '新人5元券'
        }
    ],
    
    // 配送费规则
    delivery: {
        baseFee: 5.00,
        freeThreshold: 40,  // 满40免配送费
        label: '配送费5元，满40免配送费'
    }
};

// 初始购物车状态
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

// 计算当前购物车商品总价
function getCartSubtotal(items) {
    return items.reduce((sum, item) => {
        if (item.inCart) {
            return sum + item.price * item.quantity;
        }
        return sum;
    }, 0);
}

// 计算配送费
function calcDeliveryFee(subtotal) {
    if (subtotal >= PROMOTIONS.delivery.freeThreshold) {
        return 0;
    }
    return PROMOTIONS.delivery.baseFee;
}

// 计算满减优惠（返回最优匹配的满减）
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

// 计算优惠券
function calcCoupon(subtotal) {
    for (const coupon of PROMOTIONS.coupons) {
        if (subtotal >= coupon.threshold) {
            return {
                discount: coupon.discount,
                label: coupon.label
            };
        }
    }
    return { discount: 0, label: '暂无优惠券' };
}

// 完整的价格计算
function calcPriceBreakdown(items) {
    if (!items.some(item => item.inCart && item.quantity > 0)) {
        return { subtotal: '0.00', deliveryFee: '0.00', fullReduction: '0.00', fullReductionLabel: '暂无满减', coupon: '0.00', couponLabel: '暂无优惠券', total: '0.00' };
    }
    const subtotal = getCartSubtotal(items);
    const deliveryFee = calcDeliveryFee(subtotal);
    const fullReduction = calcFullReduction(subtotal);
    const coupon = calcCoupon(subtotal);
    
    const total = Math.max(0, subtotal + deliveryFee - fullReduction.discount - coupon.discount);
    
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
