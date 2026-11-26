import { z } from 'zod';
import { agentTaskDefinitionSchema, jobNameSchema } from './definitions';

/**
 * Agent wire protocol, version 1. JSON text frames over WebSocket (WSS in production).
 *
 * Handshake: the client opens `GET /v1/agent/ws` with `Authorization: Bearer chr_a_...`
 * and sends `hello` as its first frame. The server answers `welcome` (or `error` and
 * closes). Afterwards:
 *
 *   server -> client  execute, cancel, result_ack, error
 *   client -> server  ack, heartbeat, log, result, goodbye
 *
 * Delivery is at-least-once: an `execute` may be re-sent for a new attempt after a
 * lost lease, and handlers must be idempotent (use `idempotencyKey`).
 */
export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOL_VERSIONS = [1] as const;
export const AGENT_WS_PATH = '/v1/agent/ws';

/** WebSocket close codes used by Chronos (4000-4999 is the application range). */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 4000,
  UNAUTHORIZED: 4001,
  UNSUPPORTED_VERSION: 4002,
  INVALID_REGISTRATION: 4003,
  HANDSHAKE_TIMEOUT: 4004,
  SUPERSEDED: 4005,
} as const;

/** Close codes after which reconnecting cannot succeed without operator action. */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CloseCode.UNAUTHORIZED,
  CloseCode.UNSUPPORTED_VERSION,
  CloseCode.INVALID_REGISTRATION,
]);

const executionRef = { executionId: z.string().uuid(), attempt: z.number().int().min(1) };

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const helloMessageSchema = z
  .object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    sdkVersion: z.string().max(40),
    /** Random per process; reconnects of the same process reuse it. */
    instanceId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
    /** Project slug the application believes it belongs to; must match the token. */
    project: z.string().max(48),
    hostname: z.string().max(255).optional(),
    concurrency: z.number().int().min(1).max(1000),
    tasks: z.array(agentTaskDefinitionSchema).max(1000),
  })
  .strict();

export const ackMessageSchema = z.object({ type: z.literal('ack'), ...executionRef }).strict();

export const heartbeatMessageSchema = z
  .object({
    type: z.literal('heartbeat'),
    /** Executions currently running; the server renews their leases. */
    running: z.array(z.object(executionRef).strict()).max(1000),
  })
  .strict();

export const logMessageSchema = z
  .object({
    type: z.literal('log'),
    ...executionRef,
    level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']),
    message: z.string().max(4000),
    data: z.unknown().optional(),
  })
  .strict();

export const resultMessageSchema = z.discriminatedUnion('status', [
  z
    .object({ type: z.literal('result'), ...executionRef, status: z.literal('succeeded'), output: z.unknown().optional() })
    .strict(),
  z
    .object({
      type: z.literal('result'),
      ...executionRef,
      status: z.literal('failed'),
      error: z
        .object({
          message: z.string().max(4000),
          code: z.string().max(100).optional(),
          /** false marks a permanent failure that must not be retried. */
          retryable: z.boolean().default(true),
          timedOut: z.boolean().default(false),
        })
        .strict(),
    })
    .strict(),
]);

export const goodbyeMessageSchema = z.object({ type: z.literal('goodbye'), reason: z.string().max(200).optional() }).strict();

export const clientMessageSchema = z.union([
  helloMessageSchema,
  ackMessageSchema,
  heartbeatMessageSchema,
  logMessageSchema,
  resultMessageSchema,
  goodbyeMessageSchema,
]);

export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
export type LogMessage = z.infer<typeof logMessageSchema>;
export type ResultMessage = z.infer<typeof resultMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const welcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  protocolVersion: z.number().int(),
  agentId: z.string().uuid(),
  heartbeatIntervalMs: z.number().int(),
  tasks: z.array(
    z.object({
      name: jobNameSchema,
      jobId: z.string().uuid(),
      /** "api" when an API-managed job of the same name exists; its config wins. */
      managedBy: z.enum(['sdk', 'api']),
      nextRunAt: z.string().nullable(),
    }),
  ),
});

export const executeMessageSchema = z.object({
  type: z.literal('execute'),
  ...executionRef,
  task: jobNameSchema,
  idempotencyKey: z.string(),
  scheduledFor: z.string(),
  payload: z.unknown().optional(),
  timeoutMs: z.number().int(),
});

export const cancelMessageSchema = z.object({ type: z.literal('cancel'), ...executionRef, reason: z.string() });

export const resultAckMessageSchema = z.object({
  type: z.literal('result_ack'),
  ...executionRef,
  /** false when the result arrived too late (lease lost, cancelled): it was discarded. */
  accepted: z.boolean(),
});

export const errorMessageSchema = z.object({ type: z.literal('error'), code: z.string(), message: z.string() });

export const serverMessageSchema = z.discriminatedUnion('type', [
  welcomeMessageSchema,
  executeMessageSchema,
  cancelMessageSchema,
  resultAckMessageSchema,
  errorMessageSchema,
]);

export type WelcomeMessage = z.infer<typeof welcomeMessageSchema>;
export type ExecuteMessage = z.infer<typeof executeMessageSchema>;
export type CancelMessage = z.infer<typeof cancelMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Maximum accepted frame size (bytes) in both directions. */
export const MAX_FRAME_BYTES = 256 * 1024;
