#!/usr/bin/env node

const request = require('request')
const crypto = require('crypto')
const chalk = require('chalk')
const fs = require('fs')
const path = require('path')
const print = require('chalk-printer')
const moment = require('moment')
const files = require('../../lib/file')
const keyfile = require('../../lib/keyfile')
const util = require('../../lib/util')
const logFile = require('nlogj')
  .setLogName(`kucoin.${moment().format('YYYYMMDD_HHmm')}.log`).clearLog()
const currentDir = path.dirname(fs.realpathSync(__filename))
const log = console.log

var host = 'https://api.kucoin.com'
var totalChange = 0

//@nhancv: Get default config
const minTrades = require('./mintrade.json')
var { targetPair, buyCoin, sellCoin, fee, priceStrategy } = require('./config.json')
//================
//MAKE REST API
function requestOrderApi(host, pairCoin, type, amount, price) {
  return new Promise(function (resolve, reject) {
    const { publicKey, secretKey } = require('./.apikey.json')

    var endpoint = `/v1/${pairCoin}/order`
    var url = host + endpoint

    var nonce = Date.now()
    /** 
     *  POST parameters：
     *    type: BUY
     *    amount: 10
     *    price: 1.1
     *    Arrange the parameters in ascending alphabetical order (lower cases first), then combine them with & (don't urlencode them, don't add ?, don't add extra &), e.g. amount=10&price=1.1&type=BUY    
     */
    var queryString = `amount=${amount}&price=${price}&type=${type}`
    //splice string for signing
    var strForSign = endpoint + '/' + nonce + '/' + queryString
    //Make a base64 encoding of the completed string
    var signatureStr = new Buffer(strForSign).toString('base64')
    //KC-API-SIGNATURE in header
    const signatureResult = crypto.createHmac('sha256', secretKey)
      .update(signatureStr)
      .digest('hex')

    request({
      method: 'POST',
      url: url,
      headers: {
        'KC-API-KEY': publicKey,
        'KC-API-NONCE': nonce,   //Client timestamp (exact to milliseconds), before using the calibration time, the server does not accept calls with a time difference of more than 3 seconds
        'KC-API-SIGNATURE': signatureResult,   //signature after client encryption
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      form: {
        'type': type,
        'amount': amount,
        'price': price
      }
    }, function (error, response, body) {
      var logMsg = `=> ${type} ${pairCoin} ${price} ${amount}:`
      var status = 'ERROR'
      var message = ''
      if (error) {
        message = error.message
        logMsg += chalk.red('ERROR: ' + message)
      } else {
        body = JSON.parse(body)
        logMsg += body.success ? chalk.green.bold(body.msg) : chalk.red.bold(body.msg)

        status = body.success
        message = body.msg
      }
      resolve(`${status}: ${message}`)
      log(logMsg)

    })
  })
}

function requestPublicApi(host, endpoint) {
  return new Promise(function (resolve, reject) {
    var url = host + endpoint
    // log('Request public api: ' + url)
    request({
      method: 'GET',
      url: url,
    }, function (error, response, body) {
      if (error) reject(error)
      else resolve(response)

    })
  })
}

///////////////////////////////////////////
/**
 * TRADING
 */
const mapBody = response => {
  try {
    var body = JSON.parse(response.body)

    if (body.data["BUY"].length > 0 && body.data["SELL"].length > 0) {
      return Promise.resolve({
        "BUY": body.data["BUY"][0],
        "SELL": body.data["SELL"][0]
      })
    } else {
      return Promise.reject('Fetching price FAILED')
    }
  } catch (error) {
    return Promise.reject(error)
  }
}
const mapError = error => {
  throw error
}
const isAmountValid = (coin, amount) => {
  if (minTrades[coin] && minTrades[coin].min) {
    return minTrades[coin].min <= amount
  }
  return true
}

function trading(targetCoin, buyCoin, sellCoin, inputAmount, fee, mapBody, mapError) {
  return new Promise(function (resolve, reject) {

    var pairZ = `${targetCoin}-${buyCoin}`
    var pairY = `${targetCoin}-${sellCoin}`
    var pairL = `${buyCoin}-${sellCoin}`

    var getZ = requestPublicApi(host, `/v1/${pairZ}/open/orders`).then(mapBody, mapError)
    var getY = requestPublicApi(host, `/v1/${pairY}/open/orders`).then(mapBody, mapError)
    var getL = requestPublicApi(host, `/v1/${pairL}/open/orders`).then(mapBody, mapError)

    Promise.all([getZ, getY, getL]).then(function (values) {

      var feeF = fee / 100
      //@nhancv: Get precision for price
      var minPricePrecisionBuyCoin = (minTrades[buyCoin] && minTrades[buyCoin].pricePrecision) ? minTrades[buyCoin].pricePrecision : 8
      var minPricePrecisionSellCoin = (minTrades[sellCoin] && minTrades[sellCoin].pricePrecision) ? minTrades[sellCoin].pricePrecision : 8
      //@nhancv: Get precision for amount
      var minAmountPrecisionTargetCoin = (minTrades[targetCoin] && minTrades[targetCoin].amountPrecision) ? minTrades[targetCoin].amountPrecision : 6
      var minAmountPrecisionBuyCoin = (minTrades[buyCoin] && minTrades[buyCoin].amountPrecision) ? minTrades[buyCoin].amountPrecision : 6

      //@nhancv: Optimize price & amount
      var ZPriceBuy = values[0]['BUY'][0]
      var ZPriceSell = values[0]['SELL'][0]
      var ZPriceAvg = util.precisionFloorRound((ZPriceSell + ZPriceBuy) / 2, minPricePrecisionBuyCoin)
      var ZPriceBest = priceStrategy == 0 ? ZPriceAvg : priceStrategy == -1 ? ZPriceSell : ZPriceBuy
      //BUY
      var ZPrice = util.precisionFloorRound(ZPriceBest, minPricePrecisionBuyCoin)
      var ZAmount = util.precisionFloorRound(inputAmount + inputAmount * feeF, minAmountPrecisionTargetCoin)
      if (ZAmount > values[0][1]) {
        ZAmount = util.precisionFloorRound(values[0][1], minAmountPrecisionTargetCoin)

        inputAmount = util.precisionFloorRound(ZAmount / (1 + feeF), minAmountPrecisionTargetCoin)
      }

      var YPriceBuy = values[1]['BUY'][0]
      var YPriceSell = values[1]['SELL'][0]
      var YPriceAvg = util.precisionFloorRound((YPriceSell + YPriceBuy) / 2, minPricePrecisionSellCoin)
      var YPriceBest = priceStrategy == 0 ? YPriceAvg : priceStrategy == -1 ? YPriceBuy : YPriceSell
      //SELL
      var YPrice = util.precisionFloorRound(YPriceBest, minPricePrecisionSellCoin)
      var YAmount = inputAmount
      if (YAmount > values[1][1]) {
        YAmount = util.precisionFloorRound(values[1][1], minAmountPrecisionTargetCoin)

        inputAmount = YAmount
        ZAmount = util.precisionFloorRound(inputAmount + inputAmount * feeF, minAmountPrecisionTargetCoin)
      }

      var LPriceBuy = values[2]['BUY'][0]
      var LPriceSell = values[2]['SELL'][0]
      var LPriceAvg = util.precisionFloorRound((LPriceSell + LPriceBuy) / 2, minPricePrecisionSellCoin)
      var LPriceBest = priceStrategy == 0 ? LPriceAvg : priceStrategy == -1 ? LPriceSell : LPriceBuy
      //BUY
      var LPrice = util.precisionFloorRound(LPriceBest, minPricePrecisionSellCoin)
      var LAmount = util.precisionFloorRound((inputAmount * ZPrice + 2 * inputAmount * ZPrice * feeF + inputAmount * ZPrice * feeF * feeF), minAmountPrecisionBuyCoin)
      if (LAmount > values[2][1]) {
        LAmount = util.precisionFloorRound(values[2][1], minAmountPrecisionBuyCoin)

        inputAmount = util.precisionFloorRound(LAmount / (ZPrice + 2 * ZPrice * feeF + ZPrice * feeF * feeF), minAmountPrecisionTargetCoin)
        ZAmount = util.precisionFloorRound(inputAmount + inputAmount * feeF, minAmountPrecisionTargetCoin)
        YAmount = inputAmount
      }

      //@nhancv: Check min amount valid
      var checkMinAmount = isAmountValid(targetCoin, ZAmount) && isAmountValid(targetCoin, YAmount) && isAmountValid(buyCoin, LAmount)
      //@nhancv: Check condition
      var left = util.precisionCeilRound(feeF + 2 * ZPrice * LPrice * feeF + ZPrice * LPrice * feeF * feeF + ZPrice * LPrice, Math.min(minPricePrecisionBuyCoin, minPricePrecisionSellCoin))
      var right = util.precisionFloorRound(YPrice - YPrice * feeF, minPricePrecisionSellCoin)
      var change = util.precisionFloorRound((right / left - 1) * 100, 2)
      var condition = checkMinAmount && (left < right) && (change >= 0.01)

      var changeStr = `${change > 0 ? chalk.green.bold(change) : change < 0 ? chalk.red.bold(change) : change}%`
      var logMsg = `Trigger is ${condition ? chalk.green.bold('TRUE') : chalk.red.bold('FALSE')} - Change: ${changeStr}`
      log(logMsg)
      if (condition) {
        var step1 = requestOrderApi(host, pairZ, 'BUY', ZAmount, ZPrice)
        var step2 = requestOrderApi(host, pairY, 'SELL', YAmount, YPrice)
        var step3 = requestOrderApi(host, pairL, 'BUY', LAmount, LPrice)

        Promise.all([step1, step2, step3]).then(values => {
          try {
            //@nhancv: Log to file
            totalChange += change
            var dataLog = `<${targetCoin}> Change: ${change}% - ZChange: ${totalChange.toFixed(2)}%`
              + `\r\nBUY: ${pairZ} ${ZPrice} ${ZAmount} - ${values[0]}`
              + `\r\nSELL: ${pairY} ${YPrice} ${YAmount} - ${values[1]}`
              + `\r\nBUY: ${pairL} ${LPrice} ${LAmount} - ${values[2]}`
            logFile.log(dataLog)
            resolve()
          } catch (error) {
            reject(error)
          }
        })
      } else {
        resolve()
      }
    }, mapError)
      .catch(reject)
  })
}

/**
 * Main function
 * @param {*} index 
 */
function loop(index) {

  var targetCoin = targetPair[index].coin
  var inputAmount = targetPair[index].amount
  log(chalk.blue(`Execute pair: Coin ${chalk.yellow.bold(targetCoin)} - Amount ${inputAmount}`))

  const checkNextRun = () => {
    var nextIndex = index + 1
    var nextTimeout = 1000
    if (nextIndex == targetPair.length) {
      nextIndex = 0
      nextTimeout = 3000
      log(chalk.yellow('--------------------------------------'))
    }
    setTimeout(() => {
      loop(nextIndex)
    }, nextTimeout)
  }
  console.time('Estimate')
  trading(targetCoin, buyCoin, sellCoin, inputAmount, fee, mapBody, mapError)
    .then(() => {
      console.timeEnd('Estimate')
      checkNextRun()
    }, (error) => {
      print.error(error)
      console.timeEnd('Estimate')
      checkNextRun()
    })
}

//@nhancv: Run with process
const process = ({ publicKey, secretKey }) => {
  loop(0)
}

//@nhancv: Run with command
const run = (command) => {
  if (command.example) {
    log(require('./config.json'))
  } else {
    var customConfigPath = command.config
    if (customConfigPath) {
      //@nhancv: Get custom config from file
      if (files.fileExists(customConfigPath)) {
        var config = require(customConfigPath)
        targetPair = config.targetPair
        buyCoin = config.buyCoin
        sellCoin = config.sellCoin
        fee = config.fee
        priceStrategy = config.priceStrategy

        //@nhancv: Update log file name
        var configName = path.basename(customConfigPath)
        logFile.setLogName(`kucoin.${configName.substring(0, configName.lastIndexOf('.'))}.${moment().format('YYYYMMDD_HHmm')}.log`)

      } else {
        print.error('Config file is not found')
      }
    }
    //@nhancv: Run
    keyfile.gen(currentDir, command.key)
      .then(() => {
        process(require('./.apikey.json'))
      }, () => { })
  }
}

/**
 * EXPORT
 */
module.exports = {
  main: function (command) {
    try {
      run(command)
    } catch (err) {
      print.error(err)
    }
  }
}
