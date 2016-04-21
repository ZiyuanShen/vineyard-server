'use strict';

// server.js - nodejs server for cognicity framework

/**
 * @file REST service querying cognicity database and responding with JSON data
 * @copyright (c) Tomas Holderness & SMART Infrastructure Facility January 2014
 * @license Released under GNU GPLv3 License (see LICENSE.txt).
 * @example
 * Usage:
 *     node server.js config.js
 */

// Node dependencies
var path = require('path');
// Node.js fs filesystem module
var fs = require('fs');

// Modules
// Express framework module, used to handle http server interface
var express = require('express');
//Postgres 'pg' module, used for database interaction
var pg = require('pg');
// memory-cache module, used to cache responses
var cache = require('memory-cache');
// body-parser module, used to handle form submissions
var bodyParser = require('body-parser');
// cookie-parser module, used for authentication cookies
var cookieParser = require('cookie-parser');
// express-session module, used for authentication session storage
var expressSession = require('express-session');
// connect-pg-simple, express postgres session store
var pgSession = require('connect-pg-simple')(expressSession);
// topojson module, used for response format conversion
var topojson = require('topojson');
// Morgan (express logging);
var morgan = require('morgan');
// Winston logger module, used for logging
var logger = require('winston');
// CognicityServer module, application logic and database interaction is handled here
var CognicityServer = require('./CognicityServer.js');
// Cap conversion module, transform GeoJson to Cap
var Cap = require('./Cap.js');
// Database module, abstraction layer over queries to database
var Database = require('./Database.js');
// moment module, JS date/time manipulation library
var moment = require('moment-timezone');
// Passport authentication middleware
var passport = require('passport');
// Passport plugin, local authentication plugin
var Strategy = require('passport-local').Strategy;
// PBKDF2 wrapper, provides convenience functions around node's PBKDF2 crypto functions
var NodePbkdf2 = require('node-pbkdf2');
// Express middleware, allows for authentication check with redirect back to requested URL
var connectEnsureLogin = require('connect-ensure-login');

// Objects
// Create PBKDF2 hasher for authentication
var hasher = new NodePbkdf2({ iterations: 10000, saltLength: 12, derivedKeyLength: 30 });

// Read in config file from argument or default
var configFile = ( process.argv[2] ? process.argv[2] : 'config.js' );
var config = require( __dirname + path.sep + configFile );

// Express application instance
var app = express();

/////////////
// Logging //
/////////////

// Configure custom File transport to write plain text messages
var logPath = ( config.logger.logDirectory ? config.logger.logDirectory : __dirname );
// Check that log file directory can be written to
try {
	fs.accessSync(logPath, fs.W_OK);
} catch (e) {
	console.log( "Log directory '" + logPath + "' cannot be written to"  );
	throw e;
}
logPath += path.sep;
logPath += config.instance + ".log";

logger
	.add(logger.transports.File, {
		filename: logPath, // Write to projectname.log
		json: false, // Write in plain text, not JSON
		maxsize: config.logger.maxFileSize, // Max size of each file
		maxFiles: config.logger.maxFiles, // Max number of files
		level: config.logger.level // Level of log messages
	})
	// Console transport is no use to us when running as a daemon
	.remove(logger.transports.Console);

//////////////
// Postgres //
//////////////

// Handle postgres idle connection error (generated by RDS failover among other possible causes)
pg.on('error', function(err) {
	logger.error('Postgres connection error: ' + err);

	logger.info('Attempting to reconnect at intervals');

	var reconnectionAttempts = 0;
	var reconnectionFunction = function() {
		// Try and reconnect
		pg.connect(config.pg.conString, function(err, client, done){
			if (err) {
				reconnectionAttempts++;
				if (reconnectionAttempts >= config.pg.reconnectionAttempts) {
					// We have tried the maximum number of times, exit in failure state
					logger.error( 'Postgres reconnection failed' );
					logger.error( 'Maximum reconnection attempts reached, exiting' );
					exitWithStatus(1);
				} else {
					// If we failed, try and reconnect again after a delay
					logger.error( 'Postgres reconnection failed, queuing next attempt for ' + config.pg.reconnectionDelay + 'ms' );
					setTimeout( reconnectionFunction, config.pg.reconnectionDelay );
				}
			} else {
				// If we succeeded server will begin to respond again
				logger.info( 'Postgres connection re-established' );
			}
		});
	};
	reconnectionFunction();
});

// Verify DB connection is up
pg.connect(config.pg.conString, function(err, client, done){
	if (err){
		logger.error("DB Connection error: " + err);
		logger.error("Fatal error: Application shutting down");
		done();
		exitWithStatus(1);
	}
});

// Instance of our configured database object
var database = new Database(config, logger, pg);

//////////////
// Passport //
//////////////

/**
 * Fetch user from database by username.
 * Execute callback with arguments ( error, data )
 * @param {string} username The username to look up in the database
 * @param {DataQueryCallback} callback Callback to execute with response from database. Arguments are (error, data).
 */
function getUserByUsername( username, callback ) {
	var userQuery = {
		text: "SELECT * FROM users WHERE username = $1;",
		values: [username]
	};
	database.dataQuery( userQuery, function(err, data) {
		var user = null;
		if ( data && data.length ) {
			user = data[0];
		}
		callback( err, user );
	});
}

// Configure passport to use local authentication strategy
passport.use(new Strategy(
	function(username, password, cb) {
		getUserByUsername( username, function(err, user){
			if (err) {
				logger.error( "getUserByUsername: " + err );
			} else {
				if (user) {
					hasher.checkPassword(password, user.password, function(err, authenticated) {
						if (err) {
							logger.error( "Error checking password: " + err );
							return cb(err);
						} else if (authenticated) {
							logger.info( "User " + username + " successfully authenticated" );
							return cb(null, user);
						} else {
							logger.warn( "User " + username + " failed to authenticate" );
							return cb(null, false);
						}
					});
				} else {
					logger.warn( "getUserByUsername: user '" + username + "' does not exist" );
					return cb(null, false);
				}
			}
		});
	}
));

// Passport function, serialize user object into session
passport.serializeUser(function(user, cb) {
	cb(null, user.username);
});

// Passport function, reconstruct user object out of session
passport.deserializeUser(function(username, cb) {
	getUserByUsername(username, function(err, user) {
		if ( user ) {
			cb(null,user);
		} else {
			return cb("Could not deserialize user " + username);
		}
	});
});

////////////
// Server //
////////////

// Create instance of CognicityServer
var server = new CognicityServer(config, logger, database); // Variable needs to be lowercase or jsdoc output is not correctly linked

// CAP format converted
var cap = new Cap(logger);

// Winston stream function we can plug in to express so we can capture its logs along with our own
var winstonStream = {
    write: function(message, encoding){
    	logger.info(message.slice(0, -1));
    }
};

if ( config.compression ) {
	// Enable gzip compression using defaults
	app.use( express.compress() );
}

// Redirect http to https
app.use(function redirectHTTP(req, res, next) {
	if (config.redirectHTTP && req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'].toLowerCase() === 'http') {
	 return res.redirect('https://' + req.headers.host + req.url);
	}
  next();
});
// Setup express logger
app.use( morgan('combined', { stream : winstonStream } ) );

// Initialize Passport and restore authentication state, if any, from the session.
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(expressSession({
	store: new pgSession({
		pg : pg, // Use this instance of pg
		conString : config.pg.conString, // Connect to PG with this string
		errorLog: logger.error // If error can't be returned in a callback, log it with this method
	}),
	secret: config.auth.sessionSecret, // Sign session ID cookie with this
	resave: false, // pg session store allows us to set this to false as recommended by express-session
	cookie: { 
		maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
	}, 
	saveUninitialized: false // Don't save session until we have data to save
}));

app.use(passport.initialize());
app.use(passport.session());

var unprotectedRouter = express.Router();
var protectedRouter = express.Router();


// Add authentication middleware to all routes and ensure logged in user for any access
protectedRouter.all('*', connectEnsureLogin.ensureLoggedIn('/login'), function(req, res, next) {
	next();
});

// Favicon
unprotectedRouter.use('/'+config.url_prefix+'/img/petajakarta_icon_32x32.png', express.static(config.public_dir+'/img/petajakarta_icon_32x32.png'));

// Static file server
protectedRouter.use('/'+config.url_prefix, express.static(config.public_dir));

// Robots.txt from root
unprotectedRouter.use('/robots.txt', express.static(config.robots));

// Enable CORS for data streams
app.all('/'+config.url_prefix+'/data/*', function(req, res, next){
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Headers", "X-Requested-With");
	next();
});

// Language detection based on client browser
protectedRouter.get(['/', '/'+config.root_redirect], function(req, res){
	if (req.acceptsLanguages(config.languages.locale) !== false){
		res.redirect('/'+config.root_redirect+'/'+config.languages.locale);
	}
	else {
		res.redirect('/'+config.root_redirect+'/'+config.languages.default);
	}
});

// Depreciate data API v1
protectedRouter.get('/'+config.url_prefix+'/data/api/v1*',function(req, res, next){
	res.setHeader('Cache-Control','max-age=60');
	res.redirect(301, '/'+config.url_prefix+'/data/api/v2'+req.params[0]);
});

protectedRouter.get( new RegExp('/'+config.url_prefix+'/data/api/v2/.*'), function(req, res, next){
	// See if we've got a cache hit on the request URL
	var cacheResponse = cache.get(req.originalUrl);
	// Render the cached response now or let express find the next matching route
	if (cacheResponse) writeResponse(res, cacheResponse);
	else next();
});

// Data route for spatio-temporal aggregates
protectedRouter.get('/'+config.url_prefix+'/data/api/v2/aggregates/live', function(req, res, next){
	// Organise parameter options
	var tbl;
	if (req.query.level){
		tbl = config.pg.aggregate_levels[req.query.level];

		// Validate parameter
		if ( !tbl ) {
			next( createErrorWithStatus("'level' parameter is not valid, it should refer to an aggregate level", 400) );
			return;
		}

	} else {
		// Use first aggregate level as default
		tbl = config.pg.aggregate_levels[ Object.keys(config.pg.aggregate_levels)[0] ];
	}
	logger.debug("Parsed option 'tbl' as '"+tbl+"'");

	// Validate parameter
	if ( req.query.hours && ['1','3','6','24'].indexOf(req.query.hours)===-1 ) {
		next( createErrorWithStatus("'hours' parameter must be 1, 3, 6 or 24", 400) );
		return;
	}

	var start;
	if (req.query.hours && req.query.hours === "3"){
		// 3 hours
		logger.debug("Parsed option 'hours' as '3'");
		start = Math.floor(Date.now()/1000 - 10800);
	} else if (req.query.hours && req.query.hours === "6"){
		// 6 hours
		logger.debug("Parsed option 'hours' as '6'");
		start = Math.floor(Date.now()/1000 - 21600);
		// 24 hours
	} else if (req.query.hours && req.query.houts === "24"){
		start = Math.flood(Date.now()/1000 - 86400);
	} else {
		// Default to one hour
		logger.debug("Parsed option 'hours' as '1'");
		start = Math.floor(Date.now()/1000 - 3600);
	}

	// Get data from db and update cache.
	var options = {
		polygon_layer: tbl,
		point_layer_uc: config.pg.tbl_reports_unconfirmed,
		point_layer: config.pg.tbl_reports,
		start: start,
		end: Math.floor(Date.now()/1000) // now
	};
	server.getCountByArea(options, function(err, data){
		if (err) {
			next(err);
		} else {
			// Prepare the response data, cache it, and write out the response
			var responseData = prepareResponse(req, data[0]);
			cacheTemporarily(req.originalUrl, responseData);
			writeResponse(res, responseData);
		}
	});
});

// Update route for setting flooded state of RW
protectedRouter.put( '/'+config.url_prefix+'/data/api/v2/rem/flooded/:id', function(req, res, next){
	// Only users with editor role can call this route
	if ( req.user.editor ) {
		var options = {
			id: Number(req.params.id),
			state: Number(req.body.state),
			username: req.user.username
		};

		server.setState(options, function(err, data){
			if (err) {
				// TODO On error, return proper error code so client can handle the failed request
				next(err);
			} else {
				// Write a success response
				var responseData = prepareResponse(req, {});
				writeResponse(res, responseData);
			}
		});
	} else {
		// Throw unauthorized error
		writeResponse(res, { code: 401 });
	}
});

// Unauthenticated route to get list of states
unprotectedRouter.get( '/'+config.url_prefix+'/data/api/v2/rem/flooded', function(req, res, next){
	var options = {
		polygon_layer: config.pg.aggregate_levels.rw,
		minimum_state_filter: 0
	};

	//Organise query parameter for minimum state
	if (req.query.minimum_state){
		options.minimum_state_filter = Number(req.query.minimum_state);
	}

	// Get data
	server.getStates(options, function(err, data){
		if (err) {
			// TODO On error, return proper error code so client can handle the failed request
			next(err);
		} else {
			// Write a success response
			var responseData;
			
			if (req.query.format === 'cap') {
				// Write an ATOM CAP format response
				var features = data[0].features || [];
				var capData = cap.geoJsonToAtomCap(features);
	
				responseData = {};
				responseData.code = 200;
				responseData.headers = {"Content-type":"application/xml"};
				responseData.body = capData;
				
				cacheTemporarily(req.originalUrl, responseData);
				writeResponse(res, responseData);	
			} else {
				// Standard GeoJSON or topojson response
				responseData = prepareResponse(req, data[0]);
				cacheTemporarily(req.originalUrl, responseData);
				writeResponse(res, responseData);	
			}
		}
	});
});

// Authenticated route to get DIMS states
protectedRouter.get( '/'+config.url_prefix+'/data/api/v2/rem/dims', function(req, res, next){
	var options = {
		polygon_layer: config.pg.aggregate_levels.rw
	};
	server.getDims(options, function(err, data){
		if (err) {
			next(err);
		} else {
			// Write a success response
			var responseData = prepareResponse(req, data[0]);
			cacheTemporarily(req.originalUrl, responseData);
			writeResponse(res, responseData);
		}
	});
});

// Fetch user information
protectedRouter.all('/currentUser', function(req, res, next) {
	var responseData = {};
	responseData.code = 200;
	responseData.headers = {"Content-type":"application/json"};
	responseData.body = JSON.stringify({username: req.user.username, editor:req.user.editor, admin:req.user.admin}, "utf8");
	writeResponse(res, responseData);
});

// Login page, served direct from file system
unprotectedRouter.get('/login', function(req, res) {
    res.sendFile(path.join(__dirname+'/views/login.html'));
});

// Login submission, authenticate using passport-local
unprotectedRouter.post( '/login', passport.authenticate('local', {failureRedirect: '/login', successReturnToOrRedirect: '/' }), function(req, res) {
});

// Logout and redirect to homepage
protectedRouter.get('/logout', function(req, res){
	req.logout();
	res.redirect('/');
});

// Add unauthenticated and authenticated routers
app.use( '/', unprotectedRouter);
app.use( '/', protectedRouter );

/////////////
// Helpers //
/////////////

/**
 * Store the response the memory cache with timeout
 * @see {@link config} property cache_timeout
 * @param {string} cacheKey Key for the cache entry
 * @param {object} data Data to store in the cache
 */
function cacheTemporarily(cacheKey, data){
	cache.put(cacheKey, data, config.cache_timeout);
}

// 404 handling
app.use(function(req, res, next){
  res.status(404).send('Error 404 - Page not found');
});

/**
 * Create a JavaScript Error object with the supplied status
 * @param {string} message Error message
 * @param {number} status HTTP error status code
 * @returns {Error} New Error object
 */
function createErrorWithStatus(message, status) {
	var err = new Error(message);
	err.status = status;
	return err;
}

// Error handler function
app.use(function(err, req, res, next){
	// TODO Uncomment this code when the client can cope with error status codes
	logger.error( "Express error: " + err.status + ", " + err.message + ", " + err.stack );
//	res.status( err.status || 500 );
//	res.send( err.message );

	// TODO Delete this code when the client can cope with error status codes
	writeResponse( res, { code: 204, headers: {}, body: null } );
});

/**
 * @typedef {object} HttpResponse
 * @property {number} code HTTP Response code
 * @property {object} headers Object containing HTTP headers as name/value pairs
 * @property {string} headers.(name) HTTP header name
 * @property {string} headers.(value) HTTP header value
 * @property {string} body Response body
 */

/**
 * Prepare the response data for sending to the client.
 * Will optionally format the data as topojson if this is requested via the 'format' parameter.
 * Returns a response object containing everything needed to send a response which can be sent or cached.
 *
 * @param {object} req The express 'req' request object
 * @param {object} data The data we're going to return to the client
 * @returns {HttpResponse} HTTP response object
 */
function prepareResponse(req, data){
	var format = req.query.format;
	
	var responseData = {};

	if (format === 'topojson' && data.features) {
		// Convert to topojson and construct the response object
		var topology = topojson.topology({collection:data},{"property-transform":function(object){return object.properties;}});

		addTimestampToResponse(topology);

		responseData.code = 200;
		responseData.headers = {"Content-type":"application/json"};
		responseData.body = JSON.stringify(topology, "utf8");
	} else {
		// Construct the response object in JSON format or an empty (but successful) response
		if (data) {
			addTimestampToResponse(data);

			responseData.code = 200;
			responseData.headers = {"Content-type":"application/json"};
			responseData.body = JSON.stringify(data, "utf8");
		} else {
			responseData.code = 204;
			responseData.headers = {};
			responseData.body = null;
		}
	}

	return responseData;
}

/**
 * Add a timestamp property to our response object.
 * The property is at the top level and is called 'QueryTime' and its value is an ISO8601
 * format string, showing local time for the ICT timezone.
 * @param object The object to add the timestamp to.
 */
function addTimestampToResponse(object) {
	object.QueryTime = moment().tz('Asia/Jakarta').format('YYYY-MM-DDTHH:mm:ss');
}

/**
 * Write a response object to the client using express.
 * Will write the response code, response headers and response body, and then end the response stream.
 *
 * @param {object} res Express 'res' response object
 * @param {HttpResponse} responseData HTTP response object
 */
function writeResponse(res, responseData) {
	res.writeHead( responseData.code, responseData.headers );
	res.end( responseData.body );
}

/////////////////
// Application //
/////////////////

// Use the PORT environment variable (e.g. from AWS Elastic Beanstalk) or use 8081 as the default port
logger.info( "Application starting, listening on port " + config.port );
app.listen(config.port);

// FIXME This is a workaround for https://github.com/flatiron/winston/issues/228
// If we exit immediately winston does not get a chance to write the last log message.
// So we wait a short time before exiting.
function exitWithStatus(exitStatus) {
	logger.info( "Exiting with status " + exitStatus );
	setTimeout( function() {
		process.exit(exitStatus);
	}, 500 );
}

// Catch kill and interrupt signals and log a clean exit status
process.on('SIGTERM', function() {
	logger.info('SIGTERM: Application shutting down');
	exitWithStatus(0);
});
process.on('SIGINT', function() {
	logger.info('SIGINT: Application shutting down');
	exitWithStatus(0);
});

// Catch unhandled exceptions, log, and exit with error status
process.on('uncaughtException', function (err) {
	logger.error('uncaughtException: ' + err.message + ", " + err.stack);
	logger.error("Fatal error: Application shutting down");
	exitWithStatus(1);
});
