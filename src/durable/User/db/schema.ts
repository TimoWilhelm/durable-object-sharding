import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const channel = sqliteTable(
	'channel',
	{
		id: integer('id', { mode: 'number' }).primaryKey(),
		channelId: text('channel_id').notNull(),
	},
	(table) => [check('check_channel_singleton', sql`${table.id} = 0`)]
);
