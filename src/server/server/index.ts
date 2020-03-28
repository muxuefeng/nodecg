// Minimal imports for first setup
import * as os from 'os';
import * as Sentry from '@sentry/node';
import config, { filteredConfig } from '../config';
import '../util/sentry-config';
import * as pjson from '../../../package.json';

global.exitOnUncaught = config.exitOnUncaught;
if (config.sentry && config.sentry.enabled) {
	Sentry.init({
		dsn: config.sentry.dsn,
		serverName: os.hostname(),
		release: pjson.version,
	});
	Sentry.configureScope(scope => {
		scope.setTags({
			nodecgHost: config.host,
			nodecgBaseURL: config.baseURL,
		});
	});
	global.sentryEnabled = true;

	process.on('unhandledRejection', (reason, p) => {
		console.error('Unhandled Rejection at:', p, 'reason:', reason);
		Sentry.captureException(reason);
	});

	console.info('[nodecg] Sentry enabled.');
}

// Native
import { EventEmitter } from 'events';
import fs = require('fs');
import path = require('path');

// Packages
import bodyParser from 'body-parser';
import clone from 'clone';
import debounce from 'lodash.debounce';
import express from 'express';
import template from 'lodash.template';
import memoize from 'fast-memoize';
import transformMiddleware from 'express-transform-bare-module-specifiers';
import compression from 'compression';
import { Server } from 'http';
import SocketIO from 'socket.io';
import appRootPath from 'app-root-path';

// Ours
import bundleManager = require('../bundle-manager');
import createLogger from '../logger';
import socketAuthMiddleware from '../login/socketAuthMiddleware';
import socketApiMiddleware from './socketApiMiddleware';
import Replicator from '../replicant/replicator';
import * as db from '../database';

const renderTemplate = memoize((content, options) => {
	return template(content)(options);
});

export default class NodeCGServer extends EventEmitter {
	readonly log = createLogger('server');

	private readonly _io = SocketIO();

	private readonly _app = express();

	private readonly _server: Server;

	constructor() {
		super();

		/**
		 * HTTP(S) server setup
		 */
		const { _app: app } = this;
		let server: Server;
		if (config.ssl && config.ssl.enabled) {
			const sslOpts: { key: Buffer; cert: Buffer; passphrase?: string } = {
				key: fs.readFileSync(config.ssl.keyPath),
				cert: fs.readFileSync(config.ssl.certificatePath),
			};
			if (config.ssl.passphrase) {
				sslOpts.passphrase = config.ssl.passphrase;
			}

			// If we allow HTTP on the same port, use httpolyglot
			// otherwise, standard https server
			server = config.ssl.allowHTTP
				? require('httpolyglot').createServer(sslOpts, app)
				: require('https').createServer(sslOpts, app);
		} else {
			server = require('http').createServer(app);
		}

		this._server = server;
	}

	async start(): Promise<void> {
		const { _app: app, _io: io, _server: server, log } = this;
		log.info('Starting NodeCG %s (Running on Node.js %s)', pjson.version, process.version);

		const database = await db.getConnection();
		if (global.sentryEnabled) {
			app.use(Sentry.Handlers.requestHandler());
		}

		// Set up Express
		app.use(compression());
		app.use(bodyParser.json());
		app.use(bodyParser.urlencoded({ extended: true }));

		app.engine('tmpl', (filePath: string, options: any, callback: any) => {
			fs.readFile(filePath, (error, content) => {
				if (error) {
					return callback(error);
				}

				return callback(null, renderTemplate(content, options));
			});
		});

		if (config.login && config.login.enabled) {
			log.info('Login security enabled');
			const login = await import('../login');
			app.use(await login.createMiddleware());
			io.use(socketAuthMiddleware);
		} else {
			app.get('/login*', (_, res) => {
				res.redirect('/dashboard');
			});
		}

		const bundlesPaths = [path.join(process.env.NODECG_ROOT, 'bundles')].concat(config.bundles.paths);
		const cfgPath = path.join(process.env.NODECG_ROOT, 'cfg');
		bundleManager.init(bundlesPaths, cfgPath, pjson.version, config);
		bundleManager.all().forEach(bundle => {
			// TODO: deprecate this feature once Import Maps are shipped and stable in browsers.
			// TODO: remove this feature after Import Maps have been around a while (like a year maybe).
			if (bundle.transformBareModuleSpecifiers) {
				const opts = {
					rootDir: process.env.NODECG_ROOT,
					modulesUrl: `/bundles/${bundle.name}/node_modules`,
				};
				app.use(`/bundles/${bundle.name}/*`, transformMiddleware(opts));
			}
		});

		io.on('error', (err: Error) => {
			if (global.sentryEnabled) {
				Sentry.captureException(err);
			}

			log.error(err.stack);
		});

		io.use(socketApiMiddleware);

		log.trace(`Attempting to listen on ${config.host}:${config.port}`);
		server.on('error', err => {
			switch ((err as any).code) {
				case 'EADDRINUSE':
					if (process.env.NODECG_TEST) {
						return;
					}

					log.error(
						`Listen ${config.host}:${config.port} in use, is NodeCG already running? NodeCG will now exit.`,
					);
					break;
				default:
					log.error('Unhandled error!', err);
					break;
			}

			this.emit('error', err);
		});

		if (global.sentryEnabled) {
			const sentryHelpers = await import('../util/sentry-config');
			app.use(sentryHelpers.app);
		}

		const graphics = new GraphicsLib(io);
		app.use(graphic.app);

		const dashboard = await import('../dashboard.ts');
		app.use(dashboard);

		const mounts = await import('../mounts');
		app.use(mounts.default);

		const sounds = await import('../sounds');
		app.use(sounds);

		const assets = await import('../assets');
		app.use(assets);

		const sharedSources = await import('../shared-sources');
		app.use(sharedSources);

		if (global.sentryEnabled) {
			app.use(Sentry.Handlers.errorHandler());
		}

		// Fallthrough error handler,
		// Taken from https://docs.sentry.io/platforms/node/express/
		app.use((_, res) => {
			res.statusCode = 500;
			if (global.sentryEnabled) {
				// The error id is attached to `res.sentry` to be returned
				// and optionally displayed to the user for support.
				res.end(`${String((res as any).sentry)}\n`);
			} else {
				res.end('Internal error');
			}
		});

		/**
		 * Replicator setup
		 */
		const persistedReplicantEntities = await database.getRepository(db.Replicant).find();
		const replicator = new Replicator(io, persistedReplicantEntities);

		// Set up "bundles" Replicant.
		const bundlesReplicant = replicator.declare('bundles', 'nodecg', {
			schemaPath: path.resolve(appRootPath.path, 'schemas/bundles.json'),
			persistent: false,
		});
		const updateBundlesReplicant = debounce(() => {
			bundlesReplicant.value = clone(bundleManager.all());
		}, 100);
		bundleManager.on('init', updateBundlesReplicant);
		bundleManager.on('bundleChanged', updateBundlesReplicant);
		bundleManager.on('gitChanged', updateBundlesReplicant);
		bundleManager.on('bundleRemoved', updateBundlesReplicant);
		updateBundlesReplicant();

		extensionManager = await import('./extensions');
		extensionManager.init();
		this.emit('extensionsLoaded');

		// We intentionally wait until all bundles and extensions are loaded before starting the server.
		// This has two benefits:
		// 1) Prevents the dashboard/views from being opened before everything has finished loading
		// 2) Prevents dashboard/views from re-declaring replicants on reconnect before extensions have had a chance
		server.listen(
			{
				host: config.host,
				port: process.env.NODECG_TEST ? undefined : config.port,
			},
			() => {
				if (process.env.NODECG_TEST) {
					const addrInfo = server.address();
					if (typeof addrInfo !== 'object' || addrInfo === null) {
						throw new Error("couldn't get port number");
					}

					const { port } = addrInfo;
					log.warn(`Test mode active, using automatic listen port: ${port}`);
					config.port = port;
					filteredConfig.port = port;
					process.env.NODECG_TEST_PORT = String(port);
				}

				const protocol = config.ssl && config.ssl.enabled ? 'https' : 'http';
				log.info('NodeCG running on %s://%s', protocol, config.baseURL);
				this.emit('started');
			},
		);
	}

	async stop(): Promise<void> {
		await new Promise((resolve, reject) => {
			this._server.close(err => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});

		await new Promise(resolve => {
			this._io.close(() => {
				resolve();
			});
		});

		replicator.saveAllReplicants();
		this.emit('stopped');
	}

	getExtensions(): { [k: string]: unknown } {
		return this._extensionManager.getExtensions();
	}

	getSocketIOServer(): SocketIO.Server | null {
		return this._io;
	}

	mount(...handlers: express.RequestHandler[]): void {
		this._app.use(...handlers);
	}
}
