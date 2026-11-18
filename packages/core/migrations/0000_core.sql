CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE SCHEMA "hubd";
--> statement-breakpoint
CREATE TABLE "hubd"."attachment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"from_kind" text NOT NULL,
	"from_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubd"."clients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"os" text,
	"arch" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "clients_name_unique" UNIQUE("name"),
	CONSTRAINT "clients_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "hubd"."commit" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"client_id" uuid,
	"session" text,
	"model" text,
	"operation" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "hubd"."content" (
	"hash" text PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"media_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubd"."install_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "install_codes_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "hubd"."link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"from_kind" text NOT NULL,
	"from_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"to_subject" uuid,
	"to_kind" text,
	"to_id" uuid,
	"path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_unique" UNIQUE NULLS NOT DISTINCT("from_kind","from_id","kind","to_subject","to_kind","to_id","path"),
	CONSTRAINT "link_kind" CHECK ("hubd"."link"."kind" in ('about', 'mentions', 'ref')),
	CONSTRAINT "link_one_target" CHECK (num_nonnulls("hubd"."link"."to_subject", "hubd"."link"."to_id") = 1),
	CONSTRAINT "link_record_pair" CHECK (("hubd"."link"."to_kind" is null) = ("hubd"."link"."to_id" is null)),
	CONSTRAINT "link_about_subject" CHECK ("hubd"."link"."kind" <> 'about' or "hubd"."link"."to_subject" is not null),
	CONSTRAINT "link_ref_record" CHECK ("hubd"."link"."kind" <> 'ref' or "hubd"."link"."to_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "hubd"."name" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid,
	"record_id" uuid,
	"name" text NOT NULL,
	"domain" uuid,
	"global" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	CONSTRAINT "name_one_owner" CHECK (num_nonnulls("hubd"."name"."subject_id", "hubd"."name"."record_id") = 1),
	CONSTRAINT "name_subject_kind" CHECK (("hubd"."name"."kind" in ('topic', 'asset')) = ("hubd"."name"."subject_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "hubd"."record_kind" (
	"kind" text PRIMARY KEY NOT NULL,
	"plugin" text NOT NULL,
	"table_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubd"."revision" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"commit_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"home" uuid,
	"snapshot" jsonb,
	"baseline" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubd"."space" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"parent" uuid,
	"description" text,
	"color" text,
	"isolated" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_name" UNIQUE NULLS NOT DISTINCT("parent","name"),
	CONSTRAINT "space_kind" CHECK ("hubd"."space"."kind" in ('scope', 'project')),
	CONSTRAINT "space_project_has_parent" CHECK (("hubd"."space"."kind" = 'project') = ("hubd"."space"."parent" is not null)),
	CONSTRAINT "space_isolated_scope" CHECK ("hubd"."space"."kind" = 'scope' or not "hubd"."space"."isolated"),
	CONSTRAINT "space_archived_project" CHECK ("hubd"."space"."kind" = 'project' or "hubd"."space"."archived_at" is null),
	CONSTRAINT "space_global" CHECK ("hubd"."space"."name" <> 'global' or ("hubd"."space"."kind" = 'scope' and not "hubd"."space"."isolated"))
);
--> statement-breakpoint
CREATE TABLE "hubd"."subject" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"home" uuid,
	"summary" text,
	"type" text,
	"endpoint" text,
	"reached_by" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"merged_into" uuid,
	CONSTRAINT "subject_kind" CHECK ("hubd"."subject"."kind" in ('topic', 'asset')),
	CONSTRAINT "subject_asset_fields" CHECK ("hubd"."subject"."kind" = 'asset' or ("hubd"."subject"."type" is null and "hubd"."subject"."endpoint" is null and "hubd"."subject"."reached_by" is null)),
	CONSTRAINT "subject_asset_type" CHECK ("hubd"."subject"."kind" = 'topic' or "hubd"."subject"."type" is not null)
);
--> statement-breakpoint
CREATE TABLE "hubd"."upload" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code_hash" text NOT NULL,
	"from_kind" text NOT NULL,
	"from_id" uuid NOT NULL,
	"name" text NOT NULL,
	"client_id" uuid,
	"isolated_to" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "hubd"."attachment" ADD CONSTRAINT "attachment_from_kind_record_kind_kind_fk" FOREIGN KEY ("from_kind") REFERENCES "hubd"."record_kind"("kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."attachment" ADD CONSTRAINT "attachment_hash_content_hash_fk" FOREIGN KEY ("hash") REFERENCES "hubd"."content"("hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."attachment" ADD CONSTRAINT "attachment_created_by_clients_id_fk" FOREIGN KEY ("created_by") REFERENCES "hubd"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."commit" ADD CONSTRAINT "commit_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "hubd"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."link" ADD CONSTRAINT "link_from_kind_record_kind_kind_fk" FOREIGN KEY ("from_kind") REFERENCES "hubd"."record_kind"("kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."link" ADD CONSTRAINT "link_to_subject_subject_id_fk" FOREIGN KEY ("to_subject") REFERENCES "hubd"."subject"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."link" ADD CONSTRAINT "link_to_kind_record_kind_kind_fk" FOREIGN KEY ("to_kind") REFERENCES "hubd"."record_kind"("kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."name" ADD CONSTRAINT "name_subject_id_subject_id_fk" FOREIGN KEY ("subject_id") REFERENCES "hubd"."subject"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."name" ADD CONSTRAINT "name_domain_space_id_fk" FOREIGN KEY ("domain") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."revision" ADD CONSTRAINT "revision_commit_id_commit_id_fk" FOREIGN KEY ("commit_id") REFERENCES "hubd"."commit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."revision" ADD CONSTRAINT "revision_home_space_id_fk" FOREIGN KEY ("home") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."space" ADD CONSTRAINT "space_parent_space_id_fk" FOREIGN KEY ("parent") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."subject" ADD CONSTRAINT "subject_home_space_id_fk" FOREIGN KEY ("home") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."subject" ADD CONSTRAINT "subject_created_by_clients_id_fk" FOREIGN KEY ("created_by") REFERENCES "hubd"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."subject" ADD CONSTRAINT "subject_merged_into_subject_id_fk" FOREIGN KEY ("merged_into") REFERENCES "hubd"."subject"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."upload" ADD CONSTRAINT "upload_from_kind_record_kind_kind_fk" FOREIGN KEY ("from_kind") REFERENCES "hubd"."record_kind"("kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."upload" ADD CONSTRAINT "upload_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "hubd"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubd"."upload" ADD CONSTRAINT "upload_isolated_to_space_id_fk" FOREIGN KEY ("isolated_to") REFERENCES "hubd"."space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_from" ON "hubd"."attachment" USING btree ("from_kind","from_id");--> statement-breakpoint
CREATE INDEX "attachment_hash" ON "hubd"."attachment" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "commit_at" ON "hubd"."commit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "commit_session" ON "hubd"."commit" USING btree ("session");--> statement-breakpoint
CREATE INDEX "link_to_subject" ON "hubd"."link" USING btree ("to_subject");--> statement-breakpoint
CREATE INDEX "link_to_record" ON "hubd"."link" USING btree ("to_kind","to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "name_live" ON "hubd"."name" USING btree ("kind",coalesce("domain", '00000000-0000-0000-0000-000000000000'),lower("name")) WHERE "hubd"."name"."valid_until" is null;--> statement-breakpoint
CREATE INDEX "name_subject" ON "hubd"."name" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "name_record" ON "hubd"."name" USING btree ("kind","record_id");--> statement-breakpoint
CREATE INDEX "name_trgm" ON "hubd"."name" USING gin (lower("name") gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "revision_n" ON "hubd"."revision" USING btree ("kind","target_id","n");--> statement-breakpoint
CREATE INDEX "revision_commit" ON "hubd"."revision" USING btree ("commit_id");--> statement-breakpoint
CREATE INDEX "subject_home" ON "hubd"."subject" USING btree ("home");--> statement-breakpoint
INSERT INTO "hubd"."space" ("id", "kind", "name", "description") VALUES ('00000000-0000-7000-8000-000000000001', 'scope', 'global', 'Seen by every session');--> statement-breakpoint
CREATE FUNCTION "hubd"."drop_links"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	rid uuid := (to_jsonb(OLD) ->> TG_ARGV[1])::uuid;
BEGIN
	DELETE FROM "hubd"."link"
	WHERE ("from_kind" = TG_ARGV[0] AND "from_id" = rid) OR ("to_kind" = TG_ARGV[0] AND "to_id" = rid);
	DELETE FROM "hubd"."attachment" WHERE "from_kind" = TG_ARGV[0] AND "from_id" = rid;
	DELETE FROM "hubd"."upload" WHERE "from_kind" = TG_ARGV[0] AND "from_id" = rid;
	DELETE FROM "hubd"."name" WHERE "kind" = TG_ARGV[0] AND "record_id" = rid;
	RETURN OLD;
END
$$;
