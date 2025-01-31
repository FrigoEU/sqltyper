// Generated by sqltyper from tableColumns.sql.
// Do not edit directly. Instead, edit tableColumns.sql and re-run sqltyper.

import * as postgres from '../postgres'

export async function tableColumns(
  sql: postgres.Sql<{}>,
  params: { schemaName: string; tableName: string }
): Promise<
  Array<{
    attnum: number
    attname: string
    atttypid: number
    attnotnull: boolean
    atthasdef: boolean
    attisdropped: boolean
  }>
> {
  const result = await sql.unsafe(
    `SELECT attnum, attname, atttypid, attnotnull, atthasdef, attisdropped
FROM pg_catalog.pg_attribute attr
JOIN pg_catalog.pg_class cls on attr.attrelid = cls.oid
JOIN pg_catalog.pg_namespace nsp ON nsp.oid = cls.relnamespace
WHERE
    (cls.relkind = 'r' OR cls.relkind = 'v')
    AND nsp.nspname = $1
    AND cls.relname = $2
ORDER BY attnum
`,
    [params.schemaName, params.tableName]
  )
  return result
}
