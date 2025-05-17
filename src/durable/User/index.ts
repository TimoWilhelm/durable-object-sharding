import { DurableObject } from 'cloudflare:workers';
import type { ChannelMessage } from '@/durable/shared';
import { type DrizzleSqliteDODatabase, drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import * as schema from './db/schema';
import migrations from './db/drizzle/migrations.js';
import { eq } from 'drizzle-orm';

const MAX_SHARDS = 3;
const DO_KEY = 'CHANNEL';

export class UserDurableObject extends DurableObject<Env> {
	private db: DrizzleSqliteDODatabase<typeof schema>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema, logger: false });
		this.ctx.blockConcurrencyWhile(async () => {
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
		console.log(`Received user message: ${message}`);

		const channelResult = await this.db.query.channel.findFirst();
		console.log('channelResult', channelResult);

		if (channelResult === undefined) {
			await this.subscribeToChannel();
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		await this.handleClose(ws);
	}

	async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
		await this.handleClose(ws);
	}

	async onChannelMessage(message: ChannelMessage): Promise<void> {
		console.log(`Received message from channel: ${message.channelId}: ${message.content}`);

		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			await this.unsubscribeFromChannel(message.channelId);
			// await this.ctx.storage.deleteAll(); // TODO: issue with sqlite migrations
			return;
		}

		const channelResult = await this.db.query.channel.findFirst();
		if (channelResult === undefined || message.channelId !== channelResult.channelId) {
			console.warn('received message from invalid channel', message.channelId, channelResult?.channelId);
			await this.unsubscribeFromChannel(message.channelId);
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

	async onChannelUnsubscribed(channelId: string): Promise<void> {
		await this.db.delete(schema.channel).where(eq(schema.channel.channelId, channelId));
		console.log(`Unsubscribed from channel: ${channelId}`);
	}

	private async handleClose(webSocket: WebSocket): Promise<void> {
		console.log('WebSocket closed');
		webSocket.close(1011); // ensure websocket is closed

		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length === 0) {
			const channelResult = await this.db.query.channel.findFirst();
			if (channelResult !== undefined) {
				console.log('Unsubscribing from channel:', channelResult.channelId);
				await this.unsubscribeFromChannel(channelResult.channelId);
			}
			// await this.ctx.storage.deleteAll(); // TODO: issue with sqlite migrations
		}
	}

	private async unsubscribeFromChannel(channelId: string): Promise<void> {
		const stub = this.env.CHANNEL_DURABLE_OBJECT.idFromString(channelId);
		const channel = this.env.CHANNEL_DURABLE_OBJECT.get(stub);
		await channel.unsubscribe(this.ctx.id.toString());
	}

	private async subscribeToChannel(): Promise<void> {
		console.log('Subscribing to channel...');
		const channelResult = await this.db.query.channel.findFirst();

		if (channelResult !== undefined) {
			return;
		}

		for (let i = 0; i < MAX_SHARDS; i++) {
			const id = this.env.CHANNEL_DURABLE_OBJECT.idFromName(`${DO_KEY}_${i}`);
			const stub = this.env.CHANNEL_DURABLE_OBJECT.get(id);
			const subscribed = await stub.subscribe(this.ctx.id.toString());
			if (subscribed) {
				await this.db.insert(schema.channel).values({ id: 0, channelId: id.toString() });
				console.log(`Subscribed to channel: ${id.toString()}`);
				return;
			}
		}

		throw new Error('too many shards');
	}
}
