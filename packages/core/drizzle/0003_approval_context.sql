ALTER TABLE "approvals" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "effect" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "thread" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "original" text;