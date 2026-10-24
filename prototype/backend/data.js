/**
 * 模拟数据 - 商品、优惠规则、用户历史
 */

const PRODUCTS = {
    recommend: [
        {
            id: 'r1',
            name: '卤蛋',
            desc: '秘制卤味，Q弹入味',
            price: 3.00,
            emoji: '🥚',
            category: '小食',
            stock: 10,
            flashSale: null
        },
        {
            id: 'r2',
            name: '凉拌黄瓜',
            desc: '清爽爽口，开胃小菜',
            price: 6.00,
            emoji: '🥒',
            category: '小食',
            stock: 5,
            flashSale: {
                originalPrice: 6.00,
                salePrice: 4.00,
                endTime: Date.now() + 30 * 60 * 1000,
                label: '限时特惠'
            }
        },
        {
            id: 'r3',
            name: '酸梅汤',
            desc: '传统酸梅汤，冰镇',
            price: 5.00,
            emoji: '🧃',
            category: '饮品',
            stock: 8,
            flashSale: null
        },
        {
            id: 'r4',
            name: '米饭',
            desc: '东北大米，香甜软糯',
            price: 2.00,
            emoji: '🍚',
            category: '主食',
            stock: 20,
            flashSale: null
        },
        {
            id: 'r5',
            name: '可乐',
            desc: '冰镇可乐，330ml',
            price: 4.00,
            emoji: '🥤',
            category: '饮品',
            stock: 3,
            flashSale: {
                originalPrice: 4.00,
                salePrice: 2.50,
                endTime: Date.now() + 15 * 60 * 1000,
                label: '闪购'
            }
        }
    ]
};

PRODUCTS.recommend.forEach(item => { item.packagingFee = 0; });

const PROMOTIONS = {
    minimumOrder: 25,
    fullReduction: [
        { threshold: 80, discount: 20, label: '满80减20' },
        { threshold: 50, discount: 10, label: '满50减10' },
        { threshold: 30, discount: 5, label: '满30减5' }
    ],
    coupons: [
        {
            id: 'c1',
            name: '新人专享券',
            threshold: 0,
            discount: 5,
            label: '新人5元券',
            stackable: false
        },
        {
            id: 'c2',
            name: '满减叠加券',
            threshold: 40,
            discount: 3,
            label: '满40减3元',
            stackable: true
        }
    ],
    delivery: {
        baseFee: 5.00,
        freeThreshold: 40,
        label: '配送费5元，满40免配送费',
        peakHours: {
            enabled: true,
            extraFee: 2.00,
            timeRanges: [
                { start: '11:00', end: '13:00' },
                { start: '17:00', end: '19:00' }
            ]
        }
    }
};

const USER_HISTORY = {
    totalOrders: 47,
    totalSaved: 156.80,
    averageSaving: 3.34,
    adoptionRate: 0.73,
    recentOrders: [
        { date: '2026-10-20', saved: 3.00, adopted: true, items: ['米饭'] },
        { date: '2026-10-19', saved: 2.50, adopted: true, items: ['卤蛋'] },
        { date: '2026-10-18', saved: 0, adopted: false, items: [] },
        { date: '2026-10-17', saved: 4.00, adopted: true, items: ['凉拌黄瓜', '酸梅汤'] }
    ]
};

const ALGORITHM_METRICS = {
    avgCalcTime: 0.8,
    p99CalcTime: 2.3,
    accuracy: 0.983,
    totalCalculations: 1247,
    successfulSuggestions: 892,
    adoptionRate: 0.73
};

module.exports = {
    PRODUCTS,
    PROMOTIONS,
    USER_HISTORY,
    ALGORITHM_METRICS
};
