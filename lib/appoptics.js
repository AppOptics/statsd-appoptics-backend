'use strict'
/*
 * Flushes stats to AppOptics Metrics (https://my.appoptics.com).
 *
 * To enable this backend, include 'statsd-appoptics-backend' in the
 * backends configuration array:
 *
 *   backends: ['statsd-appoptics-backend']
 *
 * The backend will read the configuration options from the main
 * statsd configuration file under the sub-hash key 'appoptics'. See the
 * README in this repository for available configuration options.
 */

/* eslint-disable no-var */

const os = require('os');
const path = require('path');

var util = require('util');
var urlParse = require('url').parse;
var https = require('https');
var http = require('http');
var fs = require('fs');

var tunnelAgent = null;
var logAll;

let cfg;             // the appoptics property in the config file.
var api;
var token;
var sourceName;
var hostName;
var sourceRegex;
var includeMetrics;
var excludeMetrics;
// How long to wait before retrying a failed post, in seconds
var retryDelaySecs = 5;
// Timeout for POSTs, in seconds
var postTimeoutSecs = 4;
var appopticsStats = {};
var userAgent;
var basicAuthHeader;
var flushInterval;
// Maximum measurements we send in a single post
var maxBatchSize = 500;
// What epoch interval to align time stamps to (defaults to flush interval)
var snapTime = null;
// Counters as pushed as gauge increments.
var countersAsGauges = true;
// Do we skip publishing internal statsd metrics.
//
var skipInternalMetrics = true;
// Statsd counters reset, we want monotonically increasing
// counters.
var appopticsCounters = {};
// Do we always suffix 100 percentile with .100
// e.g. metric_name.100
var alwaysSuffixPercentile = false;
// A string to prepend to all measurement names sent to AppOptics.
var globalPrefix = '';
// AppOptics web service can't ignore individual broken metrics
// instead it's dropping whole payloads
// So we place such metrics to stoplist
var brokenMetrics = {};
// Global Measurement tags
var tags = {};
// Write to legacy
var postPayload = function (options, proto, payload, retry) {
  if (logAll) {
    util.log('Sending Payload: ' + payload);
  }
  var req = proto.request(options, function (res) {
    res.on('data', function (d) {
      if (logAll) {
        util.log('Response: ' + d);
      }
      // Retry 5xx codes
      if (Math.floor(res.statusCode / 100) == 5) {
        const errdata = 'HTTP ' + res.statusCode + ': ' + d;
        if (retry) {
          if (logAll) {
            util.log('Failed to post to AppOptics: ' + errdata, 'LOG_ERR');
          }
          setTimeout(function () {
            postPayload(options, proto, payload, false);
          }, retryDelaySecs * 1000);
        } else {
          util.log('Failed to connect to AppOptics: ' + errdata, 'LOG_ERR');
        }
      }
      // Log 4xx errors
      if (Math.floor(res.statusCode / 100) == 4) {
        const errdata = 'HTTP ' + res.statusCode + ': ' + d;
        if (logAll) {
          util.log('Failed to post to AppOptics: ' + errdata, 'LOG_ERR');
        }
        if (/^application\/json/.test(res.headers['content-type'])) {
          var meta = JSON.parse(d);
          var re = /'([^']+)' is a \S+, but was submitted as different type/;
          // eslint-disable-next-line max-len
          if (meta.errors && meta.errors.params && meta.errors.params.type && meta.errors.params.type.length) {
            var fields = meta.errors.params.type;
            for (var i = 0; i < fields.length; i++) {
              var match = re.exec(fields[i]);
              var field = match && match[1];
              if (field && !brokenMetrics[field]) {
                brokenMetrics[field] = true;
                if (logAll) {
                  util.log('Placing metric \'' + field + '\' to stoplist until service restart', 'LOG_ERR');
                }
              }
            }
          }
        }
      }
    });
  });
  req.setTimeout(postTimeoutSecs * 1000, function (request) {
    if (logAll) {
      util.log('Timed out sending metrics to AppOptics', 'LOG_ERR');
    }
    req.end();
  });
  req.write(payload);
  req.end();
  appopticsStats.last_flush = Math.round(new Date().getTime() / 1000);
  req.on('error', function (errdata) {
    if (retry) {
      setTimeout(function () {
        postPayload(options, proto, payload, false);
      }, retryDelaySecs * 1000);
    } else {
      util.log('Failed to connect to AppOptics: ' + errdata, 'LOG_ERR');
    }
  });
};
var postMetrics = function (ts, gauges, counters, measurements) {
  var payload = {};
  var parsedHost = urlParse(api || 'https://api.appoptics.com');
  var path = '/v1/measurements';
  payload = {
    time: ts,
    tags: tags,
    measurements: measurements,
  };
  payload = JSON.stringify(payload);
  var options = {
    host: parsedHost.hostname,
    port: parsedHost.port || 443,
    path: path,
    method: 'POST',
    headers: {
      'Authorization': basicAuthHeader,
      'Content-Length': payload.length,
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
    },
  };
  if (tunnelAgent) {
    options.agent = tunnelAgent;
  }
  var proto = http;
  if ((parsedHost.protocol || 'http:').match(/https/)) {
    proto = https;
  }
  postPayload(options, proto, payload, true);
};
var sanitizeName = function (name) {
  return name.replace(/[^-.:_\w]+/g, '_').substr(0, 255);
};
var timerGaugePct = function (timerName, values, pct, suffix) {
  var thresholdIndex = Math.round((100 - pct) / 100 * values.length);
  var numInThreshold = values.length - thresholdIndex;
  if (numInThreshold <= 0) {
    return null;
  }
  var max = values[numInThreshold - 1];
  var min = values[0];
  var sum = values.slice(0, numInThreshold).reduce(function (s, current) {
    return s + current;
  }, 0);

  // calculate sample standard deviation if count > 1
  var stddev = 0;
  if (numInThreshold > 1) {
    var sampleAvg = sum / numInThreshold;
    var sampleSquareDiff = values.slice(0, numInThreshold).map(function (v) {
      var diff = v - sampleAvg;
      return diff * diff;
    });
    var sampleSquareDiffSum = sampleSquareDiff.reduce(function (sum, v) {
      return sum + v;
    });
    var sampleSquareDiffAvg = sampleSquareDiffSum / (numInThreshold - 1);
    stddev = Math.sqrt(sampleSquareDiffAvg);
  }
  var names = timerName.split('#');
  var name;
  if (names.length > 1) {
    // We have tags in the timer name i.e. foo#bar=1,baz=2
    // Take the name before the # so we don't screw up the tag values with the percentile suffix
    name = names[0];
  } else {
    // No tags exist in the timer name
    name = timerName;
  }
  if (suffix) {
    name += suffix;
  }
  // Rejoin everything back together if we had tags
  if (names.length > 1) {
    names[0] = name + '#';
    name = names.join();
  }
  return {
    name: name,
    count: numInThreshold,
    sum: sum,
    min: min,
    stddev_m2: stddev,
    max: max,
  };
};
var flushStats = function appopticsFlush (ts, metrics) {
  var numStats = 0;
  var statCount;
  var key;
  // AppOptics SD Metrics
  var counters = [];
  var gauges = [];
  // AppOptics MD Metrics
  var measurements = [];
  var measureTime = ts;
  var internalStatsdRe = /^statsd\./;
  if (snapTime) {
    measureTime = Math.floor(ts / snapTime) * snapTime;
  }
  var excludeMetric = function (metric) {
    var matchesFilter = false;
    for (let index = 0; index < includeMetrics.length; index++) {
      if (includeMetrics[index].test(metric)) {
        matchesFilter = true;
        break;
      }
    }
    var matchesExclude = false;
    for (let index = 0; index < excludeMetrics.length; index++) {
      if (excludeMetrics[index].test(metric)) {
        matchesExclude = true;
        break;
      }
    }
    return includeMetrics.length > 0 && !matchesFilter || matchesExclude;
  };
  var addMeasure = function addMeasure (mType, measure, countStat) {
    countStat = typeof countStat !== 'undefined' ? countStat : true;
    var match;
    var measureName = measure.name;
    measure.tags = {};
    measureName = parseAndSetTags(measureName, measure);

    if (cfg.mergeGlobalTags) {
      measure.tags = Object.assign({}, tags, measure.tags);
    }
    // Use first capturing group as source name.
    // NOTE: Only legacy users will a) have a source and b) have a source set by regex
    if (sourceRegex && (match = measureName.match(sourceRegex)) && match[1]) {
      measure.source = sanitizeName(match[1]);
      // Remove entire matching string from the measure name, add global prefix and sanitize the final measure name.
      // eslint-disable-next-line max-len
      measure.name = sanitizeName(globalPrefix + measureName.slice(0, match.index) + measureName.slice(match.index + match[0].length));
      // Create a measurement-level tag named source
      measure.tags.source = measure.source;
    } else {
      // add global prefix and sanitize the final measure name.
      measure.name = sanitizeName(globalPrefix + measureName);
      // Use the global config sourceName as a source tag, if it exists.
      if (sourceName !== null) {
        measure.tags.source = sourceName;
      }
    }

    if (brokenMetrics[measure.name]) {
      return;
    }

    delete measure.source;
    // Add the payload
    measurements.push(measure);
    // Post measurements and clear arrays if past batch size
    if (measurements.length >= maxBatchSize) {
      postMetrics(measureTime, gauges, counters, measurements);
      if (measurements.length >= maxBatchSize) {
        measurements = [];
      }
      if (counters.length + gauges.length >= maxBatchSize) {
        gauges = [];
        counters = [];
      }
    }
  };
  var parseAndSetTags = function (measureName, measure) {
    // Valid format for parsing tags out: global-prefix.name#tag1=value,tag2=value
    // NOTE: Name can include the source
    var vals = measureName.split('#');
    if (vals.length > 1) {
      // Found tags in the measureName. Parse them out and return the measureName without the tags.
      measureName = vals.shift();
      const rawTags = vals.pop().split(',');
      rawTags.forEach(function (rawTag) {
        var name = rawTag.split('=').shift();
        var value = rawTag.split('=').pop();
        if (name.length && value.length) {
          measure.tags[name] = value;
        }
      });
      return measureName;
    } else {
      // No tags existed in the measureName
      return measureName;
    }
  };
  for (key in metrics.counters) {
    if (skipInternalMetrics && key.match(internalStatsdRe) != null) {
      continue;
    }
    if (excludeMetric(key)) {
      continue;
    }
    if (countersAsGauges) {
      addMeasure('gauge', {
        name: key,
        value: metrics.counters[key],
      });
      continue;
    }
    if (!appopticsCounters[key]) {
      appopticsCounters[key] = {
        value: metrics.counters[key],
        lastUpdate: ts,
      };
    } else {
      appopticsCounters[key].value += metrics.counters[key];
      appopticsCounters[key].lastUpdate = ts;
    }
    addMeasure('counter', {
      name: key,
      value: appopticsCounters[key].value,
    });
  }
  for (key in metrics.timers) {
    if (metrics.timers[key].length == 0) {
      continue;
    }
    if (skipInternalMetrics && key.match(internalStatsdRe) != null) {
      continue;
    }
    if (excludeMetric(key)) {
      continue;
    }
    // already sorted by statsd
    var sortedVals = metrics.timers[key];
    // First build the 100% percentile
    var gauge = timerGaugePct(key, sortedVals, 100, alwaysSuffixPercentile ? '.100' : null);
    if (gauge) {
      addMeasure('gauge', gauge);
    }
    // Now for each percentile
    var pKey;
    for (pKey in metrics.pctThreshold) {
      var pct = metrics.pctThreshold[pKey];
      gauge = timerGaugePct(key, sortedVals, pct, '.' + pct);
      if (gauge) {
        // Percentiles are not counted in numStats
        addMeasure('gauge', gauge, false);
      }
    }
    var timerData = metrics.timer_data[key];
    if (timerData != null) {
      var histogram = timerData.histogram;
      if (histogram != null) {
        var bin;
        for (bin in histogram) {
          var name = key + '.' + bin;
          // Bins are not counted in numStats
          addMeasure('gauge', {
            name: name,
            value: histogram[bin],
          }, false);
        }
      }
    }
  }
  for (key in metrics.gauges) {
    if (skipInternalMetrics && key.match(internalStatsdRe) != null) {
      continue;
    }
    if (excludeMetric(key)) {
      continue;
    }
    addMeasure('gauge', {
      name: key,
      value: metrics.gauges[key],
    });
  }
  for (key in metrics.sets) {
    if (skipInternalMetrics && key.match(internalStatsdRe) != null) {
      continue;
    }
    addMeasure('gauge', {
      name: key,
      value: metrics.sets[key].values().length,
    });
  }
  statCount = numStats;
  if (!skipInternalMetrics) {
    if (countersAsGauges) {
      addMeasure('gauge', {
        name: 'numStats',
        value: statCount,
      });
    } else {
      if (appopticsCounters.numStats) {
        appopticsCounters.numStats.value += statCount;
        appopticsCounters.numStats.lastUpdate = ts;
      } else {
        appopticsCounters.numStats = {
          value: statCount,
          lastUpdate: ts,
        };
      }
      addMeasure('counter', {
        name: 'numStats',
        value: appopticsCounters.numStats.value,
      });
    }
  }
  if (gauges.length > 0 || counters.length > 0 || measurements.length > 0) {
    postMetrics(measureTime, gauges, counters, measurements);
  }
};
var backendStatus = function appopticsStatus (writeCb) {
  for (const stat in appopticsStats) {
    writeCb(null, 'appoptics', stat, appopticsStats[stat]);
  }
};
var buildBasicAuth = function (token) {
  return 'Basic ' + new Buffer(token + ':').toString('base64');
};
var buildUserAgent = function () {
  var str;
  var version = 'unknown';
  try {
    str = fs.readFileSync(path.join(__dirname, '/../package.json'), 'UTF-8');
    const json = JSON.parse(str);
    version = json.version;
  } catch (e) {
    if (logAll) {
      util.log(e);
    }
  }
  return 'statsd-appoptics-backend/' + version;
};
var convertStringToRegex = function (stringRegex) {
  // XXX: Converting to Regexp will add another enclosing '//'
  if (stringRegex.length > 2 && stringRegex[0] == '/' && stringRegex[stringRegex.length - 1] == '/') {
    return new RegExp(stringRegex.slice(1, stringRegex.length - 1));
  } else {
    return new RegExp(stringRegex);
  }
};
exports.init = function appopticsInit (startupTime, config, events, logger) {
  logAll = config.debug;
  if (typeof logger !== 'undefined') {
    util = logger;
  }
  // Config options are nested under the top-level 'appoptics' hash
  if (config.appoptics) {
    cfg = config.appoptics;
    api = config.appoptics.api;
    token = config.appoptics.token;
    sourceName = config.appoptics.source;
    hostName = 'host' in cfg ? cfg.host : os.hostname();
    sourceRegex = config.appoptics.sourceRegex;
    snapTime = config.appoptics.snapTime;
    includeMetrics = config.appoptics.includeMetrics;
    excludeMetrics = config.appoptics.excludeMetrics;
    // Handle the sourceRegex as a string
    if (typeof sourceRegex == 'string') {
      sourceRegex = convertStringToRegex(sourceRegex);
    }
    if (!Array.isArray(includeMetrics)) {
      includeMetrics = [];
    }
    for (let index = 0; index < includeMetrics.length; index++) {
      if (typeof includeMetrics[index] == 'string') {
        includeMetrics[index] = convertStringToRegex(includeMetrics[index]);
      }
    }
    if (!Array.isArray(excludeMetrics)) {
      excludeMetrics = [];
    }
    for (let index = 0; index < excludeMetrics.length; index++) {
      if (typeof excludeMetrics[index] == 'string') {
        excludeMetrics[index] = convertStringToRegex(excludeMetrics[index]);
      }
    }
    if (config.appoptics.countersAsGauges != null) {
      countersAsGauges = config.appoptics.countersAsGauges;
    }
    if (config.appoptics.skipInternalMetrics != null) {
      skipInternalMetrics = config.appoptics.skipInternalMetrics;
    }
    if (config.appoptics.proxy && config.appoptics.proxy.uri) {
      var TunnelFunc;
      try {
        TunnelFunc = require('https-proxy-agent');
      } catch (e) {
        util.log('Cannot find module \'https-proxy-agent\'.', 'LOG_CRIT');
        util.log('Make sure to run `npm install https-proxy-agent`.', 'LOG_CRIT');
        return false;
      }
      tunnelAgent = new TunnelFunc(config.appoptics.proxy.uri);
    }
    if (config.appoptics.retryDelaySecs) {
      retryDelaySecs = config.appoptics.retryDelaySecs;
    }
    if (config.appoptics.postTimeoutSecs) {
      postTimeoutSecs = config.appoptics.postTimeoutSecs;
    }
    if (config.appoptics.batchSize) {
      maxBatchSize = config.appoptics.batchSize;
    }
    if (config.appoptics.alwaysSuffixPercentile) {
      alwaysSuffixPercentile = config.appoptics.alwaysSuffixPercentile;
    }
    if (config.appoptics.globalPrefix) {
      globalPrefix = config.appoptics.globalPrefix + '.';
    }
    // Set global measurement tags if they are defined.
    if (config.appoptics.tags && Object.keys(config.appoptics.tags).length) {
      tags = config.appoptics.tags;
    }

    // set host as global tag. can be disabled by setting
    // config.appoptics.host to a falsey value.
    if (hostName) {
      tags.host = hostName;
    }
  }
  if (!token) {
    util.log('Invalid configuration for AppOptics Metrics backend', 'LOG_CRIT');
    return false;
  }
  flushInterval = config.flushInterval;
  if (!snapTime) {
    snapTime = Math.floor(flushInterval / 1000);
  }
  userAgent = buildUserAgent();
  basicAuthHeader = buildBasicAuth(token);
  events.on('flush', flushStats);
  events.on('status', backendStatus);
  return true;
};
