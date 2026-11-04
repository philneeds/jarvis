ALTER TABLE "chat_messages" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "kind" text;