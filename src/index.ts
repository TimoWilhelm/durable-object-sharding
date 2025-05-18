export { SubscriberDurableObject } from '@/durable/Subscriber';
export { PublisherDurableObject } from '@/durable/Publisher';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
			const id: DurableObjectId = env.DURABLE_SUBSCRIBER.newUniqueId();
			const stub = env.DURABLE_SUBSCRIBER.get(id);
			return stub.fetch(request);
		}
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
