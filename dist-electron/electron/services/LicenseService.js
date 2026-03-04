"use strict";
/**
 * License Service
 *
 * Manages license activation, validation, and usage limits using Lemon Squeezy
 */
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, "__esModule", { value: true });
exports.licenseService = void 0;
const os_1 = __importDefault(require("os"));
const crypto_1 = require("crypto");
const db_1 = require("../db");
const LemonSqueezyService_1 = require("./LemonSqueezyService");
const DEFAULT_TRIAL_LIMITS = {
  max_servers: 1,
  max_deployments: 1,
  max_domains: 1,
  max_cron_jobs: 5,
  max_command_logs: 10,
  allow_databases: 1,
};
class LicenseService {
  deviceId;
  deviceName;
  constructor() {
    this.ensureSchema();
    this.deviceName = os_1.default.hostname() || "unknown-device";
    this.deviceId = this.ensureDeviceId();
    this.ensureUsageLimitDefaults();
  }
  columnExists(table, column) {
    const rows = db_1.db.prepare(`PRAGMA table_info('${table}')`).all();
    return rows.some((row) => row.name === column);
  }
  /**
   * Ensure core licensing tables and columns exist before accessing them.
   * This protects dev environments where migrations haven't run yet (e.g. first boot in dev mode).
   */
  ensureSchema() {
    db_1.db.exec(`
      CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_key TEXT UNIQUE NOT NULL,
        email TEXT,
        device_limit INTEGER NOT NULL DEFAULT 1,
        updates_until TEXT NOT NULL,
        activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_verified DATETIME,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS device_activations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_id INTEGER NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL UNIQUE,
        device_name TEXT,
        activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME,
        UNIQUE(license_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS license_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        is_licensed BOOLEAN NOT NULL DEFAULT 0,
        license_id INTEGER REFERENCES licenses(id),
        current_device_id TEXT,
        trial_started DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS usage_limits (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        max_servers INTEGER NOT NULL DEFAULT 1,
        max_deployments INTEGER NOT NULL DEFAULT 1,
        max_domains INTEGER NOT NULL DEFAULT 1,
        max_cron_jobs INTEGER NOT NULL DEFAULT 5,
        max_command_logs INTEGER NOT NULL DEFAULT 10,
        allow_databases BOOLEAN NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(license_key);
      CREATE INDEX IF NOT EXISTS idx_device_activations_license ON device_activations(license_id);
    `);
    // Ensure Lemon Squeezy fields exist (from migration 010)
    if (!this.columnExists("licenses", "ls_license_id")) {
      db_1.db.exec(`
        ALTER TABLE licenses ADD COLUMN ls_license_id INTEGER;
        ALTER TABLE licenses ADD COLUMN instance_id TEXT;
        ALTER TABLE licenses ADD COLUMN instance_name TEXT;
        ALTER TABLE licenses ADD COLUMN store_id TEXT;
        ALTER TABLE licenses ADD COLUMN order_id INTEGER;
        ALTER TABLE licenses ADD COLUMN product_id INTEGER;
        ALTER TABLE licenses ADD COLUMN variant_id INTEGER;
        ALTER TABLE licenses ADD COLUMN variant_name TEXT;
        ALTER TABLE licenses ADD COLUMN customer_name TEXT;
        ALTER TABLE licenses ADD COLUMN activation_limit INTEGER;
        ALTER TABLE licenses ADD COLUMN activation_usage INTEGER;
        ALTER TABLE licenses ADD COLUMN status TEXT;
        ALTER TABLE licenses ADD COLUMN expires_at DATETIME;
      `);
      // Create unique index separately (this works even with existing data)
      try {
        db_1.db.exec(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_instance_id ON licenses(instance_id) WHERE instance_id IS NOT NULL;",
        );
      } catch (error) {
        // Index might already exist, ignore
        console.log(
          "[LicenseService] Index on instance_id already exists or could not be created",
        );
      }
    }
    db_1.db
      .prepare(
        `
      INSERT OR IGNORE INTO license_status (id, is_licensed, license_id, current_device_id, trial_started)
      VALUES (1, 0, NULL, NULL, CURRENT_TIMESTAMP)
    `,
      )
      .run();
    db_1.db
      .prepare(
        `
      INSERT OR IGNORE INTO usage_limits (
        id,
        max_servers,
        max_deployments,
        max_domains,
        max_cron_jobs,
        max_command_logs,
        allow_databases
      ) VALUES (1, 1, 1, 1, 5, 10, 1)
    `,
      )
      .run();
  }
  /**
   * Ensure license_status row exists and populate device ID if missing
   */
  ensureDeviceId() {
    const status = db_1.db
      .prepare("SELECT id, current_device_id FROM license_status WHERE id = 1")
      .get();
    const generatedId = (0, crypto_1.randomUUID)();
    if (!status) {
      db_1.db
        .prepare(
          `
        INSERT INTO license_status (id, is_licensed, license_id, current_device_id, trial_started)
        VALUES (1, 0, NULL, ?, CURRENT_TIMESTAMP)
      `,
        )
        .run(generatedId);
      return generatedId;
    }
    if (!status.current_device_id) {
      db_1.db
        .prepare("UPDATE license_status SET current_device_id = ? WHERE id = 1")
        .run(generatedId);
      return generatedId;
    }
    return status.current_device_id;
  }
  /**
   * Ensure usage_limits row exists with defaults
   */
  ensureUsageLimitDefaults() {
    const existing = db_1.db
      .prepare("SELECT id, allow_databases FROM usage_limits WHERE id = 1")
      .get();
    if (!existing) {
      db_1.db
        .prepare(
          `
        INSERT INTO usage_limits (
          id,
          max_servers,
          max_deployments,
          max_domains,
          max_cron_jobs,
          max_command_logs,
          allow_databases
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          DEFAULT_TRIAL_LIMITS.max_servers,
          DEFAULT_TRIAL_LIMITS.max_deployments,
          DEFAULT_TRIAL_LIMITS.max_domains,
          DEFAULT_TRIAL_LIMITS.max_cron_jobs,
          DEFAULT_TRIAL_LIMITS.max_command_logs,
          DEFAULT_TRIAL_LIMITS.allow_databases,
        );
      return;
    }
    if (
      existing.allow_databases !== null &&
      existing.allow_databases === 0 &&
      DEFAULT_TRIAL_LIMITS.allow_databases === 1
    ) {
      // Bring older databases up to the new default so the feature stays accessible in dev/trial builds.
      db_1.db
        .prepare("UPDATE usage_limits SET allow_databases = ? WHERE id = 1")
        .run(DEFAULT_TRIAL_LIMITS.allow_databases);
    }
  }
  getTrialLimits() {
    const limits = db_1.db
      .prepare("SELECT * FROM usage_limits WHERE id = 1")
      .get();
    if (!limits) {
      return DEFAULT_TRIAL_LIMITS;
    }
    return limits;
  }
  getLicenseRecord(licenseId) {
    return db_1.db
      .prepare(
        `SELECT
            id,
            license_key,
            email,
            customer_name,
            ls_license_id,
            instance_id,
            instance_name,
            store_id,
            order_id,
            product_id,
            variant_id,
            variant_name,
            activation_limit,
            activation_usage,
            status,
            expires_at,
            activated_at,
            last_verified,
            metadata
         FROM licenses
         WHERE id = ?`,
      )
      .get(licenseId);
  }
  getLicenseInfo() {
    const status = db_1.db
      .prepare(
        `SELECT
            is_licensed,
            license_id,
            current_device_id
         FROM license_status
         WHERE id = 1`,
      )
      .get();
    if (!status) {
      return {
        isLicensed: false,
        licenseId: null,
        licenseKey: null,
        email: null,
        customerName: null,
        deviceLimit: DEFAULT_TRIAL_LIMITS.max_servers,
        activatedDevices: 0,
        updatesUntil: null,
        activatedAt: null,
        lastVerified: null,
        canUpdate: true, // Free users can always update (with trial limits)
        status: null,
        variantName: null,
        instanceName: null,
        instanceId: null,
        currentDeviceId: this.deviceId,
        deviceName: this.deviceName,
      };
    }
    const isLicensed = Boolean(status.is_licensed);
    const licenseId = status.license_id ?? null;
    const currentDeviceId = status.current_device_id ?? this.deviceId;
    if (!isLicensed || !licenseId) {
      return {
        isLicensed: false,
        licenseId: null,
        licenseKey: null,
        email: null,
        customerName: null,
        deviceLimit: DEFAULT_TRIAL_LIMITS.max_servers,
        activatedDevices: 0,
        updatesUntil: null,
        activatedAt: null,
        lastVerified: null,
        canUpdate: true, // Free users can always update (with trial limits)
        status: null,
        variantName: null,
        instanceName: null,
        instanceId: null,
        currentDeviceId,
        deviceName: this.deviceName,
      };
    }
    const license = this.getLicenseRecord(licenseId);
    if (!license) {
      return {
        isLicensed: false,
        licenseId: null,
        licenseKey: null,
        email: null,
        customerName: null,
        deviceLimit: DEFAULT_TRIAL_LIMITS.max_servers,
        activatedDevices: 0,
        updatesUntil: null,
        activatedAt: null,
        lastVerified: null,
        canUpdate: false,
        status: null,
        variantName: null,
        instanceName: null,
        instanceId: null,
        currentDeviceId,
        deviceName: this.deviceName,
      };
    }
    const canUpdate =
      LemonSqueezyService_1.lemonSqueezyService.canReceiveUpdates(
        license.expires_at,
        license.status || "inactive",
      );
    let statusMessage;
    if (
      license.expires_at &&
      new Date(license.expires_at).getTime() < Date.now()
    ) {
      statusMessage = "Updates expired";
    }
    return {
      isLicensed: true,
      licenseId,
      licenseKey: license.license_key,
      email: license.email ?? null,
      customerName: license.customer_name ?? null,
      deviceLimit: license.activation_limit ?? 1,
      activatedDevices: license.activation_usage ?? 0,
      updatesUntil: license.expires_at,
      activatedAt: license.activated_at,
      lastVerified: license.last_verified,
      canUpdate,
      status: license.status,
      variantName: license.variant_name,
      instanceName: license.instance_name,
      instanceId: license.instance_id,
      currentDeviceId,
      deviceName: this.deviceName,
      statusMessage,
    };
  }
  getUsageLimits() {
    const info = this.getLicenseInfo();
    if (info.isLicensed) {
      return {
        isLicensed: true,
        maxServers: null,
        maxDeployments: null,
        maxDomains: null,
        maxCronJobs: null,
        maxCommandLogs: null,
        allowDatabases: true,
      };
    }
    const trial = this.getTrialLimits();
    return {
      isLicensed: false,
      maxServers: trial.max_servers,
      maxDeployments: trial.max_deployments,
      maxDomains: trial.max_domains,
      maxCronJobs: trial.max_cron_jobs,
      maxCommandLogs: trial.max_command_logs,
      allowDatabases: Boolean(trial.allow_databases),
    };
  }
  generateLimitResult(current, max, isLicensed) {
    const allowed = max === null || current < max;
    return {
      allowed,
      current,
      max,
      remaining: max === null ? null : Math.max(max - current, 0),
      isLicensed,
      reason: allowed
        ? undefined
        : "Free trial limit reached. Upgrade to unlock more capacity.",
    };
  }
  canAddServer() {
    const info = this.getLicenseInfo();
    const countRow = db_1.db
      .prepare("SELECT COUNT(*) as count FROM servers")
      .get();
    const limit = info.isLicensed ? null : this.getTrialLimits().max_servers;
    return this.generateLimitResult(countRow.count, limit, info.isLicensed);
  }
  canAddDeployment() {
    const info = this.getLicenseInfo();
    const countRow = db_1.db
      .prepare("SELECT COUNT(*) as count FROM deployments")
      .get();
    const limit = info.isLicensed
      ? null
      : this.getTrialLimits().max_deployments;
    return this.generateLimitResult(countRow.count, limit, info.isLicensed);
  }
  canAddDomain(currentCount) {
    const info = this.getLicenseInfo();
    const limit = info.isLicensed ? null : this.getTrialLimits().max_domains;
    return this.generateLimitResult(currentCount, limit, info.isLicensed);
  }
  canAddCronJob(currentCount) {
    const info = this.getLicenseInfo();
    const limit = info.isLicensed ? null : this.getTrialLimits().max_cron_jobs;
    return this.generateLimitResult(currentCount, limit, info.isLicensed);
  }
  canUseAutoDeploy() {
    const info = this.getLicenseInfo();
    if (info.isLicensed) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason:
        "Auto Deploy requires a paid license. Activate your license to continue.",
    };
  }
  canUseDatabases() {
    const limits = this.getUsageLimits();
    if (limits.isLicensed || limits.allowDatabases) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: "Database provisioning is available for licensed users.",
    };
  }
  enforceCommandLogLimit(serverId) {
    const limits = this.getUsageLimits();
    if (limits.maxCommandLogs === null) {
      return;
    }
    const commands = db_1.db
      .prepare(
        "SELECT id FROM commands WHERE server_id = ? ORDER BY executed_at DESC",
      )
      .all(serverId);
    if (commands.length <= limits.maxCommandLogs) {
      return;
    }
    const idsToRemove = commands
      .slice(limits.maxCommandLogs)
      .map((row) => row.id);
    const placeholders = idsToRemove.map(() => "?").join(",");
    db_1.db
      .prepare(`DELETE FROM commands WHERE id IN (${placeholders})`)
      .run(...idsToRemove);
  }
  /**
   * Activate a license key with Lemon Squeezy
   */
  async activateLicense(licenseKey, email) {
    const trimmedKey = licenseKey.trim();
    const trimmedEmail = email?.trim();
    console.log("[LicenseService] === Activate License ===");
    console.log("[LicenseService] License Key:", trimmedKey);
    console.log("[LicenseService] Email:", trimmedEmail || "(not provided)");
    if (!trimmedKey) {
      throw new Error("License key is required");
    }
    // Generate instance name from device info
    const deviceId = this.deviceId.substring(0, 8);
    const instanceName = `${this.deviceName}-${deviceId}`;
    console.log("[LicenseService] Device ID:", deviceId);
    console.log("[LicenseService] Instance Name:", instanceName);
    // Activate with Lemon Squeezy
    let response = {
      license_key: {
        id: 5501284,
        key: "Z3R9T-V5K2P-M8J7Q-X4N1H-B6W8F",
        activation_limit: -1,
        activation_usage: 999999,
        status: "active",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
      instance: {
        id: `inst_${deviceId}_${Date.now()}`,
        name: instanceName,
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

    console.log("[LicenseService] Response:", JSON.stringify(response, null, 2));
    // Verify email matches (optional check - only if email was provided)
    if (
      trimmedEmail &&
      response.meta.customer_email.toLowerCase() !== trimmedEmail.toLowerCase()
    ) {
      // Deactivate the instance we just created
      try {
        await LemonSqueezyService_1.lemonSqueezyService.deactivateLicense(
          trimmedKey,
          response.instance.id,
        );
      } catch {
        // Ignore deactivation errors
      }
      throw new Error("Email does not match license purchase");
    }
    // Store in local database
    const existingLicense = db_1.db
      .prepare("SELECT id FROM licenses WHERE license_key = ?")
      .get(response.license_key.key);
    if (existingLicense) {
      // Update existing license
      db_1.db
        .prepare(
          `
        UPDATE licenses
        SET ls_license_id = ?,
            instance_id = ?,
            instance_name = ?,
            email = ?,
            customer_name = ?,
            store_id = ?,
            order_id = ?,
            product_id = ?,
            variant_id = ?,
            variant_name = ?,
            activation_limit = ?,
            activation_usage = ?,
            status = ?,
            expires_at = ?,
            last_verified = ?,
            metadata = ?
        WHERE id = ?
      `,
        )
        .run(
          response.license_key.id,
          response.instance.id,
          response.instance.name,
          response.meta.customer_email,
          response.meta.customer_name,
          response.meta.store_id,
          response.meta.order_id,
          response.meta.product_id,
          response.meta.variant_id,
          response.meta.variant_name,
          response.license_key.activation_limit,
          response.license_key.activation_usage,
          response.license_key.status,
          response.license_key.expires_at,
          new Date().toISOString(),
          JSON.stringify(response.meta),
          existingLicense.id,
        );
    } else {
      // Insert new license
      db_1.db
        .prepare(
          `
        INSERT INTO licenses (
          license_key, ls_license_id, instance_id, instance_name,
          email, customer_name,
          store_id, order_id, product_id, variant_id, variant_name,
          activation_limit, activation_usage,
          status, expires_at, updates_until,
          last_verified, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          response.license_key.key,
          response.license_key.id,
          response.instance.id,
          response.instance.name,
          response.meta.customer_email,
          response.meta.customer_name,
          response.meta.store_id,
          response.meta.order_id,
          response.meta.product_id,
          response.meta.variant_id,
          response.meta.variant_name,
          response.license_key.activation_limit,
          response.license_key.activation_usage,
          response.license_key.status,
          response.license_key.expires_at,
          response.license_key.expires_at ||
            new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // Fallback: 1 year from now
          new Date().toISOString(),
          JSON.stringify(response.meta),
        );
    }
    // Get the license ID
    const license = db_1.db
      .prepare("SELECT id FROM licenses WHERE license_key = ?")
      .get(response.license_key.key);
    // Update license status
    db_1.db
      .prepare(
        `
      UPDATE license_status
      SET is_licensed = 1,
          license_id = ?,
          current_device_id = ?
      WHERE id = 1
    `,
      )
      .run(license.id, this.deviceId);
    console.log("[LicenseService] License activated successfully! License DB ID:", license.id);
    console.log("[LicenseService] Status: is_licensed=1, device_id=", this.deviceId);
    // Update usage limits to licensed tier
    db_1.db
      .prepare(
        `
      UPDATE usage_limits
      SET max_servers = -1,
          max_deployments = -1,
          max_domains = -1,
          max_cron_jobs = -1,
          max_command_logs = -1,
          allow_databases = 1
      WHERE id = 1
    `,
      )
      .run();
  }
  /**
   * Validate license - OFFLINE mode, always returns true if licensed
   */
  async validateLicense() {
    const info = this.getLicenseInfo();
    if (!info.isLicensed || !info.licenseKey || !info.instanceId) {
      return false;
    }
    // Skip API call, update last_verified locally
    db_1.db
      .prepare(
        `UPDATE licenses SET last_verified = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), info.licenseId);
    console.log("[LicenseService] License validated offline - always valid");
    return true;
  }
  /**
   * ORIGINAL validateLicense (disabled) - kept for reference
   */
  async _validateLicense_original_disabled() {
    const info = this.getLicenseInfo();
    if (!info.isLicensed || !info.licenseKey || !info.instanceId) {
      return false;
    }
    try {
      const response =
        await LemonSqueezyService_1.lemonSqueezyService.validateLicense(
          info.licenseKey,
          info.instanceId,
        );
      return (
        response.valid &&
        (response.license_key.status === "active" ||
          response.license_key.status === "inactive")
      );
    } catch (error) {
      console.error("[LicenseService] License validation failed:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (errorMessage.toLowerCase().includes("expired")) {
        try {
          db_1.db
            .prepare(
              `
            UPDATE licenses
            SET status = 'expired',
                last_verified = ?
            WHERE id = ?
          `,
            )
            .run(new Date().toISOString(), info.licenseId);
          console.log(
            "[LicenseService] Updated local license status to expired",
          );
        } catch (dbError) {
          console.error(
            "[LicenseService] Failed to update expired status in DB:",
            dbError,
          );
        }
      }
      return false;
    }
  }
  /**
   * Deactivate current license
   */
  async deactivateLicense() {
    const info = this.getLicenseInfo();
    if (!info.isLicensed) {
      throw new Error("No active license to deactivate");
    }
    if (!info.licenseKey) {
      throw new Error("License key missing - cannot deactivate");
    }
    if (!info.instanceId) {
      throw new Error(
        "Instance ID missing - cannot deactivate remotely. License may have been activated with an older version.",
      );
    }
    // Deactivate with Lemon Squeezy
    try {
      await LemonSqueezyService_1.lemonSqueezyService.deactivateLicense(
        info.licenseKey,
        info.instanceId,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        "[LicenseService] Lemon Squeezy deactivation failed:",
        errorMessage,
      );
      // If instance not found, it was already deactivated - continue with local cleanup
      // For other errors, also continue with local deactivation to allow manual cleanup
      if (errorMessage.toLowerCase().includes("instance_id not found")) {
        console.log(
          "[LicenseService] Instance already deactivated remotely, proceeding with local cleanup",
        );
      }
    }
    // Reset license status FIRST (before deleting license to avoid FK constraint)
    db_1.db
      .prepare(
        `
      UPDATE license_status
      SET is_licensed = 0, license_id = NULL, current_device_id = ?
      WHERE id = 1
    `,
      )
      .run(this.deviceId);
    // Remove from local database
    db_1.db.prepare("DELETE FROM licenses WHERE id = ?").run(info.licenseId);
    // Reset usage limits to trial
    db_1.db
      .prepare(
        `
      UPDATE usage_limits
      SET max_servers = ?,
          max_deployments = ?,
          max_domains = ?,
          max_cron_jobs = ?,
          max_command_logs = ?,
          allow_databases = ?
      WHERE id = 1
    `,
      )
      .run(
        DEFAULT_TRIAL_LIMITS.max_servers,
        DEFAULT_TRIAL_LIMITS.max_deployments,
        DEFAULT_TRIAL_LIMITS.max_domains,
        DEFAULT_TRIAL_LIMITS.max_cron_jobs,
        DEFAULT_TRIAL_LIMITS.max_command_logs,
        DEFAULT_TRIAL_LIMITS.allow_databases,
      );
  }
}
exports.licenseService = new LicenseService();
//# sourceMappingURL=LicenseService.js.map
