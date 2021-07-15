import { camelCase } from 'camel-case'
import chalk from 'chalk'
import * as Either from 'fp-ts/lib/Either'
import fs from 'fs-extra'
import emoji from 'node-emoji'
import path from 'path'
import { Collection, CollectionDefinition } from 'postman-collection'
import {
  CollectionWriter,
  IntegrationTestWriter,
  runNewmanWith,
  TestSuite,
  VariationWriter,
  writeNewmanEnv,
  writeRawReplacements
} from './application'
import { clearTmpDirectory, execShellCommand, getConfig } from './lib'
import { OpenApiParser } from './oas'
import { PostmanParser } from './postman'
import {
  DownloadService,
  IOpenApiToPostmanConfig,
  OpenApiToPostmanService,
  PostmanService
} from './services'
import { PortmanConfig } from './types'
import { PortmanOptions } from './types/PortmanOptions'
import { validate } from './utils/PortmanConfig.validator'

export class Portman {
  config: PortmanConfig
  options: PortmanOptions
  oasParser: OpenApiParser
  postmanParser: PostmanParser
  postmanCollection: Collection
  portmanCollection: CollectionDefinition
  testSuite: TestSuite
  variationWriter: VariationWriter
  integrationTestWriter: IntegrationTestWriter
  consoleLine: string

  public collectionFile: string

  constructor(options: PortmanOptions) {
    this.options = options
    this.consoleLine = '='.repeat(process.stdout.columns - 80)
  }

  async run(): Promise<void> {
    await this.before()
    if (!this.config) return

    await this.parseOpenApiSpec()
    await this.convertToPostmanCollection()
    this.injectTestSuite()
    this.injectVariationTests()
    this.injectVariationOverwrites()
    this.injectIntegrationTests()
    this.writePortmanCollectionToFile()
    await this.runNewmanSuite()
    await this.syncCollectionToPostman()

    return await this.after()
  }

  async uploadOnly(): Promise<void> {
    const localPostman = this.options.output || ''
    if (localPostman === '') {
      throw new Error(`Loading ${localPostman} failed.`)
    }
    this.options.syncPostman = true

    await this.before()

    try {
      const postmanJson = path.resolve(localPostman)
      this.portmanCollection = new Collection(
        JSON.parse(fs.readFileSync(postmanJson, 'utf8').toString())
      )
      await this.syncCollectionToPostman()
    } catch (err) {
      throw new Error(`Loading ${localPostman} failed.`)
    }
  }

  async before(): Promise<void> {
    const {
      consoleLine,
      options: {
        oaUrl,
        oaLocal,
        output,
        cliOptionsFile,
        portmanConfigFile,
        portmanConfigPath,
        postmanConfigFile,
        envFile,
        includeTests,
        runNewman,
        newmanIterationData,
        syncPostman
      }
    } = this
    // --- Portman - Show processing output
    console.log(chalk.red(consoleLine))

    oaUrl && console.log(chalk`{cyan  Remote Url: } \t\t{green ${oaUrl}}`)
    oaLocal && console.log(chalk`{cyan  Local Path: } \t\t{green ${oaLocal}}`)
    output && console.log(chalk`{cyan  Output Path: } \t\t{green ${output}}`)

    cliOptionsFile && console.log(chalk`{cyan  Portman CLI Config: } \t{green ${cliOptionsFile}}`)
    console.log(
      chalk`{cyan  Portman Config: } \t{green ${
        portmanConfigFile ? portmanConfigFile : 'portman-config.default.json'
      }}`
    )
    console.log(
      chalk`{cyan  Postman Config: } \t{green ${
        postmanConfigFile ? postmanConfigFile : 'postman-config.default.json'
      }}`
    )

    console.log(chalk`{cyan  Environment: } \t\t{green ${envFile}}`)
    console.log(chalk`{cyan  Inject Tests: } \t{green ${includeTests}}`)
    console.log(chalk`{cyan  Run Newman: } \t\t{green ${!!runNewman}}`)
    console.log(
      chalk`{cyan  Newman Iteration Data: }{green ${
        newmanIterationData ? newmanIterationData : false
      }}`
    )
    console.log(chalk`{cyan  Upload to Postman: } \t{green ${syncPostman}}  `)
    console.log(chalk.red(consoleLine))

    await fs.ensureDir('./tmp/working/')
    await fs.ensureDir('./tmp/converted/')
    await fs.ensureDir('./tmp/newman/')

    const configJson = await getConfig(portmanConfigPath)
    const config = validate(configJson)

    if (Either.isLeft(config)) {
      console.log(chalk`{red  Invalid Portman Config: } \t\t{green ${portmanConfigPath}}`)
      console.log(config.left)
      console.log(chalk.red(consoleLine))
    } else {
      this.config = config.right
    }
  }

  async after(): Promise<void> {
    const { consoleLine, collectionFile } = this
    await clearTmpDirectory()
    console.log(chalk.green(consoleLine))

    console.log(
      emoji.get(':rocket:'),
      chalk`{cyan Collection written to:} {green ${collectionFile}}`,
      emoji.get(':rocket:')
    )

    console.log(chalk.green(consoleLine))
  }

  async parseOpenApiSpec(): Promise<void> {
    // --- OpenApi - Get OpenApi file locally or remote
    const { oaLocal, oaUrl, filterFile } = this.options

    let openApiSpec = oaUrl && (await new DownloadService().get(oaUrl))

    if (oaLocal) {
      try {
        const oaLocalPath = path.resolve(oaLocal)
        await fs.copyFile(oaLocalPath, './tmp/converted/spec.yml')
        openApiSpec = './tmp/converted/spec.yml'
      } catch (err) {
        console.error('\x1b[31m', 'Local OAS error - no such file or directory "' + oaLocal + '"')
        process.exit(0)
      }
    }

    if (!openApiSpec) {
      throw new Error(`Error initializing OpenApi Spec.`)
    }

    const specExists = await fs.pathExists(openApiSpec)

    if (!specExists) {
      throw new Error(`${openApiSpec} doesn't exist. `)
    }

    if (filterFile && (await fs.pathExists(filterFile))) {
      const openApiSpecPath = './tmp/converted/filtered.yml'

      await execShellCommand(
        `npx openapi-format ${openApiSpec} -o ${openApiSpecPath} --yaml --filterFile ${filterFile}`
      )
      openApiSpec = openApiSpecPath
    }

    const oasParser = new OpenApiParser()
    await oasParser
      .convert({
        inputFile: openApiSpec
      })
      .catch(err => {
        console.log('error: ', err)
        throw new Error(`Parsing ${openApiSpec} failed.`)
      })

    this.oasParser = oasParser
  }

  async convertToPostmanCollection(): Promise<void> {
    // --- openapi-to-postman - Transform OpenApi to Postman collection
    const { postmanConfigPath, localPostman } = this.options

    const oaToPostman = new OpenApiToPostmanService()
    // TODO investigate better way to keep oasParser untouched
    // Clone oasParser to prevent altering with added minItems maxItems
    const { oas } = this.oasParser
    const oaToPostmanConfig: IOpenApiToPostmanConfig = {
      openApiObj: { ...oas },
      outputFile: `${process.cwd()}/tmp/working/tmpCollection.json`,
      configFile: postmanConfigPath as string
    }

    let postmanObj: Record<string, unknown>

    if (localPostman) {
      try {
        const postmanJson = path.resolve(localPostman)
        postmanObj = JSON.parse(fs.readFileSync(postmanJson, 'utf8').toString())
      } catch (err) {
        throw new Error(`Loading ${localPostman} failed.`)
      }
    } else {
      postmanObj = await oaToPostman.convert(oaToPostmanConfig).catch(err => {
        console.log('error: ', err)
        throw new Error(`Postman Collection generation failed.`)
      })
    }

    await this.runPortmanOverrides(postmanObj)

    this.postmanParser = new PostmanParser({
      collection: this.postmanCollection,
      oasParser: this.oasParser
    })

    this.portmanCollection = this.postmanParser.collection.toJSON()
  }

  injectTestSuite(): void {
    const {
      config,
      options: { includeTests },
      oasParser,
      postmanParser
    } = this

    if (includeTests) {
      const testSuite = new TestSuite({ oasParser, postmanParser, config })
      // Inject automated tests
      testSuite.generateContractTests()

      // Inject content tests
      testSuite.injectContentTests()

      // Inject variable assignment
      testSuite.injectAssignVariables()

      // Inject postman extended tests
      testSuite.injectExtendedTests()

      // Inject overwrites
      testSuite.injectOverwrites()

      // Inject PreRequestScripts
      testSuite.injectPreRequestScripts()

      this.testSuite = testSuite
      this.portmanCollection = testSuite.collection.toJSON()
    }
  }

  injectVariationTests(): void {
    const {
      options: { includeTests },
      testSuite
    } = this

    if (includeTests && testSuite) {
      // Inject variations
      this.variationWriter = new VariationWriter({
        testSuite: testSuite,
        variationFolderName: 'Variation Tests'
      })
      testSuite.variationWriter = this.variationWriter
      testSuite.generateVariationTests()

      this.portmanCollection = testSuite.collection.toJSON()
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-types
  async runPortmanOverrides(postmanCollection: CollectionDefinition): Promise<void> {
    // --- Portman - Overwrite Postman variables & values
    const { config, options } = this
    const collectionWriter = new CollectionWriter(config, options, postmanCollection)
    collectionWriter.execute()

    this.postmanCollection = new Collection(collectionWriter.collection)
  }

  injectIntegrationTests(): void {
    const {
      options: { includeTests },
      testSuite
    } = this

    if (includeTests && testSuite) {
      // Inject variations
      this.integrationTestWriter = new IntegrationTestWriter({
        testSuite: testSuite,
        integrationTestFolderName: 'Integration Tests'
      })

      testSuite.integrationTestWriter = this.integrationTestWriter
      testSuite.generateIntegrationTests()

      this.portmanCollection = testSuite.collection.toJSON()
    }
  }

  injectVariationOverwrites(): void {
    const { testSuite, variationWriter } = this
    if (!variationWriter || !testSuite) return

    this.postmanParser.map(this.portmanCollection)
    Object.entries(variationWriter.overwriteMap).map(([id, overwrites]) => {
      const pmOperation = this.postmanParser.getOperationByItemId(id)
      pmOperation && testSuite.injectOverwrites([pmOperation], overwrites)
    })

    this.portmanCollection = this.postmanParser.collection.toJSON()
  }

  writePortmanCollectionToFile(): void {
    // --- Portman - Write Postman collection to file
    const { output } = this.options
    const { globals } = this.config
    const fileName = this?.portmanCollection?.info?.name || 'portman-collection'

    let postmanCollectionFile = `./tmp/converted/${camelCase(fileName)}.json`
    if (output) {
      postmanCollectionFile = output as string
      if (!postmanCollectionFile.includes('.json')) {
        console.error(
          '\x1b[31m',
          'Output file error - Only .json filenames are allowed for "' + postmanCollectionFile + '"'
        )
        process.exit(0)
      }
    }

    try {
      let collectionString = JSON.stringify(this.portmanCollection, null, 2)

      // --- Portman - Replace & clean-up Portman
      if (globals?.portmanReplacements) {
        collectionString = writeRawReplacements(collectionString, globals.portmanReplacements)
      }

      fs.writeFileSync(postmanCollectionFile, collectionString, 'utf8')
      this.collectionFile = postmanCollectionFile
    } catch (err) {
      console.error(
        '\x1b[31m',
        'Output file error - no such file or directory "' + postmanCollectionFile + '"'
      )
      process.exit(0)
    }
  }

  async runNewmanSuite(): Promise<void> {
    // --- Portman - Execute Newman tests
    const {
      consoleLine,
      options: { runNewman, baseUrl, newmanIterationData }
    } = this

    if (runNewman) {
      const fileName = this?.portmanCollection?.info?.name || 'portman-collection'
      const newmanEnvFile = `./tmp/newman/${fileName}-env.json`
      writeNewmanEnv(this.portmanCollection, newmanEnvFile)

      try {
        console.log(chalk.green(consoleLine))
        console.log(chalk`{cyan  Run Newman against: } {green ${baseUrl}}`)
        console.log(chalk.green(consoleLine))

        await runNewmanWith(this.collectionFile, newmanEnvFile, newmanIterationData)
      } catch (error) {
        console.log(chalk.red(consoleLine))
        console.log(chalk.red(`Newman failed to run`))
        console.log(`\n`)
        console.log(error?.message)
        console.log(`\n`)
        console.log(chalk.red(consoleLine))
        process.exit(0)
      }
    }
  }

  async syncCollectionToPostman(): Promise<void> {
    // --- Portman - Upload Postman collection to Postman app
    const {
      portmanCollection,
      options: { syncPostman, postmanUid }
    } = this
    const consoleLine = '='.repeat(process.stdout.columns - 80)
    const portmanCacheFile = '.portman.cache'
    let portmanCache = {}
    let respData = ''

    if (syncPostman) {
      const postman = new PostmanService()

      const collName = portmanCollection?.info?.name as string
      let collUid = collName // fallback

      // Handle postmanUid from options
      if (postmanUid) {
        collUid = postmanUid
        respData = await postman.updateCollection(portmanCollection, collUid)
      }

      // Handle non-fixed postmanUid from cache or by collection name
      if (!postmanUid) {
        try {
          const portmanCachePath = path.resolve(portmanCacheFile)
          portmanCache = JSON.parse(fs.readFileSync(portmanCachePath, 'utf8').toString())
        } catch (err) {
          // throw new Error(`Loading ${localPostman} failed.`)
        }

        let remoteCollection = portmanCache[collName] as Record<string, unknown>
        if (!portmanCache[collName]) {
          remoteCollection = (await postman.findCollectionByName(collName)) as Record<
            string,
            unknown
          >
        }

        if (remoteCollection?.uid) {
          // Update collection by Uid
          respData = await postman.updateCollection(
            portmanCollection,
            remoteCollection.uid as string
          )
          const { status, data } = JSON.parse(respData)

          // Update cache
          if (status === 'fail') {
            // Remove invalid cache item
            delete portmanCache[collName]
          } else {
            // Merge item data with cache
            portmanCache = Object.assign({}, portmanCache, {
              [collName]: {
                name: collName,
                uid: data?.collection?.uid
              }
            })
          }
          // Write portman cache
          try {
            const portmanCacheStr = JSON.stringify(portmanCache, null, 2)
            fs.writeFileSync(portmanCacheFile, portmanCacheStr, 'utf8')
          } catch (err) {
            // skip writing file, continue
          }

          // Restart on invalid Postman Uid and use Postman name as sync identifier
          if (status === 'fail') {
            await this.syncCollectionToPostman()
          }
        } else {
          // Create collection
          respData = await postman.createCollection(portmanCollection)
          const { status, data } = JSON.parse(respData)
          console.log('createCollection', data)

          // Update cache
          if (status === 'success') {
            // Merge item data with cache
            portmanCache = Object.assign({}, portmanCache, {
              [collName]: {
                name: collName,
                uid: data?.collection?.uid
              }
            })

            // Write portman cache
            try {
              const portmanCacheStr = JSON.stringify(portmanCache, null, 2)
              fs.writeFileSync(portmanCacheFile, portmanCacheStr, 'utf8')
            } catch (err) {
              // skip writing file, continue
            }
          }
        }
      }

      // Process Postman API response as console output
      const { status, data } = JSON.parse(respData)

      if (status === 'success') {
        console.log(chalk`{cyan    -> Postman Name: } \t{green ${data?.collection?.name}}`)
        console.log(chalk`{cyan    -> Postman UID: } \t{green ${data?.collection?.uid}}`)
      } else {
        console.log(
          chalk`{red    -> Reason: } \t\tTargeted Postman collection ID ${collUid} does not exist.`
        )
        console.log(
          chalk`{red    -> Solution: } \tReview the collection ID defined for the 'postmanUid' setting.`
        )
        console.log(chalk`{red    -> Postman Name: } \t${portmanCollection?.info?.name}`)
        console.log(chalk`{red    -> Postman UID: } \t${collUid}`)

        console.log(data?.error)
        console.log(`\n`)
        console.log(chalk.red(consoleLine))
      }
    }
  }
}
