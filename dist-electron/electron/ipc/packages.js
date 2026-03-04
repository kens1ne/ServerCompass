"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPackagesHandlers = registerPackagesHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const SSHService_1 = require("../services/SSHService");
function registerPackagesHandlers() {
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.PACKAGES_LIST, async (_event, input) => {
        try {
            const { serverId } = types_1.ListPackagesSchema.parse(input);
            // Execute command to list all installed packages
            // Using apt list --installed which has better formatting
            const result = await SSHService_1.sshService.executeCommand(serverId, 'apt list --installed 2>/dev/null | tail -n +2' // Skip the "Listing..." header
            );
            if (!result.stdout) {
                return { success: true, data: [] };
            }
            const packages = [];
            const lines = result.stdout.trim().split('\n');
            for (const line of lines) {
                // Format: package/source,now version architecture [status]
                // Example: acl/noble-updates,now 2.3.2-1build1.1 amd64 [installed]
                // Match the pattern: package_name/... version architecture [...]
                const match = line.match(/^([^/]+)\/\S+\s+(\S+)\s+(\S+)\s+\[/);
                if (match) {
                    const [, name, version, architecture] = match;
                    packages.push({
                        name,
                        version,
                        architecture,
                    });
                }
            }
            return { success: true, data: packages };
        }
        catch (error) {
            console.error('Error listing packages:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.PACKAGES_UPDATE, async (_event, input) => {
        try {
            const { serverId, packageName } = types_1.UpdatePackageSchema.parse(input);
            // Execute apt update and upgrade for specific package
            await SSHService_1.sshService.executeCommand(serverId, `sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y ${packageName}`);
            return { success: true };
        }
        catch (error) {
            console.error('Error updating package:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.PACKAGES_REMOVE, async (_event, input) => {
        try {
            const { serverId, packageName } = types_1.RemovePackageSchema.parse(input);
            // Execute apt remove command
            await SSHService_1.sshService.executeCommand(serverId, `sudo DEBIAN_FRONTEND=noninteractive apt-get remove -y ${packageName}`);
            return { success: true };
        }
        catch (error) {
            console.error('Error removing package:', error);
            return { success: false, error: String(error) };
        }
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.PACKAGES_INSTALL_RECOMMENDED, async (_event, input) => {
        try {
            const { serverId } = types_1.InstallRecommendedSchema.parse(input);
            const recommendedPackages = [
                'git',
                'curl',
                'nginx',
                'ufw',
                'certbot',
                'python3-certbot-nginx',
                'build-essential',
                'software-properties-common',
                'snapd',
                'unzip',
                'wget',
                'htop',
                'net-tools',
            ];
            const logs = [];
            // Update package list
            logs.push('Updating package list...');
            await SSHService_1.sshService.executeCommand(serverId, 'sudo apt-get update');
            logs.push('Package list updated.');
            // Upgrade existing packages
            logs.push('Upgrading existing packages...');
            await SSHService_1.sshService.executeCommand(serverId, 'sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y');
            logs.push('Existing packages upgraded.');
            // Install recommended packages
            logs.push('Installing recommended packages...');
            const installCommand = `sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${recommendedPackages.join(' ')}`;
            const result = await SSHService_1.sshService.executeCommand(serverId, installCommand);
            if (result.stdout) {
                logs.push(result.stdout);
            }
            if (result.stderr) {
                logs.push(`Warnings: ${result.stderr}`);
            }
            logs.push('All recommended packages installed successfully!');
            logs.push('');
            logs.push('Installed packages:');
            recommendedPackages.forEach(pkg => {
                logs.push(`  - ${pkg}`);
            });
            return { success: true, data: { logs } };
        }
        catch (error) {
            console.error('Error installing recommended packages:', error);
            return { success: false, error: String(error) };
        }
    });
}
//# sourceMappingURL=packages.js.map