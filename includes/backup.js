const async = require('async');
const events = require('events');
const request = require('request');
const fs = require('fs');
const spoolchanges = require('./spoolchanges.js');
const logfilesummary = require('./logfilesummary.js');
const logfilegetbatches = require('./logfilegetbatches.js');

// process data in batches
var processBatches = function(dbUrl, parallelism, log, batches, ee, start, grandtotal, callback) {
  var total = grandtotal;

  // queue to process the fetch requests in an orderly fashion using _bulk_get
  var q = async.queue(function(payload, done) {
    var output = [];
    var thisBatch = payload.batch;
    delete payload.batch;

    // do the /db/_bulk_get request
    var r = {
      url: dbUrl + '/_bulk_get',
      qs: { revs: true }, // gets previous revision tokens too
      method: 'post',
      json: true,
      body: payload
    };
    request(r, function(err, res, data) {
      if (!err && data && data.results) {
        // create an output array with the docs returned
        data.results.forEach(function(d) {
          if (d.docs) {
            d.docs.forEach(function(doc) {
              if (doc.ok) {
                output.push(doc.ok);
              }
            });
          }
        });
        total += output.length;
        var t = (new Date().getTime() - start) / 1000;
        ee.emit('written', {length: output.length, time: t, total: total, data: output, batch: thisBatch});
        if (log) {
          fs.appendFile(log, ':d batch' + thisBatch + '\n', done);
        } else {
          done();
        }
      } else {
        ee.emit('writeerror', err);
        done();
      }
    });
  }, parallelism);

  for (var i in batches) {
    q.push(batches[i]);
  }

  q.drain = function() {
    callback(null, {total: total});
  };
};

// backup function
module.exports = function(dbUrl, blocksize, parallelism, log, resume) {
  if (typeof blocksize === 'string') {
    blocksize = parseInt(blocksize);
  }
  const ee = new events.EventEmitter();
  const start = new Date().getTime();
  const maxbatches = 50;
  var total = 0;

  // read the changes feed and write it to our log file
  spoolchanges(dbUrl, log, resume, blocksize, function(err, data) {
    // no point continuing if we have no docs
    if (err) {
      return ee.emit('writeerror', err);
    }

    var finished = false;
    async.doUntil(function(done) {
      logfilesummary(log, function(err, summary) {
        if (!summary.changesComplete) {
          ee.emit('writeerror', 'WARNING: Changes did not finish spooling');
        }
        if (Object.keys(summary.batches).length === 0) {
          finished = true;
          return done();
        }

        // decide which batch numbers to deal with
        var batchestofetch = [];
        var j = 0;
        for (var i in summary.batches) {
          batchestofetch.push(parseInt(i));
          j++;
          if (j >= maxbatches) break;
        }

        // fetch the batch data from file
        logfilegetbatches(log, batchestofetch, function(err, batches) {
          // process them in parallelised queue
          processBatches(dbUrl, parallelism, log, batches, ee, start, total, function(err, data) {
            total = data.total;
            done();
          });
        });
      });
    }, function() {
      // repeat until finished
      return finished;
    }, function() {
      ee.emit('writecomplete', {total: total});
    });
  });

  return ee;
};
