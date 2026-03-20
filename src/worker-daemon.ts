import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, unlink, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { OpenStall } from './agent.js';
import { loadConfig, type NotifyConfig } from './cli-config.js';
import { log, logError, buildPrompt, buildDecisionPrompt, buildQuotingPrompt, execAgent, execAgentDecision, initCrust, notify, type TaskInfo } from './worker-shared.js';

const STATE_DIR = join(homedir(), '.openstall');
const PID_FILE = join(STATE_DIR, 'worker.pid');
const LOG_DIR = join(STATE_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'worker.log');

export interface CapabilityConfig {
  name: string;
  description: string;
  price: number;
  category?: string;
  tags?: string[];
}

export interface DaemonOptions {
  categories: string[];
  tags?: string[];
  maxPrice?: number;
  agentCommand: string;
  port: number;
  webhookUrl: string;
  concurrency: number;
  noCrust?: boolean;
  autoAccept?: boolean;
  capabilities?: CapabilityConfig[];
  notifyCmd?: string;
  notify?: NotifyConfig;
}

interface QueuedTask {
  taskId: string;
  category?: string;
  price?: number;
}

export async function startWorkerDaemon(options: DaemonOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    throw new Error('Not configured. Run: npx openstall register --name <name>');
  }

  const market = new OpenStall({ apiKey: config.apiKey, baseUrl: config.baseUrl });

  // Crust protection
  const useCrust = await initCrust(options.noCrust ?? false);

  // Task queue and concurrency tracking
  const queue: QueuedTask[] = [];
  let activeTasks = 0;
  let totalProcessed = 0;
  let running = true;
  const startTime = Date.now();

  // Get agent info
  const me = await market.me();
  log(`Worker daemon started: ${me.name} (${me.id})`);

  // Publish capabilities if configured
  const publishedCapabilityIds: string[] = [];
  if (options.capabilities && options.capabilities.length > 0) {
    for (const cap of options.capabilities) {
      try {
        const published = await market.publishCapability({
          name: cap.name,
          description: cap.description,
          price: cap.price,
          category: cap.category as any,
          tags: cap.tags,
        });
        publishedCapabilityIds.push(published.id);
        log(`Published capability: ${cap.name} (${published.id}) — ${cap.price} credits`);
      } catch (err: any) {
        logError(`Failed to publish capability "${cap.name}": ${err.message}`);
      }
    }
  }

  // Drain stale mailbox events from previous sessions before subscribing
  let drained = 0;
  while (true) {
    const { events } = await market.pollMailbox({ timeout: 0 });
    if (events.length === 0) break;
    drained += events.length;
    await market.ackMailbox(events[events.length - 1].id);
  }
  if (drained > 0) log(`Drained ${drained} stale mailbox event(s)`);

  // Subscribe with webhook URL
  await market.subscribeMailbox({
    categories: options.categories,
    tags: options.tags,
    maxPrice: options.maxPrice,
    webhookUrl: options.webhookUrl,
  });
  log(`Subscribed to: ${options.categories.length === 0 ? 'ALL categories' : options.categories.join(', ')} — webhook: ${options.webhookUrl}`);

  const balance = await market.getBalance();
  log(`Balance: ${balance.balance} credits`);
  notify(options.notify ?? options.notifyCmd, 'worker.started', `Worker started! Subscribed to: ${options.categories.length === 0 ? 'ALL categories' : options.categories.join(', ')}. Balance: ${balance.balance} credits.`);

  // ─── Task Processing ───

  function drainQueue() {
    while (running && queue.length > 0 && activeTasks < options.concurrency) {
      const item = queue.shift()!;
      activeTasks++;
      processTask(item).finally(() => {
        activeTasks--;
        totalProcessed++;
        drainQueue();
      });
    }
  }

  async function processQuoteRequest(taskId: string): Promise<void> {
    try {
      const task = await market.getTask(taskId);
      if (task.status !== 'open') {
        log(`Skipping quote ${taskId}: already ${task.status}`);
        return;
      }
      const taskInfo: TaskInfo = {
        id: task.id,
        category: task.category ?? 'unknown',
        description: task.description ?? '',
        input: task.input,
        maxPrice: task.maxPrice ?? 0,
      };
      log(`Evaluating quote for ${taskId}...`);
      const decision = await execAgentDecision(
        options.agentCommand,
        buildQuotingPrompt(taskInfo),
        useCrust,
      );
      if (!decision.accept || !decision.price) {
        log(`Declined quote ${taskId}: ${decision.reason}`);
        notify(options.notify ?? options.notifyCmd, 'task.rejected',
          `Quote declined: ${decision.reason.slice(0, 120)} (${task.category}: ${(task.description ?? '').slice(0, 60)})`);
        return;
      }
      const price = decision.price!;
      log(`Submitting quote for ${taskId}: ${price} credits`);
      await market.quoteTask(task.id, price);
      notify(options.notify ?? options.notifyCmd, 'task.quoted',
        `Quote submitted: ${price} credits (${task.category}: ${(task.description ?? '').slice(0, 60)})`);
    } catch (err: any) {
      logError(`Quote failed for ${taskId}: ${err.message}`);
      notify(options.notify ?? options.notifyCmd, 'task.failed', `Quote failed: ${err.message.slice(0, 120)}`);
    }
  }

  async function processApprovedTask(taskId: string): Promise<void> {
    try {
      const task = await market.getTask(taskId);
      if (task.status !== 'in_progress') {
        log(`Skipping approved ${taskId}: already ${task.status}`);
        return;
      }
      const taskInfo: TaskInfo = {
        id: task.id,
        category: task.category ?? 'unknown',
        description: task.description ?? '',
        input: task.input,
        maxPrice: task.quotedPrice ?? task.maxPrice ?? 0,
      };
      try {
        log(`Running agent for approved ${taskId}...`);
        const output = await execAgent(options.agentCommand, buildPrompt(taskInfo), useCrust);
        if (output.error && Object.keys(output).length <= 2) {
          log(`Agent returned error for ${taskId}: ${String(output.error).slice(0, 200)}`);
          await market.cancelTask(task.id);
          notify(options.notify ?? options.notifyCmd, 'task.cancelled',
            `Task cancelled — agent cannot fulfill: ${String(output.error).slice(0, 100)}`);
          return;
        }
        await market.deliverTask(task.id, output);
        const earned = Math.floor((task.quotedPrice ?? task.maxPrice ?? 0) * 0.95);
        log(`Delivered ${taskId}! +${earned} credits`);
        notify(options.notify ?? options.notifyCmd, 'task.completed',
          `Task completed! +${earned} credits (${task.category}: ${(task.description ?? '').slice(0, 80)})`);
      } catch (execErr: any) {
        logError(`Execution failed for ${taskId}: ${execErr.message}`);
        try {
          await market.cancelTask(task.id);
          log(`Task ${taskId} cancelled, escrow refunded to buyer`);
        } catch (cancelErr: any) {
          logError(`Failed to cancel ${taskId}: ${cancelErr.message}`);
        }
        notify(options.notify ?? options.notifyCmd, 'task.failed',
          `Task failed: ${execErr.message.slice(0, 120)} (task cancelled, buyer refunded)`);
      }
    } catch (err: any) {
      logError(`Approved task failed ${taskId}: ${err.message}`);
      notify(options.notify ?? options.notifyCmd, 'task.failed', `Task failed: ${err.message.slice(0, 120)}`);
    }
  }

  async function processTask(item: QueuedTask): Promise<void> {
    try {
      const task = await market.getTask(item.taskId);
      if (task.status !== 'open') {
        log(`Skipping ${item.taskId}: already ${task.status}`);
        return;
      }

      const taskInfo: TaskInfo = {
        id: task.id,
        category: task.category ?? 'unknown',
        description: task.description ?? '',
        input: task.input,
        maxPrice: task.maxPrice ?? 0,
      };

      // Decision phase: let agent evaluate before accepting
      if (!options.autoAccept) {
        log(`Evaluating ${item.taskId}...`);
        const decision = await execAgentDecision(
          options.agentCommand,
          buildDecisionPrompt(taskInfo),
          useCrust,
        );
        if (!decision.accept) {
          log(`Rejected ${item.taskId}: ${decision.reason}`);
          notify(options.notify ?? options.notifyCmd, 'task.rejected',
            `Task rejected: ${decision.reason.slice(0, 120)} (${task.category}: ${(task.description ?? '').slice(0, 60)})`);
          return;
        }
        log(`Agent accepted ${item.taskId}: ${decision.reason}`);
      }

      log(`Accepting ${item.taskId}...`);
      await market.acceptTask(task.id);

      try {
        log(`Running agent for ${item.taskId}...`);
        const output = await execAgent(options.agentCommand, buildPrompt(taskInfo), useCrust);

        // Check if agent returned an error instead of a real result
        if (output.error && Object.keys(output).length <= 2) {
          log(`Agent returned error for ${item.taskId}: ${String(output.error).slice(0, 200)}`);
          log(`Cancelling ${item.taskId} (cannot fulfill)...`);
          await market.cancelTask(task.id);
          notify(options.notify ?? options.notifyCmd, 'task.cancelled',
            `Task cancelled — agent cannot fulfill: ${String(output.error).slice(0, 100)} (${task.category}: ${(task.description ?? '').slice(0, 60)})`);
          return;
        }

        await market.deliverTask(task.id, output);
        const earned = Math.floor((task.maxPrice ?? 0) * 0.95);
        log(`Delivered ${item.taskId}! +${earned} credits`);
        notify(options.notify ?? options.notifyCmd, 'task.completed',
          `Task completed! +${earned} credits (${task.category}: ${(task.description ?? '').slice(0, 80)})`);
      } catch (execErr: any) {
        logError(`Execution failed for ${item.taskId}: ${execErr.message}`);
        try {
          await market.cancelTask(task.id);
          log(`Task ${item.taskId} cancelled, escrow refunded to buyer`);
        } catch (cancelErr: any) {
          logError(`Failed to cancel ${item.taskId}: ${cancelErr.message}`);
        }
        notify(options.notify ?? options.notifyCmd, 'task.failed',
          `Task failed: ${execErr.message.slice(0, 120)} (task cancelled, buyer refunded)`);
      }
    } catch (err: any) {
      logError(`Failed ${item.taskId}: ${err.message}`);
      notify(options.notify ?? options.notifyCmd, 'task.failed', `Task failed: ${err.message.slice(0, 120)}`);
    }
  }

  // ─── HTTP Server ───

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  function respond(res: ServerResponse, status: number, body: Record<string, unknown>) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${options.port}`);

    if (req.method === 'POST' && url.pathname === '/webhook') {
      // Respond 200 immediately — server has 5s timeout
      respond(res, 200, { ok: true });

      try {
        const body = await readBody(req);
        const event = JSON.parse(body);

        if (event.event === 'task.quote_requested' && event.taskId) {
          log(`Webhook: task.quote_requested ${event.taskId}`);
          activeTasks++;
          processQuoteRequest(event.taskId).finally(() => { activeTasks--; totalProcessed++; });
        } else if (event.event === 'task.approved' && event.taskId) {
          log(`Webhook: task.approved ${event.taskId}`);
          activeTasks++;
          processApprovedTask(event.taskId).finally(() => { activeTasks--; totalProcessed++; });
        } else if (event.event === 'task.available' && event.task?.id) {
          log(`Webhook: task.available ${event.task.id}`);
          queue.push({
            taskId: event.task.id,
            category: event.task.category,
            price: event.task.maxPrice,
          });
          drainQueue();
        }
      } catch (err: any) {
        logError(`Webhook parse error: ${err.message}`);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      respond(res, 200, {
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        activeTasks,
        queuedTasks: queue.length,
        totalProcessed,
        concurrency: options.concurrency,
        categories: options.categories,
      });
      return;
    }

    respond(res, 404, { error: 'not found' });
  });

  server.listen(options.port, () => {
    log(`HTTP server listening on port ${options.port}`);
    log(`Webhook endpoint: ${options.webhookUrl}`);
    log(`Health check: http://localhost:${options.port}/health`);
    log(`Concurrency: ${options.concurrency}`);
    log('Waiting for tasks...');
  });

  // ─── Graceful Shutdown ───

  async function shutdown() {
    if (!running) return;
    running = false;
    log('Shutting down...');

    // Stop accepting new tasks
    server.close();

    // Unpublish capabilities published by this session
    for (const capId of publishedCapabilityIds) {
      try {
        await market.deleteCapability(capId);
        log(`Unpublished capability: ${capId}`);
      } catch (err: any) {
        logError(`Failed to unpublish ${capId}: ${err.message}`);
      }
    }

    // Unsubscribe webhook
    try {
      await market.subscribeMailbox({
        categories: options.categories,
        tags: options.tags,
        maxPrice: options.maxPrice,
        webhookUrl: undefined,
      });
      log('Unsubscribed webhook');
    } catch (err: any) {
      logError(`Failed to unsubscribe: ${err.message}`);
    }

    // Wait for in-flight tasks (30s hard timeout)
    if (activeTasks > 0) {
      log(`Waiting for ${activeTasks} in-flight task(s)...`);
      const deadline = Date.now() + 30_000;
      while (activeTasks > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
      }
      if (activeTasks > 0) {
        logError(`Force exit with ${activeTasks} task(s) still running`);
      }
    }

    // Remove PID file
    try { await unlink(PID_FILE); } catch {}

    log('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ─── Daemon Lifecycle ───

export async function daemonStart(options: DaemonOptions): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });

  // Check if already running
  const existingPid = await readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.error(`Worker already running (PID ${existingPid}). Stop it first: openstall worker stop`);
    process.exit(1);
  }

  // Build --publish args for child process
  const publishArgs: string[] = [];
  if (options.capabilities) {
    for (const cap of options.capabilities) {
      const parts = [cap.name, cap.description, String(cap.price)];
      if (cap.category) parts.push(cap.category);
      if (cap.tags) parts.push(cap.tags.join(','));
      publishArgs.push('--publish', parts.join(':'));
    }
  }

  // Open log file as fd so the child writes directly — no pipes to break when parent exits
  const logFd = openSync(LOG_FILE, 'a');

  // Spawn detached child (not fork — no IPC needed, so child survives parent exit)
  const child = spawn(process.execPath, [
    process.argv[1],
    'worker', 'run',
    '--agent', options.agentCommand,
    ...(options.categories.length > 0 ? ['--categories', options.categories.join(',')] : []),
    '--port', String(options.port),
    '--webhook-url', options.webhookUrl,
    '--concurrency', String(options.concurrency),
    ...(options.tags ? ['--tags', options.tags.join(',')] : []),
    ...(options.maxPrice ? ['--max-price', String(options.maxPrice)] : []),
    ...(options.noCrust ? ['--no-crust'] : []),
    ...(options.autoAccept ? ['--auto-accept'] : []),
    ...publishArgs,
  ], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  // Write PID
  await writeFile(PID_FILE, String(child.pid));
  child.unref();

  console.log(`Worker started in background (PID ${child.pid})`);
  console.log(`Logs: ${LOG_FILE}`);
  console.log(`Stop: openstall worker stop`);

  // Give child a moment to start, then detach
  setTimeout(() => process.exit(0), 500);
}

export async function daemonStop(): Promise<void> {
  const pid = await readPid();
  if (!pid) {
    console.log('No worker PID file found');
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`Worker (PID ${pid}) is not running. Cleaning up PID file.`);
    try { await unlink(PID_FILE); } catch {}
    return;
  }

  process.kill(pid, 'SIGTERM');
  console.log(`Sent SIGTERM to worker (PID ${pid})`);

  // Wait up to 10s for process to exit
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!isProcessAlive(pid)) {
      console.log('Worker stopped');
      try { await unlink(PID_FILE); } catch {}
      return;
    }
  }

  console.log('Worker did not stop gracefully, sending SIGKILL');
  try { process.kill(pid, 'SIGKILL'); } catch {}
  try { await unlink(PID_FILE); } catch {}
  console.log('Worker killed');
}

export async function daemonStatus(): Promise<void> {
  const pid = await readPid();
  if (!pid) {
    console.log('Worker is not running (no PID file)');
    return;
  }

  if (isProcessAlive(pid)) {
    console.log(`Worker is running (PID ${pid})`);
  } else {
    console.log(`Worker is not running (stale PID ${pid})`);
    try { await unlink(PID_FILE); } catch {}
  }
}

export async function daemonLogs(lines = 50): Promise<void> {
  try {
    const content = await readFile(LOG_FILE, 'utf-8');
    const allLines = content.split('\n');
    const tail = allLines.slice(-lines).join('\n');
    console.log(tail);
  } catch {
    console.log(`No log file found at ${LOG_FILE}`);
  }
}

// ─── Helpers ───

async function readPid(): Promise<number | null> {
  try {
    const content = await readFile(PID_FILE, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
