"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitCompatibilityLayer = void 0;
const db_1 = require("../db");
class GitCompatibilityLayer {
    static hasManagedAccounts(serverId) {
        const row = db_1.db
            .prepare('SELECT COUNT(*) as count FROM server_git_accounts WHERE server_id = ?')
            .get(serverId);
        return (row?.count ?? 0) > 0;
    }
    static isLegacyMode(serverId) {
        return !this.hasManagedAccounts(serverId);
    }
    static getDefaultAccountId(serverId) {
        const row = db_1.db
            .prepare(`
        SELECT git_account_id
        FROM server_git_accounts
        WHERE server_id = ?
        ORDER BY is_default DESC, created_at ASC
        LIMIT 1
      `)
            .get(serverId);
        return row?.git_account_id ?? null;
    }
}
exports.GitCompatibilityLayer = GitCompatibilityLayer;
//# sourceMappingURL=GitCompatibilityLayer.js.map