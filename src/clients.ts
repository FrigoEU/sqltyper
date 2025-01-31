import * as Either from 'fp-ts/lib/Either'

import * as postgres from './postgres'
import { SchemaClient, schemaClient } from './schema'
import { transforms, TypeClient, typeClient } from './tstype'

export type Clients = {
  postgres: postgres.Sql<{}>
  schema: SchemaClient
  types: TypeClient
}

export async function connect(
  transforms: transforms,
  connectionString?: string | undefined
): Promise<Either.Either<string, Clients>> {
  const postgresClient = connectionString
    ? postgres(connectionString)
    : postgres()

  return Either.right(await clients(transforms, postgresClient))
}

export async function clients(
  transforms: transforms,
  postgresClient: postgres.Sql<{}>
): Promise<Clients> {
  const schema = schemaClient(postgresClient)
  const types = await typeClient(transforms, postgresClient)
  return { postgres: postgresClient, schema, types }
}

export async function disconnect(clients: Clients): Promise<void> {
  await clients.postgres.end({ timeout: 5 })
}

export async function clearCache(clients: Clients): Promise<Clients> {
  // The type client caches stuff about user-defined SQL types.
  // Recreate it to clear the cache.
  const types = await typeClient(
    clients.types.getTransforms(),
    clients.postgres
  )
  return { ...clients, types }
}
