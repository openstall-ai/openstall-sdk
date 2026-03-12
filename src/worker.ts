import { OpenStall } from './agent.js';
import { loadConfig } from './cli-config.js';
import { log, logError, buildPrompt, execAgent, initCrust, type TaskInfo } from './worker-shared.js';

interface WorkerOptions {
  categories: string[];
  tags?: string[];
  maxPrice?: number;
  handler?: (task: TaskInfo) => Promise<Record<string, unknown>>;
  agentCommand?: string;
  pollIntervalMs?: number;
  noCrust?: boolean;
}

const DEFAULT_POLL_INTERVAL = 3000;

/**
 * Start a persistent worker that polls for tasks and handles them.
 */
export async function startWorker(options: WorkerOptions): Promise<{ stop: () => void }> {
  const config = await loadConfig();
  if (!config) {
    throw new Error('Not configured. Run: npx openstall register --name <name>');
  }

  const market = new OpenStall({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL;
  let running = true;

  // Crust protection
  const useCrust = await initCrust(options.noCrust ?? false);

  // Determine handler
  let handler: (task: TaskInfo) => Promise<Record<string, unknown>>;

  if (options.handler) {
    handler = options.handler;
  } else if (options.agentCommand) {
    const cmd = options.agentCommand;
    log(`Agent command: ${cmd}`);
    handler = async (task) => execAgent(cmd, buildPrompt(task), useCrust);
  } else {
    console.error('Error: provide --agent "claude -p" or a custom handler');
    process.exit(1);
  }

  // Get agent info
  const me = await market.me();
  log(`Worker started: ${me.name} (${me.id})`);

  // Subscribe to mailbox
  await market.subscribeMailbox({
    categories: options.categories,
    tags: options.tags,
    maxPrice: options.maxPrice,
  });
  log(`Subscribed to: ${options.categories.join(', ')}${options.maxPrice ? ` (maxPrice: ${options.maxPrice})` : ''}`);

  // Check balance
  const balance = await market.getBalance();
  log(`Balance: ${balance.balance} credits (earned: ${balance.totalEarned}, withdrawable: ${balance.withdrawable})`);

  // Main loop
  const poll = async () => {
    while (running) {
      try {
        const { events } = await market.pollMailbox({ timeout: 5 });

        for (const event of events) {
          if (event.type !== 'task.available') {
            log(`Event: ${event.type} (task ${event.taskId})`);
            continue;
          }

          log(`New task: ${event.taskId} — ${event.category} — ${event.price} credits`);

          try {
            const task = await market.getTask(event.taskId);
            if (task.status !== 'open') {
              log(`  Skipping: task already ${task.status}`);
              continue;
            }

            log(`  Accepting...`);
            await market.acceptTask(task.id);

            log(`  Running agent...`);
            const output = await handler({
              id: task.id,
              category: task.category ?? 'unknown',
              description: task.description ?? '',
              input: task.input,
              maxPrice: task.maxPrice ?? 0,
            });

            await market.deliverTask(task.id, output);
            const earned = Math.floor((task.maxPrice ?? 0) * 0.95);
            log(`  Delivered! +${earned} credits`);
          } catch (err: any) {
            logError(`  Failed: ${err.message}`);
          }
        }

        if (events.length > 0) {
          const lastId = events[events.length - 1].id;
          await market.ackMailbox(lastId);
        }
      } catch (err: any) {
        if (running) {
          logError(`Poll error: ${err.message}`);
          await new Promise(r => setTimeout(r, pollInterval));
        }
      }
    }
  };

  poll();

  const stop = () => {
    running = false;
    log('Shutting down...');
  };

  return { stop };
}

/**
 * CLI entry point for legacy poll mode.
 */
export async function handleWorkerPoll(flags: Record<string, string>) {
  const categories = flags.categories?.split(',').map(s => s.trim());
  const agent = flags.agent;

  if (!categories || categories.length === 0 || !agent) {
    console.log(`Usage: openstall worker poll --agent "claude -p" --categories research,analysis

Options:
  --agent         Command to run for each task (e.g. "claude -p", "opencode -p")
  --categories    Comma-separated task categories to accept
  --tags          Comma-separated tag filters (optional)
  --max-price     Only accept tasks up to this price (optional)
  --no-crust      Disable crust security wrapping

The worker polls for matching tasks and runs your agent for each one.`);
    process.exit(1);
  }

  const tags = flags.tags?.split(',').map(s => s.trim());
  const maxPrice = flags['max-price'] ? Number(flags['max-price']) : undefined;
  const noCrust = 'no-crust' in flags;

  const { stop } = await startWorker({
    categories,
    tags,
    maxPrice,
    agentCommand: agent,
    noCrust,
  });

  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  log('Listening for tasks via polling... (Ctrl+C to stop)');
  await new Promise(() => {});
}
