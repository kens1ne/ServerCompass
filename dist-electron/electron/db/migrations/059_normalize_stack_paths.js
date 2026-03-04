"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
/**
 * Migration 059: Normalize docker_stacks.stack_path
 *
 * Some older external-build flows persisted `stack_path` including the project segment
 * (e.g. `/root/server-compass/apps/my-app`). The codebase generally treats `stack_path`
 * as the *base directory* and derives the working directory by appending `project_name`.
 *
 * This migration removes a trailing `/<project_name>` segment when present.
 */
function migrate(db) {
    console.log('[Migration 059] Normalizing docker_stacks.stack_path values');
    const stacks = db.prepare(`
    SELECT id, project_name, stack_path
    FROM docker_stacks
    WHERE stack_path IS NOT NULL
  `).all();
    const sanitizeProjectName = (value) => (value || '').trim().replace(/^\/+|\/+$/g, '');
    const trimTrailingSlashes = (value) => {
        const trimmed = (value || '').trim();
        if (!trimmed || trimmed === '/')
            return trimmed;
        return trimmed.replace(/\/+$/g, '');
    };
    const splitSegments = (value) => value.split('/').filter(Boolean);
    const joinPath = (isAbsolute, segments, fallback) => {
        if (segments.length === 0)
            return isAbsolute ? '/' : fallback;
        return `${isAbsolute ? '/' : ''}${segments.join('/')}`;
    };
    let normalizedCount = 0;
    for (const stack of stacks) {
        const projectName = sanitizeProjectName(stack.project_name);
        if (!projectName)
            continue;
        const rawStackPath = trimTrailingSlashes(stack.stack_path);
        if (!rawStackPath)
            continue;
        const isAbsolute = rawStackPath.startsWith('/');
        const segments = splitSegments(rawStackPath);
        const last = segments[segments.length - 1];
        if (!last)
            continue;
        if (last.toLowerCase() !== projectName.toLowerCase())
            continue;
        const normalized = joinPath(isAbsolute, segments.slice(0, -1), '.');
        if (normalized !== stack.stack_path) {
            db.prepare('UPDATE docker_stacks SET stack_path = ? WHERE id = ?').run(normalized, stack.id);
            normalizedCount += 1;
        }
    }
    console.log(`[Migration 059] Normalized ${normalizedCount} stack_path value(s)`);
}
//# sourceMappingURL=059_normalize_stack_paths.js.map