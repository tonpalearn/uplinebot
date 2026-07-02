/**
 * Shared TypeScript types for the module plug-in architecture.
 * Source: SYSTEM-DESIGN.md §4.2 (Module Handler Plug-in Architecture).
 */

/** Raw-ish inbound LINE webhook event, normalized enough for module handlers to consume. */
export interface LineEvent {
  type: string; // e.g. 'message', 'follow', 'postback'
  message?: {
    id: string;
    type: string; // 'text' | 'image' | 'sticker' | ...
    text?: string;
  };
  replyToken?: string;
  source: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  timestamp: number;
  webhookEventId?: string;
}

/** A message to be sent back out via the Sender (reply or push). */
export interface OutboundMessage {
  type: "text" | "flex" | "image" | "sticker";
  // text
  text?: string;
  // flex
  altText?: string;
  contents?: Record<string, unknown>;
  // image
  originalContentUrl?: string;
  previewImageUrl?: string;
  // sticker
  packageId?: string;
  stickerId?: string;
}

/** Resolved tenant/target context, produced by the Context Resolver (lib/context.ts). */
export interface TenantContext {
  tenantId: string;
  targetId: string;
  botId: string;
  sourceType: "user" | "group" | "room";
}

/** A due row from upl_scheduled_jobs, as dispatched by the Scheduled Job Dispatcher. */
export interface ScheduledJob {
  id: string;
  tenantId: string;
  jobType: "broadcast" | "morning_brief" | "booking_reminder" | "membership_renewal";
  refId: string | null;
  targetId: string | null;
  cronExpr: string | null;
  runAt: string | null;
  timezone: string;
}

/** Per-target module configuration (upl_module_configs.settings). */
export type ModuleConfig = Record<string, unknown>;

/**
 * Every module (Assistant, Broadcast, Slip Verification, Commerce, ...) implements
 * this interface, so the Command Router and the Scheduled Job Dispatcher both drive
 * modules through the same contract.
 */
export interface ModuleHandler {
  key: string; // matches upl_module_catalog.module_key
  // called by Command Router on inbound chat events
  matchesIntent(event: LineEvent, config: ModuleConfig): boolean;
  handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]>;
  // called by Scheduled Job Dispatcher for cron-driven behavior (optional)
  handleScheduledJob?(job: ScheduledJob, ctx: TenantContext): Promise<OutboundMessage[]>;
}
