// Native
import path from 'path';

// Packages
import express from 'express';
import appRootPath from 'app-root-path';

// Ours
import * as bundles from '../bundle-manager';
import { injectScripts } from '../util';
import { Replicator } from '../replicant';
import ServerReplicant from '../replicant/server-replicant';
import { RootNS, GraphicRegRequest } from '../../types/socket-protocol';

type GraphicsInstance = {
	ipv4: string;
	timestamp: number;
	bundleName: string;
	bundleVersion: string;
	bundleGit: NodeCG.Bundle.GitData;
	pathName: string;
	singleInstance: boolean;
	socketId: string;
	open: boolean;
	potentiallyOutOfDate: boolean;
};

const BUILD_PATH = path.join(__dirname, '../../client/instance');

export default class RegistrationCoordinator {
	app = express();

	private readonly _instancesRep: ServerReplicant<GraphicsInstance[]>;

	constructor(io: RootNS, replicator: Replicator) {
		const { app } = this;

		this._instancesRep = replicator.declare('graphics:instances', 'nodecg', {
			schemaPath: path.resolve(appRootPath.path, 'schemas/graphics%3Ainstances.json'),
			persistent: false,
		});

		bundles.default.on('bundleChanged', this._updateInstanceStatuses.bind(this));
		bundles.default.on('gitChanged', this._updateInstanceStatuses.bind(this));

		io.on('connection', socket => {
			socket.on('graphic:registerSocket', (regRequest, cb) => {
				const { bundleName } = regRequest;
				let { pathName } = regRequest;
				if (pathName.endsWith(`/${bundleName}/graphics/`)) {
					pathName += 'index.html';
				}

				const bundle = bundles.find(bundleName);
				/* istanbul ignore if: simple error trapping */
				if (!bundle) {
					cb(null, false);
					return;
				}

				const graphicManifest = findGraphicManifest({ bundleName, pathName });

				/* istanbul ignore if: simple error trapping */
				if (!graphicManifest) {
					cb(null, false);
					return;
				}

				const existingSocketRegistration = this._findRegistrationBySocketId(socket.id);
				const existingPathRegistration = this._findOpenRegistrationByPathName(pathName);

				// If there is an existing registration with this pathName,
				// and this is a singleInstance graphic,
				// then deny the registration, unless the socket ID matches.
				if (existingPathRegistration && graphicManifest.singleInstance) {
					if (existingPathRegistration.socketId === socket.id) {
						return cb(null, true);
					}

					cb(null, !existingPathRegistration.open);
					return;
				}

				if (existingSocketRegistration) {
					existingSocketRegistration.open = true;
				} else {
					this._addRegistration({
						...regRequest,
						ipv4: (socket as any).request.connection.remoteAddress,
						socketId: socket.id,
						singleInstance: Boolean(graphicManifest.singleInstance),
						potentiallyOutOfDate:
							calcBundleGitMismatch(bundle, regRequest) || calcBundleVersionMismatch(bundle, regRequest),
						open: true,
					});

					if (graphicManifest.singleInstance) {
						app.emit('graphicOccupied', pathName);
					}
				}

				cb(null, true);
			});

			socket.on('graphic:queryAvailability', (pathName, cb) => {
				cb(null, !this._findOpenRegistrationByPathName(pathName));
			});

			socket.on('graphic:requestBundleRefresh', (bundleName, cb) => {
				const bundle = bundles.find(bundleName);
				if (!bundle) {
					return cb(null);
				}

				io.emit('graphic:bundleRefresh', bundleName);
				cb(null);
			});

			socket.on('graphic:requestRefreshAll', (graphic, cb) => {
				io.emit('graphic:refreshAll', graphic);
				if (typeof cb === 'function') {
					cb(null);
				}
			});

			socket.on('graphic:requestRefresh', (instance, cb) => {
				io.emit('graphic:refresh', instance);
				cb(null);
			});

			socket.on('graphic:requestKill', (instance, cb) => {
				io.emit('graphic:kill', instance);
				cb(null);
			});

			socket.on('disconnect', () => {
				// Unregister the socket.
				const registration = this._findRegistrationBySocketId(socket.id);
				if (!registration) {
					return;
				}

				registration.open = false;
				if (registration.singleInstance) {
					app.emit('graphicAvailable', registration.pathName);
				}

				setTimeout(() => {
					this._removeRegistration(socket.id);
				}, 1000);
			});
		});

		app.get('/instance/*', (req, res, next) => {
			const resName = req.path
				.split('/')
				.slice(2)
				.join('/');

			// If it's a HTML file, inject the graphic setup script and serve that
			// otherwise, send the file unmodified
			if (resName.endsWith('.html')) {
				const fileLocation = path.join(BUILD_PATH, resName);
				injectScripts(fileLocation, 'graphic', {}, html => res.send(html));
			} else {
				return next();
			}
		});
	}

	private _addRegistration(registration: GraphicsInstance): void {
		this._instancesRep.value!.push({
			...registration,
			open: true,
		});
	}

	private _removeRegistration(socketId: string): GraphicsInstance | false {
		const registrationIndex = this._instancesRep.value!.findIndex(instance => {
			return instance.socketId === socketId;
		});

		/* istanbul ignore next: simple error trapping */
		if (registrationIndex < 0) {
			return false;
		}

		return this._instancesRep.value!.splice(registrationIndex, 1)[0];
	}

	private _findRegistrationBySocketId(socketId: string): GraphicsInstance | undefined {
		return this._instancesRep.value!.find(instance => {
			return instance.socketId === socketId;
		});
	}

	private _findOpenRegistrationByPathName(pathName: string): GraphicsInstance | undefined {
		return this._instancesRep.value!.find(instance => {
			return instance.pathName === pathName && instance.open;
		});
	}

	private _updateInstanceStatuses(): void {
		this._instancesRep.value!.forEach(instance => {
			const { bundleName, pathName } = instance;
			const bundle = bundles.find(bundleName);
			/* istanbul ignore next: simple error trapping */
			if (!bundle) {
				return;
			}

			const graphicManifest = findGraphicManifest({ bundleName, pathName });
			/* istanbul ignore next: simple error trapping */
			if (!graphicManifest) {
				return;
			}

			instance.potentiallyOutOfDate =
				calcBundleGitMismatch(bundle, instance) || calcBundleVersionMismatch(bundle, instance);
			instance.singleInstance = Boolean(graphicManifest.singleInstance);
		});
	}
}

function findGraphicManifest({
	pathName,
	bundleName,
}: {
	pathName: string;
	bundleName: string;
}): NodeCG.Bundle.Graphic | undefined {
	const bundle = bundles.find(bundleName);
	/* istanbul ignore if: simple error trapping */
	if (!bundle) {
		return;
	}

	return bundle.graphics.find(graphic => {
		return graphic.url === pathName;
	});
}

function calcBundleGitMismatch(bundle: NodeCG.Bundle, regRequest: GraphicRegRequest): boolean {
	if (regRequest.bundleGit && (!bundle.git || bundle.git === null)) {
		return true;
	}

	if (!regRequest.bundleGit && bundle.git) {
		return true;
	}

	return regRequest.bundleGit!.hash !== bundle.git!.hash;
}

function calcBundleVersionMismatch(bundle: NodeCG.Bundle, regRequest: GraphicRegRequest): boolean {
	return bundle.version !== regRequest.bundleVersion;
}