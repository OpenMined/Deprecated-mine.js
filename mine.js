/**
 * Bootstrap the application
 * - create schedule to poll blockchain
 */

// const schedule = require('node-schedule')
global.config = require('./config')
const Sonar = require('./lib/sonar')
const tmp = require('tmp')
const path = require('path')
const fs = require('fs')
const spawn = require('child_process').spawn
const IPFS = require('./lib/ipfs')
const Web3 = require('web3')
const geth = require('./lib/geth')
const EventEmitter = require('events').EventEmitter

class Mine extends EventEmitter {
  constructor (mineAddress, contractAddress, ethereumUrl) {
    super()

    this.mineAddress = mineAddress
    this.contractAddress = contractAddress
    this.ethereumUrl = ethereumUrl
    this.web3 = new Web3(new Web3.providers.HttpProvider(ethereumUrl))
    this.sonar = null
    this.ipfs = null
  }

  log (msg) {
    this.emit('log', msg)
  }

  error (err) {
    this.emit('error', err)
  }

  async connect (gethDataDir, gethPasswordFile) {
    var self = this

    if (self.mineAddress === 'auto') {
      const mineAddresses = await self.web3.eth.getAccounts()
      self.mineAddress = mineAddresses.length && mineAddresses[0]
    }

    self.sonar = new Sonar(self.web3, self.contractAddress, self.mineAddress)

    self.log(`📄  Connecting to Geth`)

    geth.connect(self.mineAddress, gethDataDir, gethPasswordFile)
    .then(() => {
      self.log(`📄  Connected to Geth`)
      return IPFS.connect()
    })
    .then(async (ipfs) => {
      self.ipfs = ipfs
      self.log(`💾  Connected to IPFS. Online ${ipfs.isOnline()}`)

      self.emit('connect')
    })
    .catch(err => self.error(err))
  }

  async getModels () {
    var self = this

    self.log(`🔎️  Looking for models to train at ${self.contractAddress} for mine ${self.mineAddress}`)

    const modelCount = await self.getNumModels()
    self.log(`💃  ${modelCount} models found`)

    const models = {}
    for (let modelId = 0; modelId < modelCount; modelId++) {
      const model = await self.getModel(modelId)
      models[modelId] = model
    }

    return models
  }

  async getNumModels () {
    var self = this

    const modelCount = await self.sonar.getNumModels()
    return modelCount
  }

  async getModel (modelId) {
    var self = this

    const model = await self.sonar.getModel(modelId)

    if (model.gradientCount > Infinity) { // disable for now, should be > 0 to work ;)
      try {
        const gradients = await self.sonar.getModelGradients(modelId, model.gradientCount - 1)
        self.log(`latest gradient#${gradients.id}: ${gradients.gradientsAddress} (weights: ${gradients.weightsAddress})`)
      } catch (e) {
        self.error(` could not fetch gradients: ${e}`)
      }
    }

    return model
  }

  async trainModel (model) {
    var self = this

    self.log(` 💃  model#${model.id} with ${model.gradientCount} gradients at IPFS:${model.weightsAddress}`)

    // download & train the model
    // create folder structure
    const tmpDirectory = tmp.dirSync()
    const tmpPaths = {}
    Object.keys(config.syft.tmpFiles)
    .forEach(e => {
      tmpPaths[e] = path.join(tmpDirectory.name, config.syft.tmpFiles[e])
    })

    self.log(`  ⬇️  Downloading model ${model.id}`)
    // download the model from IPFS
    const modelFh = fs.createWriteStream(tmpPaths.model)
    await new Promise((resolve, reject) => {
      self.ipfs.files.get(model.weightsAddress, (err, stream) => {
        if (err) return reject(err)
        stream.on('data', (file) => file.content.pipe(modelFh))
        stream.on('end', () => resolve(`weight stored to ${tmpPaths.model}`))
      })
    })

    // spawn syft
    self.log(`  🏋️  Training model ${model.id}`)
    const childOpts = {
      shell: true,
      stdio: config.debug ? 'inherit' : ['ignore', 'ignore', process.stderr]
    }
    const trainStart = new Date()
    const sp = spawn(`syft_cmd generate_gradient`, [`-model ${tmpPaths.model}`, `-input_data ${path.join(__dirname, 'data/adapters/diabetes/diabetes_input.csv')}`, `-target_data ${path.join(__dirname, 'data/adapters/diabetes/diabetes_output.csv')}`, `-gradient ${tmpPaths.gradient}`], childOpts)
    await new Promise((resolve, reject) => {
      sp.on('close', code => {
        if (code) reject(new Error(`error while calling syft, code=${code}`))
        resolve()
      })
    })
    config.debug && self.log(`  🏋️  Finished training the model in ${(new Date() - trainStart) / 1000} s`)

    // put new gradients into IPFS
    self.log(`  ⬆️  Uploading new gradients to IPFS`)
    const gradientFh = fs.createReadStream(tmpPaths.gradient)
    const gradientsAddress = await new Promise((resolve, reject) => {
      const files = [{
        path: tmpPaths.gradient,
        content: gradientFh
      }]

      self.ipfs.files.add(files, (err, res) => {
        if (err) return console.error(err)
        const obj = res.find(e => e.path === tmpPaths.gradient)
        resolve(obj.hash)
      })
    })
    // upload new gradient address to sonar
    const response = await self.sonar.addGradient(model.id, gradientsAddress)
    self.log(config.debug ? `  ✅  Successfully propagated new gradient to Sonar with tx: ${response.transactionHash} for the price of ${response.gasUsed} gas  at IPFS:${gradientsAddress}` : `  ✅  Successfully propagated new gradient to Sonar at IPFS:${gradientsAddress}`)

    // if (config.pollInterval > 0) setTimeout(() => checkForModels(mineAddress, contractAddress, web3, ipfs), config.pollInterval * 1000)
  }
}

module.exports = Mine
