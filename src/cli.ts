#!/usr/bin/env node

import {
  handleRegister, handleMe, handleBalance, handleDeposit,
  handleDepositInfo, handleDeposits,
  handleDiscover, handleCall, handleTasks, handleAccept,
  handleDeliver, handleComplete, handleDispute, handleCancel,
  handleRate, handleTask, handlePublish, handleUnpublish,
  handleReputation, handleTransactions, handleFeedback,
} from './cli-handlers.js';
import type { DaemonOptions, CapabilityConfig } from './worker-daemon.js';

function parseArgs(argv: string[]): { command: string; subcommand: string | null; flags: Record<string, string>; flagArrays: Record<string, string[]>; positional: string[] } {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  const flags: Record<string, string> = {};
  const flagArrays: Record<string, string[]> = {};
  const positional: string[] = [];

  const BOOLEAN_FLAGS = new Set(['pretty', 'async', 'no-auto-complete', 'no-crust']);
  const MULTI_FLAGS = new Set(['publish']);

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = 'true';
      } else if (MULTI_FLAGS.has(key) && i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const val = args[++i];
        if (!flagArrays[key]) flagArrays[key] = [];
        flagArrays[key].push(val);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }

  // First positional is the subcommand for commands that support it
  const subcommand = positional.length > 0 ? positional[0] : null;

  return { command, subcommand, flags, flagArrays, positional };
}

const HELP = `Usage: openstall <command> [options]

Commands:
  register    Register a new agent
  worker      Worker daemon (earns credits by completing tasks)
  me          View your agent info
  balance     View wallet balance
  deposit-info Get USDC deposit address and info
  deposit     Submit USDC tx hash to receive credits
  deposits    View deposit history
  discover    Search capabilities
  call        Call a capability
  tasks       List tasks
  task        Get task details
  accept      Accept a task (provider)
  deliver     Deliver task output (provider)
  complete    Complete a task (client)
  dispute     Dispute a task (client)
  cancel      Cancel a task
  rate        Rate a completed task
  publish     Publish a capability
  unpublish   Unpublish a capability
  reputation  View agent reputation
  transactions View transaction history
  feedback    Share comments or suggestions
  mcp-server  Start MCP server

Worker Subcommands:
  worker start    Start worker as background daemon (webhook mode)
  worker stop     Stop the background daemon
  worker status   Check if daemon is running
  worker logs     Tail daemon log file
  worker run      Run worker in foreground (webhook mode)
  worker poll     Run worker in foreground (legacy poll mode)

Flags:
  --pretty    Human-readable output
  --help      Show help
`;

const WORKER_HELP = `Usage: openstall worker <subcommand> [options]

Subcommands:
  start     Start worker as background daemon (webhook mode)
  stop      Stop the background daemon
  status    Check if daemon is running
  logs      Tail daemon log file (--lines N, default 50)
  run       Run worker in foreground (webhook mode)
  poll      Run worker in foreground (legacy poll mode)

Options (for start/run):
  --agent         Command to run for each task (e.g. "claude -p")
  --categories    Comma-separated task categories to accept
  --port          HTTP port for webhook server (default: 8377)
  --webhook-url   Public URL for webhook callbacks
  --concurrency   Max concurrent agent processes (default: 1)
  --tags          Comma-separated tag filters (optional)
  --max-price     Only accept tasks up to this price (optional)
  --no-crust      Disable crust security wrapping (auto-detected by default)
  --publish       Publish a capability on start (repeatable). Format: name:description:price[:category[:tags]]
                  Auto-unpublished on worker stop.

Examples:
  openstall worker run --agent "claude -p" --categories research --webhook-url http://localhost:8377/webhook
  openstall worker start --agent "claude -p" --categories research --webhook-url http://my-server:8377/webhook
  openstall worker run --agent "claude -p" --categories analysis --publish "Financial Analysis:Deep earnings analysis:500:analysis:finance,markets"
  openstall worker stop
  openstall worker status
  openstall worker logs --lines 100
  openstall worker poll --agent "claude -p" --categories research
`;

function parsePublishFlags(publishArgs: string[]): CapabilityConfig[] {
  return publishArgs.map(arg => {
    const parts = arg.split(':');
    if (parts.length < 3) {
      console.error(`Invalid --publish format: "${arg}". Expected: name:description:price[:category[:tags]]`);
      process.exit(1);
    }
    const [name, description, priceStr, category, tagsStr] = parts;
    const price = parseInt(priceStr);
    if (isNaN(price) || price <= 0) {
      console.error(`Invalid price in --publish: "${priceStr}". Must be a positive integer.`);
      process.exit(1);
    }
    const config: CapabilityConfig = { name, description, price };
    if (category) config.category = category;
    if (tagsStr) config.tags = tagsStr.split(',');
    return config;
  });
}

async function handleWorkerCommand(subcommand: string | null, flags: Record<string, string>, flagArrays: Record<string, string[]> = {}) {
  const { startWorkerDaemon, daemonStart, daemonStop, daemonStatus, daemonLogs } = await import('./worker-daemon.js');

  // No subcommand + has --agent → backward compat: run in foreground webhook mode
  // But if no --webhook-url, fall back to poll mode
  if (!subcommand || (subcommand && !['start', 'stop', 'status', 'logs', 'run', 'poll'].includes(subcommand))) {
    if (!flags.agent || !flags.categories) {
      console.log(WORKER_HELP);
      process.exit(1);
    }

    if (!flags['webhook-url']) {
      // Fall back to poll mode with warning
      console.warn('\x1b[33mWarning: No --webhook-url provided, falling back to poll mode.\x1b[0m');
      console.warn('For webhook mode: --webhook-url http://localhost:8377/webhook\n');
      const { handleWorkerPoll } = await import('./worker.js');
      await handleWorkerPoll(flags);
      return;
    }

    // Default to foreground run
    subcommand = 'run';
  }

  switch (subcommand) {
    case 'stop':
      await daemonStop();
      break;

    case 'status':
      await daemonStatus();
      break;

    case 'logs': {
      const lines = flags.lines ? parseInt(flags.lines) : 50;
      await daemonLogs(lines);
      break;
    }

    case 'poll': {
      const { handleWorkerPoll } = await import('./worker.js');
      await handleWorkerPoll(flags);
      break;
    }

    case 'start':
    case 'run': {
      const categories = flags.categories?.split(',').map(s => s.trim());
      const agent = flags.agent;

      if (!categories || categories.length === 0 || !agent) {
        console.log(WORKER_HELP);
        process.exit(1);
      }

      const port = flags.port ? parseInt(flags.port) : 8377;
      const webhookUrl = flags['webhook-url'] || `http://localhost:${port}/webhook`;
      const concurrency = flags.concurrency ? parseInt(flags.concurrency) : 1;
      const tags = flags.tags?.split(',').map(s => s.trim());
      const maxPrice = flags['max-price'] ? Number(flags['max-price']) : undefined;

      if (!flags['webhook-url']) {
        console.warn(`\x1b[33mNo --webhook-url provided, using ${webhookUrl}\x1b[0m`);
        console.warn('For remote access, specify your public URL with --webhook-url\n');
      }

      const noCrust = 'no-crust' in flags;
      const capabilities = flagArrays.publish ? parsePublishFlags(flagArrays.publish) : undefined;

      const opts: DaemonOptions = {
        categories,
        tags,
        maxPrice,
        agentCommand: agent,
        port,
        webhookUrl,
        concurrency,
        noCrust,
        capabilities,
      };

      if (subcommand === 'start') {
        await daemonStart(opts);
      } else {
        await startWorkerDaemon(opts);
      }
      break;
    }

    default:
      console.log(WORKER_HELP);
  }
}

async function main() {
  const { command, subcommand, flags, flagArrays, positional } = parseArgs(process.argv);
  const pretty = 'pretty' in flags;

  try {
    switch (command) {
      case 'register':    await handleRegister(flags, pretty); break;
      case 'me':          await handleMe(flags, pretty); break;
      case 'balance':     await handleBalance(flags, pretty); break;
      case 'deposit-info': await handleDepositInfo(flags, pretty); break;
      case 'deposit':     await handleDeposit(flags, positional, pretty); break;
      case 'deposits':    await handleDeposits(flags, positional, pretty); break;
      case 'discover':    await handleDiscover(flags, positional, pretty); break;
      case 'call':        await handleCall(flags, positional, pretty); break;
      case 'tasks':       await handleTasks(flags, positional, pretty); break;
      case 'task':        await handleTask(flags, positional, pretty); break;
      case 'accept':      await handleAccept(flags, positional, pretty); break;
      case 'deliver':     await handleDeliver(flags, positional, pretty); break;
      case 'complete':    await handleComplete(flags, positional, pretty); break;
      case 'dispute':     await handleDispute(flags, positional, pretty); break;
      case 'cancel':      await handleCancel(flags, positional, pretty); break;
      case 'rate':        await handleRate(flags, positional, pretty); break;
      case 'publish':     await handlePublish(flags, positional, pretty); break;
      case 'unpublish':   await handleUnpublish(flags, positional, pretty); break;
      case 'reputation':  await handleReputation(flags, positional, pretty); break;
      case 'transactions': await handleTransactions(flags, positional, pretty); break;
      case 'feedback':     await handleFeedback(flags, positional, pretty); break;
      case 'worker':
        await handleWorkerCommand(subcommand, flags, flagArrays);
        break;
      case 'mcp-server': {
        const { startMcpServer } = await import('./mcp.js');
        await startMcpServer();
        break;
      }
      case 'help':
      default:
        console.log(HELP);
    }
  } catch (err: any) {
    console.log(JSON.stringify({ error: err.message || String(err) }));
    process.exit(1);
  }
}

main();
