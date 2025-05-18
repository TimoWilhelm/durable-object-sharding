import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const publisher = sqliteTable(
	'publisher',
	{
		id: integer('id', { mode: 'number' }).primaryKey(),
		publisherId: text('publisher_id').notNull(),
	},
	(table) => [check('check_publisher_singleton', sql`${table.id} = 0`)]
);
