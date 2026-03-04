"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add columns for local upload deployments
    db.exec(`
    ALTER TABLE deployments ADD COLUMN source_type TEXT DEFAULT 'git';
    ALTER TABLE deployments ADD COLUMN local_upload_size INTEGER;
    ALTER TABLE deployments ADD COLUMN local_upload_file_count INTEGER;
    ALTER TABLE deployments ADD COLUMN git_linked_at INTEGER;
  `);
    console.log('Local upload support schema updated successfully');
}
//# sourceMappingURL=020_local_upload_support.js.map