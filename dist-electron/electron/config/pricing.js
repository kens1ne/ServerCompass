"use strict";
/**
 * Centralized Pricing Configuration
 *
 * Update BASE_PRICE to automatically recalculate all pricing tiers
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRICING = exports.PRICING_TIERS = exports.FIVE_DEVICE_SAVINGS = exports.THREE_DEVICE_SAVINGS = exports.FIVE_DEVICE_PRICE = exports.THREE_DEVICE_PRICE = exports.SINGLE_DEVICE_PRICE = exports.DISCOUNT_5_DEVICES = exports.DISCOUNT_3_DEVICES = exports.BASE_PRICE = void 0;
exports.getPricingTier = getPricingTier;
exports.calculatePrice = calculatePrice;
exports.formatPrice = formatPrice;
exports.getDiscountPercentage = getDiscountPercentage;
exports.printPricingSummary = printPricingSummary;
// ============================================
// PRICING CONFIGURATION
// ============================================
/**
 * Base price for a single device license
 * Change this value to update all pricing tiers automatically
 */
exports.BASE_PRICE = 29;
/**
 * Discount percentages for bulk purchases
 */
exports.DISCOUNT_3_DEVICES = 0.10; // 10% off
exports.DISCOUNT_5_DEVICES = 0.20; // 20% off
// ============================================
// CALCULATED PRICES
// ============================================
/**
 * Single device license price
 */
exports.SINGLE_DEVICE_PRICE = exports.BASE_PRICE;
/**
 * 3-device license price (10% discount)
 */
exports.THREE_DEVICE_PRICE = parseFloat(((exports.BASE_PRICE * 3) * (1 - exports.DISCOUNT_3_DEVICES)).toFixed(2));
/**
 * 5-device license price (20% discount)
 */
exports.FIVE_DEVICE_PRICE = parseFloat(((exports.BASE_PRICE * 5) * (1 - exports.DISCOUNT_5_DEVICES)).toFixed(2));
/**
 * Savings for 3-device license
 */
exports.THREE_DEVICE_SAVINGS = parseFloat(((exports.BASE_PRICE * 3) - exports.THREE_DEVICE_PRICE).toFixed(2));
/**
 * Savings for 5-device license
 */
exports.FIVE_DEVICE_SAVINGS = parseFloat(((exports.BASE_PRICE * 5) - exports.FIVE_DEVICE_PRICE).toFixed(2));
exports.PRICING_TIERS = [
    {
        devices: 1,
        price: exports.SINGLE_DEVICE_PRICE,
        pricePerDevice: exports.SINGLE_DEVICE_PRICE,
        discount: 0,
        savings: 0,
        displayPrice: `$${exports.SINGLE_DEVICE_PRICE}`,
        displaySavings: '',
    },
    {
        devices: 3,
        price: exports.THREE_DEVICE_PRICE,
        pricePerDevice: parseFloat((exports.THREE_DEVICE_PRICE / 3).toFixed(2)),
        discount: exports.DISCOUNT_3_DEVICES,
        savings: exports.THREE_DEVICE_SAVINGS,
        displayPrice: `$${exports.THREE_DEVICE_PRICE}`,
        displaySavings: `Save $${exports.THREE_DEVICE_SAVINGS}`,
    },
    {
        devices: 5,
        price: exports.FIVE_DEVICE_PRICE,
        pricePerDevice: parseFloat((exports.FIVE_DEVICE_PRICE / 5).toFixed(2)),
        discount: exports.DISCOUNT_5_DEVICES,
        savings: exports.FIVE_DEVICE_SAVINGS,
        displayPrice: `$${exports.FIVE_DEVICE_PRICE}`,
        displaySavings: `Save $${exports.FIVE_DEVICE_SAVINGS}`,
    },
];
// ============================================
// HELPER FUNCTIONS
// ============================================
/**
 * Get pricing tier by device count
 */
function getPricingTier(devices) {
    return exports.PRICING_TIERS.find(tier => tier.devices === devices);
}
/**
 * Calculate price for any number of devices with discount
 */
function calculatePrice(devices) {
    const tier = getPricingTier(devices);
    if (tier) {
        return tier.price;
    }
    // For custom device counts, use base price without discount
    return exports.BASE_PRICE * devices;
}
/**
 * Format price for display
 */
function formatPrice(price) {
    return `$${price.toFixed(2)}`;
}
/**
 * Get discount percentage for device count
 */
function getDiscountPercentage(devices) {
    const tier = getPricingTier(devices);
    return tier ? tier.discount * 100 : 0;
}
// ============================================
// EXPORT ALL PRICING INFO
// ============================================
exports.PRICING = {
    basePrice: exports.BASE_PRICE,
    tiers: exports.PRICING_TIERS,
    discounts: {
        threeDevices: exports.DISCOUNT_3_DEVICES,
        fiveDevices: exports.DISCOUNT_5_DEVICES,
    },
    prices: {
        single: exports.SINGLE_DEVICE_PRICE,
        three: exports.THREE_DEVICE_PRICE,
        five: exports.FIVE_DEVICE_PRICE,
    },
    savings: {
        three: exports.THREE_DEVICE_SAVINGS,
        five: exports.FIVE_DEVICE_SAVINGS,
    },
    helpers: {
        getTier: getPricingTier,
        calculatePrice,
        formatPrice,
        getDiscountPercentage,
    },
};
// ============================================
// PRICING SUMMARY (for logging/debugging)
// ============================================
function printPricingSummary() {
    console.log('='.repeat(50));
    console.log('SERVERCOMPASS PRICING CONFIGURATION');
    console.log('='.repeat(50));
    console.log(`Base Price: $${exports.BASE_PRICE}`);
    console.log('');
    exports.PRICING_TIERS.forEach(tier => {
        console.log(`${tier.devices} Device${tier.devices > 1 ? 's' : ''}:`);
        console.log(`  Price: ${tier.displayPrice}`);
        console.log(`  Per Device: $${tier.pricePerDevice}`);
        if (tier.discount > 0) {
            console.log(`  Discount: ${(tier.discount * 100).toFixed(0)}% OFF`);
            console.log(`  Savings: $${tier.savings}`);
        }
        console.log('');
    });
    console.log('='.repeat(50));
}
//# sourceMappingURL=pricing.js.map