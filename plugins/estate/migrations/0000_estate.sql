CREATE SCHEMA "estate";
--> statement-breakpoint
CREATE TABLE "estate"."claim" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"home" uuid,
	"type" text NOT NULL,
	"statement" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"strength" text,
	"loading" text DEFAULT 'on-request' NOT NULL,
	"status" text DEFAULT 'current' NOT NULL,
	"status_reason" text,
	"reconfirm_at" timestamp with time zone,
	"review_days" integer,
	"contradicted_at" timestamp with time zone,
	"true_from" timestamp with time zone,
	"true_until" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', statement), 'A') || setweight(to_tsvector('english', detail), 'D')) STORED,
	CONSTRAINT "claim_strength" CHECK ("estate"."claim"."strength" is null or "estate"."claim"."type" = 'Rule'),
	CONSTRAINT "claim_reason" CHECK ("estate"."claim"."status" = 'current' or "estate"."claim"."status_reason" is not null),
	CONSTRAINT "claim_statement" CHECK (length(btrim("estate"."claim"."statement")) > 0)
);
--> statement-breakpoint
CREATE TABLE "estate"."check" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"claim_id" uuid NOT NULL,
	"command" text NOT NULL,
	"needs" text[] DEFAULT '{}'::text[] NOT NULL,
	"timeout" integer,
	"runs_on" uuid
);
--> statement-breakpoint
CREATE TABLE "estate"."claim_relation" (
	"from_claim" uuid NOT NULL,
	"relation" text NOT NULL,
	"to_claim" uuid NOT NULL,
	CONSTRAINT "claim_relation_from_claim_relation_to_claim_pk" PRIMARY KEY("from_claim","relation","to_claim"),
	CONSTRAINT "claim_relation_not_self" CHECK ("estate"."claim_relation"."from_claim" <> "estate"."claim_relation"."to_claim")
);
--> statement-breakpoint
CREATE TABLE "estate"."claim_source" (
	"claim_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"locator" text,
	CONSTRAINT "claim_source_claim_id_source_id_pk" PRIMARY KEY("claim_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "estate"."instruction" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"home" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"machines" text[],
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruction_machines" CHECK ("estate"."instruction"."machines" is null or cardinality("estate"."instruction"."machines") > 0)
);
--> statement-breakpoint
CREATE TABLE "estate"."profile" (
	"space" uuid PRIMARY KEY NOT NULL,
	"voice" text,
	"style" text,
	"load_cap" integer
);
--> statement-breakpoint
CREATE TABLE "estate"."source" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"home" uuid,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estate"."subject_relation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"claim_id" uuid NOT NULL,
	"from_subject" uuid NOT NULL,
	"from_path" text DEFAULT '' NOT NULL,
	"relation" text NOT NULL,
	"to_subject" uuid NOT NULL,
	"to_path" text DEFAULT '' NOT NULL,
	CONSTRAINT "subject_relation_not_self" CHECK ("estate"."subject_relation"."from_subject" <> "estate"."subject_relation"."to_subject")
);
--> statement-breakpoint
CREATE TABLE "estate"."suggestion" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"author" text NOT NULL,
	"client_id" uuid,
	"scope" uuid,
	"homes" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"unassigned" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"steps" jsonb NOT NULL,
	"lint" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"session" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"commit_id" uuid
);
--> statement-breakpoint
CREATE TABLE "estate"."verification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"claim_id" uuid NOT NULL,
	"check_id" uuid,
	"revision" integer NOT NULL,
	"by" text NOT NULL,
	"reporter" text NOT NULL,
	"ran_on" uuid,
	"outcome" text NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "estate"."claim" ADD CONSTRAINT "claim_home_space_id_fk" FOREIGN KEY ("home") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."check" ADD CONSTRAINT "check_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "estate"."claim"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."claim_relation" ADD CONSTRAINT "claim_relation_from_claim_claim_id_fk" FOREIGN KEY ("from_claim") REFERENCES "estate"."claim"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."claim_relation" ADD CONSTRAINT "claim_relation_to_claim_claim_id_fk" FOREIGN KEY ("to_claim") REFERENCES "estate"."claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."claim_source" ADD CONSTRAINT "claim_source_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "estate"."claim"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."claim_source" ADD CONSTRAINT "claim_source_source_id_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "estate"."source"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."instruction" ADD CONSTRAINT "instruction_home_space_id_fk" FOREIGN KEY ("home") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."profile" ADD CONSTRAINT "profile_space_space_id_fk" FOREIGN KEY ("space") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."source" ADD CONSTRAINT "source_home_space_id_fk" FOREIGN KEY ("home") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."subject_relation" ADD CONSTRAINT "subject_relation_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "estate"."claim"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."suggestion" ADD CONSTRAINT "suggestion_commit_id_commit_id_fk" FOREIGN KEY ("commit_id") REFERENCES "hubd"."commit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."verification" ADD CONSTRAINT "verification_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "estate"."claim"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estate"."verification" ADD CONSTRAINT "verification_check_id_check_id_fk" FOREIGN KEY ("check_id") REFERENCES "estate"."check"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_home_status" ON "estate"."claim" USING btree ("home","status");--> statement-breakpoint
CREATE INDEX "claim_reconfirm" ON "estate"."claim" USING btree ("reconfirm_at") WHERE "estate"."claim"."status" = 'current';--> statement-breakpoint
CREATE INDEX "claim_search" ON "estate"."claim" USING gin ("search");--> statement-breakpoint
CREATE INDEX "claim_always" ON "estate"."claim" USING btree ("home") WHERE "estate"."claim"."loading" = 'always';--> statement-breakpoint
CREATE INDEX "instruction_home" ON "estate"."instruction" USING btree ("home","position");--> statement-breakpoint
CREATE INDEX "subject_relation_to" ON "estate"."subject_relation" USING btree ("to_subject");--> statement-breakpoint
CREATE INDEX "suggestion_pending" ON "estate"."suggestion" USING btree ("created_at") WHERE "estate"."suggestion"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "verification_claim" ON "estate"."verification" USING btree ("claim_id","last_seen");
