// Native
import path from 'path';

// Packages
import express from 'express';
import SocketIO from 'socket.io';

// Ours
import * as bundles from '../bundle-manager';
import { authCheck, injectScripts } from '../util';
import RegistrationCoordinator from './registration';
import { Replicator } from '../replicant';

export default class GraphicsLib {
	app = express();

	constructor(io: SocketIO.Server, replicator: Replicator) {
		const { app } = this;

		// Start up the registration lib, which tracks how many instances of
		// a graphic are open, and enforces singleInstance behavior.
		app.use(new RegistrationCoordinator(io, replicator).app);

		app.get('/bundles/:bundleName/graphics*', authCheck, (req, res, next) => {
			const { bundleName } = req.params as { [k: string]: string };
			const bundle = bundles.find(bundleName);
			if (!bundle) {
				next();
				return;
			}

			// We start out assuming the user is trying to reach the index page
			let resName = 'index.html';

			// We need a trailing slash for view index pages so that relatively linked assets can be reached as expected.
			if (req.path.endsWith(`/${bundleName}/graphics`)) {
				res.redirect(`${req.url}/`);
				return;
			}

			// If the url path has more params beyond just /graphics/,
			// then the user is trying to resolve an asset and not the index page.
			if (!req.path.endsWith(`/${bundleName}/graphics/`)) {
				resName = req.params[0];
			}

			// Set a flag if this graphic is one we should enforce singleInstance behavior on.
			// This flag is passed to injectScripts, which then injects the client-side portion of the
			// singleInstance enforcement.
			let isGraphic = false;
			bundle.graphics.some(graphic => {
				if (`/${graphic.file}` === resName || graphic.file === resName) {
					isGraphic = true;
					return true;
				}

				return false;
			});

			const fileLocation = path.join(bundle.dir, 'graphics', resName);
			// If this file is a main HTML file for a graphic, inject the graphic setup scripts.
			if (isGraphic) {
				injectScripts(
					fileLocation,
					'graphic',
					{
						createApiInstance: bundle,
						sound: bundle.soundCues && bundle.soundCues.length > 0,
					},
					html => res.send(html),
				);
			} else {
				res.sendFile(fileLocation, (err: NodeJS.ErrnoException) => {
					if (err) {
						if (err.code === 'ENOENT') {
							return next();
						}

						/* istanbul ignore next */
						if (!res.headersSent) {
							return next();
						}
					}
				});
			}
		});

		// This isn't really a graphics-specific thing, should probably be in the main server lib.
		app.get('/bundles/:bundleName/:target(bower_components|node_modules)/*', (req, res, next) => {
			const { bundleName } = req.params;
			const bundle = bundles.find(bundleName);
			if (!bundle) {
				next();
				return;
			}

			const resName = req.params[0];
			const fileLocation = path.join(bundle.dir, req.params.target, resName);
			res.sendFile(fileLocation, (err: NodeJS.ErrnoException) => {
				if (err) {
					if (err.code === 'ENOENT') {
						return res.sendStatus(404);
					}

					/* istanbul ignore next */
					if (!res.headersSent) {
						return next();
					}
				}
			});
		});
	}
}
