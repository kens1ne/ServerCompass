"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.monitoringAgentService = void 0;
const db_1 = require("../db");
const SSHService_1 = require("./SSHService");
const crypto_1 = require("crypto");
const CredentialVault_1 = require("./CredentialVault");
// Agent version - increment when updating agent scripts
const AGENT_VERSION = '1.0.7';
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
// ============================================================================
// Agent Source Code
// These scripts are installed on the VPS for monitoring
// ============================================================================
const AGENT_SCRIPT = `#!/bin/bash
# ============================================================================
# ServerCompass Monitoring Agent v${AGENT_VERSION}
# https://github.com/servercompass/agent
#
# This script collects system metrics and sends alerts when thresholds are
# exceeded. It runs as a systemd service and executes every 60 seconds.
#
# Location: ~/server-compass/agents/monitoring/agent.sh
# Config:   ~/server-compass/agents/monitoring/config.json
# Logs:     ~/server-compass/agents/monitoring/logs/
# ============================================================================

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$AGENT_DIR/config.json"
STATE_FILE="$AGENT_DIR/state.json"
LOG_FILE="$AGENT_DIR/logs/agent.log"
NOTIFY_SCRIPT="$AGENT_DIR/notify.sh"

# Ensure log directory exists
mkdir -p "$AGENT_DIR/logs"

# Read log settings from config
get_log_setting() {
  local key="$1" default="$2"
  if [[ -f "$CONFIG_FILE" ]]; then
    jq -r ".logs.$key // $default" "$CONFIG_FILE" 2>/dev/null || echo "$default"
  else
    echo "$default"
  fi
}

MAX_LOG_LINES=$(get_log_setting "max_lines" 1000)
MAX_LOG_SIZE_MB=$(get_log_setting "max_size_mb" 10)
RETENTION_DAYS=$(get_log_setting "retention_days" 7)

# Rotate log if it exceeds max lines or size
rotate_log() {
  local log_file="$1"
  local max_lines="$2"
  local max_size_mb="$3"

  [[ ! -f "$log_file" ]] && return

  # Check size (in MB)
  local size_mb=$(du -m "$log_file" 2>/dev/null | cut -f1)
  if [[ "$size_mb" -ge "$max_size_mb" ]]; then
    # Rotate: keep last N lines, archive old
    local timestamp=$(date +%Y%m%d_%H%M%S)
    mv "$log_file" "\${log_file}.\${timestamp}"
    gzip "\${log_file}.\${timestamp}" 2>/dev/null || true
    touch "$log_file"
    return
  fi

  # Check line count
  local line_count=$(wc -l < "$log_file" 2>/dev/null || echo 0)
  if [[ "$line_count" -gt "$max_lines" ]]; then
    # Keep only last max_lines
    local temp_file=$(mktemp)
    tail -n "$max_lines" "$log_file" > "$temp_file"
    mv "$temp_file" "$log_file"
  fi
}

# Clean old log archives
cleanup_old_logs() {
  find "$AGENT_DIR/logs" -name "*.gz" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true
}

# Log function with rotation
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
  rotate_log "$LOG_FILE" "$MAX_LOG_LINES" "$MAX_LOG_SIZE_MB"
}

# Collect metrics
collect_metrics() {
  local cpu_usage memory_used memory_total disk_used disk_total load_1m load_5m load_15m cores

  # Get number of CPU cores
  cores=$(nproc 2>/dev/null || echo "1")

  # Load average
  load_avg=$(cat /proc/loadavg 2>/dev/null || echo "0 0 0")
  load_1m=$(echo "$load_avg" | awk '{print $1}')
  load_5m=$(echo "$load_avg" | awk '{print $2}')
  load_15m=$(echo "$load_avg" | awk '{print $3}')

  # CPU usage (percentage) - calculate from load average like the app does
  # Formula: (load_1m / cores) * 100, clamped to 0-100
  cpu_usage=$(echo "scale=2; l=$load_1m; c=$cores; u=l/c*100; if(u>100) u=100; if(u<0) u=0; u" | bc)

  # Memory (bytes)
  memory_info=$(free -b 2>/dev/null | grep Mem || echo "Mem: 0 0 0")
  memory_total=$(echo "$memory_info" | awk '{print $2}')
  memory_used=$(echo "$memory_info" | awk '{print $3}')

  # Disk (bytes) - root partition
  disk_info=$(df -B1 / 2>/dev/null | tail -1 || echo "/ 0 0 0")
  disk_total=$(echo "$disk_info" | awk '{print $2}')
  disk_used=$(echo "$disk_info" | awk '{print $3}')

  # Output as JSON
  cat <<EOF
{
  "cpu_usage": $cpu_usage,
  "memory_used": $memory_used,
  "memory_total": $memory_total,
  "disk_used": $disk_used,
  "disk_total": $disk_total,
  "load_1m": $load_1m,
  "load_5m": $load_5m,
  "load_15m": $load_15m,
  "timestamp": $(date +%s)
}
EOF
}

# Calculate percentage
calc_percent() {
  local used=$1 total=$2
  if [[ "$total" -eq 0 ]]; then
    echo "0"
  else
    echo "scale=2; $used * 100 / $total" | bc
  fi
}

# Check if value exceeds threshold
check_threshold() {
  local value=$1 operator=$2 threshold=$3
  case "$operator" in
    ">")  (( $(echo "$value > $threshold" | bc -l) )) ;;
    "<")  (( $(echo "$value < $threshold" | bc -l) )) ;;
    ">=") (( $(echo "$value >= $threshold" | bc -l) )) ;;
    "<=") (( $(echo "$value <= $threshold" | bc -l) )) ;;
    *)    return 1 ;;
  esac
}

# Evaluate alert rules
evaluate_rules() {
  local metrics="$1"

  # Read config
  if [[ ! -f "$CONFIG_FILE" ]]; then
    log "ERROR: Config file not found: $CONFIG_FILE"
    return 1
  fi

  # Read current state
  local state="{}"
  if [[ -f "$STATE_FILE" ]]; then
    state=$(cat "$STATE_FILE")
  fi

  # Parse metrics
  local cpu_usage=$(echo "$metrics" | jq -r '.cpu_usage')
  local memory_used=$(echo "$metrics" | jq -r '.memory_used')
  local memory_total=$(echo "$metrics" | jq -r '.memory_total')
  local disk_used=$(echo "$metrics" | jq -r '.disk_used')
  local disk_total=$(echo "$metrics" | jq -r '.disk_total')
  local load_5m=$(echo "$metrics" | jq -r '.load_5m')

  local memory_percent=$(calc_percent "$memory_used" "$memory_total")
  local disk_percent=$(calc_percent "$disk_used" "$disk_total")

  # Iterate over rules
  local rules=$(jq -c '.rules[]' "$CONFIG_FILE" 2>/dev/null || echo "")

  while IFS= read -r rule; do
    [[ -z "$rule" ]] && continue

    local rule_id=$(echo "$rule" | jq -r '.id')
    local rule_name=$(echo "$rule" | jq -r '.name')
    local metric=$(echo "$rule" | jq -r '.metric')
    local operator=$(echo "$rule" | jq -r '.operator')
    local threshold=$(echo "$rule" | jq -r '.threshold')
    local severity=$(echo "$rule" | jq -r '.severity')
    local enabled=$(echo "$rule" | jq -r '.enabled')

    [[ "$enabled" != "true" ]] && continue

    # Get metric value
    local value
    case "$metric" in
      "cpu_usage")     value="$cpu_usage" ;;
      "memory_usage")  value="$memory_percent" ;;
      "disk_usage")    value="$disk_percent" ;;
      "load_5m")       value="$load_5m" ;;
      *)               continue ;;
    esac

    # Check if currently firing
    local is_firing=$(echo "$state" | jq -r --arg id "$rule_id" '.[$id].firing // false')

    # Evaluate threshold
    if check_threshold "$value" "$operator" "$threshold"; then
      if [[ "$is_firing" != "true" ]]; then
        # New alert - fire notification
        log "ALERT FIRING: $rule_name ($metric $operator $threshold, current: $value)"

        "$NOTIFY_SCRIPT" \\
          --severity "$severity" \\
          --title "$rule_name" \\
          --message "$metric is $value (threshold: $operator $threshold)" \\
          --status "firing"

        # Update state
        state=$(echo "$state" | jq --arg id "$rule_id" '.[$id] = {"firing": true, "since": now}')
      fi
    else
      if [[ "$is_firing" == "true" ]]; then
        # Alert resolved
        log "ALERT RESOLVED: $rule_name ($metric is now $value)"

        "$NOTIFY_SCRIPT" \\
          --severity "info" \\
          --title "$rule_name" \\
          --message "$metric is now $value (recovered)" \\
          --status "resolved"

        # Update state
        state=$(echo "$state" | jq --arg id "$rule_id" 'del(.[$id])')
      fi
    fi
  done <<< "$rules"

  # Save state
  echo "$state" > "$STATE_FILE"
}

# Main execution
main() {
  log "Starting metrics collection..."

  # Cleanup old log archives periodically
  cleanup_old_logs

  # Collect metrics
  local metrics
  metrics=$(collect_metrics)

  log "Metrics collected: CPU=$(echo "$metrics" | jq -r '.cpu_usage')%"

  # Evaluate rules
  evaluate_rules "$metrics"

  log "Evaluation complete."
}

main "$@"
`;
const NOTIFY_SCRIPT = `#!/bin/bash
# ============================================================================
# ServerCompass Notification Dispatcher
# Sends alerts to configured channels (Email, Slack, Discord, Webhooks)
#
# Location: ~/server-compass/agents/monitoring/notify.sh
# ============================================================================

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$AGENT_DIR/config.json"
LOG_FILE="$AGENT_DIR/logs/notifications.log"

# Ensure log directory exists
mkdir -p "$AGENT_DIR/logs"

# Parse arguments
SEVERITY=""
TITLE=""
MESSAGE=""
STATUS=""
CHANNEL_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --severity) SEVERITY="$2"; shift 2 ;;
    --title)    TITLE="$2"; shift 2 ;;
    --message)  MESSAGE="$2"; shift 2 ;;
    --status)   STATUS="$2"; shift 2 ;;
    --channel-id) CHANNEL_ID="$2"; shift 2 ;;
    *)          shift ;;
  esac
done

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Get server name from config, fallback to hostname
SERVER_NAME=$(jq -r '.server_name // empty' "$CONFIG_FILE" 2>/dev/null)
if [[ -z "$SERVER_NAME" ]]; then
  SERVER_NAME=$(hostname)
fi

# Send to Slack
send_slack() {
  local webhook_url="$1"
  local color

  case "$SEVERITY" in
    "critical") color="danger" ;;
    "warning")  color="warning" ;;
    *)          color="good" ;;
  esac

  [[ "$STATUS" == "resolved" ]] && color="good"

  local icon="🔴"
  [[ "$STATUS" == "resolved" ]] && icon="✅"

  local payload=$(cat <<EOF
{
  "attachments": [{
    "color": "$color",
    "title": "$icon $TITLE",
    "text": "$MESSAGE",
    "fields": [
      {"title": "Server", "value": "$SERVER_NAME", "short": true},
      {"title": "Status", "value": "$STATUS", "short": true}
    ],
    "footer": "ServerCompass Agent",
    "ts": $(date +%s)
  }]
}
EOF
)

  curl -s -X POST -H "Content-Type: application/json" -d "$payload" -- "$webhook_url" > /dev/null 2>&1 || true
  log "Slack notification sent: $TITLE"
}

# Send to Discord
send_discord() {
  local webhook_url="$1"
  local color

  case "$SEVERITY" in
    "critical") color=16711680 ;;  # Red
    "warning")  color=16753920 ;;  # Orange
    *)          color=65280 ;;     # Green
  esac

  [[ "$STATUS" == "resolved" ]] && color=65280

  local icon="🔴"
  [[ "$STATUS" == "resolved" ]] && icon="✅"

  local payload=$(cat <<EOF
{
  "embeds": [{
    "title": "$icon $TITLE",
    "description": "$MESSAGE",
    "color": $color,
    "fields": [
      {"name": "Server", "value": "$SERVER_NAME", "inline": true},
      {"name": "Status", "value": "$STATUS", "inline": true}
    ],
    "footer": {"text": "ServerCompass Agent"},
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  }]
}
EOF
)

  curl -s -X POST -H "Content-Type: application/json" -d "$payload" -- "$webhook_url" > /dev/null 2>&1 || true
  log "Discord notification sent: $TITLE"
}

# Send email via HTTP API (e.g., SendGrid, Resend, Postmark)
send_email_api() {
  local api_url="$1"
  local api_key="$2"
  local from="$3"
  local to="$4"
  local provider="$5"

  local icon="🔴"
  [[ "$STATUS" == "resolved" ]] && icon="✅"

  local subject="$icon [$SEVERITY] $TITLE - $SERVER_NAME"
  local html_body="<h2>$TITLE</h2><p>$MESSAGE</p><p><strong>Server:</strong> $SERVER_NAME</p><p><strong>Status:</strong> $STATUS</p><hr><p style='color:#888'>Sent by ServerCompass Agent</p>"

  local payload
  local auth_header="Authorization: Bearer $api_key"

  case "$provider" in
    "sendgrid")
      payload=$(cat <<EOF
{
  "personalizations": [{"to": [{"email": "$to"}]}],
  "from": {"email": "$from"},
  "subject": "$subject",
  "content": [{"type": "text/html", "value": "$html_body"}]
}
EOF
)
      ;;
    "postmark")
      auth_header="X-Postmark-Server-Token: $api_key"
      payload=$(cat <<EOF
{
  "From": "$from",
  "To": "$to",
  "Subject": "$subject",
  "HtmlBody": "$html_body"
}
EOF
)
      ;;
    "mailgun")
      # Mailgun uses form data, not JSON
      curl -s -X POST \\
        -u "api:$api_key" \\
        -F from="$from" \\
        -F to="$to" \\
        -F subject="$subject" \\
        -F html="$html_body" \\
        -- "$api_url" > /dev/null 2>&1 || true
      log "Email notification sent via Mailgun: $TITLE"
      return
      ;;
    *)
      # Default format (works for Resend and custom APIs)
      payload=$(cat <<EOF
{
  "from": "$from",
  "to": "$to",
  "subject": "$subject",
  "html": "$html_body"
}
EOF
)
      ;;
  esac

  curl -s -X POST -H "Content-Type: application/json" -H "$auth_header" -d "$payload" -- "$api_url" > /dev/null 2>&1 || true
  log "Email notification sent via $provider: $TITLE"
}

# Send email via SMTP (e.g., Gmail)
send_email_smtp() {
  local smtp_host="$1"
  local smtp_port="$2"
  local smtp_user="$3"
  local smtp_password="$4"
  local from="$5"
  local to="$6"

  local icon="🔴"
  [[ "$STATUS" == "resolved" ]] && icon="✅"

  local subject="$icon [$SEVERITY] $TITLE - $SERVER_NAME"
  local body="<h2>$TITLE</h2><p>$MESSAGE</p><p><strong>Server:</strong> $SERVER_NAME</p><p><strong>Status:</strong> $STATUS</p><hr><p style='color:#888'>Sent by ServerCompass Agent</p>"

  # Use curl to send email via SMTP
  curl -s --ssl-reqd \\
    --url "smtp://$smtp_host:$smtp_port" \\
    --user "$smtp_user:$smtp_password" \\
    --mail-from "$from" \\
    --mail-rcpt "$to" \\
    -T - <<EOF
From: $from
To: $to
Subject: $subject
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

$body
EOF

  log "Email notification sent via SMTP: $TITLE"
}

# Send to custom webhook
send_webhook() {
  local url="$1"
  local payload=$(cat <<EOF
{
  "event": "$STATUS",
  "severity": "$SEVERITY",
  "title": "$TITLE",
  "message": "$MESSAGE",
  "hostname": "$SERVER_NAME",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)

  curl -s -X POST -H "Content-Type: application/json" -d "$payload" -- "$url" > /dev/null 2>&1 || true
  log "Webhook notification sent: $TITLE"
}

# Read channels from config and send notifications
main() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    log "ERROR: Config file not found"
    exit 1
  fi

  local channels=$(jq -c '.notification_channels[]' "$CONFIG_FILE" 2>/dev/null || echo "")

  while IFS= read -r channel; do
    [[ -z "$channel" ]] && continue

    local channel_id=$(echo "$channel" | jq -r '.id // empty')
    if [[ -n "$CHANNEL_ID" && "$channel_id" != "$CHANNEL_ID" ]]; then
      continue
    fi

    local type=$(echo "$channel" | jq -r '.type')
    local enabled=$(echo "$channel" | jq -r '.enabled')

    [[ "$enabled" != "true" ]] && continue

    case "$type" in
      "slack")
        local webhook=$(echo "$channel" | jq -r '.webhook_url')
        send_slack "$webhook"
        ;;
      "discord")
        local webhook=$(echo "$channel" | jq -r '.webhook_url')
        send_discord "$webhook"
        ;;
      "email")
        local is_smtp=$(echo "$channel" | jq -r '.is_smtp // false')
        local from=$(echo "$channel" | jq -r '.from')
        local to=$(echo "$channel" | jq -r '.to')
        local provider=$(echo "$channel" | jq -r '.provider // "custom"')

        if [[ "$is_smtp" == "true" ]]; then
          # SMTP-based email (Gmail, etc.)
          local smtp_host=$(echo "$channel" | jq -r '.smtp_host')
          local smtp_port=$(echo "$channel" | jq -r '.smtp_port')
          local smtp_user=$(echo "$channel" | jq -r '.smtp_user')
          local smtp_password=$(echo "$channel" | jq -r '.smtp_password')
          send_email_smtp "$smtp_host" "$smtp_port" "$smtp_user" "$smtp_password" "$from" "$to"
        else
          # HTTP API-based email (Resend, SendGrid, etc.)
          local api_url=$(echo "$channel" | jq -r '.api_url')
          local api_key=$(echo "$channel" | jq -r '.api_key')
          send_email_api "$api_url" "$api_key" "$from" "$to" "$provider"
        fi
        ;;
      "webhook")
        local url=$(echo "$channel" | jq -r '.url')
        send_webhook "$url"
        ;;
    esac
  done <<< "$channels"
}

main
`;
const DEPLOY_NOTIFY_SCRIPT = `#!/bin/bash
# ============================================================================
# ServerCompass Deployment Notifier
# Watches docker containers for a stack and sends notifications when finished.
#
# Location: ~/server-compass/agents/monitoring/deploy-notify.sh
# ============================================================================

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
NOTIFY_SCRIPT="$AGENT_DIR/notify.sh"
LOG_FILE="$AGENT_DIR/logs/deployments.log"

PROJECT=""
DEPLOYMENT_ID=""
WORKING_DIR=""
ACTION="deploy"
TIMEOUT_SECONDS=3600
SLEEP_SECONDS=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --deployment) DEPLOYMENT_ID="$2"; shift 2 ;;
    --working-dir) WORKING_DIR="$2"; shift 2 ;;
    --action) ACTION="$2"; shift 2 ;;
    --timeout) TIMEOUT_SECONDS="$2"; shift 2 ;;
    *) shift ;;
  esac
done

log() {
  local message="$1"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$PROJECT] $message" >> "$LOG_FILE"
}

notify() {
  local severity="$1"
  local title="$2"
  local message="$3"
  local status="$4"

  if [[ -x "$NOTIFY_SCRIPT" ]]; then
    "$NOTIFY_SCRIPT" --severity "$severity" --title "$title" --message "$message" --status "$status" >/dev/null 2>&1 || true
  else
    log "notify.sh missing - unable to send notification"
  fi
}

if [[ -z "$PROJECT" ]]; then
  log "Missing --project"
  exit 1
fi

if [[ -z "$TIMEOUT_SECONDS" || "$TIMEOUT_SECONDS" -lt 60 ]]; then
  TIMEOUT_SECONDS=3600
fi

ACTION_LABEL="Deployment"
if [[ "$ACTION" == "redeploy" ]]; then
  ACTION_LABEL="Redeploy"
fi

start_time=$(date +%s)
empty_cycles=0
unhealthy_cycles=0
restarting_cycles=0

# Wait for compose file to appear (best effort)
if [[ -n "$WORKING_DIR" ]]; then
  for _ in {1..30}; do
    if [[ -f "$WORKING_DIR/docker-compose.yml" || -f "$WORKING_DIR/docker-compose.yaml" ]]; then
      break
    fi
    sleep "$SLEEP_SECONDS"
  done
fi

log "Starting deployment watcher (timeout: $TIMEOUT_SECONDS seconds)"

while true; do
  now=$(date +%s)
  if (( now - start_time > TIMEOUT_SECONDS )); then
    notify "critical" "$ACTION_LABEL timed out" "$ACTION_LABEL timed out for $PROJECT." "failed"
    log "$ACTION_LABEL timed out after $TIMEOUT_SECONDS seconds"
    exit 0
  fi

  mapfile -t lines < <(docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}' | grep "^$PROJECT-" || true)

  if (( \${#lines[@]} == 0 )); then
    empty_cycles=$((empty_cycles + 1))
    if (( empty_cycles > 60 )); then
      notify "critical" "$ACTION_LABEL failed" "No containers found for $PROJECT." "failed"
      log "No containers found after waiting"
      exit 0
    fi
    sleep "$SLEEP_SECONDS"
    continue
  fi

  empty_cycles=0
  total=\${#lines[@]}
  running=0
  exited=0
  restarting=0
  unhealthy=0

  for line in "\${lines[@]}"; do
    state=$(echo "$line" | cut -d'|' -f2)
    status=$(echo "$line" | cut -d'|' -f3)

    if [[ "$state" == "running" ]]; then
      running=$((running + 1))
    else
      exited=$((exited + 1))
    fi

    if [[ "$status" == *"Restarting"* || "$status" == *"restarting"* ]]; then
      restarting=$((restarting + 1))
    fi

    if [[ "$status" == *"unhealthy"* ]]; then
      unhealthy=$((unhealthy + 1))
    fi
  done

  if (( exited > 0 )); then
    notify "critical" "$ACTION_LABEL failed" "$ACTION_LABEL failed for $PROJECT. Check logs." "failed"
    log "Detected exited containers"
    exit 0
  fi

  if (( unhealthy > 0 )); then
    unhealthy_cycles=$((unhealthy_cycles + 1))
  else
    unhealthy_cycles=0
  fi

  if (( restarting > 0 )); then
    restarting_cycles=$((restarting_cycles + 1))
  else
    restarting_cycles=0
  fi

  if (( unhealthy_cycles > 12 )); then
    notify "critical" "$ACTION_LABEL unhealthy" "$ACTION_LABEL unhealthy for $PROJECT. Check health checks." "failed"
    log "Containers unhealthy for too long"
    exit 0
  fi

  if (( restarting_cycles > 12 )); then
    notify "critical" "$ACTION_LABEL restarting" "$ACTION_LABEL restarting for $PROJECT. Check logs." "failed"
    log "Containers restarting for too long"
    exit 0
  fi

  if (( running == total )); then
    notify "info" "$ACTION_LABEL complete" "$ACTION_LABEL finished for $PROJECT." "resolved"
    log "$ACTION_LABEL completed successfully"
    exit 0
  fi

  sleep "$SLEEP_SECONDS"
done
`;
const SYSTEMD_SERVICE = `[Unit]
Description=ServerCompass Monitoring Agent
After=network.target

[Service]
Type=oneshot
User=__USERNAME__
WorkingDirectory=__AGENT_PATH__
ExecStart=__AGENT_PATH__/agent.sh
StandardOutput=append:__AGENT_PATH__/logs/agent.log
StandardError=append:__AGENT_PATH__/logs/agent.log

[Install]
WantedBy=multi-user.target
`;
const SYSTEMD_TIMER = `[Unit]
Description=Run ServerCompass Monitoring Agent every minute

[Timer]
OnBootSec=60
OnUnitActiveSec=60
AccuracySec=1s

[Install]
WantedBy=timers.target
`;
class MonitoringAgentService {
    vault = new CredentialVault_1.CredentialVault();
    /**
     * Get the agent source code for display in the UI
     */
    getAgentSourceCode() {
        return {
            agentScript: AGENT_SCRIPT,
            notifyScript: NOTIFY_SCRIPT,
        };
    }
    /**
     * Get the current agent version
     */
    getAgentVersion() {
        return AGENT_VERSION;
    }
    async migrateNotificationChannelSecrets() {
        // Best-effort migration:
        // - Older installs stored secrets inside `notification_channels.config` in plaintext JSON.
        // - We migrate them into `encrypted_secrets` and redact them from `config`.
        try {
            const columns = db_1.db.prepare('PRAGMA table_info(notification_channels)').all();
            if (!columns.some((c) => c.name === 'encrypted_secrets')) {
                return;
            }
        }
        catch {
            return;
        }
        try {
            const rows = db_1.db
                .prepare('SELECT id, config, encrypted_secrets FROM notification_channels')
                .all();
            for (const row of rows) {
                await this.getChannelConfigWithSecrets(row);
            }
        }
        catch (error) {
            console.warn('[Monitoring] Failed to migrate notification channel secrets:', error);
        }
    }
    normalizeSecretValue(value) {
        if (typeof value !== 'string')
            return undefined;
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    extractSecretsFromConfig(config) {
        // Strip known secret fields out of the JSON config so they are never stored or returned in plaintext.
        const redactedConfig = { ...config };
        const secrets = {};
        const webhookUrl = this.normalizeSecretValue(redactedConfig.webhook_url);
        if (webhookUrl) {
            secrets.webhook_url = webhookUrl;
        }
        delete redactedConfig.webhook_url;
        const apiKey = this.normalizeSecretValue(redactedConfig.api_key);
        if (apiKey) {
            secrets.api_key = apiKey;
        }
        delete redactedConfig.api_key;
        const smtpPassword = this.normalizeSecretValue(redactedConfig.smtp_password);
        if (smtpPassword) {
            secrets.smtp_password = smtpPassword;
        }
        delete redactedConfig.smtp_password;
        const url = this.normalizeSecretValue(redactedConfig.url);
        if (url) {
            secrets.url = url;
        }
        delete redactedConfig.url;
        return { redactedConfig, secrets };
    }
    getSecretsConfigured(secrets) {
        const configured = {};
        if (this.normalizeSecretValue(secrets.webhook_url))
            configured.webhookUrl = true;
        if (this.normalizeSecretValue(secrets.api_key))
            configured.apiKey = true;
        if (this.normalizeSecretValue(secrets.smtp_password))
            configured.smtpPassword = true;
        if (this.normalizeSecretValue(secrets.url))
            configured.url = true;
        return configured;
    }
    async decryptChannelSecrets(encryptedSecrets) {
        if (!encryptedSecrets || encryptedSecrets.length === 0)
            return { secrets: {}, ok: true };
        try {
            const json = await this.vault.decrypt(encryptedSecrets);
            const parsed = JSON.parse(json);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { secrets: {}, ok: true };
            }
            return { secrets: parsed, ok: true };
        }
        catch (error) {
            console.warn('[Monitoring] Failed to decrypt notification channel secrets:', error);
            return { secrets: {}, ok: false };
        }
    }
    async encryptChannelSecrets(secrets) {
        const normalized = {};
        const webhookUrl = this.normalizeSecretValue(secrets.webhook_url);
        const apiKey = this.normalizeSecretValue(secrets.api_key);
        const smtpPassword = this.normalizeSecretValue(secrets.smtp_password);
        const url = this.normalizeSecretValue(secrets.url);
        if (webhookUrl)
            normalized.webhook_url = webhookUrl;
        if (apiKey)
            normalized.api_key = apiKey;
        if (smtpPassword)
            normalized.smtp_password = smtpPassword;
        if (url)
            normalized.url = url;
        if (Object.keys(normalized).length === 0)
            return null;
        return this.vault.encrypt(JSON.stringify(normalized));
    }
    async getChannelConfigWithSecrets(row) {
        // NOTE: This returns a renderer-safe `config` (redacted) plus decrypted `secrets` for internal use.
        // Callers that return values to the renderer should only use `config` + `secretsConfigured`.
        let parsedConfig = {};
        try {
            const parsed = JSON.parse(row.config);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                parsedConfig = parsed;
            }
        }
        catch {
            // ignore invalid JSON
        }
        const { redactedConfig, secrets: plaintextSecrets } = this.extractSecretsFromConfig(parsedConfig);
        const encryptedSecrets = await this.decryptChannelSecrets(row.encrypted_secrets);
        const mergedSecrets = { ...encryptedSecrets.secrets, ...plaintextSecrets };
        // If we found plaintext secrets in config, migrate them into encrypted_secrets.
        if (Object.keys(plaintextSecrets).length > 0) {
            const encrypted = await this.encryptChannelSecrets(mergedSecrets);
            db_1.db.prepare('UPDATE notification_channels SET config = ?, encrypted_secrets = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(redactedConfig), encrypted, Date.now(), row.id);
        }
        return {
            config: redactedConfig,
            secrets: mergedSecrets,
            secretsConfigured: this.getSecretsConfigured(mergedSecrets),
            secretsDecryptedOk: encryptedSecrets.ok,
        };
    }
    /**
     * Get monitoring configuration for a server
     */
    getConfig(serverId) {
        const row = db_1.db
            .prepare('SELECT * FROM monitoring_config WHERE server_id = ?')
            .get(serverId);
        return row || null;
    }
    /**
     * Create or update monitoring configuration for a server
     */
    upsertConfig(serverId, config) {
        const now = Date.now();
        const existing = this.getConfig(serverId);
        if (existing) {
            const updates = [];
            const values = [];
            if (config.enabled !== undefined) {
                updates.push('enabled = ?');
                values.push(config.enabled);
            }
            if (config.interval_seconds !== undefined) {
                updates.push('interval_seconds = ?');
                values.push(config.interval_seconds);
            }
            if (config.retention_days !== undefined) {
                updates.push('retention_days = ?');
                values.push(config.retention_days);
            }
            if (config.agent_installed !== undefined) {
                updates.push('agent_installed = ?');
                values.push(config.agent_installed);
            }
            if (config.agent_version !== undefined) {
                updates.push('agent_version = ?');
                values.push(config.agent_version);
            }
            if (config.agent_last_seen !== undefined) {
                updates.push('agent_last_seen = ?');
                values.push(config.agent_last_seen);
            }
            if (config.log_max_lines !== undefined) {
                updates.push('log_max_lines = ?');
                values.push(config.log_max_lines);
            }
            if (config.log_max_size_mb !== undefined) {
                updates.push('log_max_size_mb = ?');
                values.push(config.log_max_size_mb);
            }
            if (config.log_retention_days !== undefined) {
                updates.push('log_retention_days = ?');
                values.push(config.log_retention_days);
            }
            updates.push('updated_at = ?');
            values.push(now);
            values.push(serverId);
            db_1.db.prepare(`UPDATE monitoring_config SET ${updates.join(', ')} WHERE server_id = ?`).run(...values);
        }
        else {
            db_1.db.prepare(`
        INSERT INTO monitoring_config (
          server_id, enabled, interval_seconds, retention_days,
          agent_installed, agent_version, agent_last_seen,
          log_max_lines, log_max_size_mb, log_retention_days,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(serverId, config.enabled ?? 1, config.interval_seconds ?? 60, config.retention_days ?? 7, config.agent_installed ?? 0, config.agent_version ?? null, config.agent_last_seen ?? null, config.log_max_lines ?? 1000, config.log_max_size_mb ?? 10, config.log_retention_days ?? 7, now, now);
        }
    }
    /**
     * Check if dependencies (jq, bc, curl) are installed on the server
     */
    async checkDependencies(serverId) {
        const deps = ['jq', 'bc', 'curl'];
        const missing = [];
        for (const dep of deps) {
            const result = await SSHService_1.sshService.executeCommand(serverId, `which ${dep} 2>/dev/null`);
            if (result.exitCode !== 0 || !result.stdout.trim()) {
                missing.push(dep);
            }
        }
        return { installed: missing.length === 0, missing };
    }
    /**
     * Install missing dependencies on the server
     */
    async installDependencies(serverId, missing) {
        if (missing.length === 0)
            return;
        // Detect package manager
        const aptResult = await SSHService_1.sshService.executeCommand(serverId, 'which apt-get 2>/dev/null');
        const yumResult = await SSHService_1.sshService.executeCommand(serverId, 'which yum 2>/dev/null');
        const dnfResult = await SSHService_1.sshService.executeCommand(serverId, 'which dnf 2>/dev/null');
        let installCmd;
        if (aptResult.exitCode === 0 && aptResult.stdout.trim()) {
            // Wait for apt lock to be released (common on fresh VPS with auto-updates)
            const waitForApt = `
        echo "Waiting for apt lock to be released..."
        while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
          sleep 2
        done
        echo "Lock released, proceeding..."
      `;
            installCmd = `${waitForApt} && sudo apt-get update && sudo apt-get install -y ${missing.join(' ')}`;
        }
        else if (dnfResult.exitCode === 0 && dnfResult.stdout.trim()) {
            installCmd = `sudo dnf install -y ${missing.join(' ')}`;
        }
        else if (yumResult.exitCode === 0 && yumResult.stdout.trim()) {
            installCmd = `sudo yum install -y ${missing.join(' ')}`;
        }
        else {
            throw new Error('Could not detect package manager. Please install jq, bc, and curl manually.');
        }
        const result = await SSHService_1.sshService.executeCommand(serverId, installCmd);
        if (result.exitCode !== 0) {
            throw new Error(`Failed to install dependencies: ${result.stderr || result.stdout}`);
        }
    }
    /**
     * Install the monitoring agent on a server
     */
    async installAgent(serverId) {
        // 1. Check and install dependencies
        const deps = await this.checkDependencies(serverId);
        if (!deps.installed) {
            await this.installDependencies(serverId, deps.missing);
        }
        // 2. Get home directory
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            throw new Error('Could not determine home directory');
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        // 3. Create directory structure
        const mkdirResult = await SSHService_1.sshService.executeCommand(serverId, `mkdir -p ${agentPath}/logs`);
        if (mkdirResult.exitCode !== 0) {
            throw new Error(`Failed to create agent directory: ${mkdirResult.stderr}`);
        }
        // 4. Write agent.sh
        const writeAgentResult = await SSHService_1.sshService.executeCommand(serverId, `cat > ${agentPath}/agent.sh << 'AGENT_EOF'
${AGENT_SCRIPT}
AGENT_EOF`);
        if (writeAgentResult.exitCode !== 0) {
            throw new Error(`Failed to write agent.sh: ${writeAgentResult.stderr}`);
        }
        // 5. Write notify.sh
        const writeNotifyResult = await SSHService_1.sshService.executeCommand(serverId, `cat > ${agentPath}/notify.sh << 'NOTIFY_EOF'
${NOTIFY_SCRIPT}
NOTIFY_EOF`);
        if (writeNotifyResult.exitCode !== 0) {
            throw new Error(`Failed to write notify.sh: ${writeNotifyResult.stderr}`);
        }
        // 6. Write deploy-notify.sh
        const writeDeployNotifyResult = await SSHService_1.sshService.executeCommand(serverId, `cat > ${agentPath}/deploy-notify.sh << 'DEPLOY_NOTIFY_EOF'
${DEPLOY_NOTIFY_SCRIPT}
DEPLOY_NOTIFY_EOF`);
        if (writeDeployNotifyResult.exitCode !== 0) {
            throw new Error(`Failed to write deploy-notify.sh: ${writeDeployNotifyResult.stderr}`);
        }
        // 7. Write VERSION file
        await SSHService_1.sshService.executeCommand(serverId, `echo "${AGENT_VERSION}" > ${agentPath}/VERSION`);
        // 8. Make scripts executable
        const chmodResult = await SSHService_1.sshService.executeCommand(serverId, `chmod +x ${agentPath}/agent.sh ${agentPath}/notify.sh ${agentPath}/deploy-notify.sh`);
        if (chmodResult.exitCode !== 0) {
            throw new Error(`Failed to make scripts executable: ${chmodResult.stderr}`);
        }
        // 9. Get username for systemd
        const whoamiResult = await SSHService_1.sshService.executeCommand(serverId, 'whoami');
        const username = whoamiResult.stdout.trim();
        // 10. Create systemd service file
        const serviceContent = SYSTEMD_SERVICE.replace(/__USERNAME__/g, username).replace(/__AGENT_PATH__/g, agentPath);
        const writeServiceResult = await SSHService_1.sshService.executeCommand(serverId, `sudo tee /etc/systemd/system/servercompass-monitor.service > /dev/null << 'SERVICE_EOF'
${serviceContent}
SERVICE_EOF`);
        if (writeServiceResult.exitCode !== 0) {
            throw new Error(`Failed to create systemd service: ${writeServiceResult.stderr}`);
        }
        // 11. Create systemd timer file
        const writeTimerResult = await SSHService_1.sshService.executeCommand(serverId, `sudo tee /etc/systemd/system/servercompass-monitor.timer > /dev/null << 'TIMER_EOF'
${SYSTEMD_TIMER}
TIMER_EOF`);
        if (writeTimerResult.exitCode !== 0) {
            throw new Error(`Failed to create systemd timer: ${writeTimerResult.stderr}`);
        }
        // 12. Reload systemd and enable timer
        const reloadResult = await SSHService_1.sshService.executeCommand(serverId, 'sudo systemctl daemon-reload && sudo systemctl enable servercompass-monitor.timer && sudo systemctl start servercompass-monitor.timer');
        if (reloadResult.exitCode !== 0) {
            throw new Error(`Failed to enable systemd timer: ${reloadResult.stderr}`);
        }
        // 13. Update local database
        this.upsertConfig(serverId, {
            agent_installed: 1,
            agent_version: AGENT_VERSION,
            agent_last_seen: Date.now(),
        });
    }
    /**
     * Uninstall the monitoring agent from a server
     */
    async uninstallAgent(serverId) {
        // 1. Stop and disable systemd services
        await SSHService_1.sshService.executeCommand(serverId, 'sudo systemctl stop servercompass-monitor.timer 2>/dev/null || true');
        await SSHService_1.sshService.executeCommand(serverId, 'sudo systemctl disable servercompass-monitor.timer 2>/dev/null || true');
        await SSHService_1.sshService.executeCommand(serverId, 'sudo rm -f /etc/systemd/system/servercompass-monitor.service /etc/systemd/system/servercompass-monitor.timer 2>/dev/null || true');
        await SSHService_1.sshService.executeCommand(serverId, 'sudo systemctl daemon-reload');
        // 2. Remove agent directory
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (homeDir) {
            await SSHService_1.sshService.executeCommand(serverId, `rm -rf ${homeDir}/server-compass/agents/monitoring`);
        }
        // 3. Update local database
        this.upsertConfig(serverId, {
            agent_installed: 0,
            agent_version: null,
            agent_last_seen: null,
        });
    }
    /**
     * Check the status of the monitoring agent on a server
     */
    async getAgentStatus(serverId) {
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            return {
                installed: false,
                version: null,
                lastSeen: null,
                serviceActive: false,
                timerActive: false,
                configExists: false,
            };
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        // Check if agent directory exists
        const dirResult = await SSHService_1.sshService.executeCommand(serverId, `test -d ${agentPath} && echo "exists"`);
        if (dirResult.stdout.trim() !== 'exists') {
            return {
                installed: false,
                version: null,
                lastSeen: null,
                serviceActive: false,
                timerActive: false,
                configExists: false,
            };
        }
        // Check version
        const versionResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${agentPath}/VERSION 2>/dev/null || echo ""`);
        const version = versionResult.stdout.trim() || null;
        // Check config exists
        const configResult = await SSHService_1.sshService.executeCommand(serverId, `test -f ${agentPath}/config.json && echo "exists"`);
        const configExists = configResult.stdout.trim() === 'exists';
        // Check systemd timer status
        const timerResult = await SSHService_1.sshService.executeCommand(serverId, 'systemctl is-active servercompass-monitor.timer 2>/dev/null || echo "inactive"');
        const timerActive = timerResult.stdout.trim() === 'active';
        // Check service status (last run)
        const serviceResult = await SSHService_1.sshService.executeCommand(serverId, 'systemctl show servercompass-monitor.service --property=ExecMainExitTimestamp 2>/dev/null || echo ""');
        let lastSeen = null;
        const timestampMatch = serviceResult.stdout.match(/ExecMainExitTimestamp=(.+)/);
        if (timestampMatch && timestampMatch[1] && timestampMatch[1] !== 'n/a') {
            const date = new Date(timestampMatch[1]);
            if (!isNaN(date.getTime())) {
                lastSeen = date.getTime();
            }
        }
        // Update local config with last seen
        if (lastSeen) {
            this.upsertConfig(serverId, { agent_last_seen: lastSeen });
        }
        return {
            installed: true,
            version,
            lastSeen,
            serviceActive: true, // oneshot service, always "inactive" when not running
            timerActive,
            configExists,
        };
    }
    /**
     * Push configuration to the agent on the server
     * Also updates scripts if the version has changed
     */
    async pushConfig(serverId, config) {
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            throw new Error('Could not determine home directory');
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        const configJson = JSON.stringify(config, null, 2);
        // Push config.json
        const configResult = await SSHService_1.sshService.executeCommand(serverId, `cat > ${agentPath}/config.json << 'CONFIG_EOF'
${configJson}
CONFIG_EOF`);
        if (configResult.exitCode !== 0) {
            throw new Error(`Failed to push config: ${configResult.stderr}`);
        }
        // Check if scripts need to be updated by comparing version
        const versionResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${agentPath}/VERSION 2>/dev/null || echo "0.0.0"`);
        const remoteVersion = versionResult.stdout.trim();
        if (remoteVersion !== AGENT_VERSION) {
            console.log(`[Monitoring] Updating scripts from ${remoteVersion} to ${AGENT_VERSION}`);
            await this.updateAgentScripts(serverId, agentPath);
        }
    }
    /**
     * Update agent scripts on the server (agent.sh, notify.sh, VERSION)
     */
    async updateAgentScripts(serverId, agentPath) {
        // Update agent.sh
        const agentResult = await SSHService_1.sshService.executeCommand(serverId, `cat > ${agentPath}/agent.sh << 'AGENT_EOF'
${AGENT_SCRIPT}
AGENT_EOF`);
        if (agentResult.exitCode !== 0) {
            throw new Error(`Failed to update agent.sh: ${agentResult.stderr}`);
        }
        // Update notify.sh
        const notifyResult = await SSHService_1.sshService.executeCommand(serverId, `cat > ${agentPath}/notify.sh << 'NOTIFY_EOF'
${NOTIFY_SCRIPT}
NOTIFY_EOF`);
        if (notifyResult.exitCode !== 0) {
            throw new Error(`Failed to update notify.sh: ${notifyResult.stderr}`);
        }
        // Update deploy-notify.sh
        const deployNotifyResult = await SSHService_1.sshService.executeCommand(serverId, `cat > ${agentPath}/deploy-notify.sh << 'DEPLOY_NOTIFY_EOF'
${DEPLOY_NOTIFY_SCRIPT}
DEPLOY_NOTIFY_EOF`);
        if (deployNotifyResult.exitCode !== 0) {
            throw new Error(`Failed to update deploy-notify.sh: ${deployNotifyResult.stderr}`);
        }
        // Make scripts executable
        const chmodResult = await SSHService_1.sshService.executeCommand(serverId, `chmod +x ${agentPath}/agent.sh ${agentPath}/notify.sh ${agentPath}/deploy-notify.sh`);
        if (chmodResult.exitCode !== 0) {
            throw new Error(`Failed to make scripts executable: ${chmodResult.stderr}`);
        }
        // Update VERSION
        const versionResult = await SSHService_1.sshService.executeCommand(serverId, `echo "${AGENT_VERSION}" > ${agentPath}/VERSION`);
        if (versionResult.exitCode !== 0) {
            throw new Error(`Failed to update VERSION: ${versionResult.stderr}`);
        }
        console.log(`[Monitoring] Scripts updated to version ${AGENT_VERSION}`);
    }
    /**
     * Build the agent configuration from database rules and channels
     */
    async buildAgentConfig(serverId) {
        const monitoringConfig = this.getConfig(serverId);
        // Get server name
        const server = db_1.db
            .prepare('SELECT name FROM servers WHERE id = ?')
            .get(serverId);
        const serverName = server?.name ?? 'Unknown Server';
        // Get alert rules for this server (or global rules)
        const rules = db_1.db
            .prepare(`SELECT * FROM alert_rules WHERE enabled = 1 AND (server_id = ? OR server_id IS NULL)`)
            .all(serverId);
        // Get notification channels for this server (or global channels)
        const channels = db_1.db
            .prepare(`SELECT * FROM notification_channels WHERE enabled = 1 AND (server_id = ? OR server_id IS NULL)`)
            .all(serverId);
        // Get quiet hours
        const quietHours = db_1.db
            .prepare(`SELECT * FROM quiet_hours WHERE enabled = 1 AND (server_id = ? OR server_id IS NULL) LIMIT 1`)
            .get(serverId);
        // IMPORTANT: the agent on the server needs the plaintext secrets (webhooks, API keys, SMTP password),
        // so we decrypt them here and include them in the config we push to the VPS.
        const notificationChannels = await Promise.all(channels.map(async (c) => {
            const { config, secrets } = await this.getChannelConfigWithSecrets(c);
            return {
                id: c.id,
                name: c.name,
                type: c.type,
                enabled: true,
                ...config,
                ...secrets,
            };
        }));
        return {
            version: AGENT_VERSION,
            server_name: serverName,
            interval_seconds: monitoringConfig?.interval_seconds ?? 60,
            rules: rules.map((r) => ({
                id: r.id,
                name: r.name,
                metric: r.metric,
                operator: r.operator,
                threshold: r.threshold,
                severity: r.severity,
                enabled: true,
            })),
            notification_channels: notificationChannels,
            quiet_hours: quietHours
                ? {
                    enabled: true,
                    start: quietHours.start_time,
                    end: quietHours.end_time,
                    timezone: quietHours.timezone,
                }
                : null,
            logs: {
                max_lines: monitoringConfig?.log_max_lines ?? 1000,
                max_size_mb: monitoringConfig?.log_max_size_mb ?? 10,
                retention_days: monitoringConfig?.log_retention_days ?? 7,
            },
        };
    }
    /**
     * Fetch agent logs from the server
     */
    async getAgentLogs(serverId, lines = 100) {
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            return { agentLog: '', notificationLog: '' };
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        const agentLogResult = await SSHService_1.sshService.executeCommand(serverId, `tail -n ${lines} ${agentPath}/logs/agent.log 2>/dev/null || echo ""`);
        const notificationLogResult = await SSHService_1.sshService.executeCommand(serverId, `tail -n ${lines} ${agentPath}/logs/notifications.log 2>/dev/null || echo ""`);
        return {
            agentLog: agentLogResult.stdout,
            notificationLog: notificationLogResult.stdout,
        };
    }
    /**
     * Trigger a manual agent run (for testing)
     */
    async triggerManualRun(serverId) {
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            return { success: false, output: 'Could not determine home directory' };
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        const result = await SSHService_1.sshService.executeCommand(serverId, `${agentPath}/agent.sh 2>&1`);
        return {
            success: result.exitCode === 0,
            output: result.stdout || result.stderr,
        };
    }
    /**
     * Send a test notification through the agent
     */
    async sendTestNotification(serverId, _channel) {
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            return { success: false, output: 'Could not determine home directory' };
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        const result = await SSHService_1.sshService.executeCommand(serverId, `${agentPath}/notify.sh --severity info --title "Test Notification" --message "This is a test notification from ServerCompass" --status test 2>&1`);
        return {
            success: result.exitCode === 0,
            output: result.stdout || result.stderr || 'Notification sent',
        };
    }
    /**
     * Send a test notification to a specific channel with a custom message
     */
    async sendChannelTestNotification(serverId, input) {
        const channelRow = db_1.db
            .prepare('SELECT id, server_id, name, type FROM notification_channels WHERE id = ?')
            .get(input.channelId);
        if (!channelRow) {
            return { success: false, output: 'Notification channel not found' };
        }
        if (channelRow.server_id && channelRow.server_id !== serverId) {
            return { success: false, output: 'Notification channel does not belong to this server' };
        }
        try {
            const agentPath = await this.ensureNotificationAssets(serverId);
            const severity = input.severity || 'info';
            const title = shellQuote(input.title);
            const message = shellQuote(input.message);
            const result = await SSHService_1.sshService.executeCommand(serverId, `${agentPath}/notify.sh --severity ${shellQuote(severity)} --title ${title} --message ${message} --status test --channel-id ${shellQuote(input.channelId)} 2>&1`);
            const success = result.exitCode === 0;
            const output = result.stdout || result.stderr || (success ? 'Notification sent' : 'Notification failed');
            // Update channel test status
            await this.updateNotificationChannel(input.channelId, {
                lastTestAt: Date.now(),
                lastTestStatus: success ? 'success' : 'failed',
            });
            // Log the notification event
            this.logNotificationEvent({
                serverId,
                type: 'test',
                severity: input.severity || 'info',
                title: input.title,
                message: input.message,
                channelId: input.channelId,
                channelName: channelRow.name,
                channelType: channelRow.type,
                status: success ? 'sent' : 'failed',
                output,
            });
            return { success, output };
        }
        catch (error) {
            const output = error instanceof Error ? error.message : String(error);
            try {
                await this.updateNotificationChannel(input.channelId, {
                    lastTestAt: Date.now(),
                    lastTestStatus: 'failed',
                });
            }
            catch {
                // Ignore update errors
            }
            // Log the failed notification event
            this.logNotificationEvent({
                serverId,
                type: 'test',
                severity: input.severity || 'info',
                title: input.title,
                message: input.message,
                channelId: input.channelId,
                channelName: channelRow.name,
                channelType: channelRow.type,
                status: 'failed',
                output,
            });
            return { success: false, output };
        }
    }
    /**
     * Send a custom notification through the agent
     */
    async sendNotification(serverId, input) {
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            return { success: false, output: 'Could not determine home directory' };
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        const severity = input.severity || 'info';
        const title = shellQuote(input.title);
        const message = shellQuote(input.message);
        const status = input.status ? ` --status ${shellQuote(input.status)}` : '';
        const result = await SSHService_1.sshService.executeCommand(serverId, `${agentPath}/notify.sh --severity ${shellQuote(severity)} --title ${title} --message ${message}${status} 2>&1`);
        const success = result.exitCode === 0;
        const output = result.stdout || result.stderr || 'Notification sent';
        // Log the notification event
        this.logNotificationEvent({
            serverId,
            type: 'manual',
            severity: input.severity || 'info',
            title: input.title,
            message: input.message,
            status: success ? 'sent' : 'failed',
            output,
        });
        return { success, output };
    }
    /**
     * Log a notification event to the database
     */
    logNotificationEvent(event) {
        try {
            const id = (0, crypto_1.randomUUID)();
            const now = Math.floor(Date.now() / 1000);
            db_1.db.prepare(`
        INSERT INTO notification_events (
          id, server_id, type, severity, title, message,
          channel_id, channel_name, channel_type, status, output, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, event.serverId, event.type, event.severity, event.title, event.message, event.channelId ?? null, event.channelName ?? null, event.channelType ?? null, event.status, event.output ?? null, now);
        }
        catch (error) {
            // Don't throw - logging should not break the main functionality
            console.warn('[Monitoring] Failed to log notification event:', error);
        }
    }
    async ensureNotificationAssets(serverId) {
        const status = await this.getAgentStatus(serverId);
        if (!status.installed) {
            await this.installAgent(serverId);
        }
        const agentConfig = await this.buildAgentConfig(serverId);
        await this.pushConfig(serverId, agentConfig);
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            throw new Error('Could not determine home directory');
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        const deployScriptCheck = await SSHService_1.sshService.executeCommand(serverId, `test -f ${agentPath}/deploy-notify.sh && echo "exists"`);
        if (deployScriptCheck.stdout.trim() !== 'exists') {
            const writeDeployNotifyResult = await SSHService_1.sshService.executeCommand(serverId, `cat > ${agentPath}/deploy-notify.sh << 'DEPLOY_NOTIFY_EOF'
${DEPLOY_NOTIFY_SCRIPT}
DEPLOY_NOTIFY_EOF`);
            if (writeDeployNotifyResult.exitCode !== 0) {
                throw new Error(`Failed to write deploy-notify.sh: ${writeDeployNotifyResult.stderr}`);
            }
            const chmodResult = await SSHService_1.sshService.executeCommand(serverId, `chmod +x ${agentPath}/deploy-notify.sh`);
            if (chmodResult.exitCode !== 0) {
                throw new Error(`Failed to make deploy-notify.sh executable: ${chmodResult.stderr}`);
            }
        }
        return agentPath;
    }
    /**
     * Schedule a background deployment notification on the server.
     */
    async scheduleDeploymentNotification(serverId, input) {
        try {
            const agentPath = await this.ensureNotificationAssets(serverId);
            const action = input.action || 'deploy';
            const timeoutSeconds = input.timeoutSeconds ?? 3600;
            const scriptPath = `${agentPath}/deploy-notify.sh`;
            const logPath = `${agentPath}/logs/deploy-${input.deploymentId}.log`;
            const command = `nohup ${shellQuote(scriptPath)} ` +
                `--project ${shellQuote(input.projectName)} ` +
                `--deployment ${shellQuote(input.deploymentId)} ` +
                `--working-dir ${shellQuote(input.workingDir)} ` +
                `--action ${shellQuote(action)} ` +
                `--timeout ${shellQuote(String(timeoutSeconds))} ` +
                `> ${shellQuote(logPath)} 2>&1 & echo $!`;
            const result = await SSHService_1.sshService.executeCommand(serverId, command);
            return {
                success: result.exitCode === 0,
                output: result.stdout || result.stderr || '',
            };
        }
        catch (error) {
            return {
                success: false,
                output: error instanceof Error ? error.message : String(error),
            };
        }
    }
    // ============================================================================
    // Alert Rules CRUD
    // ============================================================================
    /**
     * Get all alert rules for a server
     */
    getAlertRules(serverId) {
        const query = serverId
            ? 'SELECT * FROM alert_rules WHERE server_id = ? OR server_id IS NULL ORDER BY name'
            : 'SELECT * FROM alert_rules WHERE server_id IS NULL ORDER BY name';
        const rows = serverId
            ? db_1.db.prepare(query).all(serverId)
            : db_1.db.prepare(query).all();
        return rows.map((r) => ({
            id: r.id,
            serverId: r.server_id,
            name: r.name,
            description: r.description,
            enabled: Boolean(r.enabled),
            metric: r.metric,
            operator: r.operator,
            threshold: r.threshold,
            durationSeconds: r.duration_seconds,
            cooldownSeconds: r.cooldown_seconds,
            severity: r.severity,
            notifyOnFiring: Boolean(r.notify_on_firing),
            notifyOnResolved: Boolean(r.notify_on_resolved),
            notificationChannels: r.notification_channels
                ? JSON.parse(r.notification_channels)
                : [],
            isDefault: Boolean(r.is_default),
        }));
    }
    /**
     * Create a new alert rule
     */
    createAlertRule(rule) {
        const id = (0, crypto_1.randomUUID)();
        const now = Date.now();
        db_1.db.prepare(`
      INSERT INTO alert_rules (
        id, server_id, name, description, enabled, metric, operator, threshold,
        duration_seconds, cooldown_seconds, severity, notify_on_firing,
        notify_on_resolved, notification_channels, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, rule.serverId, rule.name, rule.description ?? null, rule.metric, rule.operator, rule.threshold, rule.durationSeconds ?? 0, rule.cooldownSeconds ?? 300, rule.severity, rule.notifyOnFiring !== false ? 1 : 0, rule.notifyOnResolved !== false ? 1 : 0, JSON.stringify(rule.notificationChannels ?? []), now, now);
        return id;
    }
    /**
     * Update an alert rule
     */
    updateAlertRule(id, updates) {
        const setters = [];
        const values = [];
        if (updates.name !== undefined) {
            setters.push('name = ?');
            values.push(updates.name);
        }
        if (updates.description !== undefined) {
            setters.push('description = ?');
            values.push(updates.description);
        }
        if (updates.enabled !== undefined) {
            setters.push('enabled = ?');
            values.push(updates.enabled ? 1 : 0);
        }
        if (updates.metric !== undefined) {
            setters.push('metric = ?');
            values.push(updates.metric);
        }
        if (updates.operator !== undefined) {
            setters.push('operator = ?');
            values.push(updates.operator);
        }
        if (updates.threshold !== undefined) {
            setters.push('threshold = ?');
            values.push(updates.threshold);
        }
        if (updates.durationSeconds !== undefined) {
            setters.push('duration_seconds = ?');
            values.push(updates.durationSeconds);
        }
        if (updates.cooldownSeconds !== undefined) {
            setters.push('cooldown_seconds = ?');
            values.push(updates.cooldownSeconds);
        }
        if (updates.severity !== undefined) {
            setters.push('severity = ?');
            values.push(updates.severity);
        }
        if (updates.notifyOnFiring !== undefined) {
            setters.push('notify_on_firing = ?');
            values.push(updates.notifyOnFiring ? 1 : 0);
        }
        if (updates.notifyOnResolved !== undefined) {
            setters.push('notify_on_resolved = ?');
            values.push(updates.notifyOnResolved ? 1 : 0);
        }
        if (updates.notificationChannels !== undefined) {
            setters.push('notification_channels = ?');
            values.push(JSON.stringify(updates.notificationChannels));
        }
        setters.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        db_1.db.prepare(`UPDATE alert_rules SET ${setters.join(', ')} WHERE id = ?`).run(...values);
    }
    /**
     * Delete an alert rule
     */
    deleteAlertRule(id) {
        db_1.db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
    }
    // ============================================================================
    // Notification Channels CRUD
    // ============================================================================
    /**
     * Get all notification channels for a server
     */
    async getNotificationChannels(serverId) {
        // SECURITY: this method is used by the renderer; never return decrypted secret values.
        const query = serverId
            ? 'SELECT * FROM notification_channels WHERE server_id = ? OR server_id IS NULL ORDER BY name'
            : 'SELECT * FROM notification_channels WHERE server_id IS NULL ORDER BY name';
        const rows = serverId
            ? db_1.db.prepare(query).all(serverId)
            : db_1.db.prepare(query).all();
        return Promise.all(rows.map(async (r) => {
            const { config, secretsConfigured } = await this.getChannelConfigWithSecrets(r);
            return {
                id: r.id,
                serverId: r.server_id,
                name: r.name,
                type: r.type,
                enabled: Boolean(r.enabled),
                config,
                secretsConfigured,
                lastTestAt: r.last_test_at,
                lastTestStatus: r.last_test_status,
            };
        }));
    }
    /**
     * Create a notification channel
     */
    async createNotificationChannel(channel) {
        const id = (0, crypto_1.randomUUID)();
        const now = Date.now();
        const { redactedConfig, secrets } = this.extractSecretsFromConfig(channel.config);
        const encryptedSecrets = await this.encryptChannelSecrets(secrets);
        db_1.db.prepare(`
      INSERT INTO notification_channels (
        id,
        server_id,
        name,
        type,
        enabled,
        config,
        encrypted_secrets,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(id, channel.serverId, channel.name, channel.type, JSON.stringify(redactedConfig), encryptedSecrets, now, now);
        return id;
    }
    /**
     * Update a notification channel
     */
    async updateNotificationChannel(id, updates) {
        const setters = [];
        const values = [];
        const existing = db_1.db
            .prepare('SELECT id, config, encrypted_secrets FROM notification_channels WHERE id = ?')
            .get(id);
        if (!existing) {
            throw new Error('Notification channel not found');
        }
        if (updates.name !== undefined) {
            setters.push('name = ?');
            values.push(updates.name);
        }
        if (updates.enabled !== undefined) {
            setters.push('enabled = ?');
            values.push(updates.enabled ? 1 : 0);
        }
        if (updates.config !== undefined) {
            const { secrets: currentSecrets } = await this.getChannelConfigWithSecrets(existing);
            const { redactedConfig, secrets: incomingSecrets } = this.extractSecretsFromConfig(updates.config);
            // Note: config is stored without secrets (write-only). Use incoming config as the source of truth.
            setters.push('config = ?');
            values.push(JSON.stringify(redactedConfig));
            if (Object.keys(incomingSecrets).length > 0) {
                const mergedSecrets = {
                    ...currentSecrets,
                    ...incomingSecrets,
                };
                setters.push('encrypted_secrets = ?');
                const encrypted = await this.encryptChannelSecrets(mergedSecrets);
                values.push(encrypted);
            }
        }
        if (updates.lastTestAt !== undefined) {
            setters.push('last_test_at = ?');
            values.push(updates.lastTestAt);
        }
        if (updates.lastTestStatus !== undefined) {
            setters.push('last_test_status = ?');
            values.push(updates.lastTestStatus);
        }
        setters.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);
        db_1.db.prepare(`UPDATE notification_channels SET ${setters.join(', ')} WHERE id = ?`).run(...values);
    }
    /**
     * Delete a notification channel
     */
    deleteNotificationChannel(id) {
        db_1.db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
    }
    // ============================================================================
    // Alerts History
    // ============================================================================
    /**
     * Get recent alerts for a server, including notification events
     */
    getAlerts(serverId, options) {
        const limit = options?.limit ?? 20;
        // Build alerts query
        let alertQuery = 'SELECT * FROM alerts WHERE server_id = ?';
        const alertParams = [serverId];
        if (options?.status) {
            alertQuery += ' AND status = ?';
            alertParams.push(options.status);
        }
        alertQuery += ' ORDER BY created_at DESC';
        // Get alerts from database
        const alertRows = db_1.db.prepare(alertQuery).all(...alertParams);
        // Get notification events
        const notificationRows = db_1.db.prepare(`SELECT * FROM notification_events 
       WHERE server_id = ? 
       ORDER BY created_at DESC 
       LIMIT ?`).all(serverId, limit);
        // Map alerts
        const alerts = alertRows.map((r) => ({
            id: r.id,
            ruleId: r.rule_id,
            serverId: r.server_id,
            status: r.status,
            severity: r.severity,
            metric: r.metric,
            threshold: r.threshold,
            currentValue: r.current_value,
            message: r.message,
            pendingAt: r.pending_at,
            firingAt: r.firing_at,
            resolvedAt: r.resolved_at,
            createdAt: r.created_at,
            isNotificationEvent: false,
            channelName: null,
            channelType: null,
        }));
        // Map notification events to alert-like structure
        const notifications = notificationRows.map((r) => {
            const isTest = r.type === 'test';
            const prefix = isTest ? '🧪 Test: ' : '🔔 Notification: ';
            const channelInfo = r.channel_name ? ` [${r.channel_name}]` : '';
            return {
                id: r.id,
                ruleId: 'notification',
                serverId: r.server_id,
                status: r.status === 'sent' ? 'resolved' : 'firing',
                severity: r.severity,
                metric: r.type,
                threshold: 0,
                currentValue: 0,
                message: `${prefix}${r.title}${channelInfo}`,
                pendingAt: null,
                firingAt: r.status === 'failed' ? r.created_at : null,
                resolvedAt: r.status === 'sent' ? r.created_at : null,
                createdAt: r.created_at,
                isNotificationEvent: true,
                channelName: r.channel_name,
                channelType: r.channel_type,
            };
        });
        // Combine and sort by created_at DESC
        const combined = [...alerts, ...notifications].sort((a, b) => b.createdAt - a.createdAt);
        // Apply limit
        return combined.slice(0, limit);
    }
    /**
     * Get count of active (firing) alerts for a server
     */
    getActiveAlertCount(serverId) {
        const result = db_1.db
            .prepare('SELECT COUNT(*) as count FROM alerts WHERE server_id = ? AND status = ?')
            .get(serverId, 'firing');
        return result.count;
    }
    /**
     * Initialize default alert rules for a new server
     */
    initializeDefaultRules(serverId) {
        const defaultRules = [
            {
                name: 'High CPU Usage',
                description: 'CPU usage above 90% for 5 minutes',
                metric: 'cpu_usage',
                operator: '>',
                threshold: 90,
                durationSeconds: 300,
                severity: 'critical',
            },
            {
                name: 'High Memory Usage',
                description: 'Memory usage above 90% for 5 minutes',
                metric: 'memory_usage',
                operator: '>',
                threshold: 90,
                durationSeconds: 300,
                severity: 'warning',
            },
            {
                name: 'Low Disk Space',
                description: 'Disk usage above 85%',
                metric: 'disk_usage',
                operator: '>',
                threshold: 85,
                durationSeconds: 0,
                severity: 'warning',
            },
            {
                name: 'Critical Disk Space',
                description: 'Disk usage above 95%',
                metric: 'disk_usage',
                operator: '>',
                threshold: 95,
                durationSeconds: 0,
                severity: 'critical',
            },
        ];
        for (const rule of defaultRules) {
            this.createAlertRule({
                serverId,
                ...rule,
            });
        }
    }
    // ============================================================================
    // Alert Syncing from VPS
    // ============================================================================
    /**
     * Sync alerts from VPS to local database
     * Parses state.json for currently firing alerts and agent.log for history
     */
    async syncAlertsFromVPS(serverId) {
        const errors = [];
        let synced = 0;
        const homeDir = await SSHService_1.sshService.getHomeDirectory(serverId);
        if (!homeDir) {
            return { synced: 0, errors: ['Could not determine home directory'] };
        }
        const agentPath = `${homeDir}/server-compass/agents/monitoring`;
        // 1. Fetch state.json for currently firing alerts
        const stateResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${agentPath}/state.json 2>/dev/null || echo "{}"`);
        let firingAlerts = {};
        try {
            firingAlerts = JSON.parse(stateResult.stdout.trim() || '{}');
        }
        catch (e) {
            errors.push(`Failed to parse state.json: ${e}`);
        }
        // 2. Fetch agent.log and parse alert events
        const logResult = await SSHService_1.sshService.executeCommand(serverId, `cat ${agentPath}/logs/agent.log 2>/dev/null | grep -E "ALERT (FIRING|RESOLVED):" | tail -100 || echo ""`);
        // Parse log entries like:
        // [2024-01-15 10:30:45] ALERT FIRING: High CPU Usage (cpu_usage > 90, current: 95.5)
        // [2024-01-15 10:35:45] ALERT RESOLVED: High CPU Usage (cpu_usage is now 45.2)
        const logEntries = logResult.stdout.trim().split('\n').filter(Boolean);
        // Get alert rules for matching
        const rules = this.getAlertRules(serverId);
        const rulesByName = new Map(rules.map(r => [r.name, r]));
        for (const entry of logEntries) {
            const firingMatch = entry.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ALERT FIRING: (.+?) \((\w+) ([><=!]+) ([\d.]+), current: ([\d.]+)\)/);
            const resolvedMatch = entry.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ALERT RESOLVED: (.+?) \((\w+) is now ([\d.]+)\)/);
            if (firingMatch) {
                const [, timestamp, ruleName, metric, operator, threshold, currentValue] = firingMatch;
                const rule = rulesByName.get(ruleName);
                if (rule) {
                    const alertTime = new Date(timestamp).getTime() / 1000;
                    this.upsertAlert({
                        serverId,
                        ruleId: rule.id,
                        ruleName,
                        status: 'firing',
                        severity: rule.severity,
                        metric,
                        operator,
                        threshold: parseFloat(threshold),
                        currentValue: parseFloat(currentValue),
                        firingAt: alertTime,
                    });
                    synced++;
                }
            }
            else if (resolvedMatch) {
                const [, timestamp, ruleName, metric, currentValue] = resolvedMatch;
                const rule = rulesByName.get(ruleName);
                if (rule) {
                    const resolvedTime = new Date(timestamp).getTime() / 1000;
                    this.upsertAlert({
                        serverId,
                        ruleId: rule.id,
                        ruleName,
                        status: 'resolved',
                        severity: rule.severity,
                        metric,
                        operator: rule.operator,
                        threshold: rule.threshold,
                        currentValue: parseFloat(currentValue),
                        resolvedAt: resolvedTime,
                    });
                    synced++;
                }
            }
        }
        // 3. Update any alerts that are currently firing based on state.json
        for (const [ruleId, state] of Object.entries(firingAlerts)) {
            if (state.firing) {
                const rule = rules.find(r => r.id === ruleId);
                if (rule) {
                    // Mark as firing if not already in alerts table
                    const existingAlert = db_1.db
                        .prepare('SELECT id FROM alerts WHERE rule_id = ? AND server_id = ? AND status = ?')
                        .get(ruleId, serverId, 'firing');
                    if (!existingAlert) {
                        this.upsertAlert({
                            serverId,
                            ruleId: rule.id,
                            ruleName: rule.name,
                            status: 'firing',
                            severity: rule.severity,
                            metric: rule.metric,
                            operator: rule.operator,
                            threshold: rule.threshold,
                            currentValue: 0, // Unknown from state.json
                            firingAt: state.since,
                        });
                        synced++;
                    }
                }
            }
        }
        return { synced, errors };
    }
    /**
     * Create or update an alert in the database
     */
    upsertAlert(alert) {
        const now = Math.floor(Date.now() / 1000);
        const message = alert.status === 'resolved'
            ? `${alert.ruleName}: ${alert.metric} is now ${alert.currentValue.toFixed(1)} (recovered)`
            : `${alert.ruleName}: ${alert.metric} ${alert.operator} ${alert.threshold} (current: ${alert.currentValue.toFixed(1)})`;
        // Check if there's an existing firing alert for this rule
        if (alert.status === 'resolved') {
            // Find and update the firing alert to resolved
            const existingFiring = db_1.db
                .prepare('SELECT id FROM alerts WHERE rule_id = ? AND server_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
                .get(alert.ruleId, alert.serverId, 'firing');
            if (existingFiring) {
                db_1.db.prepare('UPDATE alerts SET status = ?, resolved_at = ?, current_value = ?, message = ? WHERE id = ?')
                    .run('resolved', alert.resolvedAt ?? now, alert.currentValue, message, existingFiring.id);
                return;
            }
        }
        // Check if there's already an alert with this exact status
        const existing = db_1.db
            .prepare('SELECT id FROM alerts WHERE rule_id = ? AND server_id = ? AND status = ? AND created_at > ?')
            .get(alert.ruleId, alert.serverId, alert.status, now - 3600);
        if (existing) {
            // Update existing alert
            db_1.db.prepare('UPDATE alerts SET current_value = ?, message = ? WHERE id = ?')
                .run(alert.currentValue, message, existing.id);
        }
        else {
            // Create new alert
            const id = (0, crypto_1.randomUUID)();
            db_1.db.prepare(`
        INSERT INTO alerts (id, rule_id, server_id, status, severity, metric, threshold, current_value, message, pending_at, firing_at, resolved_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, alert.ruleId, alert.serverId, alert.status, alert.severity, alert.metric, alert.threshold, alert.currentValue, message, alert.pendingAt ?? null, alert.firingAt ?? (alert.status === 'firing' ? now : null), alert.resolvedAt ?? null, now);
        }
    }
}
exports.monitoringAgentService = new MonitoringAgentService();
//# sourceMappingURL=MonitoringAgentService.js.map