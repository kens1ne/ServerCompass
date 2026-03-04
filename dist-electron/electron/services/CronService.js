"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cronService = void 0;
const db_1 = require("../db");
const SSHService_1 = require("./SSHService");
const CRON_MACROS = new Set([
    '@reboot',
    '@yearly',
    '@annually',
    '@monthly',
    '@weekly',
    '@daily',
    '@midnight',
    '@hourly',
]);
const NUMERIC_FIELD_PATTERN = /^[0-9*/?,\-]+$/;
const NAMED_MONTHS = new Set(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);
const NAMED_DAYS = new Set(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const isValidCronName = (value) => NAMED_MONTHS.has(value) || NAMED_DAYS.has(value);
const isValidNameSegment = (segment) => {
    if (!segment)
        return false;
    const [base, step] = segment.split('/');
    if (step !== undefined && !/^[0-9]+$/.test(step)) {
        return false;
    }
    const baseUpper = base.toUpperCase();
    if (baseUpper === '*') {
        return true;
    }
    const rangeParts = baseUpper.split('-');
    if (rangeParts.length > 2) {
        return false;
    }
    return rangeParts.every((part) => isValidCronName(part));
};
const isValidCronFieldToken = (token) => {
    if (!token)
        return false;
    if (NUMERIC_FIELD_PATTERN.test(token)) {
        return true;
    }
    const segments = token.toUpperCase().split(',');
    return segments.every(isValidNameSegment);
};
class CronService {
    getMetadataMap(serverId) {
        const rows = db_1.db
            .prepare('SELECT * FROM cron_metadata WHERE server_id = ?')
            .all(serverId);
        return rows.reduce((acc, row) => {
            acc[row.job_signature] = row;
            return acc;
        }, {});
    }
    upsertMetadata(serverId, jobSignature, cronId, name, description, type = null, createdBy = null) {
        const now = Date.now();
        db_1.db.prepare(`
      INSERT INTO cron_metadata (server_id, job_signature, cron_id, name, description, type, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, job_signature)
      DO UPDATE SET
        cron_id = excluded.cron_id,
        name = excluded.name,
        description = excluded.description,
        type = excluded.type,
        created_by = excluded.created_by,
        updated_at = excluded.updated_at
    `).run(serverId, jobSignature, cronId, name, description, type, createdBy, now, now);
    }
    deleteMetadata(serverId, jobSignature) {
        db_1.db.prepare('DELETE FROM cron_metadata WHERE server_id = ? AND job_signature = ?')
            .run(serverId, jobSignature);
    }
    normalizeLine(line) {
        return line.replace(/\s+$/u, '');
    }
    stripComment(line) {
        if (line.trimStart().startsWith('#')) {
            return line.trimStart().replace(/^#\s*/, '');
        }
        return line;
    }
    signatureFor(schedule, command) {
        return Buffer.from(`${schedule.trim()}|${command.trim()}`).toString('base64');
    }
    signatureFromLine(line) {
        const parsed = this.parseCronLine(line, 0, 'user');
        if (!parsed)
            return null;
        return parsed.jobSignature;
    }
    /**
     * Regex to parse metadata comments in format:
     * # name:{name} |id:{cronId} |type:{type} |by:{creator} |desc:{description}
     * All fields after name are optional
     */
    parseMetadataComment(line) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('#')) {
            return null;
        }
        // Remove leading # and whitespace
        const content = trimmed.replace(/^#\s*/, '');
        // Check if it matches our metadata format (must start with "name:" or "id:")
        if (!content.startsWith('name:') && !content.startsWith('id:')) {
            return null;
        }
        const result = {
            name: null,
            cronId: null,
            type: null,
            createdBy: null,
            description: null,
        };
        // Parse each segment separated by |
        const segments = content.split('|').map(s => s.trim());
        for (const segment of segments) {
            const colonIndex = segment.indexOf(':');
            if (colonIndex === -1)
                continue;
            const key = segment.substring(0, colonIndex).trim();
            const value = segment.substring(colonIndex + 1).trim();
            if (!value)
                continue;
            switch (key) {
                case 'name':
                    result.name = value;
                    break;
                case 'id':
                    result.cronId = value;
                    break;
                case 'type':
                    result.type = value;
                    break;
                case 'by':
                    result.createdBy = value;
                    break;
                case 'desc':
                    result.description = value;
                    break;
            }
        }
        // Must have at least a name or id to be valid
        return (result.name || result.cronId) ? result : null;
    }
    /**
     * Generate a metadata comment line from metadata fields.
     * Returns null if no meaningful metadata to write.
     */
    generateCommentLine(name, cronId, type, createdBy, description) {
        const cleanName = name?.trim() || '';
        const cleanCronId = cronId?.trim() || '';
        const cleanType = type?.trim() || '';
        const cleanCreatedBy = createdBy?.trim() || '';
        const cleanDescription = description?.trim() || '';
        // Always generate a comment if we have a cronId (for folder structure)
        if (!cleanName && !cleanCronId && !cleanType && !cleanCreatedBy && !cleanDescription) {
            return null;
        }
        const parts = [];
        if (cleanName) {
            parts.push(`name:${cleanName}`);
        }
        if (cleanCronId) {
            parts.push(`id:${cleanCronId}`);
        }
        if (cleanType) {
            parts.push(`type:${cleanType}`);
        }
        if (cleanCreatedBy) {
            parts.push(`by:${cleanCreatedBy}`);
        }
        if (cleanDescription) {
            parts.push(`desc:${cleanDescription}`);
        }
        return parts.length > 0 ? `# ${parts.join(' |')}` : null;
    }
    async readCrontab(serverId, useSudo = false) {
        const command = useSudo ? 'sudo -n crontab -l' : 'crontab -l';
        const result = await SSHService_1.sshService.executeCommand(serverId, command);
        if (result.exitCode && result.exitCode !== 0) {
            const combined = [result.stderr, result.stdout].filter(Boolean).join('\n').toLowerCase();
            if (combined.includes('no crontab for')) {
                return [];
            }
            if (useSudo) {
                if (combined.includes('password is required') ||
                    combined.includes('no tty present') ||
                    combined.includes('authentication failure') ||
                    combined.includes('command not found') ||
                    combined.includes('permission denied') ||
                    combined.includes('sorry')) {
                    return [];
                }
            }
            throw new Error(`Failed to read ${useSudo ? 'root' : 'user'} crontab: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
        }
        const output = result.stdout || result.stderr || '';
        if (!output.trim()) {
            return [];
        }
        return output.replace(/\r/g, '').split('\n');
    }
    async writeCrontab(serverId, lines, useSudo = false) {
        const content = lines.join('\n').replace(/\s+$/u, '');
        const fullContent = content.length > 0 ? `${content}\n` : '\n';
        const encoded = Buffer.from(fullContent).toString('base64');
        const commandPrefix = useSudo ? 'sudo -n ' : '';
        const result = await SSHService_1.sshService.executeCommand(serverId, `echo '${encoded}' | base64 -d | ${commandPrefix}crontab -`);
        if (result.exitCode && result.exitCode !== 0) {
            const combined = result.stderr || result.stdout || '';
            throw new Error(`Failed to update ${useSudo ? 'root' : 'user'} crontab: ${combined}`);
        }
    }
    /**
     * Check if a commented line is just documentation rather than a commented-out cron job.
     * Returns true if the line should be ignored as a pure comment.
     */
    isDocumentationComment(content) {
        const trimmed = content.trim().toLowerCase();
        // Empty or whitespace-only after stripping comment
        if (!trimmed) {
            return true;
        }
        // Common documentation patterns in crontab files
        const docPatterns = [
            /^edit this file/i,
            /^each task to run/i,
            /^indicating with different fields/i,
            /^and what command to run/i,
            /^to define the time/i,
            /^minute \(m\)/i,
            /^notice that tasks will be started/i,
            /^output of the crontab/i,
            /^for example,/i,
            /^for more information/i,
            /^at \d+.*every (week|day|month|hour)/i,
            /^email to the user/i,
            /^\s*m\s+h\s+(dom|day)/i, // Header line like "m h dom mon dow command"
        ];
        if (docPatterns.some((pattern) => pattern.test(trimmed))) {
            return true;
        }
        // Lines that are just field descriptions without actual commands
        // e.g., "# minute (m), hour (h), day of month (dom)..."
        if (/^[a-z\s(),]+$/i.test(trimmed) && !(/^\d/.test(trimmed) || trimmed.startsWith('@'))) {
            return true;
        }
        // Lines that explain cron syntax but don't have executable paths
        // They typically don't contain slashes or actual command names
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 6) {
            const possibleSchedule = parts.slice(0, 5);
            const possibleCommand = parts.slice(5).join(' ');
            // If the "schedule" parts contain obvious placeholder text like "m", "h", "dom", "mon", "dow"
            const placeholderPattern = /^(m|h|dom|mon|dow|minute|hour|day|month|week)$/i;
            if (possibleSchedule.some(part => placeholderPattern.test(part))) {
                return true;
            }
            // If the "command" part is just descriptive text without any executable indicators
            // (no slashes for paths, no common command patterns)
            if (!/[/\\]/.test(possibleCommand) &&
                !/^(sudo|bash|sh|python|node|npm|php|perl|ruby|\w+\.\w+)/.test(possibleCommand)) {
                return true;
            }
        }
        return false;
    }
    /**
     * Check if a commented line looks like the standard example that ships with crontab.
     * e.g., "# 0 5 * * 1 tar -zcf /var/backups/home.tgz /home/"
     */
    isStockExample(schedule, command) {
        return schedule === '0 5 * * 1' && command.includes('tar') && command.includes('/var/backups/home.tgz');
    }
    parseCronLine(line, lineNumber, owner) {
        const trimmed = line.trim();
        if (!trimmed) {
            return null;
        }
        let isActive = true;
        let content = trimmed;
        if (trimmed.startsWith('#')) {
            content = trimmed.replace(/^#+\s*/, '');
            isActive = false;
            if (!content) {
                return null;
            }
            // Filter out pure documentation comments
            if (this.isDocumentationComment(content)) {
                return null;
            }
        }
        const parts = content.split(/\s+/);
        const firstToken = parts[0];
        if (!firstToken) {
            return null;
        }
        let schedule;
        let command;
        let isMacro = false;
        let supportsScheduleEdit = true;
        if (CRON_MACROS.has(firstToken)) {
            isMacro = true;
            supportsScheduleEdit = false;
            command = parts.slice(1).join(' ').trim();
            if (!command) {
                return null;
            }
            schedule = firstToken;
        }
        else {
            if (parts.length < 6) {
                return null;
            }
            const scheduleParts = parts.slice(0, 5);
            const scheduleValid = scheduleParts.every((token) => isValidCronFieldToken(token));
            if (!scheduleValid) {
                return null;
            }
            command = parts.slice(5).join(' ').trim();
            if (!command) {
                return null;
            }
            schedule = scheduleParts.join(' ');
        }
        // Filter out the stock crontab example line that ships with most distributions
        if (!isActive && this.isStockExample(schedule, command)) {
            return null;
        }
        const jobSignature = this.signatureFor(schedule, command);
        return {
            lineNumber,
            raw: this.normalizeLine(line),
            schedule,
            command,
            isActive,
            isMacro,
            jobSignature,
            cronId: null,
            name: null,
            description: null,
            type: null,
            createdBy: null,
            supportsScheduleEdit,
            owner,
        };
    }
    reconcileLinesWithJobs(lines, owner) {
        const jobs = [];
        lines.forEach((line, index) => {
            const job = this.parseCronLine(line, index, owner);
            if (job) {
                // Check if the previous line is a metadata comment
                if (index > 0) {
                    const prevLine = lines[index - 1];
                    const metadata = this.parseMetadataComment(prevLine);
                    if (metadata) {
                        job.cronId = metadata.cronId;
                        job.name = metadata.name;
                        job.description = metadata.description;
                        job.type = metadata.type;
                        job.createdBy = metadata.createdBy;
                    }
                }
                jobs.push(job);
            }
        });
        return jobs;
    }
    async list(serverId) {
        const metadataMap = this.getMetadataMap(serverId);
        const userLines = await this.readCrontab(serverId, false).catch(() => []);
        const userJobs = this.reconcileLinesWithJobs(userLines, 'user');
        let rootLines = [];
        try {
            rootLines = await this.readCrontab(serverId, true);
        }
        catch (error) {
            console.warn('Failed to read root crontab:', error);
            rootLines = [];
        }
        const combinedJobs = [...userJobs];
        if (rootLines.length) {
            const rootJobs = this.reconcileLinesWithJobs(rootLines, 'root');
            const isSameAsUser = userLines.length > 0 && userLines.join('\n') === rootLines.join('\n');
            rootJobs.forEach((job) => {
                if (isSameAsUser) {
                    // When running as root, avoid adding duplicate entries labelled as root.
                    return;
                }
                const duplicate = combinedJobs.some((existing) => existing.jobSignature === job.jobSignature && existing.owner === job.owner);
                if (!duplicate) {
                    combinedJobs.push(job);
                }
            });
        }
        const mapped = combinedJobs.map((job) => {
            const meta = metadataMap[job.jobSignature];
            // Comments take priority over database. If comment has data, use it; otherwise fall back to DB
            return {
                ...job,
                cronId: job.cronId || meta?.cron_id || null,
                name: job.name || meta?.name || null,
                description: job.description || meta?.description || null,
                type: job.type || meta?.type || null,
                createdBy: job.createdBy || meta?.created_by || null,
            };
        });
        mapped.sort((a, b) => {
            if (a.owner !== b.owner) {
                return a.owner === 'user' ? -1 : 1;
            }
            if (a.schedule !== b.schedule) {
                return a.schedule.localeCompare(b.schedule);
            }
            return a.command.localeCompare(b.command);
        });
        return mapped;
    }
    saveMetadata(serverId, jobSignature, cronId, name, description, type, createdBy) {
        const cleanCronId = cronId?.trim() || null;
        const cleanName = name?.trim() || '';
        const cleanDescription = description?.trim() || '';
        const cleanType = type?.trim() || '';
        const cleanCreatedBy = createdBy?.trim() || '';
        if (!cleanCronId && !cleanName && !cleanDescription && !cleanType && !cleanCreatedBy) {
            this.deleteMetadata(serverId, jobSignature);
            return;
        }
        this.upsertMetadata(serverId, jobSignature, cleanCronId, cleanName || null, cleanDescription || null, cleanType || null, cleanCreatedBy || null);
    }
    async updateJob(options) {
        const { serverId, lineNumber, originalLine, schedule, command, isActive, name, description, type, createdBy, owner } = options;
        const useSudo = owner === 'root';
        const lines = await this.readCrontab(serverId, useSudo);
        let targetIndex = -1;
        if (lineNumber >= 0 && lineNumber < lines.length && this.normalizeLine(lines[lineNumber]) === this.normalizeLine(originalLine)) {
            targetIndex = lineNumber;
        }
        else {
            targetIndex = lines.findIndex((line) => this.normalizeLine(line) === this.normalizeLine(originalLine));
        }
        if (targetIndex === -1) {
            throw new Error('Unable to locate target cron entry. It may have changed on the remote server.');
        }
        const baseLine = `${schedule.trim()} ${command.trim()}`.trim();
        const newLine = isActive ? baseLine : `# ${baseLine}`;
        // Check if there's a metadata comment above the current line and preserve the cronId
        const existingMetadata = targetIndex > 0 ? this.parseMetadataComment(lines[targetIndex - 1]) : null;
        const existingCronId = existingMetadata?.cronId || null;
        // Also check database for cronId if not in comment
        const oldSignature = this.signatureFromLine(originalLine);
        const dbCronId = oldSignature ? this.getCronIdBySignature(serverId, oldSignature) : null;
        const cronId = existingCronId || dbCronId;
        // Generate metadata comment line
        const cleanName = name?.trim() || '';
        const cleanDescription = description?.trim() || '';
        const cleanType = type?.trim() || '';
        const cleanCreatedBy = createdBy?.trim() || '';
        const commentLine = this.generateCommentLine(cleanName, cronId, cleanType, cleanCreatedBy, cleanDescription);
        // Update or insert the comment and cron entry
        if (commentLine) {
            if (existingMetadata) {
                // Update existing comment
                lines[targetIndex - 1] = commentLine;
                lines[targetIndex] = newLine;
            }
            else {
                // Insert new comment above
                lines[targetIndex] = newLine;
                lines.splice(targetIndex, 0, commentLine);
            }
        }
        else {
            // No metadata to write, remove comment if it exists
            if (existingMetadata) {
                lines.splice(targetIndex - 1, 1); // Remove comment line
                lines[targetIndex - 1] = newLine; // targetIndex shifted down by 1
            }
            else {
                lines[targetIndex] = newLine;
            }
        }
        await this.writeCrontab(serverId, lines, useSudo);
        const newSignature = this.signatureFor(schedule, command);
        if (oldSignature && oldSignature !== newSignature) {
            this.deleteMetadata(serverId, oldSignature);
        }
        // Save metadata to database (always save if we have a cronId)
        if (cleanName || cleanDescription || cleanType || cleanCreatedBy || cronId) {
            this.upsertMetadata(serverId, newSignature, cronId, cleanName || null, cleanDescription || null, cleanType || null, cleanCreatedBy || null);
        }
        else {
            this.deleteMetadata(serverId, newSignature);
        }
        return { jobSignature: newSignature };
    }
    async toggleJob(options) {
        const { serverId, lineNumber, originalLine, active, owner } = options;
        const useSudo = owner === 'root';
        const lines = await this.readCrontab(serverId, useSudo);
        let targetIndex = -1;
        if (lineNumber >= 0 && lineNumber < lines.length && this.normalizeLine(lines[lineNumber]) === this.normalizeLine(originalLine)) {
            targetIndex = lineNumber;
        }
        else {
            targetIndex = lines.findIndex((line) => this.normalizeLine(line) === this.normalizeLine(originalLine));
        }
        if (targetIndex === -1) {
            throw new Error('Unable to locate target cron entry. It may have changed on the remote server.');
        }
        const stripped = this.stripComment(lines[targetIndex]).trim();
        const updated = active ? stripped : `# ${stripped}`;
        lines[targetIndex] = updated;
        await this.writeCrontab(serverId, lines, useSudo);
    }
    async deleteJob(options) {
        const { serverId, lineNumber, originalLine, owner } = options;
        const useSudo = owner === 'root';
        const lines = await this.readCrontab(serverId, useSudo);
        let targetIndex = -1;
        if (lineNumber >= 0 && lineNumber < lines.length && this.normalizeLine(lines[lineNumber]) === this.normalizeLine(originalLine)) {
            targetIndex = lineNumber;
        }
        else {
            targetIndex = lines.findIndex((line) => this.normalizeLine(line) === this.normalizeLine(originalLine));
        }
        if (targetIndex === -1) {
            throw new Error('Unable to locate target cron entry. It may have changed on the remote server.');
        }
        const signature = this.signatureFromLine(lines[targetIndex]);
        // Get cronId from metadata comment or database before deleting
        const existingMetadata = targetIndex > 0 ? this.parseMetadataComment(lines[targetIndex - 1]) : null;
        const cronId = existingMetadata?.cronId || (signature ? this.getCronIdBySignature(serverId, signature) : null);
        // Check if there's a metadata comment above this line and remove it too
        if (existingMetadata) {
            lines.splice(targetIndex - 1, 2); // Remove both comment and cron line
        }
        else {
            lines.splice(targetIndex, 1);
        }
        await this.writeCrontab(serverId, lines, useSudo);
        if (signature) {
            this.deleteMetadata(serverId, signature);
            // Clean up wrapper script and log directory on the server
            await this.cleanupJobFiles(serverId, cronId);
        }
    }
    /**
     * Clean up wrapper script and log directory for a deleted job
     */
    async cleanupJobFiles(serverId, cronId) {
        if (!cronId) {
            return;
        }
        const scriptPath = this.getScriptPath(cronId);
        const logDir = this.getLogDirPath(cronId);
        // Remove script and log directory (ignore errors if they don't exist)
        const cleanupCmd = `rm -f ${scriptPath} 2>/dev/null; rm -rf ${logDir} 2>/dev/null; true`;
        try {
            await SSHService_1.sshService.executeCommand(serverId, cleanupCmd);
        }
        catch (error) {
            // Log but don't fail if cleanup fails
            console.warn('Failed to cleanup job files:', error);
        }
    }
    /**
     * Maximum safe cron line length (crontab typically limits to 1024 characters)
     */
    MAX_CRON_LINE_LENGTH = 900;
    /**
     * Base path for wrapper scripts on the server
     */
    SCRIPTS_PATH = '~/server-compass/crons/scripts';
    /**
     * Base path for cron logs on the server
     */
    LOGS_PATH = '~/server-compass/crons/logs';
    /**
     * Generate a short alphanumeric ID (8 characters)
     */
    generateCronId() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 8; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    /**
     * Get the script path for a cron job by its ID
     */
    getScriptPath(cronId) {
        return `${this.SCRIPTS_PATH}/${cronId}.sh`;
    }
    /**
     * Get the log directory path for a cron job by its ID
     */
    getLogDirPath(cronId) {
        return `${this.LOGS_PATH}/${cronId}`;
    }
    /**
     * Get the log file path for a cron job by its ID
     */
    getLogFilePath(cronId) {
        return `${this.LOGS_PATH}/${cronId}/output.log`;
    }
    /**
     * Write a wrapper script to the server and return the path
     */
    async writeWrapperScript(serverId, scriptPath, scriptContent) {
        // Ensure the scripts directory exists
        const mkdirCmd = `mkdir -p ${this.SCRIPTS_PATH}`;
        const mkdirResult = await SSHService_1.sshService.executeCommand(serverId, mkdirCmd);
        if (mkdirResult.exitCode !== 0) {
            throw new Error(`Failed to create scripts directory: ${mkdirResult.stderr || mkdirResult.stdout}`);
        }
        // Write the script content using base64 encoding to handle special characters
        const encoded = Buffer.from(scriptContent).toString('base64');
        const writeCmd = `echo '${encoded}' | base64 -d > ${scriptPath} && chmod +x ${scriptPath}`;
        const writeResult = await SSHService_1.sshService.executeCommand(serverId, writeCmd);
        if (writeResult.exitCode !== 0) {
            throw new Error(`Failed to write wrapper script: ${writeResult.stderr || writeResult.stdout}`);
        }
    }
    /**
     * Build a wrapper script for complex commands (logging + seconds-based scheduling)
     */
    buildWrapperScript(command, options) {
        const lines = ['#!/bin/bash', ''];
        if (options.enableLogging && options.logPath) {
            // Convert ~ to $HOME for proper expansion in the script
            const expandedLogPath = options.logPath.replace(/^~/, '$HOME');
            // Add logging setup
            lines.push(`LOG_DIR="$(dirname ${expandedLogPath})"`);
            lines.push('mkdir -p "$LOG_DIR" 2>/dev/null');
            lines.push('');
            lines.push('# Log rotation (1MB limit, 3 backups)');
            lines.push(`LOG_FILE="${expandedLogPath}"`);
            lines.push('MAX_SIZE=1048576');
            lines.push('if [ -f "$LOG_FILE" ]; then');
            lines.push('  SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)');
            lines.push('  if [ "$SIZE" -gt "$MAX_SIZE" ]; then');
            lines.push('    for i in 2 1; do');
            lines.push('      [ -f "$LOG_FILE.$i" ] && mv "$LOG_FILE.$i" "$LOG_FILE.$((i+1))"');
            lines.push('    done');
            lines.push('    mv "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null');
            lines.push('  fi');
            lines.push('fi');
            lines.push('');
            lines.push('# Add timestamp');
            lines.push('echo "=== $(date \'+%Y-%m-%d %H:%M:%S\') ===" >> "$LOG_FILE"');
            lines.push('');
        }
        if (options.secondsInterval) {
            // Generate loop for sub-minute scheduling
            const offsets = [];
            for (let i = 0; i < 60; i += options.secondsInterval) {
                offsets.push(i);
            }
            lines.push('# Run command every ' + options.secondsInterval + ' seconds');
            lines.push(`for i in ${offsets.join(' ')}; do`);
            lines.push('  (');
            lines.push('    sleep $i');
            if (options.enableLogging && options.logPath) {
                lines.push(`    (${command}) >> "$LOG_FILE" 2>&1`);
            }
            else {
                lines.push(`    ${command}`);
            }
            lines.push('  ) &');
            lines.push('done');
            lines.push('wait');
        }
        else {
            // Simple execution with optional logging
            if (options.enableLogging && options.logPath) {
                lines.push(`(${command}) >> "$LOG_FILE" 2>&1`);
            }
            else {
                lines.push(command);
            }
        }
        return lines.join('\n');
    }
    async addJob(options) {
        const { serverId, schedule, command, isActive, owner, name, description, type, createdBy, secondsInterval, enableLogging } = options;
        const useSudo = owner === 'root';
        // Generate a unique cron ID for this job
        const cronId = this.generateCronId();
        // Determine if we need a wrapper script
        const needsWrapper = secondsInterval || enableLogging;
        let finalCommand = command;
        if (needsWrapper) {
            const scriptPath = this.getScriptPath(cronId);
            // Determine log path if logging is enabled
            const logPath = enableLogging ? this.getLogFilePath(cronId) : undefined;
            // Build the wrapper script
            const scriptContent = this.buildWrapperScript(command, {
                secondsInterval,
                enableLogging,
                logPath,
            });
            // Write the script to the server
            await this.writeWrapperScript(serverId, scriptPath, scriptContent);
            // The cron command just calls the script
            finalCommand = `bash ${scriptPath}`;
        }
        // Check if the cron line would be too long
        const testLine = `${schedule.trim()} ${finalCommand.trim()}`;
        if (testLine.length > this.MAX_CRON_LINE_LENGTH) {
            throw new Error(`Cron command is too long (${testLine.length} chars, max ${this.MAX_CRON_LINE_LENGTH}). ` +
                `Try using a shorter command or creating a script file manually.`);
        }
        // Read existing crontab
        const lines = await this.readCrontab(serverId, useSudo);
        // Build the cron entry
        const baseLine = `${schedule.trim()} ${finalCommand.trim()}`.trim();
        const cronLine = isActive ? baseLine : `# ${baseLine}`;
        // Generate metadata comment (always include cronId for tracking)
        const cleanName = name?.trim() || '';
        const cleanDescription = description?.trim() || '';
        const cleanType = type?.trim() || '';
        const cleanCreatedBy = createdBy?.trim() || '';
        const commentLine = this.generateCommentLine(cleanName, cronId, cleanType, cleanCreatedBy, cleanDescription);
        // Append to crontab
        if (commentLine) {
            lines.push(commentLine);
        }
        lines.push(cronLine);
        // Write updated crontab
        await this.writeCrontab(serverId, lines, useSudo);
        // Save metadata to database
        const jobSignature = this.signatureFor(schedule, finalCommand);
        this.upsertMetadata(serverId, jobSignature, cronId, cleanName || null, cleanDescription || null, cleanType || null, cleanCreatedBy || null);
        return { jobSignature, cronId };
    }
    /**
     * Get the cron ID for a job by its signature
     */
    getCronIdBySignature(serverId, jobSignature) {
        const row = db_1.db.prepare('SELECT cron_id FROM cron_metadata WHERE server_id = ? AND job_signature = ?')
            .get(serverId, jobSignature);
        return row?.cron_id || null;
    }
}
exports.cronService = new CronService();
//# sourceMappingURL=CronService.js.map