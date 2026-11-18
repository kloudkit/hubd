CREATE SCHEMA "hello";
--> statement-breakpoint
CREATE TABLE "hello"."greetings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"welcomed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "hello"."notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"home" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hello"."notes" ADD CONSTRAINT "notes_home_space_id_fk" FOREIGN KEY ("home") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;
