import { z } from "zod";

import { ContractMetadataSchema, IsoDateTimeSchema } from "./common";
import {
  OptimizerTokenOverheadSchema,
  WorkflowTokenAccountingSchema,
} from "./optimization";

const TokenLedgerEntryBaseSchema = z.object({
  entryId: z.string().min(1).max(500),
  recordedAt: IsoDateTimeSchema,
  operationId: z.string().min(1).max(500).optional(),
});

const KnownOptimizerCallEntrySchema = TokenLedgerEntryBaseSchema.extend({
  kind: z.literal("optimizer_call"),
  status: z.literal("known"),
  toolName: z.string().min(1).max(200),
  overhead: OptimizerTokenOverheadSchema,
});

const UnknownOptimizerCallEntrySchema = TokenLedgerEntryBaseSchema.extend({
  kind: z.literal("optimizer_call"),
  status: z.literal("unknown"),
  toolName: z.string().min(1).max(200),
  unknownReason: z.string().min(1).max(1000),
});

const KnownAgentRunEntrySchema = TokenLedgerEntryBaseSchema.extend({
  kind: z.literal("agent_run"),
  status: z.literal("known"),
  accounting: WorkflowTokenAccountingSchema,
});

const UnknownAgentRunEntrySchema = TokenLedgerEntryBaseSchema.extend({
  kind: z.literal("agent_run"),
  status: z.literal("unknown"),
  unknownReason: z.string().min(1).max(1000),
});

export const TokenLedgerEntrySchema = z.union([
  KnownOptimizerCallEntrySchema,
  UnknownOptimizerCallEntrySchema,
  KnownAgentRunEntrySchema,
  UnknownAgentRunEntrySchema,
]);

export const TokenLedgerSchema = z.object({
  metadata: ContractMetadataSchema,
  runId: z.string().min(1).max(500),
  taskId: z.string().min(1).max(500).optional(),
  entries: z.array(TokenLedgerEntrySchema).min(1).max(10000),
});

export type KnownOptimizerCallEntry = z.infer<typeof KnownOptimizerCallEntrySchema>;
export type UnknownOptimizerCallEntry = z.infer<typeof UnknownOptimizerCallEntrySchema>;
export type KnownAgentRunEntry = z.infer<typeof KnownAgentRunEntrySchema>;
export type UnknownAgentRunEntry = z.infer<typeof UnknownAgentRunEntrySchema>;
export type TokenLedgerEntry = z.infer<typeof TokenLedgerEntrySchema>;
export type TokenLedger = z.infer<typeof TokenLedgerSchema>;
