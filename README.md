# StatsD AppOptics backend

[![npm](https://img.shields.io/npm/v/statsd-appoptics-backend.svg)](https://www.npmjs.com/package/statsd-appoptics-backend)
[![Travis](https://img.shields.io/travis/appoptics/statsd-appoptics-backend/master.svg)](https://travis-ci.org/appoptics/statsd-appoptics-backend)
[![npm](https://img.shields.io/npm/dm/statsd-appoptics-backend.svg)](https://www.npmjs.com/package/statsd-appoptics-backend)
[![npm](https://img.shields.io/npm/l/statsd-appoptics-backend.svg)](https://github.com/appoptics/statsd-appoptics-backend/blob/master/LICENSE)
---

## Overview

This is a pluggable backend for [StatsD][statsd], which
publishes stats to [AppOptics](https://www.appoptics.com). 

## Requirements

* [StatsD][statsd] versions >= 0.6.0.
* An active [AppOptics](https://my.appoptics.com/sign_up) account

## Installation

    $ cd /path/to/statsd
    $ npm install statsd-appoptics-backend

## Configuration

You will need to add the following to your StatsD config file.

```js
appoptics: {
  token:  "ca98e2bc23b1bfd0cbe9041e824f610491129bb952d52ca4ac22cf3eab5a1c32"
}
```

Example Full Configuration File:

```js
{
  appoptics: {
    token:  "ca98e2bc23b1bfd0cbe9041e824f610491129bb952d52ca4ac22cf3eab5a1c32"
  }
  , backends: ["statsd-appoptics-backend"]
  , port: 8125
  , keyNameSanitize: false
}
```


The *token* settings can be found on your AppOptics account
settings page.

## Enabling

Add the `statsd-appoptics-backend` backend to the list of StatsD
backends in the StatsD configuration file:

```js
{
  backends: ["statsd-appoptics-backend"]
}
```

Start/restart the statsd daemon and your StatsD metrics should now be
pushed to your AppOptics account.


## Additional configuration options

The AppOptics backend also supports the following optional configuration
options under the top-level `appoptics` hash:

| Parameter | Description |
| --------- |------------ |
| snapTime  | Measurement timestamps are snapped to this interval (specified in seconds). This makes it easier to align measurements sent from multiple statsd instances on a single graph. Default is to use the flush interval time. |
| countersAsGauges | A boolean that controls whether StatsD counters are sent to AppOptics as gauge values (default) or as counters. When set to true (default), the backend will send the aggregate value of all increment/decrement operations during a flush period as a gauge measurement to AppOptics.<br/><br/>When set to false, the backend will track the running value of all counters and submit the current absolute value to AppOptics as acounter. This will require some additional memory overhead and processing time to track the running value of all counters. |
| skipInternalMetrics | Boolean of whether to skip publishing of internal statsd metrics. This includes all metrics beginning with 'statsd.' and the metric numStats. Defaults to true, implying they are not sent. |
| retryDelaySecs | How long to wait before retrying a failed request, in seconds. |
| postTimeoutSecs | Max time for POST requests to AppOptics, in seconds. |
| includeMetrics | An array of JavaScript regular expressions. Only metrics that match any of the regular expressions will be sent to AppOptics. Defaults to an empty array.<br/><br/>{includeMetrics: [/^my\.included\.metrics/, /^my.specifically.included.metric$/]} |
| excludeMetrics | An array of JavaScript regular expressions. Metrics which match any of the regular expressions will NOT be sent to AppOptics. If includedMetrics is specified, then patterns will be matched against the resulting list of included metrics. Defaults to an empty array.<br/><br/>{excludeMetrics: [/^my\.excluded\.metrics/, /^my.specifically.excluded.metric$/]} |
| globalPrefix | A string to prepend to all measurement names sent to AppOptics. If set, a dot will automatically be added as separator between prefix and measurement name. |

## Reducing published data for inactive stats

By default StatsD will push a zero value for any counter that does not
receive an update during a flush interval. Similarly, it will continue
to push the last seen value of any gauge that hasn't received an
update during the flush interval. This is required for some backend
systems that can not handle sporadic metric reports and therefore
require a fixed frequency of incoming metrics. However, it requires
StatsD to track all known gauges and counters and means that published
payloads are inflated with zero-fill data.

AppOptics can handle sporadic metric publishing at non-fixed
frequencies. Any "zero filling" of graphs is handled at display time
on the frontend. Therefore, when using the AppOptics backend it is
beneficial for bandwidth and measurement-pricing costs to reduce the
amount of data sent to AppOptics. In the StatsD configuration file it is
recommended that you enable the following top-level configuration
directive to reduce the amount of zero-fill data StatsD sends:

```json
{
   deleteIdleStats: true
}
```

You can configure your metric in AppOptics to display the gaps between
sporadic reports in a variety of ways. Visit the [knowledge base
article](https://docs.appoptics.com/kb/faq/gap_detection/)
to see how to change the display attributes.

## Publishing to Graphite and AppOptics simultaneously

You can push metrics to Graphite and AppOptics simultaneously as
you evaluate AppOptics. Just include both backends in the `backends`
variable:

```js
{
  backends: [ "./backends/graphite", "statsd-appoptics-backend" ],
  ...
}
```

See the [statsd][statsd] manpage for more information.

## Using Proxy

If you want to use statsd-appoptics-backend througth a proxy you should
install **https-proxy-agent** module:

        $npm install https-proxy-agent

After that you should add the *proxy* config to the StatsD config file
in the appoptics configuration section:

```js
{
  "appoptics" : {
    "proxy" : {
      "uri" : "http://127.0.0.01:8080"
    }
  }
}
```

That configuration will proxy requests via a proxy listening on
localhost on port 8080. You can also use an https proxy by setting the
protocol to https in the URI.

## Tags

Our backend plugin offers basic tagging support for your metrics you submit to AppOptics. You can specify what tags you want to submit to AppOptics using the *tags*
config in the appoptics configuration section of the StatsD config file:


```js
{
  "appoptics" : {
    "tags": { "os" : "ubuntu", "host" : "production-web-server-1", ... }
  }
}
```

Once your config has been updated, all metrics submitted to AppOptics will include your defined tags in the request payload and along with the actual measure tags.


We also support tags at the per-stat level should you need more detailed tagging. We provide a naming syntax for your stats so you can submit tags for each stat. That syntax is as follows:

```
metric.name#tag1=value,tag2=value:value
```

Starting with a `#`, you would pass in a comma-separated list of tags and we will parse out the tags and values. Given the above example, a stat matching
the above syntax will be submitted as metric to AppOptics with a name of `metric.name`, a value of `value` and with the tags `tag1=value` and `tag2=value`. You are welcome to use any statsd client of your choosing.

Please note that in order to use tags, the statsd config option `keyNameSanitize` must be set to `false` to properly parse tags out of your stat name.

## Docker

You may use `bin/statsd-appoptics` to easily bootstrap the daemon inside
a container.

Invoking this via `CMD` or `ENTRYPOINT` will create a simple
configuration and run the statsd daemon with this backend enabled,
listening on `8125`.

The following environment variables are available to customize:

 - `APPOPTICS_TOKEN`
 - `APPOPTICS_SOURCE`

## Development

- [AppOptics Backend](https://github.com/appoptics/statsd-appoptics-backend)

If you want to contribute:

1. Clone your fork
2. `yarn install`
3. Hack away
4. If you are adding new functionality, document it in the README
5. for tests, run `yarn test`
6. Push the branch up to GitHub
7. Send a pull request

[statsd]: https://github.com/etsy/statsd
