import type { DurableObject } from 'cloudflare:workers';

const symbolMigrationsApplied = Symbol('durable-object-sqlite-migrations-applied');
const symbolDeleteAllPatched = Symbol.for('durable-object-sqlite-deleteAll-patched');

export function DoSqliteMigrations<T extends { new (...args: any[]): DurableObject }>(
	migrationFunction: (storage: DurableObjectStorage) => void | Promise<void>
) {
	return function (target: T) {
		for (const key of Object.getOwnPropertyNames(target.prototype)) {
			const descriptor = Object.getOwnPropertyDescriptor(target.prototype, key);
			if (key !== 'constructor' && typeof descriptor?.value === 'function') {
				const originalMethod = descriptor.value;
				target.prototype[key] = async function (...args: any[]) {
					// Patch deleteAll to reset migrations symbol
					if (
						this.ctx &&
						this.ctx.storage &&
						typeof this.ctx.storage.deleteAll === 'function' &&
						!this.ctx.storage[symbolDeleteAllPatched]
					) {
						const originalDeleteAll = this.ctx.storage.deleteAll.bind(this.ctx.storage);
						this.ctx.storage.deleteAll = async (...deleteArgs: any[]) => {
							console.log(`Resetting migrations for ${target.name} on deleteAll`);
							const result = await originalDeleteAll(...deleteArgs);
							this[symbolMigrationsApplied] = undefined;
							return result;
						};
						this.ctx.storage[symbolDeleteAllPatched] = true;
					}

					console.log(`Checking migrations for ${target.name} on method ${key}. Applied: ${this[symbolMigrationsApplied]}`);
					return this.ctx
						.blockConcurrencyWhile(async () => {
							if (this[symbolMigrationsApplied]) {
								console.log(`Migrations already applied for ${target.name}`);
								return;
							}

							console.log(`Running migrations for ${target.name}`);
							await Promise.resolve(migrationFunction(this.ctx.storage));
							this[symbolMigrationsApplied] = true;
						})
						.then(() => {
							console.log(`Running original method ${key} for ${target.name}`);
							return originalMethod.apply(this, args);
						});
				};
			}
		}
	};
}
