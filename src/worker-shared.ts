import { execFile, exec } from 'node:child_process';
import { request } from 'node:https';
import type { NotifyConfig } from './cli-config.js';

export interface TaskInfo {
  id: string;
  category: string;
  description: string;
  input: Record<string, unknown>;
  maxPrice: number;
}

export function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`\x1b[36m[${ts}]\x1b[0m ${msg}`);
}

export function logError(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`\x1b[31m[${ts}]\x1b[0m ${msg}`);
}

/**
 * Detect if crust is installed on PATH.
 */
export async function detectCrust(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', ['crust'], { timeout: 3000 }, (error) => {
      resolve(!error);
    });
  });
}

/**
 * Log crust protection status at worker startup.
 * Returns whether crust should be used.
 */
export async function initCrust(noCrust: boolean): Promise<boolean> {
  if (noCrust) {
    log('Crust protection: \x1b[33mdisabled\x1b[0m (--no-crust)');
    return false;
  }

  const available = await detectCrust();
  if (available) {
    log('Crust protection: \x1b[32mactive\x1b[0m');
    return true;
  }

  log('Crust protection: \x1b[33mnot available\x1b[0m (install: https://github.com/BakeLens/crust)');
  return false;
}

export function buildPrompt(task: TaskInfo): string {
  return [
    `You are completing a task from OpenStall.`,
    ``,
    `Category: ${task.category}`,
    `Description: ${task.description}`,
    `Payment: ${task.maxPrice} credits (you earn ${Math.floor(task.maxPrice * 0.95)})`,
    ``,
    `Input:`,
    JSON.stringify(task.input, null, 2),
    ``,
    `Complete this task. Output ONLY valid JSON with your result — no markdown, no explanation, just the JSON object.`,
  ].join('\n');
}

export function buildQuotingPrompt(task: TaskInfo): string {
  const inputSummary = JSON.stringify(task.input, null, 2).slice(0, 2000);
  return [
    `You are an OpenStall worker agent. A client has requested YOUR capability — this is a task directed specifically to you because you published this capability on the marketplace.`,
    ``,
    `IMPORTANT: You published this capability yourself. Do NOT decline based on assumptions about what you can or cannot do. Before declining, check your tools, skills, MCP servers, SOUL.md, CLAUDE.md, and any configuration files. If you have the tools to fulfill this task, accept it and propose a price.`,
    ``,
    `Category: ${task.category}`,
    `Capability description: ${task.description}`,
    ...(task.maxPrice > 0 ? [`Client budget ceiling: ${task.maxPrice} credits`] : []),
    ``,
    `Client input:`,
    inputSummary,
    ``,
    `Propose a fair price. Consider:`,
    `- The complexity and effort required`,
    `- The value you're providing to the client`,
    ...(task.maxPrice > 0 ? [`- The client's budget ceiling of ${task.maxPrice} credits`] : []),
    ``,
    `Respond with ONLY a JSON object: {"accept": true, "price": <credits>, "reason": "..."}  or  {"accept": false, "reason": "..."}`,
  ].join('\n');
}

export function buildDecisionPrompt(task: TaskInfo): string {
  const inputSummary = JSON.stringify(task.input, null, 2).slice(0, 2000);
  return [
    `You are an OpenStall worker agent evaluating whether to accept a task.`,
    ``,
    `Category: ${task.category}`,
    `Description: ${task.description}`,
    `Payment: ${task.maxPrice} credits (you earn ${Math.floor(task.maxPrice * 0.95)})`,
    ``,
    `Input:`,
    inputSummary,
    ``,
    `Evaluate this task. Consider:`,
    `- Is this within your capabilities?`,
    `- Is the payment fair for the expected effort?`,
    `- Can you deliver quality output?`,
    ``,
    `Respond with ONLY a JSON object: {"accept": true, "reason": "..."}  or  {"accept": false, "reason": "..."}`,
  ].join('\n');
}

/**
 * Send a notification to the operator.
 * Supports built-in providers (Telegram, Slack, Discord, webhook) or legacy shell command.
 * Fire-and-forget — errors are logged but never block task processing.
 */
export function notify(config: NotifyConfig | string | undefined, event: string, message: string): void {
  if (!config) return;

  const fullMsg = `[OpenStall] ${message}`;

  // Legacy: string = shell command
  if (typeof config === 'string') {
    const cmd = `${config} ${JSON.stringify(fullMsg)}`;
    exec(cmd, { timeout: 30_000 }, (error) => {
      if (error) logError(`Notify failed: ${error.message}`);
    });
    return;
  }

  // Built-in providers
  switch (config.provider) {
    case 'telegram':
      notifyTelegram(config, fullMsg);
      break;
    case 'slack':
      notifyWebhook(config.webhookUrl!, JSON.stringify({ text: fullMsg }));
      break;
    case 'discord':
      notifyWebhook(config.webhookUrl!, JSON.stringify({ content: fullMsg }));
      break;
    case 'webhook':
      notifyWebhook(config.webhookUrl!, JSON.stringify({ event, message: fullMsg, timestamp: new Date().toISOString() }));
      break;
    default:
      logError(`Unknown notify provider: ${(config as any).provider}`);
  }
}

function notifyTelegram(config: NotifyConfig, text: string): void {
  if (!config.botToken || !config.chatId) {
    logError('Telegram notify: missing botToken or chatId');
    return;
  }
  const body = JSON.stringify({ chat_id: config.chatId, text });
  const url = new URL(`https://api.telegram.org/bot${config.botToken}/sendMessage`);
  const req = request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10_000,
  }, (res) => {
    if (res.statusCode && res.statusCode >= 400) {
      logError(`Telegram notify failed: HTTP ${res.statusCode}`);
    }
    res.resume(); // drain
  });
  req.on('error', (err) => logError(`Telegram notify error: ${err.message}`));
  req.end(body);
}

function notifyWebhook(url: string, body: string): void {
  if (!url) {
    logError('Webhook notify: missing URL');
    return;
  }
  const parsed = new URL(url);
  const mod = parsed.protocol === 'https:' ? require('node:https') : require('node:http');
  const req = mod.request({
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10_000,
  }, (res: any) => {
    if (res.statusCode && res.statusCode >= 400) {
      logError(`Webhook notify failed: HTTP ${res.statusCode}`);
    }
    res.resume();
  });
  req.on('error', (err: Error) => logError(`Webhook notify error: ${err.message}`));
  req.end(body);
}

export async function execAgent(command: string, prompt: string, useCrust = false): Promise<Record<string, unknown>> {
  const fullCommand = useCrust ? `crust wrap -- ${command}` : command;
  const parts = fullCommand.split(/\s+/);
  const bin = parts[0];
  const args = [...parts.slice(1), prompt];

  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Agent command failed: ${error.message}${stderr ? `\nstderr: ${stderr}` : ''}`));
        return;
      }

      const output = stdout.trim();

      let jsonStr = output;
      const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      try {
        const parsed = JSON.parse(jsonStr);
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : { result: parsed });
      } catch {
        resolve({ result: output });
      }
    });
  });
}

export async function execAgentDecision(
  command: string,
  prompt: string,
  useCrust = false,
  timeoutMs = 30_000,
): Promise<{ accept: boolean; reason: string }> {
  const fullCommand = useCrust ? `crust wrap -- ${command}` : command;
  const parts = fullCommand.split(/\s+/);
  const bin = parts[0];
  const args = [...parts.slice(1), prompt];

  return new Promise((resolve) => {
    execFile(bin, args, {
      maxBuffer: 1 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env },
    }, (error, stdout) => {
      if (error) {
        resolve({ accept: false, reason: `Agent decision failed: ${error.message}` });
        return;
      }

      const output = stdout.trim();
      let jsonStr = output;
      const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (jsonMatch) jsonStr = jsonMatch[1].trim();

      try {
        const parsed = JSON.parse(jsonStr);
        resolve({
          accept: parsed.accept === true,
          reason: parsed.reason || '',
        });
      } catch {
        resolve({ accept: false, reason: `Failed to parse decision: ${output.slice(0, 200)}` });
      }
    });
  });
}
