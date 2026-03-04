"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveStackWorkingDir = resolveStackWorkingDir;
function trimTrailingSlashes(value) {
    if (!value)
        return value;
    if (value === '/')
        return '/';
    return value.replace(/\/+$/g, '');
}
function sanitizeProjectName(projectName) {
    return (projectName || '').trim().replace(/^\/+|\/+$/g, '');
}
function splitPathSegments(pathValue) {
    return pathValue.split('/').filter(Boolean);
}
function joinAbsoluteOrRelativePath(isAbsolute, segments, fallback) {
    if (segments.length === 0) {
        return isAbsolute ? '/' : fallback;
    }
    return `${isAbsolute ? '/' : ''}${segments.join('/')}`;
}
/**
 * Docker stack rows traditionally persist `stack_path` as a base directory
 * and derive the working directory by appending `project_name`.
 *
 * Some external-build flows accidentally persisted `stack_path` including
 * the project segment (e.g. `/root/server-compass/apps/my-app`), which then
 * caused runtime code to resolve `/root/server-compass/apps/my-app/my-app`.
 */
function resolveStackWorkingDir(stack) {
    const projectName = sanitizeProjectName(stack.project_name);
    const rawStackPath = trimTrailingSlashes((stack.stack_path || '').trim()) || '/root/server-compass/apps';
    const isAbsolutePath = rawStackPath.startsWith('/');
    const pathSegments = splitPathSegments(rawStackPath);
    const lastSegment = pathSegments[pathSegments.length - 1];
    const projectLower = projectName.toLowerCase();
    let normalizedSegments = pathSegments;
    let needsNormalization = false;
    if (projectName && lastSegment && lastSegment.toLowerCase() === projectLower) {
        normalizedSegments = pathSegments.slice(0, -1);
        needsNormalization = true;
    }
    const normalizedStackPath = joinAbsoluteOrRelativePath(isAbsolutePath, normalizedSegments, '.');
    if (!projectName) {
        return {
            workingDir: normalizedStackPath,
            normalizedStackPath,
            needsNormalization,
        };
    }
    const workingDir = normalizedStackPath === '/'
        ? `/${projectName}`
        : `${normalizedStackPath}/${projectName}`;
    return {
        workingDir,
        normalizedStackPath,
        needsNormalization,
    };
}
//# sourceMappingURL=pathUtils.js.map