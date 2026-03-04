"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTemplateHandlers = registerTemplateHandlers;
const electron_1 = require("electron");
const types_1 = require("./types");
const TemplateService_1 = require("../services/TemplateService");
// Import templates from frontend data (we'll need to move this to shared location)
const TEMPLATES = [
    {
        id: 'jekyll',
        name: 'Jekyll',
        description: 'A simple, blog-aware, static site generator for personal, project, or organization sites',
        category: 'static-site',
        icon: '📄',
        version: '4.3.2',
        supported: true,
        requirements: ['Ruby 2.7+', 'Build tools', 'Git'],
        defaultPort: 4000,
    },
    {
        id: 'ghost',
        name: 'Ghost',
        description: 'Professional publishing platform for modern blogs and content creators',
        category: 'blog',
        icon: '👻',
        version: '5.0',
        supported: false,
        requirements: ['Node.js 18+', 'MySQL 8+', 'Nginx'],
        defaultPort: 2368,
    },
    {
        id: 'strapi',
        name: 'Strapi',
        description: 'Open-source headless CMS for building powerful APIs with no effort',
        category: 'cms',
        icon: '🚀',
        version: '4.0',
        supported: false,
        requirements: ['Node.js 18+', 'Database (PostgreSQL/MySQL)', 'PM2'],
        defaultPort: 1337,
    },
];
function registerTemplateHandlers() {
    // List available templates
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TEMPLATE_LIST, async (_event, input) => {
        try {
            types_1.ListTemplatesSchema.parse(input);
            return { success: true, data: TEMPLATES };
        }
        catch (error) {
            console.error('Error listing templates:', error);
            return { success: false, error: String(error) };
        }
    });
    // Deploy a template
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.TEMPLATE_DEPLOY, async (_event, input) => {
        try {
            const validated = types_1.TemplateDeploySchema.parse(input);
            const { serverId, templateId, appName, siteName } = validated;
            console.log(`[Templates] Deploying ${templateId} template for app: ${appName}`);
            // Find template
            const template = TEMPLATES.find((t) => t.id === templateId);
            if (!template) {
                return { success: false, error: `Template ${templateId} not found` };
            }
            if (!template.supported) {
                return {
                    success: false,
                    error: `Template ${template.name} is not yet supported. Coming soon!`,
                };
            }
            // Deploy based on template type
            let result;
            switch (templateId) {
                case 'jekyll':
                    result = await TemplateService_1.templateService.deployJekyll({
                        serverId,
                        appName,
                        siteName: siteName || appName,
                        port: template.defaultPort,
                    });
                    break;
                default:
                    return {
                        success: false,
                        error: `Deployment for template ${templateId} is not implemented yet`,
                    };
            }
            console.log(`[Templates] Deployment successful:`, result);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('Error deploying template:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    });
}
//# sourceMappingURL=templates.js.map