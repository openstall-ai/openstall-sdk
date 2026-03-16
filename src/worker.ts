import { OpenStall } from './agent.js';
import { loadConfig, type NotifyConfig } from './cli-config.js';
import { log, logError, buildPrompt, buildDecisionPrompt, buildQuotingPrompt, execAgent, execAgentDecision, initCrust, notify, type TaskInfo } from './worker-shared.js';

interface WorkerOptions {
  categories: string[];
  tags?: string[];
  maxPrice?: number;
  handler?: (task: TaskInfo) => Promise<Record<string, unknown>>;
  agentCommand?: string;
  pollIntervalMs?: number;
  noCrust?: boolean;
  autoAccept?: boolean;
  notifyCmd?: string;
  notify?: NotifyConfig;
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
  log(`Subscribed to: ${options.categories.length === 0 ? 'ALL categories' : options.categories.join(', ')}${options.maxPrice ? ` (maxPrice: ${options.maxPrice})` : ''}`);

  // Check balance
  const balance = await market.getBalance();
  log(`Balance: ${balance.balance} credits (earned: ${balance.totalEarned}, withdrawable: ${balance.withdrawable})`);

  // Drain stale mailbox events from previous sessions
  let drained = 0;
  while (true) {
    const { events } = await market.pollMailbox({ timeout: 0 });
    if (events.length === 0) break;
    drained += events.length;
    await market.ackMailbox(events[events.length - 1].id);
  }
  if (drained > 0) log(`Drained ${drained} stale mailbox event(s)`);

  // Main loop
  const poll = async () => {
    while (running) {
      try {
        const { events } = await market.pollMailbox({ timeout: 5 });

        for (const event of events) {
          // ── Quote requested: provider must evaluate and submit a price ──
          if (event.type === 'task.quote_requested') {
            log(`Quote request: ${event.taskId}`);
            try {
              const task = await market.getTask(event.taskId);
              if (task.status !== 'open') {
                log(`  Skipping: task already ${task.status}`);
                continue;
              }
              const taskInfo: TaskInfo = {
                id: task.id,
                category: task.category ?? 'unknown',
                description: task.description ?? '',
                input: task.input,
                maxPrice: task.maxPrice ?? 0,
              };
              if (options.agentCommand) {
                log(`  Evaluating quote...`);
                const decision = await execAgentDecision(
                  options.agentCommand,
                  buildQuotingPrompt(taskInfo),
                  useCrust,
                );
                if (!decision.accept || !(decision as any).price) {
                  log(`  Declined quote: ${decision.reason}`);
                  notify(options.notify ?? options.notifyCmd, 'task.rejected',
                    `Quote declined: ${decision.reason.slice(0, 120)} (${task.category}: ${(task.description ?? '').slice(0, 60)})`);
                  continue;
                }
                const price = (decision as any).price as number;
                log(`  Submitting quote: ${price} credits`);
                await market.quoteTask(task.id, price);
                log(`  Quote submitted`);
                notify(options.notify ?? options.notifyCmd, 'task.quoted',
                  `Quote submitted: ${price} credits (${task.category}: ${(task.description ?? '').slice(0, 60)})`);
              }
            } catch (err: any) {
              logError(`  Quote failed: ${err.message}`);
              notify(options.notify ?? options.notifyCmd, 'task.failed', `Quote failed: ${err.message.slice(0, 120)}`);
            }
            continue;
          }

          // ── Quote approved: provider should execute the task ──
          if (event.type === 'task.approved') {
            log(`Quote approved: ${event.taskId}`);
            try {
              const task = await market.getTask(event.taskId);
              if (task.status !== 'in_progress') {
                log(`  Skipping: task already ${task.status}`);
                continue;
              }
              const taskInfo: TaskInfo = {
                id: task.id,
                category: task.category ?? 'unknown',
                description: task.description ?? '',
                input: task.input,
                maxPrice: task.quotedPrice ?? task.maxPrice ?? 0,
              };
              try {
                log(`  Running agent...`);
                const output = await handler(taskInfo);
                if (output.error && Object.keys(output).length <= 2) {
                  log(`  Agent returned error: ${String(output.error).slice(0, 200)}`);
                  await market.cancelTask(task.id);
                  notify(options.notify ?? options.notifyCmd, 'task.cancelled',
                    `Task cancelled — agent cannot fulfill: ${String(output.error).slice(0, 100)}`);
                  continue;
                }
                await market.deliverTask(task.id, output);
                const earned = Math.floor((task.quotedPrice ?? task.maxPrice ?? 0) * 0.95);
                log(`  Delivered! +${earned} credits`);
                notify(options.notify ?? options.notifyCmd, 'task.completed',
                  `Task completed! +${earned} credits (${task.category}: ${(task.description ?? '').slice(0, 80)})`);
              } catch (execErr: any) {
                logError(`  Execution failed: ${execErr.message}`);
                try {
                  await market.cancelTask(task.id);
                  log(`  Task cancelled, escrow refunded to buyer`);
                } catch (cancelErr: any) {
                  logError(`  Failed to cancel task: ${cancelErr.message}`);
                }
                notify(options.notify ?? options.notifyCmd, 'task.failed',
                  `Task failed: ${execErr.message.slice(0, 120)} (task cancelled, buyer refunded)`);
              }
            } catch (err: any) {
              logError(`  Approved task failed: ${err.message}`);
              notify(options.notify ?? options.notifyCmd, 'task.failed', `Task failed: ${err.message.slice(0, 120)}`);
            }
            continue;
          }

          if (event.type !== 'task.available') {
            log(`Event: ${event.type} (task ${event.taskId})`);
            continue;
          }

          // ── task.available: standard accept/execute flow ──
          log(`New task: ${event.taskId} — ${event.category} — ${event.price} credits`);

          try {
            const task = await market.getTask(event.taskId);
            if (task.status !== 'open') {
              log(`  Skipping: task already ${task.status}`);
              continue;
            }

            const taskInfo: TaskInfo = {
              id: task.id,
              category: task.category ?? 'unknown',
              description: task.description ?? '',
              input: task.input,
              maxPrice: task.maxPrice ?? 0,
            };

            // Decision phase: let agent evaluate before accepting
            if (!options.autoAccept && options.agentCommand) {
              log(`  Evaluating...`);
              const decision = await execAgentDecision(
                options.agentCommand,
                buildDecisionPrompt(taskInfo),
                useCrust,
              );
              if (!decision.accept) {
                log(`  Rejected: ${decision.reason}`);
                notify(options.notify ?? options.notifyCmd, 'task.rejected',
                  `Task rejected: ${decision.reason.slice(0, 120)} (${task.category}: ${(task.description ?? '').slice(0, 60)})`);
                continue;
              }
              log(`  Agent accepted: ${decision.reason}`);
            }

            log(`  Accepting...`);
            await market.acceptTask(task.id);

            try {
              log(`  Running agent...`);
              const output = await handler(taskInfo);

              // Check if agent returned an error instead of a real result
              if (output.error && Object.keys(output).length <= 2) {
                log(`  Agent returned error: ${String(output.error).slice(0, 200)}`);
                log(`  Cancelling task (cannot fulfill)...`);
                await market.cancelTask(task.id);
                notify(options.notify ?? options.notifyCmd, 'task.cancelled',
                  `Task cancelled — agent cannot fulfill: ${String(output.error).slice(0, 100)} (${task.category}: ${(task.description ?? '').slice(0, 60)})`);
                continue;
              }

              await market.deliverTask(task.id, output);
              const earned = Math.floor((task.maxPrice ?? 0) * 0.95);
              log(`  Delivered! +${earned} credits`);
              notify(options.notify ?? options.notifyCmd, 'task.completed',
                `Task completed! +${earned} credits (${task.category}: ${(task.description ?? '').slice(0, 80)})`);
            } catch (execErr: any) {
              logError(`  Execution failed: ${execErr.message}`);
              // Try to cancel the task so escrow is refunded to buyer
              try {
                await market.cancelTask(task.id);
                log(`  Task cancelled, escrow refunded to buyer`);
              } catch (cancelErr: any) {
                logError(`  Failed to cancel task: ${cancelErr.message}`);
              }
              notify(options.notify ?? options.notifyCmd, 'task.failed',
                `Task failed: ${execErr.message.slice(0, 120)} (task cancelled, buyer refunded)`);
            }
          } catch (err: any) {
            logError(`  Failed: ${err.message}`);
            notify(options.notify ?? options.notifyCmd, 'task.failed', `Task failed: ${err.message.slice(0, 120)}`);
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
  // Read agentCmd from config if not provided via --agent
  if (!flags.agent) {
    const { loadConfig } = await import('./cli-config.js');
    const config = await loadConfig();
    if (config?.agentCmd) flags.agent = config.agentCmd;
  }

  const categories = flags.categories?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
  const agent = flags.agent;

  if (!agent) {
    console.log(`Usage: openstall worker poll --agent "claude -p"

Options:
  --agent         Command to run for each task (reads from config agentCmd if not set)
  --categories    Comma-separated task categories to accept (omit to subscribe to ALL)
  --tags          Comma-separated tag filters (optional)
  --max-price     Only accept tasks up to this price (optional)
  --no-crust      Disable crust security wrapping
  --notify-cmd    Command to notify operator on events (reads from config notifyCmd if not set)

The worker polls for matching tasks and runs your agent for each one.`);
    process.exit(1);
  }

  const tags = flags.tags?.split(',').map(s => s.trim());
  const maxPrice = flags['max-price'] ? Number(flags['max-price']) : undefined;
  const noCrust = 'no-crust' in flags;
  const autoAccept = 'auto-accept' in flags;

  // Read notify config from config file
  const { loadConfig: lc } = await import('./cli-config.js');
  const cfg = await lc();
  const notifyConfig = cfg?.notify;
  const notifyCmd = flags['notify-cmd'] || cfg?.notifyCmd;

  const { stop } = await startWorker({
    categories,
    tags,
    maxPrice,
    agentCommand: agent,
    noCrust,
    autoAccept,
    notify: notifyConfig,
    notifyCmd,
  });

  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  log('Listening for tasks via polling... (Ctrl+C to stop)');
  await new Promise(() => {});
}
