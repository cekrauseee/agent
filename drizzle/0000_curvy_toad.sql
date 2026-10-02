CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_provider_identity_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"next_turn" integer DEFAULT 0 NOT NULL,
	"generation_version" integer DEFAULT 0 NOT NULL,
	"current_generation_id" uuid,
	"provider_response_id" text,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_counters_check" CHECK ("conversation"."next_turn" >= 0 AND "conversation"."generation_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "folder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folder_id_space_unique" UNIQUE("id","space_id"),
	CONSTRAINT "folder_not_self_parent" CHECK ("folder"."parent_id" IS NULL OR "folder"."parent_id" <> "folder"."id")
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn" integer NOT NULL,
	"role" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"request_id" uuid NOT NULL,
	"generation_id" uuid,
	"generation_version" integer,
	"status" text DEFAULT 'completed' NOT NULL,
	"model" text,
	"effort" text,
	"usage" jsonb,
	"citations" jsonb,
	"provider_response_id" text,
	"provider_output" jsonb,
	"context_before" jsonb,
	"response_id_before" text,
	"stream_cursor" integer DEFAULT -1 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_generation_id_unique" UNIQUE("generation_id"),
	CONSTRAINT "message_turn_role_unique" UNIQUE("conversation_id","turn","role"),
	CONSTRAINT "message_request_role_unique" UNIQUE("conversation_id","request_id","role"),
	CONSTRAINT "message_role_check" CHECK ("message"."role" IN ('user', 'assistant')),
	CONSTRAINT "message_status_check" CHECK ("message"."status" IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "message_turn_check" CHECK ("message"."turn" >= 0 AND "message"."stream_cursor" >= -1),
	CONSTRAINT "message_generation_check" CHECK (("message"."role" = 'user' AND "message"."status" = 'completed' AND "message"."generation_id" IS NULL) OR ("message"."role" = 'assistant' AND "message"."generation_id" IS NOT NULL AND "message"."generation_version" IS NOT NULL AND "message"."generation_version" >= 0 AND "message"."model" IS NOT NULL AND "message"."effort" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"folder_id" uuid,
	"title" text NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_id_owner_unique" UNIQUE("id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "space" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_owner_id_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"first_name" text,
	"last_name" text,
	"preferred_model" text,
	"preferred_effort" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_project_owner_fk" FOREIGN KEY ("project_id","owner_id") REFERENCES "public"."project"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder" ADD CONSTRAINT "folder_parent_space_fk" FOREIGN KEY ("parent_id","space_id") REFERENCES "public"."folder"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_space_id_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page" ADD CONSTRAINT "page_folder_space_fk" FOREIGN KEY ("folder_id","space_id") REFERENCES "public"."folder"("id","space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space" ADD CONSTRAINT "space_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversation_owner_updated_idx" ON "conversation" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "conversation_project_idx" ON "conversation" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "folder_space_parent_idx" ON "folder" USING btree ("space_id","parent_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_one_active_generation" ON "message" USING btree ("conversation_id") WHERE "message"."role" = 'assistant' AND "message"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "page_space_folder_idx" ON "page" USING btree ("space_id","folder_id","id");--> statement-breakpoint
CREATE INDEX "project_owner_updated_idx" ON "project" USING btree ("owner_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");