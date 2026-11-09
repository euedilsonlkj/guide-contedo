CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`ok` integer NOT NULL,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`acknowledged_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alerts_open_idx` ON `alerts` (`code`,`acknowledged_at`);--> statement-breakpoint
CREATE TABLE `content_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account` text NOT NULL,
	`kind` text NOT NULL,
	`pillar` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`topic` text NOT NULL,
	`angle` text,
	`hook` text,
	`script` text,
	`caption` text,
	`media` text NOT NULL,
	`container_id` text,
	`ig_media_id` text,
	`permalink` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_posts_slot_unique` ON `content_posts` (`account`,`kind`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `content_posts_status_idx` ON `content_posts` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gemini_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer,
	`kind` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`prompt` text NOT NULL,
	`status` text NOT NULL,
	`file` text,
	`error` text,
	`date_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `content_posts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gemini_runs_day_idx` ON `gemini_runs` (`kind`,`date_key`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`lane` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`last_error` text,
	`idempotency_key` text,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_unique` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`lane`,`run_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
