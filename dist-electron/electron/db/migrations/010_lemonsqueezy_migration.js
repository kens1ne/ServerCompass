"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 010: Lemon Squeezy Integration
 *
 * Adds Lemon Squeezy-specific fields to the licensing system:
 * - Instance-based activation tracking (replaces device_activations table)
 * - Store/Product/Variant metadata for validation
 * - License status tracking
 */
function migrate(db) {
    let columns = db.prepare("PRAGMA table_info('licenses')").all();
    const columnExists = (name) => columns.some(col => col.name === name);
    const refreshColumns = () => {
        columns = db.prepare("PRAGMA table_info('licenses')").all();
    };
    const columnsToEnsure = [
        { name: 'ls_license_id', definition: 'ls_license_id INTEGER' },
        { name: 'instance_id', definition: 'instance_id TEXT' },
        { name: 'instance_name', definition: 'instance_name TEXT' },
        { name: 'store_id', definition: 'store_id TEXT' },
        { name: 'order_id', definition: 'order_id INTEGER' },
        { name: 'product_id', definition: 'product_id INTEGER' },
        { name: 'variant_id', definition: 'variant_id INTEGER' },
        { name: 'variant_name', definition: 'variant_name TEXT' },
        { name: 'customer_name', definition: 'customer_name TEXT' },
        { name: 'activation_limit', definition: 'activation_limit INTEGER' },
        { name: 'activation_usage', definition: 'activation_usage INTEGER' },
        { name: 'status', definition: 'status TEXT' },
        { name: 'expires_at', definition: 'expires_at DATETIME' },
    ];
    const addedColumns = [];
    columnsToEnsure.forEach(({ name, definition }) => {
        if (!columnExists(name)) {
            db.exec(`ALTER TABLE licenses ADD COLUMN ${definition};`);
            addedColumns.push(name);
            refreshColumns();
        }
    });
    if (addedColumns.length > 0) {
        console.log(`Migration 010: Added columns [${addedColumns.join(', ')}] to licenses table`);
    }
    else {
        console.log('Migration 010: Lemon Squeezy fields already exist, skipping column creation');
    }
    // Always try to create indexes (IF NOT EXISTS handles duplicates)
    const hasInstanceId = columnExists('instance_id');
    if (hasInstanceId) {
        db.exec(`
      -- Create indexes for lookups
      -- Use partial unique index to allow UNIQUE constraint only on non-NULL values
      CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_instance_id ON licenses(instance_id) WHERE instance_id IS NOT NULL;
    `);
    }
    else {
        console.warn('Migration 010: instance_id column missing, skipping idx_licenses_instance_id creation');
    }
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
    CREATE INDEX IF NOT EXISTS idx_licenses_expires ON licenses(expires_at);
  `);
}
//# sourceMappingURL=010_lemonsqueezy_migration.js.map