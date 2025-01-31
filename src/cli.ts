#!/usr/bin/env node
// tslint:disable:no-console
import { promises as fs } from 'fs'
import watch from 'node-watch'
import * as path from 'path'

import camelCase = require('camelcase')
import * as Array from 'fp-ts/lib/Array'
import * as Either from 'fp-ts/lib/Either'
import * as Option from 'fp-ts/lib/Option'
import * as Ord from 'fp-ts/lib/Ord'
import * as Ordering from 'fp-ts/lib/Ordering'
import * as Task from 'fp-ts/lib/Task'
import * as TaskEither from 'fp-ts/lib/TaskEither'
import { identity } from 'fp-ts/lib/function'
import { pipe } from 'fp-ts/lib/pipeable'
import * as yargs from 'yargs'

import { Clients, connect, disconnect } from './clients'
import { CodegenTarget, codegenTargets } from './codegen'
import {
  sqlToStatementDescription,
  generateTSCode,
  indexModuleTS,
  TsModule,
  TsModuleDir,
} from './index'
import { traverseATs } from './fp-utils'
import * as Warn from './Warn'
import { transforms } from './tstype'

type Options = {
  verbose: boolean
  index: boolean
  prettify: boolean
  target: CodegenTarget
  module: string
  terminalColumns: number | undefined
}

async function getTransforms(filepath: string): Promise<transforms> {
  const contents = await fs.readFile(filepath, 'utf-8')
  const transforms = JSON.parse(contents)
  if (typeof transforms === 'object') {
    const map: transforms = new Map()
    for (var key in transforms) {
      const val = transforms[key]
      if (val && (val as any).tsType && (val as any).serializeFunc) {
      } else {
        throw new Error('Invalid transforms structure')
      }
      map.set(parseInt(key), transforms[key])
    }
    return map
  } else {
    throw new Error('Invalid transforms structure, should be an object')
  }
}

async function main(): Promise<number> {
  const args = parseArgs()
  if (!args._.length) {
    console.error('No input files. Try with `--help`.')
    return 1
  }

  if (args.watch && args.check) {
    console.error('Cannot use --watch and --check together')
    return 1
  }

  const transforms = args.transforms
    ? await getTransforms(args.transforms)
    : new Map()

  const options: Options = {
    verbose: args.verbose,
    index: args.index,
    prettify: args.prettify,
    target: args.target,
    module: args.module ?? args['pg-module'] ?? args.target,
    terminalColumns: process.stdout.columns,
  }

  const dirPaths: string[] = []
  for (const dirPath of args._.map((arg) => arg.toString())) {
    if (!(await fs.stat(dirPath)).isDirectory()) {
      console.error(`Not a directory: ${dirPath}`)
      return 1
    }
    dirPaths.push(dirPath)
  }
  const fileExtensions = extensions(args.ext)

  const clients = await connect(transforms, args.database)
  if (Either.isLeft(clients)) {
    console.error(clients.left)
    return 1
  }

  let status = 0
  if (args.watch) {
    await watchDirectories(clients.right, fileExtensions, dirPaths, options)
  } else if (args.check) {
    const result = await checkDirectories(
      clients.right,
      fileExtensions,
      dirPaths,
      options
    )()
    if (!result.every(identity)) {
      console.error(`
Some files are out of date!`)
      status = 1
    }
  } else {
    const moduleDirs = await processDirectories(
      clients.right,
      fileExtensions,
      dirPaths,
      options
    )()
    if (moduleDirs.some((moduleDir) => moduleDir.hasErrors)) status = 1
  }

  await disconnect(clients.right)
  return status
}

function parseArgs() {
  return yargs
    .usage('Usage: $0 [options] DIRECTORY...')
    .option('database', {
      alias: 'd',
      describe:
        'Database URI to connect to, e.g. -d postgres://user:pass@localhost/mydb. ' +
        'If not given, relies node-postgres default connecting logic which uses ' +
        'environment variables',
      type: 'string',
    })
    .option('ext', {
      alias: 'e',
      describe: 'File extensions to consider, e.g. -e sql,psql',
      type: 'string',
      default: 'sql',
    })
    .option('verbose', {
      alias: 'v',
      describe:
        'Give verbose output about problems with inferring statement nullability.',
      type: 'boolean',
      default: false,
    })
    .option('index', {
      describe:
        'Generate an index.ts file that re-exports all generated functions',
      type: 'boolean',
      default: true,
    })
    .option('watch', {
      alias: 'w',
      description: 'Watch files and run the conversion when something changes',
      type: 'boolean',
      default: false,
    })
    .option('target', {
      alias: 't',
      description:
        'Postgres client library to use in generated TypeScript code',
      choices: codegenTargets,
      default: codegenTargets[0],
    })
    .option('module', {
      alias: 'm',
      description: 'Where to import node-postgres or postgres.js from.',
      type: 'string',
    })
    .option('check', {
      alias: 'c',
      description:
        'Check whether all output files are up-to-date without actually updating ' +
        'them. If they are, exit with status 0, otherwise exit with status 1. ' +
        'Useful for CI or pre-commit hooks.',
      type: 'boolean',
      default: false,
    })
    .option('prettify', {
      alias: 'p',
      description: 'Apply prettier to output TypeScript files',
      type: 'boolean',
      default: false,
    })
    .option('transforms', {
      alias: 'f',
      description: 'JSON file containing transforms for PG types',
      type: 'string',
      default: '',
    })
    .option('pg-module', {
      description:
        'Where to import node-postgres from. (deprecated, use --module instead)',
      type: 'string',
    })
    .epilogue(
      `\
Generate TypeScript functions for SQL statements in all files in the \
given directories. For each input file, the output file name is \
generated by removing the file extension and appending ".ts".

Each output file will export a single function whose name is a \
camelCased version of the basename of the input file.

$0 connects to the database to infer the parameter and output column \
types of each SQL statement. It does this without actually executing \
the SQL queries, so it's safe to run against any database.
`
    )
    .help().argv
}

type WatchEvent = {
  type: 'update' | 'remove'
  dirPath: string
  fileName: string
}

type WatchEventHandler = (
  nestedDirs: TsModuleDir[],
  modules: TsModule[],
  type: 'update' | 'remove',
  dirPath: string,
  fileName: string
) => Promise<TsModule[]>

async function watchDirectories(
  clients: Clients,
  fileExtensions: string[],
  dirPaths: string[],
  options: Options
): Promise<void> {
  let moduleDirs = await processDirectories(
    clients,
    fileExtensions,
    dirPaths,
    options
  )()

  console.log('Watching for file changes...')
  const eventBuffer: WatchEvent[] = []
  let handlingEvents = false
  const eventHandler = makeWatchEventHandler(clients, options)

  dirPaths.forEach((dirPath) =>
    watch(
      dirPath,
      { filter: (fileName) => hasOneOfExtensions(fileExtensions, fileName) },
      async (event, filePath) => {
        if (!event || !filePath) return
        eventBuffer.push({
          type: event,
          dirPath,
          fileName: path.relative(dirPath, filePath),
        })
        if (!handlingEvents) {
          handlingEvents = true
          moduleDirs = await handleWatchEvents(
            moduleDirs,
            eventBuffer,
            eventHandler
          )
          handlingEvents = false
        }
      }
    )
  )

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return new Promise(() => {})
}

async function handleWatchEvents(
  moduleDirs: TsModuleDir[],
  events: WatchEvent[],
  eventHandler: WatchEventHandler
): Promise<TsModuleDir[]> {
  while (events.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const { type, dirPath, fileName } = events.shift()!

    const moduleDir = moduleDirs.find((dir) => dir.dirPath === dirPath)
    if (moduleDir == null) return moduleDirs

    const newModules = await eventHandler(
      moduleDir.nestedDirs,
      moduleDir.modules,
      type,
      dirPath,
      fileName
    )
    moduleDirs = pipe(
      modifyWhere(
        (moduleDir) => moduleDir.dirPath === dirPath,
        (moduleDir) => ({
          dirPath: moduleDir.dirPath,
          nestedDirs: moduleDir.nestedDirs,
          modules: newModules,
          hasErrors: moduleDir.hasErrors,
        }),
        moduleDirs
      ),
      Option.getOrElse(() => moduleDirs)
    )
  }
  return moduleDirs
}

function makeWatchEventHandler(
  clients: Clients,
  options: Options
): WatchEventHandler {
  return async (
    nestedDirs: TsModuleDir[],
    tsModules: TsModule[],
    type: 'update' | 'remove',
    dirPath: string,
    sqlFileName: string
  ) => {
    const sqlFilePath = path.join(dirPath, sqlFileName)

    let result: Task.Task<TsModule[]>
    switch (type) {
      case 'update':
        result = pipe(
          processSQLFile(clients, sqlFilePath, false, options),
          Task.map((tsModuleOption) =>
            pipe(
              tsModuleOption,
              Option.map((tsModule) =>
                replaceOrAddTsModule(tsModule, tsModules)
              ),
              Option.getOrElse(() => removeTsModule(sqlFileName, tsModules))
            )
          )
        )
        break
      case 'remove':
        await removeOutputFile(sqlFilePath)
        result = pipe(Task.of(removeTsModule(sqlFileName, tsModules)))
        break

      default:
        throw new Error('never reached')
    }

    result = pipe(
      result,
      Task.chain((newModules) =>
        maybeWriteIndexModule(
          options.index,
          dirPath,
          nestedDirs,
          newModules,
          options.prettify
        )
      )
    )

    return await result()
  }
}

function replaceOrAddTsModule(
  tsModule: TsModule,
  tsModules: TsModule[]
): TsModule[] {
  return pipe(
    modifyWhere(
      (mod) => mod.sqlFileName === tsModule.sqlFileName,
      () => tsModule,
      tsModules
    ),
    Option.getOrElse((): TsModule[] => Array.snoc(tsModules, tsModule))
  )
}

function modifyWhere<A>(
  pred: (value: A) => boolean,
  replacer: (found: A) => A,
  where: A[]
): Option.Option<A[]> {
  return pipe(
    where.findIndex(pred),
    Option.fromNullable,
    Option.chain((index) =>
      pipe(
        where,
        Array.modifyAt(index, () => replacer(where[index]))
      )
    )
  )
}

function removeTsModule(
  sqlFileName: string,
  tsModules: TsModule[]
): TsModule[] {
  return tsModules.filter((mod) => mod.sqlFileName != sqlFileName)
}

function processDirectories(
  clients: Clients,
  fileExtensions: string[],
  dirPaths: string[],
  options: Options
): Task.Task<TsModuleDir[]> {
  return pipe(
    async () => {
      console.log('Starting compilation...')
    },
    Task.chain(() =>
      mapDirectories(
        dirPaths,
        fileExtensions,
        (filePath) => processSQLFile(clients, filePath, false, options),
        (dirPath, nestedDirs: TsModuleDir[], tsModules) =>
          processSQLDirectory(dirPath, nestedDirs, tsModules, options)
      )
    ),
    Task.map((moduleDirs) => {
      if (moduleDirs.some((moduleDir) => moduleDir.hasErrors)) {
        console.log('Compilation failed.')
      } else {
        console.log('done.')
      }
      return moduleDirs
    })
  )
}

function checkDirectories(
  clients: Clients,
  fileExtensions: string[],
  dirPaths: string[],
  options: Options
): Task.Task<boolean[]> {
  return mapDirectories(
    dirPaths,
    fileExtensions,
    (filePath) => processSQLFile(clients, filePath, true, options),
    (_dirPath, _nestedDirs, tsModules) => checkDirectoryResult(tsModules)
  )
}

function checkDirectoryResult(
  tsModules: Option.Option<TsModule>[]
): Task.Task<boolean> {
  return Task.of(tsModules.every(Option.isSome))
}

function mapDirectories<T, U>(
  dirPaths: string[],
  fileExtensions: string[],
  fileProcessor: (filePath: string) => Task.Task<T>,
  dirProcessor: (
    dirPath: string,
    nestedDirs: U[],
    fileResults: T[]
  ) => Task.Task<U>
): Task.Task<U[]> {
  return traverseATs(dirPaths, (dirPath) =>
    mapDirectory(dirPath, fileExtensions, fileProcessor, dirProcessor)
  )
}

function mapDirectory<T, U>(
  dirPath: string,
  fileExtensions: string[],
  fileProcessor: (filePath: string) => Task.Task<T>,
  dirProcessor: (
    dirPath: string,
    nestedDirs: U[],
    fileResults: T[]
  ) => Task.Task<U>
): Task.Task<U> {
  return pipe(
    findSQLFilePaths(dirPath, fileExtensions),
    Task.chain((res) =>
      pipe(
        traverseATs(res.nestedDirs, (dirPath) =>
          mapDirectory(dirPath, fileExtensions, fileProcessor, dirProcessor)
        ),
        Task.chain((processedDirs) =>
          pipe(
            traverseATs(res.sqlFiles, fileProcessor),
            Task.chain((processedFiles) =>
              dirProcessor(dirPath, processedDirs, processedFiles)
            )
          )
        )
      )
    )
  )
}

function processSQLFile(
  clients: Clients,
  filePath: string,
  checkOnly: boolean,
  options: Options
): Task.Task<Option.Option<TsModule>> {
  const tsPath = getOutputPath(filePath)
  const fnName = funcName(filePath)
  return pipe(
    () => fs.readFile(filePath, 'utf-8'),
    Task.chain((sql) => sqlToStatementDescription(clients, sql)),
    TaskEither.map((stmtWithWarnings) => {
      const [stmt, warnings] = Warn.split(stmtWithWarnings)
      if (warnings.length > 0) {
        console.warn(
          Warn.format(warnings, options.verbose, options.terminalColumns || 78)
        )
      }
      return stmt
    }),
    TaskEither.chain((source) =>
      generateTSCode(clients, path.basename(filePath), source, fnName, {
        prettierFileName: options.prettify ? tsPath : undefined,
        target: options.target,
        module: options.module,
      })
    ),
    TaskEither.chain((tsCode) => async () => {
      if (await isFileOutOfDate(tsPath, tsCode)) {
        if (checkOnly) {
          return Either.left('out of date')
        }
        console.log(`Writing ${tsPath}`)
        await fs.writeFile(tsPath, tsCode).then(Either.right)
      }
      return Either.right(undefined)
    }),
    TaskEither.orElse((errorMessage) => async (): Promise<
      Either.Either<undefined, undefined>
    > => {
      console.error(`${filePath}: ${errorMessage}`)
      if (!checkOnly) {
        console.log(`Removing ${tsPath}`)
        await tryCatch(() => fs.unlink(tsPath))
      }
      return Either.left(undefined)
    }),
    TaskEither.map(() => ({
      sqlFileName: path.basename(filePath),
      tsFileName: path.basename(tsPath),
      funcName: fnName,
    })),
    Task.map(Option.fromEither)
  )
}

function processSQLDirectory(
  dirPath: string,
  nestedDirs: TsModuleDir[],
  modules: Option.Option<TsModule>[],
  options: Options
): Task.Task<TsModuleDir> {
  const successfulModules = pipe(modules, Array.filterMap(identity))
  const hasErrors = modules.some(Option.isNone)
  return pipe(
    maybeWriteIndexModule(
      options.index,
      dirPath,
      nestedDirs,
      successfulModules,
      options.prettify
    ),
    Task.map((modules) => ({ hasErrors, dirPath, modules, nestedDirs }))
  )
}

function moduleDirContainsSqlFiles(dir: TsModuleDir): boolean {
  return (
    dir.modules.length > 0 || dir.nestedDirs.some(moduleDirContainsSqlFiles)
  )
}

function maybeWriteIndexModule(
  write: boolean,
  dirPath: string,
  nestedDirs: TsModuleDir[],
  tsModules: TsModule[],
  prettify: boolean
): Task.Task<TsModule[]> {
  const tsPath = path.join(dirPath, 'index.ts')

  if (
    write &&
    (tsModules.length > 0 || nestedDirs.some(moduleDirContainsSqlFiles))
  ) {
    return pipe(
      Task.of(tsModules),
      Task.map((modules) =>
        pipe(
          modules,
          Array.sort(
            Ord.fromCompare((a: TsModule, b: TsModule) =>
              Ordering.sign(a.tsFileName.localeCompare(b.tsFileName))
            )
          )
        )
      ),
      Task.chain((sortedModules) =>
        indexModuleTS(
          dirPath,
          nestedDirs.filter(moduleDirContainsSqlFiles),
          sortedModules,
          {
            prettierFileName: prettify ? tsPath : null,
          }
        )
      ),
      Task.chain((tsCode) => async () => {
        if (await isFileOutOfDate(tsPath, tsCode)) {
          console.log(`Writing ${tsPath}`)
          await fs.writeFile(tsPath, tsCode)
        }
      }),
      Task.map(() => tsModules)
    )
  }
  return Task.of(tsModules)
}

async function isFileOutOfDate(filePath: string, newContents: string) {
  let oldContents: string | null
  try {
    oldContents = await fs.readFile(filePath, 'utf-8')
  } catch (_err) {
    oldContents = null
  }
  return oldContents !== newContents
}

async function tryCatch<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f()
  } catch (_err) {
    return null
  }
}

function funcName(filePath: string) {
  const parsed = path.parse(filePath)
  return camelCase(parsed.name)
}

async function removeOutputFile(filePath: string): Promise<void> {
  const tsPath = getOutputPath(filePath)
  try {
    await fs.unlink(tsPath)
  } catch (_err) {
    return
  }
  console.log(`Removing ${tsPath}`)
}

function mapPartial<A, B>(as: A[], f: (a: A) => null | B): B[] {
  function isNotNull<A>(a: A | null): a is A {
    return a !== null
  }
  return as.map(f).filter(isNotNull)
}

function findSQLFilePaths(
  dirPath: string,
  fileExtensions: string[]
): Task.Task<{
  sqlFiles: string[]
  nestedDirs: string[]
}> {
  return pipe(
    () =>
      fs.readdir(dirPath, {
        encoding: 'utf-8',
        withFileTypes: true,
      }),
    Task.chain((dirents) =>
      pipe(
        traverseATs(dirents, (dirent) =>
          pipe(
            categoriseDirEnt(fileExtensions, dirPath, dirent.name),
            Task.map((typ) => [typ, dirent] as const)
          )
        ),
        Task.map((dirents) => ({
          sqlFiles: mapPartial(dirents, ([typ, dirent]) =>
            typ === 'sqlfile' ? path.join(dirPath, dirent.name) : null
          ),
          nestedDirs: mapPartial(dirents, ([typ, dirent]) =>
            typ === 'dir' ? path.join(dirPath, dirent.name) : null
          ),
        }))
      )
    )
  )
}

function getOutputPath(filePath: string): string {
  return path.format({
    ...path.parse(filePath),
    base: undefined,
    ext: '.ts',
  })
}

function extensions(e: string): string[] {
  return e.split(',').map((ext) => `.${ext}`)
}

function categoriseDirEnt(
  extensions: string[],
  dirPath: string,
  fileName: string
): Task.Task<null | 'dir' | 'sqlfile'> {
  return async () => {
    let stats
    try {
      stats = await fs.stat(path.join(dirPath, fileName))
    } catch (_err) {
      return null
    }
    return stats.isFile() && hasOneOfExtensions(extensions, fileName)
      ? 'sqlfile'
      : stats.isDirectory()
      ? 'dir'
      : null
  }
}

function hasOneOfExtensions(exts: string[], fileName: string): boolean {
  return exts.includes(path.parse(fileName).ext)
}

main()
  .then((status) => process.exit(status))
  .catch((err) => {
    console.error(err)
    process.exit(99)
  })
