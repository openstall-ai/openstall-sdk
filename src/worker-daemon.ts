import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, unlink, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { OpenStall } from './agent.js';
import { loadConfig } from './cli-config.js';
import { log, logError, buildPrompt, execAgent, initCrust, type TaskInfo } from './worker-shared.js';

const STATE_DIR = join(homedir(), '.openstall');
const PID_FILE = join(STATE_DIR, 'worker.pid');
const LOG_DIR = join(STATE_DIR, 'logs');
const LOG_FILE = join(LOG_DIR, 'worker.log');

export interface DaemonOptions {
  categories: string[];
  tags?: string[];
  maxPrice?: number;
  agentCommand: string;
  port: number;
  webhookUrl: string;
  concurrency: number;
  noCrust?: boolean;
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

  // Subscribe with webhook URL
  await market.subscribeMailbox({
    categories: options.categories,
    tags: options.tags,
    maxPrice: options.maxPrice,
    webhookUrl: options.webhookUrl,
  });
  log(`Subscribed to: ${options.categories.join(', ')} — webhook: ${options.webhookUrl}`);

  const balance = await market.getBalance();
  log(`Balance: ${balance.balance} credits`);

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

  async function processTask(item: QueuedTask): Promise<void> {
    try {
      const task = await market.getTask(item.taskId);
      if (task.status !== 'open') {
        log(`Skipping ${item.taskId}: already ${task.status}`);
        return;
      }

      log(`Accepting ${item.taskId}...`);
      await market.acceptTask(task.id);

      log(`Running agent for ${item.taskId}...`);
      const taskInfo: TaskInfo = {
        id: task.id,
        category: task.category ?? 'unknown',
        description: task.description ?? '',
        input: task.input,
        maxPrice: task.maxPrice ?? 0,
      };

      const output = await execAgent(options.agentCommand, buildPrompt(taskInfo), useCrust);

      await market.deliverTask(task.id, output);
      const earned = Math.floor((task.maxPrice ?? 0) * 0.95);
      log(`Delivered ${item.taskId}! +${earned} credits`);
    } catch (err: any) {
      logError(`Failed ${item.taskId}: ${err.message}`);
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

        if (event.event === 'task.available' && event.task?.id) {
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

  // Fork detached child
  const child = fork(process.argv[1], [
    'worker', 'run',
    '--agent', options.agentCommand,
    '--categories', options.categories.join(','),
    '--port', String(options.port),
    '--webhook-url', options.webhookUrl,
    '--concurrency', String(options.concurrency),
    ...(options.tags ? ['--tags', options.tags.join(',')] : []),
    ...(options.maxPrice ? ['--max-price', String(options.maxPrice)] : []),
    ...(options.noCrust ? ['--no-crust'] : []),
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Redirect stdout/stderr to log file
  if (child.stdout) {
    child.stdout.on('data', (data: Buffer) => {
      appendFile(LOG_FILE, data).catch(() => {});
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      appendFile(LOG_FILE, data).catch(() => {});
    });
  }

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
