"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.s3UploadService = exports.S3UploadService = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const lib_storage_1 = require("@aws-sdk/lib-storage");
const events_1 = require("events");
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const promises_2 = require("stream/promises");
/**
 * Provider-specific endpoint mapping
 * Note: Providers not listed here require explicit endpoint (r2, minio, hetzner, custom)
 */
const PROVIDER_ENDPOINTS = {
    backblaze: (r) => `https://s3.${r}.backblazeb2.com`,
    wasabi: (r) => `https://s3.${r}.wasabisys.com`,
    do_spaces: (r) => `https://${r}.digitaloceanspaces.com`,
    vultr: (r) => `https://${r}.vultrobjects.com`,
    // AWS uses default SDK behavior (no explicit endpoint)
    // R2, MinIO, Hetzner, and custom require explicit endpoint from user
};
/**
 * S3UploadService - Handles S3-compatible storage operations
 *
 * Follows singleton pattern like SSHService.
 * Supports multiple S3-compatible providers: AWS, Backblaze, Wasabi, MinIO, R2, etc.
 */
class S3UploadService extends events_1.EventEmitter {
    constructor() {
        super();
    }
    /**
     * Create an S3Client for a given storage configuration
     */
    createClient(config) {
        const endpoint = this.resolveEndpoint(config);
        // Use 'auto' region for providers that support it (like Hetzner, R2)
        const region = config.region || 'auto';
        console.log(`[S3Upload] Creating client for ${config.provider}: endpoint=${endpoint}, region=${region}`);
        // Minimal config matching working S3-compatible implementations
        const clientConfig = {
            region,
            endpoint,
            credentials: {
                accessKeyId: config.accessKey,
                secretAccessKey: config.secretKey,
            },
        };
        // Only MinIO typically needs path-style addressing
        if (config.provider === 'minio') {
            clientConfig.forcePathStyle = true;
        }
        return new client_s3_1.S3Client(clientConfig);
    }
    /**
     * Resolve the endpoint URL for a provider
     */
    resolveEndpoint(config) {
        // If custom endpoint is provided, use it directly
        if (config.endpoint) {
            return config.endpoint;
        }
        // AWS uses default SDK behavior (no explicit endpoint)
        if (config.provider === 'aws') {
            return undefined;
        }
        // Look up provider-specific endpoint
        const endpointFn = PROVIDER_ENDPOINTS[config.provider];
        if (endpointFn && config.region) {
            return endpointFn(config.region);
        }
        return undefined;
    }
    /**
     * Test connection to S3 bucket
     * Uses HeadBucket to verify bucket exists and we have access
     */
    async testConnection(config) {
        const startTime = Date.now();
        const client = this.createClient(config);
        console.log(`[S3Upload] Testing connection to bucket: ${config.bucket}`);
        try {
            // HeadBucket is the simplest way to test bucket access
            // It just checks if the bucket exists and we have permission
            await client.send(new client_s3_1.HeadBucketCommand({
                Bucket: config.bucket,
            }));
            const latencyMs = Date.now() - startTime;
            console.log(`[S3Upload] Connection test successful for ${config.provider}/${config.bucket} (${latencyMs}ms)`);
            return { success: true, latencyMs };
        }
        catch (error) {
            console.error(`[S3Upload] Connection test failed:`, error);
            console.error(`[S3Upload] Error details: name=${error.name}, Code=${error.Code}, httpStatus=${error.$metadata?.httpStatusCode}`);
            let errorMessage = 'Connection failed';
            const errorName = error.name || error.Code;
            const httpStatus = error.$metadata?.httpStatusCode;
            // NoSuchKey with 404 on HeadBucket usually means the bucket doesn't exist
            // or there's a path-style vs virtual-hosted style mismatch
            if (errorName === 'NoSuchKey' || errorName === 'NotFound' || errorName === 'NoSuchBucket' || httpStatus === 404) {
                errorMessage = 'Bucket does not exist or endpoint URL is incorrect';
            }
            else if (errorName === 'AccessDenied' || errorName === 'InvalidAccessKeyId' || httpStatus === 403) {
                errorMessage = 'Access denied - check credentials';
            }
            else if (errorName === 'SignatureDoesNotMatch') {
                errorMessage = 'Invalid secret key';
            }
            else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                errorMessage = 'Cannot reach endpoint - check URL and network';
            }
            else if (error.message) {
                errorMessage = error.message;
            }
            return { success: false, error: errorMessage };
        }
        finally {
            client.destroy();
        }
    }
    /**
     * Upload a file to S3
     * Uses multipart upload for large files with progress tracking
     */
    async uploadFile(config, localPath, s3Key, options = {}) {
        const client = this.createClient(config);
        const fullKey = config.pathPrefix ? `${config.pathPrefix}/${s3Key}` : s3Key;
        try {
            // Get file size for progress tracking
            const fileStats = await (0, promises_1.stat)(localPath);
            const fileSize = fileStats.size;
            const fileStream = (0, fs_1.createReadStream)(localPath);
            const upload = new lib_storage_1.Upload({
                client,
                params: {
                    Bucket: config.bucket,
                    Key: fullKey,
                    Body: fileStream,
                    ContentType: options.contentType || 'application/octet-stream',
                    Metadata: options.metadata,
                },
                // 5MB part size for multipart (minimum)
                partSize: 5 * 1024 * 1024,
                // Concurrent part uploads
                queueSize: 4,
                leavePartsOnError: false,
            });
            // Track progress
            upload.on('httpUploadProgress', (progress) => {
                const loaded = progress.loaded || 0;
                const total = progress.total || fileSize;
                const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
                if (options.onProgress) {
                    options.onProgress({ loaded, total, percent });
                }
                this.emit('upload:progress', {
                    s3Key: fullKey,
                    loaded,
                    total,
                    percent,
                });
            });
            const result = await upload.done();
            console.log(`[S3Upload] Upload complete: ${fullKey} (${fileSize} bytes)`);
            return {
                success: true,
                s3Key: fullKey,
                etag: result.ETag?.replace(/"/g, ''),
            };
        }
        catch (error) {
            console.error(`[S3Upload] Upload failed:`, error);
            return {
                success: false,
                s3Key: fullKey,
                error: error.message || 'Upload failed',
            };
        }
        finally {
            client.destroy();
        }
    }
    /**
     * Upload a buffer to S3
     */
    async uploadBuffer(config, buffer, s3Key, options = {}) {
        const client = this.createClient(config);
        const fullKey = config.pathPrefix ? `${config.pathPrefix}/${s3Key}` : s3Key;
        try {
            const upload = new lib_storage_1.Upload({
                client,
                params: {
                    Bucket: config.bucket,
                    Key: fullKey,
                    Body: buffer,
                    ContentType: options.contentType || 'application/octet-stream',
                    Metadata: options.metadata,
                },
                partSize: 5 * 1024 * 1024,
                queueSize: 4,
                leavePartsOnError: false,
            });
            // Track progress
            upload.on('httpUploadProgress', (progress) => {
                const loaded = progress.loaded || 0;
                const total = progress.total || buffer.length;
                const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
                if (options.onProgress) {
                    options.onProgress({ loaded, total, percent });
                }
            });
            const result = await upload.done();
            console.log(`[S3Upload] Buffer upload complete: ${fullKey} (${buffer.length} bytes)`);
            return {
                success: true,
                s3Key: fullKey,
                etag: result.ETag?.replace(/"/g, ''),
            };
        }
        catch (error) {
            console.error(`[S3Upload] Buffer upload failed:`, error);
            return {
                success: false,
                s3Key: fullKey,
                error: error.message || 'Upload failed',
            };
        }
        finally {
            client.destroy();
        }
    }
    /**
     * Download a file from S3
     */
    async downloadFile(config, s3Key, localPath, options = {}) {
        const client = this.createClient(config);
        const fullKey = config.pathPrefix ? `${config.pathPrefix}/${s3Key}` : s3Key;
        try {
            // Get object metadata first for size
            const headResult = await client.send(new client_s3_1.HeadObjectCommand({
                Bucket: config.bucket,
                Key: fullKey,
            }));
            const totalSize = headResult.ContentLength || 0;
            // Get object
            const getResult = await client.send(new client_s3_1.GetObjectCommand({
                Bucket: config.bucket,
                Key: fullKey,
            }));
            if (!getResult.Body) {
                throw new Error('Empty response body');
            }
            // Stream to file
            const writeStream = (0, fs_1.createWriteStream)(localPath);
            const body = getResult.Body;
            let downloaded = 0;
            body.on('data', (chunk) => {
                downloaded += chunk.length;
                const percent = totalSize > 0 ? Math.round((downloaded / totalSize) * 100) : 0;
                if (options.onProgress) {
                    options.onProgress({ loaded: downloaded, total: totalSize, percent });
                }
            });
            await (0, promises_2.pipeline)(body, writeStream);
            console.log(`[S3Upload] Download complete: ${fullKey} -> ${localPath}`);
            return {
                success: true,
                localPath,
                size: totalSize,
            };
        }
        catch (error) {
            console.error(`[S3Upload] Download failed:`, error);
            let errorMessage = error.message || 'Download failed';
            if (error.name === 'NoSuchKey') {
                errorMessage = 'File not found';
            }
            return {
                success: false,
                localPath,
                error: errorMessage,
            };
        }
        finally {
            client.destroy();
        }
    }
    /**
     * Download a file as buffer
     */
    async downloadBuffer(config, s3Key) {
        const client = this.createClient(config);
        const fullKey = config.pathPrefix ? `${config.pathPrefix}/${s3Key}` : s3Key;
        try {
            const result = await client.send(new client_s3_1.GetObjectCommand({
                Bucket: config.bucket,
                Key: fullKey,
            }));
            if (!result.Body) {
                throw new Error('Empty response body');
            }
            // Convert stream to buffer
            const chunks = [];
            const body = result.Body;
            for await (const chunk of body) {
                chunks.push(chunk);
            }
            const data = Buffer.concat(chunks);
            console.log(`[S3Upload] Buffer download complete: ${fullKey} (${data.length} bytes)`);
            return {
                success: true,
                data,
                size: data.length,
            };
        }
        catch (error) {
            console.error(`[S3Upload] Buffer download failed:`, error);
            return {
                success: false,
                error: error.message || 'Download failed',
            };
        }
        finally {
            client.destroy();
        }
    }
    /**
     * List backups with a given prefix
     * Returns items sorted by last modified (newest first)
     */
    async listBackups(config, prefix) {
        const client = this.createClient(config);
        const fullPrefix = config.pathPrefix
            ? prefix
                ? `${config.pathPrefix}/${prefix}`
                : `${config.pathPrefix}/`
            : prefix || '';
        try {
            const items = [];
            let continuationToken;
            // Paginate through all results
            do {
                const result = await client.send(new client_s3_1.ListObjectsV2Command({
                    Bucket: config.bucket,
                    Prefix: fullPrefix,
                    ContinuationToken: continuationToken,
                    MaxKeys: 1000,
                }));
                if (result.Contents) {
                    for (const obj of result.Contents) {
                        if (obj.Key && obj.LastModified && obj.Size !== undefined) {
                            // Return key relative to pathPrefix so other methods can prepend it
                            let relativeKey = obj.Key;
                            if (config.pathPrefix && obj.Key.startsWith(config.pathPrefix + '/')) {
                                relativeKey = obj.Key.slice(config.pathPrefix.length + 1);
                            }
                            items.push({
                                key: relativeKey,
                                lastModified: obj.LastModified,
                                size: obj.Size,
                                etag: obj.ETag?.replace(/"/g, ''),
                            });
                        }
                    }
                }
                continuationToken = result.NextContinuationToken;
            } while (continuationToken);
            // Sort by last modified (newest first)
            items.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
            console.log(`[S3Upload] Listed ${items.length} backups with prefix: ${fullPrefix}`);
            return { success: true, items };
        }
        catch (error) {
            console.error(`[S3Upload] List backups failed:`, error);
            return {
                success: false,
                items: [],
                error: error.message || 'Failed to list backups',
            };
        }
        finally {
            client.destroy();
        }
    }
    /**
     * Delete a backup object
     */
    async deleteBackup(config, s3Key) {
        const client = this.createClient(config);
        // Don't add prefix if the key already includes it
        const fullKey = s3Key.startsWith(config.pathPrefix || '')
            ? s3Key
            : config.pathPrefix
                ? `${config.pathPrefix}/${s3Key}`
                : s3Key;
        try {
            await client.send(new client_s3_1.DeleteObjectCommand({
                Bucket: config.bucket,
                Key: fullKey,
            }));
            console.log(`[S3Upload] Deleted backup: ${fullKey}`);
            return { success: true };
        }
        catch (error) {
            console.error(`[S3Upload] Delete failed:`, error);
            return {
                success: false,
                error: error.message || 'Delete failed',
            };
        }
        finally {
            client.destroy();
        }
    }
    /**
     * Apply retention policy - delete old backups exceeding retention count
     * @param config S3 storage configuration
     * @param prefix Prefix to filter backups (e.g., "app-config/", "servers/srv_123/")
     * @param retentionCount Number of backups to keep (deletes oldest beyond this)
     * @returns List of deleted keys
     */
    async applyRetentionPolicy(config, prefix, retentionCount) {
        try {
            // List all backups with prefix
            const listResult = await this.listBackups(config, prefix);
            if (!listResult.success) {
                return { success: false, deletedKeys: [], error: listResult.error };
            }
            const items = listResult.items;
            // If we have fewer or equal to retention count, nothing to delete
            if (items.length <= retentionCount) {
                console.log(`[S3Upload] Retention: ${items.length} backups, keeping all (limit: ${retentionCount})`);
                return { success: true, deletedKeys: [] };
            }
            // Items are already sorted newest first, so delete from retentionCount onwards
            const toDelete = items.slice(retentionCount);
            const deletedKeys = [];
            const errors = [];
            for (const item of toDelete) {
                const result = await this.deleteBackup(config, item.key);
                if (result.success) {
                    deletedKeys.push(item.key);
                }
                else {
                    errors.push(`${item.key}: ${result.error}`);
                }
            }
            console.log(`[S3Upload] Retention: deleted ${deletedKeys.length} old backups, kept ${retentionCount}`);
            if (errors.length > 0) {
                return {
                    success: false,
                    deletedKeys,
                    error: `Some deletions failed: ${errors.join('; ')}`,
                };
            }
            return { success: true, deletedKeys };
        }
        catch (error) {
            console.error(`[S3Upload] Retention policy failed:`, error);
            return {
                success: false,
                deletedKeys: [],
                error: error.message || 'Retention policy failed',
            };
        }
    }
    /**
     * Get object metadata (size, last modified, etc.)
     */
    async getObjectMetadata(config, s3Key) {
        const client = this.createClient(config);
        const fullKey = config.pathPrefix ? `${config.pathPrefix}/${s3Key}` : s3Key;
        try {
            const result = await client.send(new client_s3_1.HeadObjectCommand({
                Bucket: config.bucket,
                Key: fullKey,
            }));
            return {
                success: true,
                size: result.ContentLength,
                lastModified: result.LastModified,
                contentType: result.ContentType,
                metadata: result.Metadata,
            };
        }
        catch (error) {
            console.error(`[S3Upload] Get metadata failed:`, error);
            if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
                return { success: false, error: 'Object not found' };
            }
            return {
                success: false,
                error: error.message || 'Failed to get metadata',
            };
        }
        finally {
            client.destroy();
        }
    }
}
exports.S3UploadService = S3UploadService;
// Export singleton instance
exports.s3UploadService = new S3UploadService();
//# sourceMappingURL=S3UploadService.js.map