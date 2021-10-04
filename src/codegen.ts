import * as path from 'path'

import * as Either from 'fp-ts/lib/Either'
import * as Option from 'fp-ts/lib/Option'
import * as Arr from 'fp-ts/lib/Array'
import * as Eq from 'fp-ts/lib/Eq'
import * as Task from 'fp-ts/lib/Task'
import { pipe } from 'fp-ts/lib/pipeable'

import { traverseATs } from './fp-utils'
import * as pkginfo from './pkginfo'
import { TypeClient } from './tstype'
import { StatementDescription, NamedValue } from './types'

export type CodegenTarget = 'pg' | 'postgres'
export const codegenTargets: ReadonlyArray<CodegenTarget> = ['pg', 'postgres']

////////////////////////////////////////////////////////////////////////

export function validateStatement(
  stmt: StatementDescription
): Either.Either<string, StatementDescription> {
  const columnNames: Set<string> = new Set()
  const conflicts: Set<string> = new Set()

  stmt.columns.forEach(({ name }) => {
    if (columnNames.has(name)) {
      conflicts.add(name)
    } else {
      columnNames.add(name)
    }
  })

  if (conflicts.size) {
    const dup = [...conflicts.values()].sort().join(', ')
    return Either.left(`Duplicate output columns: ${dup}`)
  }

  return Either.right(stmt)
}

////////////////////////////////////////////////////////////////////////

export function generateTypeScript(
  types: TypeClient,
  sourceFileName: string,
  target: CodegenTarget,
  module: string,
  funcName: string,
  stmt: StatementDescription
): Task.Task<string> {
  const positionalOnly = hasOnlyPositionalParams(stmt)
  return pipe(
    Task.of(
      typeScriptString(sourceFileName, target, module, funcName, stmt.sql)
    ),
    Task.ap(funcParams(types, stmt, positionalOnly)),
    Task.ap(funcReturnType(types, stmt)),
    Task.ap(
      Task.of(
        queryValues(
          types,
          stmt,
          positionalOnly,
          target === 'postgres',
          target === 'postgres'
        )
      )
    ),
    Task.ap(Task.of(outputValue(target, stmt))),
    Task.ap(Task.of(extraImports(types))),
    Task.ap(Task.of(serializeFuncs(types)))
  )
}

const typeScriptString = (
  sourceFileName: string,
  target: CodegenTarget,
  module: string,
  funcName: string,
  sql: string
) => (params: string) => (returnType: string) => (queryValues: string[]) => (
  outputValue: string
) => (extraImports: string[]) => (serializeFuncs: string[]): string =>
  generators[target]({
    sourceFileName,
    module,
    funcName,
    sql,
    params,
    returnType,
    queryValues,
    outputValue,
    extraImports,
    serializeFuncs,
  })

type GeneratorOptions = {
  sourceFileName: string
  module: string
  funcName: string
  params: string
  returnType: string
  sql: string
  queryValues: string[]
  outputValue: string
  extraImports: string[]
  serializeFuncs: string[]
}
type Generator = (opts: GeneratorOptions) => string

const topComment = (sourceFileName: string) => `\
// Generated by ${pkginfo.name} from ${sourceFileName}.
// Do not edit directly. Instead, edit ${sourceFileName} and re-run ${pkginfo.name}.
`

const generators: Record<CodegenTarget, Generator> = {
  pg({
    sourceFileName,
    module,
    funcName,
    params,
    returnType,
    sql,
    queryValues,
    outputValue,
    extraImports,
    serializeFuncs,
  }: GeneratorOptions) {
    return `\
${topComment(sourceFileName)}

import { ClientBase, Pool } from '${module}'
${extraImports}

export async function ${funcName}(
  client: ClientBase | Pool${params}
): Promise<${returnType}> {
    const result = await client.query(\`\\
${sql}\`${'[' + queryValues.join(',') + ']'})
    return ${outputValue}
}
`
  },
  postgres({
    sourceFileName,
    module,
    funcName,
    params,
    returnType,
    sql,
    queryValues,
    outputValue,
    extraImports,
    serializeFuncs,
  }: GeneratorOptions) {
    const substitutedSqlStatement = queryValues.reduceRight(function (
      acc,
      p,
      i
    ) {
      return acc.replace(new RegExp('\\$' + (i + 1), 'gi'), '${' + p + '}')
    },
    sql)
    return `\
${topComment(sourceFileName)}

import postgres from '${module}'
${extraImports}

export async function ${funcName}(
  sql: postgres.Sql<{${serializeFuncs}}>${params}
): Promise<${returnType}> {
    const result: postgres.RowList<any[]>  = await sql\`${substitutedSqlStatement}\`;
    return ${outputValue}
}
`
  },
}

function hasOnlyPositionalParams(stmt: StatementDescription) {
  return stmt.params.every((param) => !!param.name.match(/\$\d+/))
}

function funcReturnType(
  types: TypeClient,
  stmt: StatementDescription
): Task.Task<string> {
  return pipe(
    traverseATs(stmt.columns, columnType(types)),
    Task.map((columnTypes) => {
      const rowType = '{ ' + columnTypes.join('; ') + ' }'
      switch (stmt.rowCount) {
        case 'zero':
          return 'number' // return the affected row count
        case 'one':
          return rowType
        case 'zeroOrOne':
          return `${rowType} | null`
        case 'many':
          return `Array<${rowType}>`
      }
    })
  )
}

const columnType = (types: TypeClient) => (
  column: NamedValue
): Task.Task<string> => {
  return pipe(
    types.columnType(column),
    Task.map(({ name, type }) => `${stringLiteral(name)}: ${type}`)
  )
}

function outputValue(
  target: CodegenTarget,
  stmt: StatementDescription
): string {
  let rows: string, count: string
  switch (target) {
    case 'pg':
      rows = 'result.rows'
      count = 'result.rowCount'
      break
    case 'postgres':
      rows = 'result'
      count = 'result.count'
      break
  }
  switch (stmt.rowCount) {
    case 'zero':
      return count // return the affected row count
    case 'one':
      return `${rows}[0]`
    case 'zeroOrOne':
      return `${count} > 0 ? ${rows}[0] : null`
    case 'many':
      return rows
  }
}

function extraImports(types: TypeClient): string[] {
  return Arr.uniq(Eq.eqString)(
    Arr.compact(
      Array.from(types.getTransforms()).map(([_oid, transform]) => {
        return transform.import ? Option.some(transform.import) : Option.none
      })
    )
  )
}

function serializeFuncs(types: TypeClient): string[] {
  return Arr.uniq(Eq.eqString)(
    Array.from(types.getTransforms()).map(([_oid, transform]) => {
      return `${transform.serializeFunc}: (_: ${transform.tsType}) => string`
    })
  )
}

function stringLiteral(str: string): string {
  return "'" + str.replace('\\', '\\\\').replace("'", "\\'") + "'"
}

function funcParams(
  types: TypeClient,
  stmt: StatementDescription,
  positionalOnly: boolean
): Task.Task<string> {
  if (!stmt.params.length) {
    return Task.of('')
  }

  return pipe(
    positionalOnly
      ? positionalFuncParams(types, stmt)
      : namedFuncParams(types, stmt),
    Task.map((params) => `, ${params}`)
  )
}

function positionalFuncParams(
  types: TypeClient,
  stmt: StatementDescription
): Task.Task<string> {
  return pipe(
    traverseATs(stmt.params, (param) =>
      pipe(
        types.tsType(param.type, param.nullable),
        Task.map((tsType) => `${param.name}: ${tsType}`)
      )
    ),
    Task.map((params) => params.join(', '))
  )
}

function namedFuncParams(
  types: TypeClient,
  stmt: StatementDescription
): Task.Task<string> {
  return pipe(
    positionalFuncParams(types, stmt),
    Task.map((params) => `params: { ${params} }`)
  )
}

function queryValues(
  types: TypeClient,
  stmt: StatementDescription,
  positionalOnly: boolean,
  encodeArray: boolean,
  serializeFunctionOnConnection: boolean
): string[] {
  if (!stmt.params.length) {
    return []
  }

  const prefix = positionalOnly ? '' : 'params.'
  return stmt.params.map((param) => {
    const p = prefix + param.name
    const transform = types.getTransform(param.type.oid)
    const pWithTransform = transform
      ? `${p} && ${serializeFunctionOnConnection ? 'sql.types.' : ''}${
          transform.serializeFunc
        }(${p})`
      : p
    return encodeArray && types.isArray(param.type.oid)
      ? 'sql.array(' + pWithTransform + ')'
      : pWithTransform
  })
}

////////////////////////////////////////////////////////////////////////

export type TsModule = {
  sqlFileName: string // full path
  tsFileName: string // full path
  funcName: string
}

export type TsModuleDir = {
  dirPath: string // full path
  nestedDirs: TsModuleDir[]
  modules: TsModule[]
  hasErrors: boolean
}

export function generateIndexModule(
  dirPath: string,
  nestedDirs: TsModuleDir[],
  modules: TsModule[]
): string {
  const nestedDirsStr = nestedDirs
    .map((dir) => {
      const name = path.relative(dirPath, dir.dirPath)
      return `export * as ${name} from './${name}';`
    })
    .join('\n')
  const modulesStr = modules
    .map(
      ({ tsFileName, funcName }) =>
        `export { ${funcName} } from './${baseNameWithoutExt(tsFileName)}';`
    )
    .join('\n')
  return nestedDirsStr + '\n' + modulesStr
}

function baseNameWithoutExt(filePath: string): string {
  return path.parse(filePath).name
}
