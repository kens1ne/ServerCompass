"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.templateService = exports.TemplateService = void 0;
const electron_1 = require("electron");
class TemplateService {
    sshService;
    constructor(sshService) {
        this.sshService = sshService;
    }
    /**
     * Send deployment log to renderer
     */
    sendDeploymentLog(message, type = 'info') {
        const log = {
            message,
            type,
            timestamp: Date.now(),
        };
        const windows = electron_1.BrowserWindow.getAllWindows();
        windows.forEach((win) => {
            win.webContents.send('deployment:log', log);
        });
        console.log(`[TemplateService] ${type.toUpperCase()}: ${message}`);
    }
    /**
     * Deploy a Jekyll static site
     */
    async deployJekyll(config) {
        const { serverId, appName, siteName, port } = config;
        const workingDir = `/root/apps/${appName}`;
        this.sendDeploymentLog('Starting Jekyll deployment...', 'info');
        try {
            // Step 1: Update system packages
            this.sendDeploymentLog('Updating system packages...', 'info');
            await this.executeStep(serverId, {
                name: 'Update system',
                commands: ['sudo apt update && sudo apt upgrade -y'],
                description: 'Update package lists and upgrade existing packages',
            });
            this.sendDeploymentLog('System packages updated', 'success');
            // Step 2: Install Ruby and dependencies
            this.sendDeploymentLog('Installing Ruby and build dependencies...', 'info');
            await this.executeStep(serverId, {
                name: 'Install Ruby',
                commands: ['sudo apt install ruby-full build-essential zlib1g-dev -y'],
                description: 'Install Ruby runtime and build dependencies',
            });
            this.sendDeploymentLog('Ruby installed', 'success');
            // Step 3: Configure RubyGems environment
            this.sendDeploymentLog('Configuring RubyGems environment...', 'info');
            const homeDir = await this.sshService.getHomeDirectory(serverId);
            if (!homeDir) {
                throw new Error('Could not determine home directory');
            }
            await this.sshService.executeCommand(serverId, `
        grep -q 'GEM_HOME=' ~/.bashrc || {
          echo '' >> ~/.bashrc
          echo '# Install Ruby Gems to ~/.gems' >> ~/.bashrc
          echo 'export GEM_HOME="$HOME/.gems"' >> ~/.bashrc
          echo 'export PATH="$HOME/.gems/bin:$PATH"' >> ~/.bashrc
        }
      `);
            this.sendDeploymentLog('RubyGems environment configured', 'success');
            // Step 4: Install Jekyll and Bundler
            this.sendDeploymentLog('Installing Jekyll and Bundler...', 'info');
            await this.sshService.executeCommand(serverId, 'export GEM_HOME="$HOME/.gems" && export PATH="$HOME/.gems/bin:$PATH" && gem install jekyll bundler');
            this.sendDeploymentLog('Jekyll and Bundler installed', 'success');
            // Step 5: Create working directory
            this.sendDeploymentLog(`Creating site directory at ${workingDir}...`, 'info');
            await this.sshService.executeCommand(serverId, `sudo mkdir -p ${workingDir}`);
            const currentUser = await this.sshService.executeCommand(serverId, 'whoami');
            await this.sshService.executeCommand(serverId, `sudo chown ${currentUser.stdout.trim()}:${currentUser.stdout.trim()} ${workingDir}`);
            // Step 6: Create new Jekyll site
            this.sendDeploymentLog(`Creating new Jekyll site "${siteName}"...`, 'info');
            await this.sshService.executeCommand(serverId, `cd ${workingDir} && export GEM_HOME="$HOME/.gems" && export PATH="$HOME/.gems/bin:$PATH" && jekyll new . --force`);
            this.sendDeploymentLog('Jekyll site created', 'success');
            // Step 7: Configure site
            this.sendDeploymentLog('Configuring Jekyll site...', 'info');
            await this.sshService.executeCommand(serverId, `cd ${workingDir} && sed -i 's/title: .*/title: ${siteName}/' _config.yml`);
            // Step 8: Install PM2 if not already installed
            this.sendDeploymentLog('Checking PM2 installation...', 'info');
            const pm2Check = await this.sshService.executeCommand(serverId, 'command -v pm2');
            if (!pm2Check.stdout.trim()) {
                this.sendDeploymentLog('Installing PM2...', 'info');
                await this.sshService.executeCommand(serverId, 'sudo npm install -g pm2');
                this.sendDeploymentLog('PM2 installed', 'success');
            }
            // Step 9: Create PM2 ecosystem file
            this.sendDeploymentLog('Creating PM2 configuration...', 'info');
            const ecosystemConfig = `
module.exports = {
  apps: [{
    name: '${appName}',
    cwd: '${workingDir}',
    script: 'bundle',
    args: 'exec jekyll serve --host 0.0.0.0 --port ${port}',
    env: {
      GEM_HOME: '${homeDir}/.gems',
      PATH: '${homeDir}/.gems/bin:/usr/local/bin:/usr/bin:/bin'
    },
    autorestart: true,
    watch: false,
    max_memory_restart: '500M'
  }]
};
      `.trim();
            await this.sshService.executeCommand(serverId, `cat > ${workingDir}/ecosystem.config.js << 'EOF'\n${ecosystemConfig}\nEOF`);
            // Step 10: Start with PM2
            this.sendDeploymentLog('Starting Jekyll server with PM2...', 'info');
            // Stop any existing process with the same name
            await this.sshService.executeCommand(serverId, `pm2 delete ${appName} || true`);
            // Start the new process
            await this.sshService.executeCommand(serverId, `cd ${workingDir} && pm2 start ecosystem.config.js`);
            await this.sshService.executeCommand(serverId, 'pm2 save');
            this.sendDeploymentLog('Jekyll server started', 'success');
            // Step 11: Get server IP
            const ipResult = await this.sshService.executeCommand(serverId, "hostname -I | awk '{print $1}'");
            const serverIp = ipResult.stdout.trim();
            const url = `http://${serverIp}:${port}`;
            // Step 12: Generate documentation
            this.sendDeploymentLog('Generating deployment documentation...', 'info');
            const docsContent = await this.generateJekyllDocs({
                appName,
                siteName,
                port,
                url,
                directory: workingDir,
            });
            // Write documentation to server
            const docsDir = `${workingDir}/docs`;
            await this.sshService.executeCommand(serverId, `mkdir -p ${docsDir}`);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const docsFileName = `deployment-${timestamp}.md`;
            const docsPath = `${docsDir}/${docsFileName}`;
            await this.sshService.executeCommand(serverId, `cat > ${docsPath} << 'DOCEOF'\n${docsContent}\nDOCEOF`);
            this.sendDeploymentLog('Documentation generated', 'success');
            this.sendDeploymentLog(`✓ Deployment complete! Site available at ${url}`, 'success');
            return {
                url,
                port,
                docsPath,
                docsContent,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.sendDeploymentLog(`Deployment failed: ${errorMessage}`, 'error');
            throw error;
        }
    }
    /**
     * Execute a single installation step
     */
    async executeStep(serverId, step) {
        this.sendDeploymentLog(`Running: ${step.name}`, 'info');
        for (const command of step.commands) {
            const result = await this.sshService.executeCommand(serverId, command);
            if (result.exitCode !== 0) {
                throw new Error(`Command failed: ${command}\nExit code: ${result.exitCode}\nStderr: ${result.stderr}`);
            }
        }
    }
    /**
     * Generate Jekyll deployment documentation
     */
    async generateJekyllDocs(data) {
        const { appName, siteName, port, url, directory } = data;
        const timestamp = new Date().toISOString();
        return `# Jekyll Site Deployment Report

**Date:** ${timestamp}
**App Name:** ${appName}
**Site Name:** ${siteName}
**Template:** Jekyll 4.x

## Access Information
- **URL:** ${url}
- **Port:** ${port}
- **Directory:** ${directory}

## What Was Installed
- Ruby (system version)
- Jekyll 4.x
- Bundler (latest)
- PM2 Process Manager

## File Structure
\`\`\`
${directory}/
├── _config.yml      # Site configuration
├── _posts/          # Blog posts go here
├── _site/           # Generated static files
├── Gemfile          # Ruby dependencies
├── index.md         # Homepage
└── ecosystem.config.js  # PM2 configuration
\`\`\`

## Useful Commands

### View application logs
\`\`\`bash
pm2 logs ${appName}
\`\`\`

### Restart the service
\`\`\`bash
pm2 restart ${appName}
\`\`\`

### Stop the service
\`\`\`bash
pm2 stop ${appName}
\`\`\`

### Edit site configuration
\`\`\`bash
nano ${directory}/_config.yml
\`\`\`

### Create a new blog post
\`\`\`bash
cd ${directory}
bundle exec jekyll post "My New Post Title"
\`\`\`

### Build site manually
\`\`\`bash
cd ${directory}
bundle exec jekyll build
\`\`\`

### Serve site with live reload (development)
\`\`\`bash
cd ${directory}
bundle exec jekyll serve --host 0.0.0.0
\`\`\`

## Next Steps
1. **Add Content:** Create markdown files in \`_posts/\` directory following the naming convention: \`YYYY-MM-DD-title.md\`
2. **Customize Configuration:** Edit \`_config.yml\` to set your site title, description, and other settings
3. **Choose a Theme:** Browse themes at http://jekyllthemes.org/ and install your favorite
4. **Set Up Custom Domain:** Configure a domain to point to your server (optional)
5. **Enable SSL:** Set up HTTPS with Let's Encrypt for secure connections

## Writing Your First Post

Create a file in \`_posts/\` directory:
\`\`\`bash
cd ${directory}/_posts
nano $(date +%Y-%m-%d)-my-first-post.md
\`\`\`

Add this content:
\`\`\`markdown
---
layout: post
title: "My First Post"
date: $(date +%Y-%m-%d %H:%M:%S %z)
categories: blog
---

# Welcome to my Jekyll site!

This is my first blog post. Jekyll will automatically convert this markdown to HTML.

## Features
- Easy to write in Markdown
- Fast static site generation
- No database required
\`\`\`

## Customizing Your Site

### Change Site Title and Description
Edit \`_config.yml\`:
\`\`\`yaml
title: ${siteName}
description: >- # this means to ignore newlines until next key
  Write an awesome description for your new site here.
baseurl: "" # the subpath of your site, e.g. /blog
url: "${url}" # the base hostname & protocol for your site
\`\`\`

### Install a Theme
Browse themes at http://jekyllthemes.org/, then update your \`Gemfile\`:
\`\`\`ruby
gem "minima", "~> 2.5"  # Replace with your chosen theme
\`\`\`

Run:
\`\`\`bash
cd ${directory}
bundle install
pm2 restart ${appName}
\`\`\`

## Resources
- **Jekyll Documentation:** https://jekyllrb.com/docs/
- **Theme Gallery:** http://jekyllthemes.org/
- **Markdown Guide:** https://www.markdownguide.org/
- **Jekyll Talk Community:** https://talk.jekyllrb.com/

## Troubleshooting

### Site not updating?
Restart the PM2 process:
\`\`\`bash
pm2 restart ${appName}
\`\`\`

### Permission errors?
Ensure RubyGems environment is configured:
\`\`\`bash
echo $GEM_HOME    # Should output: /home/youruser/.gems
\`\`\`

### Port already in use?
Check what's running on port ${port}:
\`\`\`bash
sudo lsof -i :${port}
pm2 list
\`\`\`

### View detailed logs
\`\`\`bash
pm2 logs ${appName} --lines 100
\`\`\`

---
Generated by ServerCompass on ${timestamp}
`;
    }
}
exports.TemplateService = TemplateService;
// Export singleton instance
exports.templateService = new TemplateService(require('./SSHService').sshService);
//# sourceMappingURL=TemplateService.js.map