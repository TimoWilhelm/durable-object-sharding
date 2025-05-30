import { DurableObject } from 'cloudflare:workers';
import type { PublishMessage } from '@/durable/shared';
import { count, eq } from 'drizzle-orm';
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';

const MAX_SHARDS = 3;
const DO_KEY = 'PUBLISHER';

export class SubscriberDurableObject extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema, logger: false });
		void this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1]);

			return new Response(null, {
				status: 101,
				webSocket: pair[0],
			});
		}
		return new Response('Not found', { status: 404 });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await migrate(this.db, migrations);

		console.log(`Received message: ${message}`);

		const [{ count: numPublishers }] = await this.db.select({ count: count() }).from(schema.publisher);

		if (numPublishers === 0) {
			await this.subscribe();
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		await migrate(this.db, migrations);

		await this.handleClose(ws);
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		await migrate(this.db, migrations);

		await this.handleClose(ws);
	}

	async onMessage(message: PublishMessage): Promise<void> {
		await migrate(this.db, migrations);

		console.log(`Received message from publisher ${message.publisherId}: ${message.content}`);

		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			await this.unsubscribe(message.publisherId);
			void this.ctx.blockConcurrencyWhile(async () => {
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
			});
			return;
		}

		const publisher = await this.db.query.publisher.findFirst({ columns: { publisherId: true } });
		if (publisher === undefined || message.publisherId !== publisher.publisherId) {
			console.warn('received message from invalid publisher', message.publisherId, publisher?.publisherId);
			await this.unsubscribe(message.publisherId);
			return;
		}

		console.log('Received message:', message);

		await Promise.all(
			webSockets.map(async (webSocket) => {
				try {
					webSocket.send(JSON.stringify(message));
				} catch (error) {
					console.error('Error sending message to WebSocket:', error);
					await this.handleClose(webSocket);
				}
			})
		);
	}

	async onUnsubscribed(publisherId: string): Promise<void> {
		await migrate(this.db, migrations);

		await this.db.delete(schema.publisher).where(eq(schema.publisher.publisherId, publisherId));
		console.log(`Unsubscribed from: ${publisherId}`);
	}

	private async handleClose(webSocket: WebSocket): Promise<void> {
		console.log('WebSocket closed');
		webSocket.close(1011); // ensure websocket is closed

		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			const publisher = await this.db.query.publisher.findFirst({ columns: { publisherId: true } });
			if (publisher !== undefined) {
				console.log('Unsubscribing from publisher:', publisher.publisherId);
				await this.unsubscribe(publisher.publisherId);
			}
			void this.ctx.blockConcurrencyWhile(async () => {
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
			});
		}
	}

	private async unsubscribe(publisherId: string): Promise<void> {
		const id = this.env.DURABLE_PUBLISHER.idFromString(publisherId);
		const stub = this.env.DURABLE_PUBLISHER.get(id);
		await stub.unsubscribe(this.ctx.id.toString());
	}

	private async subscribe(): Promise<void> {
		console.log('Subscribing to publisher...');
		const publisher = await this.db.query.publisher.findFirst({ columns: { publisherId: true } });

		if (publisher !== undefined) {
			return;
		}

		for (let i = 0; i < MAX_SHARDS; i++) {
			const id = this.env.DURABLE_PUBLISHER.idFromName(`${DO_KEY}_${i}`);
			const stub = this.env.DURABLE_PUBLISHER.get(id);
			const subscribed = await stub.subscribe(this.ctx.id.toString());
			if (subscribed) {
				await this.db.insert(schema.publisher).values({ id: 0, publisherId: id.toString() });
				console.log(`Subscribed to publisher: ${id.toString()}`);
				return;
			}
		}

		throw new Error('too many shards');
	}
}
