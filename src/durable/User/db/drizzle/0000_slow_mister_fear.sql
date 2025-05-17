CREATE TABLE `channel` (
	`id` integer PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	CONSTRAINT "check_channel_singleton" CHECK("channel"."id" = 0)
);
