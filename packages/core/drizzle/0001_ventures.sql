CREATE TABLE "metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"venture" text NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"value" real NOT NULL,
	"source" text
);
--> statement-breakpoint
CREATE TABLE "records" (
	"id" text PRIMARY KEY NOT NULL,
	"venture" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"fields" jsonb,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "metrics_vk_idx" ON "metrics" USING btree ("venture","key","at");--> statement-breakpoint
CREATE INDEX "records_vk_idx" ON "records" USING btree ("venture","kind");