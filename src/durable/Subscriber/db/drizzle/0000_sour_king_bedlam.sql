CREATE TABLE `publisher` (
	`id` integer PRIMARY KEY NOT NULL,
	`publisher_id` text NOT NULL,
	CONSTRAINT "check_publisher_singleton" CHECK("publisher"."id" = 0)
);
