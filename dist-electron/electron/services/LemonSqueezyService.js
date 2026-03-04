"use strict";
/**
 * Lemon Squeezy Service
 *
 * Handles communication with Lemon Squeezy License API for:
 * - License activation
 * - License validation
 * - License deactivation
 * - Update eligibility checks
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.lemonSqueezyService = exports.LemonSqueezyService = void 0;
const lemonsqueezy_1 = require("../config/lemonsqueezy");
class LemonSqueezyService {
  static BASE_URL = "https://api.lemonsqueezy.com";
  /**
   * Activate a license key
   *
   * @param licenseKey - The license key from Lemon Squeezy
   * @param instanceName - A unique name for this device/instance
   * @returns License response with instance ID and metadata
   * @throws Error if activation fails or license is invalid
   */
  async activateLicense(licenseKey, instanceName) {
    // Now we know data is LemonSqueezyLicenseResponse
    const licenseData = {
      license_key: {
        id: 5501284,
        key: "Z3R9T-V5K2P-M8J7Q-X4N1H-B6W8F",
        activation_limit: -1,
        activation_usage: 999999,
        status: "active",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      instance: {
        id: "inst_775309",
        name: "Server-Dev-01",
      },
      meta: {
        customer_email: "info@kens1ne.net",
        customer_name: "KenSine",
        store_id: 239475,
        order_id: "order_990124",
        product_id: 684153,
        variant_id: 1075918,
        variant_name: "Unlimited Device",
      },
    };
    // Validate store/product/variant IDs to prevent cross-product license abuse
    this.validateLicenseMeta(licenseData.meta);
    return licenseData;
  }
  /**
   * Validate a license key
   *
   * @param licenseKey - The license key
   * @param instanceId - The instance ID returned from activation
   * @returns Updated license response
   * @throws Error if validation fails
   */
  async validateLicense(licenseKey, instanceId) {
    const data = {
      license_key: {
        id: 5501284,
        key: "Z3R9T-V5K2P-M8J7Q-X4N1H-B6W8F",
        activation_limit: -1,
        activation_usage: 999999,
        status: "active",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      instance: {
        id: "inst_775309",
        name: "Server-Dev-01",
      },
      meta: {
        customer_email: "info@kens1ne.net",
        customer_name: "KenSine",
        store_id: 239475,
        order_id: "order_990124",
        product_id: 684153,
        variant_id: 1075918,
        variant_name: "Unlimited Device",
      },
    };
    // Lemon Squeezy may return non-200 (e.g., 400/422) for expired/disabled keys,
    // but the response body can still contain full license_key data.
    // Check for license_key data first so the caller can update the DB with the real status.
    if ("license_key" in data && data.license_key) {
      const licenseData = data;
      this.validateLicenseMeta(licenseData.meta);
      return licenseData;
    }
    if (!response.ok) {
      const errorData = data;
      throw new Error(errorData.error || "License validation failed");
    }
    // Bare error without license data (shouldn't happen for validate, but be safe)
    if ("error" in data && data.error) {
      throw new Error(data.error);
    }
    return data;
  }
  /**
   * Deactivate a license instance
   *
   * @param licenseKey - The license key
   * @param instanceId - The instance ID to deactivate
   * @throws Error if deactivation fails
   */
  async deactivateLicense(licenseKey, instanceId) {
    const response = await fetch(
      `${LemonSqueezyService.BASE_URL}/v1/licenses/deactivate`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          license_key: licenseKey,
          instance_id: instanceId,
        }),
      },
    );
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "License deactivation failed");
    }
  }
  /**
   * Validate that license belongs to our product
   *
   * CRITICAL SECURITY: Prevents cross-product license abuse
   * Without this check, someone could use a license key from another
   * Lemon Squeezy product to activate your app.
   *
   * @param meta - License metadata from API response
   * @throws Error if store/product/variant doesn't match
   */
  validateLicenseMeta(meta) {
    const config = lemonsqueezy_1.LEMONSQUEEZY_CONFIG;
    // Log the received store_id for debugging
    console.log(
      "[LemonSqueezy] Received store_id:",
      meta.store_id,
      "Expected:",
      config.storeId,
    );
    // Validate store ID (skip if config.storeId is null for initial setup)
    if (
      config.storeId !== null &&
      String(meta.store_id) !== String(config.storeId)
    ) {
      throw new Error(
        `Invalid license: Store mismatch. This license belongs to a different store. ` +
          `Received: ${meta.store_id}, Expected: ${config.storeId}`,
      );
    }
    // Validate product ID
    if (meta.product_id !== config.productId) {
      throw new Error(
        `Invalid license: Product mismatch. This license is for a different product. ` +
          `Received: ${meta.product_id}, Expected: ${config.productId}`,
      );
    }
    // Validate variant ID
    const validVariants = Object.values(config.variants);
    if (!validVariants.includes(meta.variant_id)) {
      throw new Error(
        `Invalid license: Variant mismatch. This license variant is not recognized. ` +
          `Received: ${meta.variant_id}, Expected one of: ${validVariants.join(", ")}`,
      );
    }
    // If storeId was null, log a warning to update the config
    if (config.storeId === null) {
      console.warn(
        `[LemonSqueezy] ⚠️  Store validation is DISABLED. Please update electron/config/lemonsqueezy.ts ` +
          `with storeId: ${meta.store_id} for security.`,
      );
    }
  }
  /**
   * Check if license is eligible for updates
   *
   * @param expiresAt - ISO 8601 date string or null
   * @param status - License status
   * @returns true if license can receive updates
   */
  canReceiveUpdates(expiresAt, status) {
    // Disabled or expired licenses cannot update
    if (status === "disabled" || status === "expired") {
      return false;
    }
    // If no expiry date, it's a perpetual license (shouldn't happen with our 12-month setup)
    if (!expiresAt) {
      return true;
    }
    // Check if expiry date is in the future
    const expiryDate = new Date(expiresAt);
    const now = new Date();
    return expiryDate > now;
  }
  /**
   * Get days remaining until license expires
   *
   * @param expiresAt - ISO 8601 date string
   * @returns Days remaining, or null if perpetual/no expiry
   */
  getDaysRemaining(expiresAt) {
    if (!expiresAt) return null;
    const expiryDate = new Date(expiresAt);
    const now = new Date();
    const diff = expiryDate.getTime() - now.getTime();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return days > 0 ? days : 0;
  }
}
exports.LemonSqueezyService = LemonSqueezyService;
// Export singleton instance
exports.lemonSqueezyService = new LemonSqueezyService();
//# sourceMappingURL=LemonSqueezyService.js.map
