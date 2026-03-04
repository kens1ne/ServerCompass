"use strict";
/**
 * Lemon Squeezy Configuration
 *
 * Store and product IDs for license validation and checkout
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEMONSQUEEZY_CONFIG = void 0;
exports.LEMONSQUEEZY_CONFIG = {
    // Store ID - IMPORTANT: This must be the numeric store ID from Lemon Squeezy, not the slug
    // You can find this in your Lemon Squeezy dashboard URL or in API responses
    // TEMPORARILY DISABLED for testing - set to actual numeric ID after activation test
    storeId: 239475, // TODO: Replace with actual store ID (e.g., 12345)
    // Product ID
    productId: 684153,
    // Variant IDs for each pricing tier
    variants: {
        singleDevice: 1075918,
        threeDevices: 1075921,
        fiveDevices: 1075925,
    },
    // Checkout URLs - Update these after getting them from Lemon Squeezy dashboard
    // Go to Products → ServerCompass Desktop License → Click Share button on each variant
    checkoutUrls: {
        singleDevice: 'https://stoicsoft.lemonsqueezy.com/buy/731a1a6c-cafe-42d4-af90-c7e88ae2b08c',
        threeDevices: 'https://stoicsoft.lemonsqueezy.com/buy/35e5e4f1-db25-4d0b-8c40-42d26073531e',
        fiveDevices: 'https://stoicsoft.lemonsqueezy.com/buy/9b3489e7-3267-4f0b-b875-9c302840cede',
    },
    // API Configuration
    api: {
        baseUrl: 'https://api.lemonsqueezy.com',
        rateLimit: 60, // requests per minute
    },
};
//# sourceMappingURL=lemonsqueezy.js.map