export interface OpenStallConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface Agent {
  id: string;
  name: string;
  status: string;
  walletId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  wallet?: WalletSummary;
  reputation?: Reputation;
}

export interface WalletSummary {
  id: string;
  balance: number;
  escrowBalance: number;
  totalEarned: number;
  totalSpent: number;
  totalWithdrawn: number;
  withdrawable: number;
}

export interface Wallet extends WalletSummary {
  withdrawAddress: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Withdrawal {
  id: string;
  walletId: string;
  amount: number;
  toAddress: string;
  status: 'pending' | 'processing' | 'completed' | 'rejected';
  txHash: string | null;
  rejectedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DepositInfo {
  address: string;
  chain: string;
  chainId: number;
  usdcContract: string;
  creditsPerUsdc: number;
}

export interface Deposit {
  id: string;
  walletId: string;
  txHash: string;
  amount: number;
  usdcAmount: string;
  fromAddress: string;
  status: 'pending' | 'confirmed' | 'rejected';
  blockNumber: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MailboxSubscription {
  id: string;
  agentId: string;
  categories: string[];
  tags: string[];
  maxPrice: number | null;
  cursor: string;
  webhookUrl: string | null;
  active: boolean;
}

export interface MailboxEvent {
  id: string;
  type: string;
  taskId: string;
  capability?: string;
  category?: string;
  price?: number;
  timestamp: number;
}

export interface MailboxPollResult {
  events: MailboxEvent[];
  cursor: string;
  hasMore: boolean;
}

export interface Transaction {
  id: string;
  walletId: string;
  type: string;
  amount: number;
  balance: number;
  referenceId: string | null;
  description: string | null;
  createdAt: string;
}

export interface Capability {
  id: string;
  agentId: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  price: number;
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  agent?: { id: string; name: string };
}

export interface CreateCapabilityInput {
  name: string;
  description: string;
  category?: string;
  tags?: string[];
  price?: number;  // 0 or omitted = dynamic pricing (caller specifies maxPrice)
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface DiscoverParams {
  query?: string;
  category?: string;
  maxPrice?: number;
  tags?: string[];
  page?: number;
  limit?: number;
}

export interface MatchResult {
  capabilities: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    price: number;
    relevanceReason: string;
    agent: { id: string; name: string };
  }>;
  matchCount: number;
}

export interface Task {
  id: string;
  capabilityId: string;
  clientAgentId: string;
  providerAgentId: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  escrowAmount: number;
  platformFee: number;
  category?: string;
  description?: string;
  maxPrice?: number;
  tags?: string[];
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  capability?: { name: string; description?: string };
  rating?: Rating;
}

export interface Rating {
  id: string;
  taskId: string;
  fromAgentId: string;
  toAgentId: string;
  score: number;
  comment: string | null;
  createdAt: string;
}

export interface Reputation {
  id: string;
  agentId: string;
  tasksCompleted: number;
  tasksFailed: number;
  successRate: number;
  avgRating: number;
  totalRatings: number;
  updatedAt: string;
}

export interface PaginatedResult<T> {
  total: number;
  page: number;
  limit: number;
  [key: string]: T[] | number;
}

export interface RegisterResult {
  agent: Agent;
  apiKey: string;
}

export type TaskHandler = (task: Task) => Promise<Record<string, unknown>>;
