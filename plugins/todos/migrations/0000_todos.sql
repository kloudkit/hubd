CREATE SCHEMA "todos";
--> statement-breakpoint
CREATE TABLE "todos"."label" (
	"name" text PRIMARY KEY NOT NULL,
	"color" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todos"."todo" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"home" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'p3' NOT NULL,
	"due" date,
	"session" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "todos"."todo_label" (
	"todo_id" uuid NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "todo_label_todo_id_label_pk" PRIMARY KEY("todo_id","label")
);
--> statement-breakpoint
ALTER TABLE "todos"."todo" ADD CONSTRAINT "todo_home_space_id_fk" FOREIGN KEY ("home") REFERENCES "hubd"."space"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos"."todo_label" ADD CONSTRAINT "todo_label_todo_id_todo_id_fk" FOREIGN KEY ("todo_id") REFERENCES "todos"."todo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos"."todo_label" ADD CONSTRAINT "todo_label_label_label_name_fk" FOREIGN KEY ("label") REFERENCES "todos"."label"("name") ON DELETE cascade ON UPDATE cascade;
