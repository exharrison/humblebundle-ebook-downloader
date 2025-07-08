#!/usr/bin/env node

const async = require('async')
const commander = require('commander')
const packageInfo = require('./package.json')
const Nightmare = require('nightmare')
const request = require('request')
const Breeze = require('breeze')
const Bottleneck = require('bottleneck')
const colors = require('colors')
const crypto = require('crypto')
const inquirer = require('inquirer')
const keypath = require('nasa-keypath')
const mkdirp = require('mkdirp')
const sanitizeFilename = require('sanitize-filename')
const url = require('url')
const util = require('util')
const path = require('path')
const fs = require('fs')
const os = require('os')
const userAgent = util.format('Humblebundle-Ebook-Downloader/%s', packageInfo.version)

const SUPPORTED_FORMATS = ['epub', 'mobi', 'pdf', 'pdf_hd', 'cbz']
const ALLOWED_FORMATS = SUPPORTED_FORMATS.concat(['all', 'any']).sort()
const PREFERRED_FORMATS = ['cbz', 'pdf_hd', 'pdf', 'epub', 'mobi']
var ORDERED_FORMATS = PREFERRED_FORMATS
var NUMBER_OF_BUNDLES = 0

/* Setup catalog objects and files to read from and write to */
/* Basic catalog */
var catalog_obj = {
  "Book Bundles": 0,
  "All Bundles": 0,
  bundles: []
};
var catalog_file_name = 'basic_catalog.json'
var catalog_path = './'
var catalog_file = catalog_path + catalog_file_name
let old_catalog_json;
try {
  old_catalog_json = require(catalog_file);
} catch (error) {
  old_catalog_json = { bundles: [] };
}

/* Detailed catalog */
var ext_catalog_obj = {
  "Book Bundles": 0,
  "All Bundles": 0,
  bundles: []
};
var ext_catalog_file_name = 'detailed_catalog.json'
var ext_catalog_path = './'
var ext_catalog_file = ext_catalog_path + ext_catalog_file_name
let old_ext_catalog_json;
try {
  old_ext_catalog_json = require(ext_catalog_file);
} catch (error) {
  old_ext_catalog_json = { bundles: [] };
}

/* Set up logging to file */
const today = new Date().toISOString()
const winston = require('winston');

// const csv_logger = new (winston.Logger)({
//   transports: [
//     new (winston.transports.File)({
//       filename: "audit.csv",
//       json: false,
//       formatter: csv_formatter
//     })
//   ]
// })

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.splat(),
    // winston.format.simple()
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'record.log' })
    // new (winston.transports.File)({
    //   filename: "audit.csv",
    //   json: false,
    //   formatter: csv_formatter
    // })
  ]
});
logger.info('Humble audit at %s', today);

const catalog = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.splat(),
    // winston.format.simple()
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'record.log' })
  ]
});
catalog.info('Humble audit at %s', today);


function order(val) {
  return val.split(',')
}

commander
  .version(packageInfo.version)
  .option('-d, --download-folder <downloader_folder>', 'Download folder', 'download')
  .option('-l, --download-limit <download_limit>', 'Parallel download limit', 1)
  .option('-f, --format <format>', util.format('What format to download the ebook in (%s)', ALLOWED_FORMATS.join(', ')), 'epub')
  .option('-o, --order <format>', util.format('What order to prefer ebooks in (%s)', PREFERRED_FORMATS.join(', ')), order)
  .option('--auth-token <auth-token>', 'Optional: If you want to run headless, you can specify your authentication cookie from your browser (_simpleauth_sess)')
  .option('-a, --all', 'Download all bundles')
  .option('-b, --bundles <number of bundles to download>', 'Download what is new to your downloads. This will download the first n bundles you have not yet downloaded.')
  .option('-r, --record', 'Record an audit of bundle information')
  .option('-c, --csv', 'Record the audit in csv format')
  .option('-j, --json', 'Record the audit in json format')
  .option('--debug', 'Enable debug logging', false)
  .parse(process.argv)

if (ALLOWED_FORMATS.indexOf(commander.format) === -1) {
  console.error(colors.red('Invalid format selected.'))
  commander.help()
}

if (commander.order) {
  commander.format = 'any'
  for (var format of commander.order) {
    if (PREFERRED_FORMATS.indexOf(format) === -1) {
      console.error(colors.red('Invalid format in ordered list.'))
      commander.help()
    }
  }
  ORDERED_FORMATS = commander.order
}

/* If this is running in this mode, the idea is to download all of the bundles
  in batches to mirror your collection locally. However, many people might have
  too many bundles to store locally. So this allows you to download them all 
  and store them over network storage or other off-computer storage. This will
  use the display bundle function to collect a json struct of all of the 
  bundles found online. Anything that has been recorded locally as downloaded
  will have the downloaded flag set to true. Then this will overload the
  downloadbundles function to download the next 'n' number of bundles and once
  that is completed, those bundles will have their flag set to true. Then at
  exit, the records will be written to disk.
*/
if (commander.bundles) {
  /* Set the number of bundles to download each run. */
  NUMBER_OF_BUNDLES=commander.bundles
}

const configPath = path.resolve(os.homedir(), '.humblebundle_ebook_downloader.json')
const flow = Breeze()
const limiter = new Bottleneck({ // Limit concurrent downloads
  maxConcurrent: commander.downloadLimit
})

console.log(colors.green('Starting...'))

function loadConfig (next) {
  fs.access(configPath, (error) => {
    if (error) {
      if (error.code === 'ENOENT') {
        return next(null, {})
      }

      return next(error)
    }

    var config

    try {
      config = require(configPath)
    } catch (ignore) {
      config = {}
    }

    next(null, config)
  })
}

function getRequestHeaders (session) {
  return {
    'Accept': 'application/json',
    'Accept-Charset': 'utf-8',
    'User-Agent': userAgent,
    'Cookie': '_simpleauth_sess=' + session + ';'
  }
}

function validateSession (next, config) {
  console.log('Validating session...')

  var session = config.session

  if (!commander.authToken) {
    if (!config.session || !config.expirationDate) {
      return next()
    }

    if (config.expirationDate < new Date()) {
      return next()
    }
  } else {
    session = util.format('"%s"', commander.authToken.replace(/^"|"$/g, ''))
  }

  request.get({
    url: 'https://www.humblebundle.com/api/v1/user/order?ajax=true',
    headers: getRequestHeaders(session),
    json: true
  }, (error, response) => {
    if (error) {
      return next(error)
    }

    if (response.statusCode === 200) {
      return next(null, session)
    }

    if (response.statusCode === 401 && !commander.authToken) {
      return next(null)
    }

    return next(new Error(util.format('Could not validate session, unknown error, status code:', response.statusCode)))
  })
}

function saveConfig (config, callback) {
  fs.writeFile(configPath, JSON.stringify(config, null, 4), 'utf8', callback)
}

function debug () {
  if (commander.debug) {
    console.log(colors.yellow('[DEBUG] ' + util.format.apply(this, arguments)))
  }
}

function authenticate (next) {
  console.log('Authenticating...')

  var nightmare = Nightmare({
    show: true,
    width: 800,
    height: 600
  })

  nightmare.useragent(userAgent)

  var handledRedirect = false

  function handleRedirect (targetUrl) {
    if (handledRedirect) {
      return
    }

    var parsedUrl = url.parse(targetUrl, true)

    if (parsedUrl.hostname !== 'www.humblebundle.com' || parsedUrl.path.indexOf('/home/library') === -1) {
      return
    }

    debug('Handled redirect for url %s', targetUrl)
    handledRedirect = true

    nightmare
      .cookies.get({
        secure: true,
        name: '_simpleauth_sess'
      })
      .then((sessionCookie) => {
        if (!sessionCookie) {
          return next(new Error('Could not get session cookie'))
        }

        nightmare._endNow()

        saveConfig({
          session: sessionCookie.value,
          expirationDate: new Date(sessionCookie.expirationDate * 1000)
        }, (error) => {
          if (error) {
            return next(error)
          }

          next(null, sessionCookie.value)
        })
      })
      .catch((error) => next(error))
  }

  nightmare.on('did-get-redirect-request', (event, sourceUrl, targetUrl, isMainFrame, responseCode, requestMethod) => {
    debug('did-get-redirect-request: %s %s', sourceUrl, targetUrl)
    handleRedirect(targetUrl)
  })

  nightmare.on('will-navigate', (event, targetUrl) => {
    debug('will-navigate: %s', targetUrl)
    handleRedirect(targetUrl)
  })

  nightmare
    .goto('https://www.humblebundle.com/login?goto=%2Fhome%2Flibrary')
    .then()
    .catch((error) => next(error))
}

function fetchOrders (next, session) {
  console.log('Fetching bundles...')

  request.get({
    url: 'https://www.humblebundle.com/api/v1/user/order?ajax=true',
    headers: getRequestHeaders(session),
    json: true
  }, (error, response) => {
    if (error) {
      return next(error)
    }

    if (response.statusCode !== 200) {
      return next(new Error(util.format('Could not fetch orders, unknown error, status code:', response.statusCode)))
    }

    var total = response.body.length
    var done = 0

    catalog_obj['All Bundles']=ext_catalog_obj['All Bundles'] = total
    var orderInfoLimiter = new Bottleneck({
      maxConcurrent: 5,
      minTime: 500
    })

    async.concat(response.body, (item, next) => {
      orderInfoLimiter.submit((next) => {
        request.get({
          url: util.format('https://www.humblebundle.com/api/v1/order/%s?ajax=true', item.gamekey),
          headers: getRequestHeaders(session),
          json: true
        }, (error, response) => {
          if (error) {
            return next(error)
          }

          if (response.statusCode !== 200) {
            return next(new Error(util.format('Could not fetch orders, unknown error, status code:', response.statusCode)))
          }

          console.log('Fetched bundle information... (%s/%s)', colors.yellow(++done), colors.yellow(total))
          next(null, response.body)
        })
      }, next)
    }, (error, orders) => {
      if (error) {
        return next(error)
      }

      var filteredOrders = orders.filter((order) => {
        return flatten(keypath.get(order, 'subproducts.[].downloads.[].platform')).indexOf('ebook') !== -1
      })

      next(null, filteredOrders, session)
    })
  })
}

function getWindowHeight () {
  var windowSize = process.stdout.getWindowSize()
  return windowSize[windowSize.length - 1]
}

function displayOrders (next, orders) {
  var options = []

  for (var order of orders) {
    options.push(order.product.human_name)
  }

  catalog_obj['Book Bundles']=ext_catalog_obj['Book Bundles']=orders.length
  /* Generate the updated basic catalog here */
  for (var order of orders) {
    // Find matching entry in old catalog
    const oldEntry = old_catalog_json.bundles.find(entry => 
      entry.gamekey === order.gamekey || 
      entry.uid === order.uid || 
      entry.machine_name === order.product.machine_name
    );

    catalog_obj.bundles.push({
      "human_name": order.product.human_name,
      "machine_name": order.product.machine_name,
      "amount_spent": order.amount_spent,
      "total": order.total,
      "purchase date": order.created,
      "gamekey": order.gamekey,
      "Number of books": order.subproducts.length,
      "uid": order.uid,
      "url": order.url,
      "downloaded": oldEntry ? oldEntry.downloaded : false
    });
  }
  
  /* This will be the extended catalog with the books for each bundle */
  /* Generate the updated catalog here */
  for (var order of orders) {
    // Find matching entry in old catalog
    const oldEntry = old_ext_catalog_json.bundles.find(entry => 
      entry.gamekey === order.gamekey || 
      entry.uid === order.uid || 
      entry.machine_name === order.product.machine_name
    );

    var books_obj = {
      books: []
    }
    for (var subproduct of order.subproducts) {
      var formats = []
      var filteredDownloads = subproduct.downloads.filter((download) => {
        return download.platform === 'ebook'
      })
      var downloadStructs = flatten(keypath.get(filteredDownloads, '[].download_struct'))
      var filteredDownloadStructs = downloadStructs.filter((download) => {
        if (!download.name || !download.url) {
          return false
        }

        var normalizedFormat = normalizeFormat(download.name)
        if (formats.indexOf(normalizedFormat) === -1) {
          // Create format object directly
          var formatDetails = {
            format: normalizedFormat,
            size: download.human_size,
            download_urls: {}
          };
          
          // Add available download URLs
          if (download.url) {
            if (download.url.web) {
              formatDetails.download_urls.web = download.url.web;
            }
            if (download.url.bittorrent) {
              formatDetails.download_urls.bittorrent = download.url.bittorrent;
            }
          }
          
          formats.push(formatDetails)
        }
      })

      books_obj.books.push({
        "Book Title": subproduct.human_name,
        "Machine Name": subproduct.machine_name,
        "Publisher": subproduct.payee.human_name,
        "Available Formats": formats,
        "icon": subproduct.icon,
        "url": subproduct.url
      })
    }

    ext_catalog_obj.bundles.push({
      "human_name": order.product.human_name,
      "machine_name": order.product.machine_name,
      "amount_spent": order.amount_spent,
      "total": order.total,
      "purchase date": order.created,
      "gamekey": order.gamekey,
      "Number of books": order.subproducts.length,
      "uid": order.uid,
      "url": order.url,
      "downloaded": oldEntry ? oldEntry.downloaded : false,
      "books": books_obj.books
    });
  }

  options.sort((a, b) => {
    return a.localeCompare(b)
  })

  process.stdout.write('\x1Bc') // Clear console

  if (commander.bundles) {
    // Find first N undownloaded bundles
    var undownloadedBundles = orders.filter(order => {
      const oldEntry = catalog_obj.bundles.find(entry => 
        entry.gamekey === order.gamekey || 
        entry.uid === order.uid || 
        entry.machine_name === order.product.machine_name
      );
      return !oldEntry || !oldEntry.downloaded;
    }).slice(0, NUMBER_OF_BUNDLES);

    // Update the orders array to only include the undownloaded bundles
    orders = undownloadedBundles;
    
    // Continue with download process
    next(null, orders);
  }
  else {
    inquirer.prompt({
      type: 'checkbox',
      name: 'bundle',
      message: 'Select bundles to download',
      choices: options,
      pageSize: getWindowHeight() - 2
    }).then((answers) => {
      next(null, orders.filter((item) => {
        return answers.bundle.indexOf(item.product.human_name) !== -1
      }))
    })
  }
}


function sortBundles (next, bundles) {
  next(null, bundles.sort((a, b) => {
    return a.product.human_name.localeCompare(b.product.human_name)
  }))
}

function flatten (list) {
  return list.reduce((a, b) => a.concat(Array.isArray(b) ? flatten(b) : b), [])
}

function ensureFolderCreated (folder, callback) {
  fs.access(folder, (error) => {
    if (error && error.code !== 'ENOENT') {
      return callback(error)
    }

    mkdirp(folder).then(made => {
      callback()
    }).catch(error => {
      callback(error)
    })
  })
}

function normalizeFormat (format) {
  switch (format.toLowerCase()) {
    case '.cbz':
      return 'cbz'
    case 'pdf (hq)':
    case 'pdf (hd)':
      return 'pdf_hd'
    case 'download':
      return 'pdf'
    default:
      return format.toLowerCase()
  }
}

function getExtension (format) {
  switch (format.toLowerCase()) {
    case 'pdf_hd':
      return ' (hd).pdf'
    default:
      return util.format('.%s', format)
  }
}

function checkSignatureMatch (filePath, download, callback) {
  fs.access(filePath, (error) => {
    if (error) {
      if (error.code === 'ENOENT') {
        return callback()
      }

      return callback(error)
    }

    var hashType = download.sha1 ? 'sha1' : 'md5'
    var hashToVerify = download[hashType]

    var hash = crypto.createHash(hashType)
    hash.setEncoding('hex')

    var stream = fs.createReadStream(filePath)

    stream.on('error', (error) => {
      return callback(error)
    })

    stream.on('end', () => {
      hash.end()

      return callback(null, hash.read() === hashToVerify)
    })

    stream.pipe(hash)
  })
}

function downloadBook (bundle, name, download, callback) {
  var downloadPath = path.resolve(commander.downloadFolder, sanitizeFilename(bundle))

  ensureFolderCreated(downloadPath, (error) => {
    if (error) {
      return callback(error)
    }

    var fileName = util.format('%s%s', name.trim(), getExtension(normalizeFormat(download.name)))
    var filePath = path.resolve(downloadPath, sanitizeFilename(fileName))

    checkSignatureMatch(filePath, download, (error, matches) => {
      if (error) {
        return callback(error)
      }

      if (matches) {
        return callback(null, true)
      }

      var file = fs.createWriteStream(filePath)

      file.on('finish', () => {
        file.close(() => {
          callback()
        })
      })

      request.get({
        url: download.url.web
      }).on('error', (error) => {
        callback(error)
      }).pipe(file)
    })
  })
}

function recordBundles (next, bundles) {
  if (!bundles.length) {
    logger.info(colors.green('No bundles selected, exiting'))
    return next()
  }

  var downloads = []

  for (var bundle of bundles) {
    var bundleName = bundle.product.human_name
    var bundleDownloads = []
    var bundleFormats = []

    if (commander.csv) {
      logger.info('%s', JSON.stringify(bundleName))
    } else if (commander.json) {
      logger.info('{"Bundle Title":%s}', JSON.stringify(bundleName))
    } else {
      logger.info('Bundle Title: [%s]', JSON.stringify(bundleName))
    }

    for (var subproduct of bundle.subproducts) {
      var filteredDownloads = subproduct.downloads.filter((download) => {
        return download.platform === 'ebook'
      })

      var downloadStructs = flatten(keypath.get(filteredDownloads, '[].download_struct'))
      var filteredDownloadStructs = downloadStructs.filter((download) => {
        if (!download.name || !download.url) {
          return false
        }

        var normalizedFormat = normalizeFormat(download.name)
        
        // Debug to see the formats found
        //console.log(normalizedFormat)
        if (bundleFormats.indexOf(normalizedFormat) === -1 && SUPPORTED_FORMATS.indexOf(normalizedFormat) !== -1) {
          bundleFormats.push(normalizedFormat)
        }

        return commander.format === 'all' || commander.format === 'any' || normalizedFormat === commander.format
      })

      var bestIndex = 10
      for (var filteredDownload of filteredDownloadStructs) {
        // This is where we pick the format we want
        var index
        var tempBundles = []
        
        if (commander.format === 'any') {
          // Now we check where the format sits on the list of preference
          var normalizedFormat = normalizeFormat(filteredDownload.name)
          index = ORDERED_FORMATS.indexOf(normalizedFormat)
          if (index < bestIndex) {
            if (bestIndex < 10) {
              bundleDownloads.pop()
            }
            bestIndex = index
            bundleDownloads.push({
              bundle: bundleName,
              download: filteredDownload,
              name: subproduct.human_name
            })
          }
        }
        else {
          bundleDownloads.push({
            bundle: bundleName,
            download: filteredDownload,
            name: subproduct.human_name
          })
        }
                /*
        if (commander.format === 'all') {
          var normalizedFormat = normalizeFormat(filteredDownload.name)
          bundleDownloads.push({
            bundle: bundleName,
            download: filteredDownload,
            name: subproduct.human_name
          })
        } */
      }
    }

    if (!bundleDownloads.length) {
      logger.error(colors.red('No downloads found matching the right format (%s) for bundle (%s), available formats: (%s)'), commander.format, bundleName, bundleFormats.sort().join(', '))
      continue
    }

    for (var download of bundleDownloads) {
      downloads.push(download)
    }
  }

  if (!downloads.length) {
    logger.error(colors.red('No downloads found matching the right format (%s), exiting'), commander.format)
  }

  async.each(downloads, (download, next) => {
    limiter.submit((next) => {
      if(commander.csv) {
        logger.info('%s, %s, %s, %s, %s', 
          JSON.stringify(download.bundle), 
          JSON.stringify(download.name),
          JSON.stringify(download.download.name), 
          JSON.stringify(download.download.human_size), 
          JSON.stringify(downloads.indexOf(download) + 1)
        )
      } else if(commander.json) {
        logger.info('{"Bundle":%s,"Title":%s,"Format":%s,"Size":%s,"Index":%s}', 
          JSON.stringify(download.bundle), 
          JSON.stringify(download.name),
          JSON.stringify(download.download.name), 
          JSON.stringify(download.download.human_size), 
          JSON.stringify(downloads.indexOf(download) + 1)
        )
      } else {
        logger.info('Book: %s - %s (%s) (%s)... (%s/%s)', 
          JSON.stringify(download.bundle), 
          JSON.stringify(download.name),
          JSON.stringify(download.download.name), 
          JSON.stringify(download.download.human_size), 
          JSON.stringify(downloads.indexOf(download) + 1),
          JSON.stringify(downloads.length))
      }
      next()
      /* downloadBook(download.bundle, download.name, download.download, (error, skipped) => {
        if (error) {
          return next(error)
        }

        if (skipped) {
          console.log('Skipped downloading of %s - %s (%s) (%s) - already exists... (%s/%s)', download.bundle, download.name, download.download.name, download.download.human_size, colors.yellow(downloads.indexOf(download) + 1), colors.yellow(downloads.length))
        }

        next()
      }) */
    }, next)
  }, (error) => {
    if (error) {
      return next(error)
    }

    logger.info('Done')
    next()
  })
}

function downloadBundles (next, bundles) {
  if (!bundles.length) {
    console.log(colors.green('No bundles selected, exiting'))
    return next()
  }

  var downloads = []
  var downloadedBundles = new Set() // Track which bundles were successfully downloaded

  for (var bundle of bundles) {
    var bundleName = bundle.product.human_name
    var bundleDownloads = []
    var bundleFormats = []

    for (var subproduct of bundle.subproducts) {
      var filteredDownloads = subproduct.downloads.filter((download) => {
        return download.platform === 'ebook'
      })

      var downloadStructs = flatten(keypath.get(filteredDownloads, '[].download_struct'))
      var filteredDownloadStructs = downloadStructs.filter((download) => {
        if (!download.name || !download.url) {
          return false
        }

        var normalizedFormat = normalizeFormat(download.name)

        if (bundleFormats.indexOf(normalizedFormat) === -1 && SUPPORTED_FORMATS.indexOf(normalizedFormat) !== -1) {
          bundleFormats.push(normalizedFormat)
        }

        return commander.format === 'all' || commander.format === 'any' || normalizedFormat === commander.format
      })

      var bestIndex = 10
      for (var filteredDownload of filteredDownloadStructs) {
        // This is where we pick the format we want
        var index
        var tempBundles = []
        if (commander.format === 'any') {
          // Now we check where the format sits on the list of preference
          var normalizedFormat = normalizeFormat(filteredDownload.name)
          index = ORDERED_FORMATS.indexOf(normalizedFormat)
          if (index < bestIndex) {
            if (bestIndex < 10) {
              bundleDownloads.pop()
            }
            bestIndex = index
            bundleDownloads.push({
              bundle: bundleName,
              download: filteredDownload,
              name: subproduct.human_name
            })
          }

        }
      }
    }

    if (!bundleDownloads.length) {
      console.log(colors.red('No downloads found matching the right format (%s) for bundle (%s), available formats: (%s)'), commander.format, bundleName, bundleFormats.sort().join(', '))
      continue
    }

    for (var download of bundleDownloads) {
      downloads.push(download)
    }
  }

  if (!downloads.length) {
    console.log(colors.red('No downloads found matching the right format (%s), exiting'), commander.format)
  }

  async.each(downloads, (download, next) => {
    limiter.submit((next) => {
      console.log('Downloading %s - %s (%s) (%s)... (%s/%s)', download.bundle, download.name, download.download.name, download.download.human_size, colors.yellow(downloads.indexOf(download) + 1), colors.yellow(downloads.length))
      downloadBook(download.bundle, download.name, download.download, (error, skipped) => {
        if (error) {
          return next(error)
        }

        if (skipped) {
          console.log('Skipped downloading of %s - %s (%s) (%s) - already exists... (%s/%s)', download.bundle, download.name, download.download.name, download.download.human_size, colors.yellow(downloads.indexOf(download) + 1), colors.yellow(downloads.length))
        }

        // Mark this bundle as downloaded if it was successful
        downloadedBundles.add(download.bundle)
        next()
      })
    }, next)
  }, (error) => {
    if (error) {
      return next(error)
    }

    // Only mark bundles as downloaded if they were successfully downloaded
    for (var bundle of catalog_obj.bundles) {
      if (downloadedBundles.has(bundle.human_name)) {
        bundle.downloaded = true
      }
    }

    // Also update the extended catalog
    for (var bundle of ext_catalog_obj.bundles) {
      if (downloadedBundles.has(bundle.human_name)) {
        bundle.downloaded = true
      }
    }

    console.log(colors.green('Done'))
    next()
  })
}

function storeCatalog (next) {
  var json = JSON.stringify(catalog_obj, null, 2);
  var fs = require('fs');
  fs.writeFile(catalog_file, json, (err) => {
    if (err) {
      console.error('Error writing to file:', err);
    } else {
      console.log('File written successfully!');
    }
  });
  var json = JSON.stringify(ext_catalog_obj, null, 2);
  var fs = require('fs');
  fs.writeFile(ext_catalog_file, json, (err) => {
    if (err) {
      console.error('Error writing to file:', err);
    } else {
      console.log('File written successfully!');
    }
  });
  next()
}

flow.then(loadConfig)
flow.then(validateSession)
flow.when((session) => !session, authenticate)
flow.then(fetchOrders)
flow.when(!commander.all, displayOrders)
flow.when(commander.all, sortBundles)
flow.when(commander.record, recordBundles)
flow.when(!commander.record, downloadBundles)
flow.when(commander.bundles, storeCatalog)

flow.catch((error) => {
  console.error(colors.red('An error occured, exiting.'))
  console.error(error)
  process.exit(1)
})
