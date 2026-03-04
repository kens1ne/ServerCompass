"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = migrate;
function migrate(db) {
    // Add deployment strategy to stacks
    // Values: 'standard' | 'zero_downtime'
    const stackColumns = db.prepare(`PRAGMA table_info(docker_stacks)`).all();
    if (!stackColumns.some(c => c.name === 'deployment_strategy')) {
        db.exec(`
      ALTER TABLE docker_stacks ADD COLUMN deployment_strategy TEXT DEFAULT 'standard';
    `);
    }
    // Track staging during deployment
    if (!stackColumns.some(c => c.name === 'staging_project_name')) {
        db.exec(`
      ALTER TABLE docker_stacks ADD COLUMN staging_project_name TEXT;
    `);
    }
    // Track stateful services (auto-detected from volumes, for database-safe mode)
    if (!stackColumns.some(c => c.name === 'stateful_services')) {
        db.exec(`
      ALTER TABLE docker_stacks ADD COLUMN stateful_services TEXT;
    `);
    }
    // Add app_port column to stacks for tracking the primary app port
    if (!stackColumns.some(c => c.name === 'app_port')) {
        db.exec(`
      ALTER TABLE docker_stacks ADD COLUMN app_port INTEGER;
    `);
    }
    // Deployment tracking - add traffic_switched_at
    const deploymentColumns = db.prepare(`PRAGMA table_info(docker_stack_deployments)`).all();
    if (!deploymentColumns.some(c => c.name === 'traffic_switched_at')) {
        db.exec(`
      ALTER TABLE docker_stack_deployments ADD COLUMN traffic_switched_at INTEGER;
    `);
    }
    // Store the compose content that was DEPLOYED in this deployment (for rollback)
    // Note: previous_compose_content stores what was there BEFORE this deployment
    // compose_content stores what was actually deployed IN this deployment
    if (!deploymentColumns.some(c => c.name === 'compose_content')) {
        db.exec(`
      ALTER TABLE docker_stack_deployments ADD COLUMN compose_content TEXT;
    `);
    }
}
//# sourceMappingURL=035_zero_downtime_deployment.js.map