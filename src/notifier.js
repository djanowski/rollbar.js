
// Updated by the build process to match package.json
Notifier.VERSION = '0.10.8';
Notifier.DEFAULT_ENDPOINT = 'api.rollbar.com/api/1/';
Notifier.DEFAULT_SCRUB_FIELDS = ["passwd","password","secret","confirm_password","password_confirmation"];

// This is the global queue where all notifiers will put their
// payloads to be sent to Rollbar.
window._rollbarPayloadQueue = [];

// This contains global options for all Rollbar notifiers.
window._globalRollbarOptions = {
  startTime: (new Date()).getTime(),
};


function Notifier(parentNotifier) {
  var protocol = window.location.protocol;
  if (protocol.indexOf('http') !== 0) {
    protocol = 'https:';
  }
  var endpoint = protocol + '//' + Notifier.DEFAULT_ENDPOINT;
  this.options = {
    endpoint: endpoint,
    environment: 'production',
    scrubFields: Util.copy(Notifier.DEFAULT_SCRUB_FIELDS),
    checkIgnore: null, 
    payload: {}
  };

  this.plugins = {};
  this.parentNotifier = parentNotifier;

  if (parentNotifier) {
    // If the parent notifier has the shimId
    // property it means that it's a Rollbar shim.
    if (parentNotifier.hasOwnProperty('shimId')) {
      // After we set this, the shim is just a proxy to this
      // Notifier instance.
      parentNotifier.notifier = this;
    } else {
      this.configure(parentNotifier.options);
    }
  }
}


Notifier._generateLogFn = function(level) {
  return function() {
    var args = this._getLogArgs(arguments);

    return this._log(level || args.level || this.options.defaultLogLevel || 'debug',
        args.message, args.err, args.custom, args.callback);
  };
};


/*
 * Returns an Object with keys:
 * {
 *  message: String,
 *  err: Error,
 *  custom: Object
 * }
 */
Notifier.prototype._getLogArgs = function(args) {
  var level = this.options.defaultLogLevel || 'debug';
  var ts;
  var message;
  var err;
  var custom;
  var callback;

  var argT;
  var arg;
  for (var i = 0; i < args.length; ++i) {
    arg = args[i];
    argT = typeof arg;
    if (argT === 'string') {
      message = arg;
    } else if (argT === 'function') {
      callback = arg;
    } else if (argT === 'object') {
      if (arg.constructor.name === 'Date') {
        ts = arg;
      } else if (arg.hasOwnProperty('stack')) {
        err = arg;
      } else {
        custom = arg;
      }
    }
  }

  // TODO(cory): somehow pass in timestamp too...
  
  return {
    level: level,
    message: message,
    err: err,
    custom: custom,
    callback: callback
  };
};


Notifier.prototype._route = function(path) {
  var endpoint = this.options.endpoint;

  var endpointTrailingSlash = /\/$/.test(endpoint);
  var pathBeginningSlash = /^\//.test(path);

  if (endpointTrailingSlash && pathBeginningSlash) {
    path = path.substring(1);
  } else if (!endpointTrailingSlash && !pathBeginningSlash) {
    path = '/' + path;
  }

  return endpoint + path;
};


/*
 * Given a queue containing each call to the shim, call the
 * corresponding method on this instance.
 *
 * shim queue contains:
 *
 * {shim: Rollbar, method: 'info', args: ['hello world', exc], ts: Date}
 */
Notifier.prototype._processShimQueue = function(shimQueue) {
  // implement me
  var shim;
  var obj;
  var tmp;
  var method;
  var args;
  var shimToNotifier = {};
  var parentShim;
  var parentNotifier;
  var notifier;

  // For each of the messages in the shimQueue we need to:
  // 1. get/create the notifier for that shim
  // 2. apply the message to the notifier
  while ((obj = shimQueue.shift())) {
    shim = obj.shim;
    method = obj.method;
    args = obj.args;
    parentShim = shim.parentShim;

    // Get the current notifier based on the shimId
    notifier = shimToNotifier[shim.shimId];
    if (!notifier) {

      // If there is no notifier associated with the shimId
      // Check to see if there's a parent shim
      if (parentShim) {

        // If there is a parent shim, get the parent notifier
        // and create a new notifier for the current shim.
        parentNotifier = shimToNotifier[parentShim.shimId];

        // Create a new Notifier which will process all of the shim's
        // messages
        notifier = new Notifier(parentNotifier);
      } else {
        // If there is no parent, assume the shim is the top
        // level shim and thus, should use this as the notifier.
        notifier = this;
      }

      // Save off the shimId->notifier mapping
      shimToNotifier[shim.shimId] = notifier;
    }

    if (notifier[method] && typeof notifier[method] === 'function') {
      notifier[method].apply(notifier, args);
    }
  }
};


/*
 * Builds and returns an Object that will be enqueued onto the
 * window._rollbarPayloadQueue array to be sent to Rollbar.
 */
Notifier.prototype._buildPayload = function(ts, level, message, err, custom) {
  var accessToken = this.options.accessToken;
  var environment = this.options.environment;

  var notifierOptions = Util.copy(this.options.payload);
  var uuid = Util.uuid4();

  if (['debug', 'info', 'warning', 'error', 'critical'].indexOf(level) == -1) {
    throw new Error('Invalid level');
  }

  if (!message && !err && !custom) {
    throw new Error('No message, error or custom data');
  }

  var payloadData = {
    environment: environment,
    endpoint: this.options.endpoint,
    uuid: uuid,
    level: level,
    platform: 'browser',
    framework: 'browser-js',
    language: 'javascript',
    body: this._buildBody(message, err, custom),
    request: {
      url: window.location.href,
      query_string: window.location.search,
      user_ip: "$remote_ip"
    },
    client: {
      runtime_ms: ts.getTime() - window._globalRollbarOptions.startTime,
      timestamp: Math.round(ts.getTime() / 1000),
      javascript: {
        browser: window.navigator.userAgent,
        language: window.navigator.language,
        cookie_enabled: window.navigator.cookieEnabled,
        screen: {
          width: window.screen.width,
          height: window.screen.height
        },
        plugins: this._getBrowserPlugins()
      }
    },
    server: {},
    notifier: {
      name: 'rollbar-browser-js',
      version: Notifier.VERSION
    }
  };

  if (notifierOptions.body) {
    delete notifierOptions.body;
  }

  // Overwrite the options from configure() with the payload
  // data.
  var payload = {
    access_token: accessToken,
    data: Util.merge(payloadData, notifierOptions)
  };

  this._scrub(payload);

  return payload;
};


Notifier.prototype._buildBody = function(message, err, custom) {
  var body;
  if (err) {
    body = this._buildPayloadBodyTrace(message, err, custom);
  } else {
    body = this._buildPayloadBodyMessage(message, custom);
  }
  return body;
};


Notifier.prototype._buildPayloadBodyMessage = function(message, custom) {
  var result = {
    body: message
  };

  if (custom) {
    result.extra = Util.copy(custom);
  }

  return {
    message: result
  };
};


Notifier.prototype._buildPayloadBodyTrace = function(description, err, custom) {
  var className = err.name || typeof err;
  var message = err.message || err.toString();
  var trace = {
    exception: {
      'class': className,
      message: err.message || err.toString()
    }
  };

  if (description) {
    trace.exception.description = description;
  }

  if (err.stack) {
    var st = new StackTrace(err);
    var frames = st.frames;
    if (frames) {
      trace.frames = frames;
    } 
  }

  if (custom) {
    trace.extra = Util.copy(custom);
  }

  if (!trace.frames) {
    // no frames - not useful as a trace. just report as a message.
    return this._buildPayloadBodyMessage(className + ': ' + message, custom);
  } else {
    return {
      trace: trace
    };
  }
};


Notifier.prototype._getBrowserPlugins = function() {
  if (!this._browserPlugins) {
    var navPlugins = (window.navigator.plugins || []);
    var cur;
    var numPlugins = navPlugins.length;
    var plugins = [];
    for (i = 0; i < numPlugins; ++i) {
      cur = navPlugins[i];
      plugins.push({name: cur.name, description: cur.description});
    }
    this._browserPlugins = plugins;
  }
  return this._browserPlugins;
};


/*
 * Does an in-place modification of obj such that:
 * 1. All keys that match the window._globalRollbarOptions.scrubParams
 *    list will be normalized into all '*'
 * 2. Any query string params that match the same criteria will have
 *    their values normalized as well.
 */
Notifier.prototype._scrub = function(obj) {
  var redactQueryParam = function(match, paramPart, dummy1,
      dummy2, dummy3, valPart, offset, string) {
    return paramPart + Util.redact(valPart);
  };

  var scrubFields = this.options.scrubFields;
  var paramRes = this._getScrubFieldRegexs(scrubFields);
  var queryRes = this._getScrubQueryParamRegexs(scrubFields);
  var paramScrubber = function(v) {
    var i;
    if (typeof(v) === 'string') {
      for (i = 0; i < queryRes.length; ++i) {
        v = v.replace(queryRes[i], redactQueryParam);
      }
    }
    return v;
  };

  var valScrubber = function(k, v) {
    var i;
    for (i = 0; i < paramRes.length; ++i) {
      if (paramRes[i].test(k)) {
        v = Util.redact(v);
        break;
      }
    }
    return v;
  };

  var scrubber = function(k, v) {
    var tmpV = valScrubber(k, v);
    if (tmpV === v) {
      return paramScrubber(tmpV);
    } else {
      return tmpV;
    }
  };

  Util.traverse(obj, scrubber);
  return obj;
};


Notifier.prototype._getScrubFieldRegexs = function(scrubFields) {
  var ret = [];
  var pat;
  for (var i = 0; i < scrubFields.length; ++i) {
    pat = '\\[?(%5[bB])?' + scrubFields[i] + '\\[?(%5[bB])?\\]?(%5[dD])?';
    ret.push(new RegExp(pat, 'i'));
  }
  return ret;
};


Notifier.prototype._getScrubQueryParamRegexs = function(scrubFields) {
  var ret = [];
  var pat;
  for (var i = 0; i < scrubFields.length; ++i) {
    pat = '\\[?(%5[bB])?' + scrubFields[i] + '\\[?(%5[bB])?\\]?(%5[dD])?';
    ret.push(new RegExp('(' + pat + '=)([^&\\n]+)', 'igm'));
  }
  return ret;
};


/*
 * Logs stuff to Rollbar and console.log using the default
 * logging level.
 *
 * Can be called with the following, (order doesn't matter but type does):
 * - message: String
 * - err: Error object, must have a .stack property or it will be
 *   treated as custom data
 * - custom: Object containing custom data to be sent along with
 *   the item
 * - callback: Function to call once the item is reported to Rollbar
 */
Notifier.prototype._log = function(level, message, err, custom, callback) {
  var payload = this._buildPayload(new Date(), level, message, err, custom);

  // TODO(cory): implement checkIgnore
  window._rollbarPayloadQueue.push({
    callback: callback,
    endpointUrl: this._route('item/'),
    payload: payload
  });
};

Notifier.prototype.log = Notifier._generateLogFn();
Notifier.prototype.debug = Notifier._generateLogFn('debug');
Notifier.prototype.info = Notifier._generateLogFn('info');
Notifier.prototype.warning = Notifier._generateLogFn('warning');
Notifier.prototype.error = Notifier._generateLogFn('error');
Notifier.prototype.critical = Notifier._generateLogFn('critical');

Notifier.prototype.uncaughtError = function(message, url, lineNo, colNo, err) {
  // Implement me
  console.log(message, url, lineNo, colNo, err);
};


Notifier.prototype.global = function(options) {
  Util.merge(window._globalRollbarOptions, options);
};


Notifier.prototype.configure = function(options) {
  // TODO(cory): only allow non-payload keys that we understand

  // Make a copy of the options object for this notifier
  Util.merge(this.options, options);
};

/*
 * Create a new Notifier instance which has the same options
 * as the current notifier + options to override them.
 */
Notifier.prototype.scope = function(payloadOptions) {
  var scopedNotifier = new Notifier(this);
  Util.merge(scopedNotifier.options.payload, payloadOptions);
  return scopedNotifier;
};


/***** Payload processor *****/

var payloadProcessorTimeout;
Notifier.processPayloads = function() {
  payloadProcessorTimeout = setTimeout(_payloadProcessorTimer, 1000); 
};


function _payloadProcessorTimer() {
  var payloadObj;
  while ((payloadObj = window._rollbarPayloadQueue.pop())) {
    _processPayload(payloadObj.endpointUrl, payloadObj.payload, payloadObj.callback);
  }
  payloadProcessorTimeout = setTimeout(_payloadProcessorTimer, 1000);
}


var rateLimitStartTime = new Date().getTime();
var rateLimitCounter = 0;
function _processPayload(url, payload, callback) {
  callback = callback || function() {};
  var now = new Date().getTime();
  if (now - rateLimitStartTime >= 60000) {
    rateLimitStartTime = now;
    rateLimitCounter = 0;
  }

  // Check to see if we have a rate limit set or if
  // the rate limit has been met/exceeded.
  var globalRateLimitPerMin = window._globalRollbarOptions.itemsPerMin;
  if (globalRateLimitPerMin !== undefined && rateLimitCounter >= globalRateLimitPerMin) {
    callback(new Error(globalRateLimitPerMin + ' items per minute reached'));
    return;
  }

  // There's either no rate limit or we haven't met it yet so
  // go ahead and send it.
  XHR.post(url, payload, function(err, resp) {
    if (err) {
      return callback(err);
    }

    // TODO(cory): parse resp as JSON
    callback(null, resp);
  });
}