import events from 'node:events';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';

import serializeError from '../serialize-error.js';

const LOADER = new URL('shared-worker-loader.js', import.meta.url);

let sharedWorkerCounter = 0;
const launchedWorkers = new Map();

const waitForAvailable = async worker => {
	for await (const [message] of events.on(worker, 'message')) {
		if (message.type === 'available') {
			return;
		}
	}
};

function launchWorker(filename, initialData) {
	if (launchedWorkers.has(filename)) {
		return launchedWorkers.get(filename);
	}

	// TODO: remove the custom id and use the built-in thread id.
	const id = `shared-worker/${++sharedWorkerCounter}`;
	const worker = new Worker(LOADER, {
		// Ensure the worker crashes for unhandled rejections, rather than allowing undefined behavior.
		execArgv: ['--unhandled-rejections=strict'],
		workerData: {
			filename,
			id,
			initialData,
		},
	});
	worker.setMaxListeners(0);

	const launched = {
		statePromises: {
			available: waitForAvailable(worker),
			error: events.once(worker, 'error').then(([error]) => error), // eslint-disable-line promise/prefer-await-to-then
		},
		exited: false,
		worker,
	};

	launchedWorkers.set(filename, launched);
	worker.once('exit', () => {
		launched.exited = true;
	});

	return launched;
}

export async function observeWorkerProcess(fork, runStatus) {
	let registrationCount = 0;
	let signalDeregistered;
	const deregistered = new Promise(resolve => {
		signalDeregistered = resolve;
	});

	fork.promise.finally(() => { // eslint-disable-line promise/prefer-await-to-then
		if (registrationCount === 0) {
			signalDeregistered();
		}
	});

	fork.onConnectSharedWorker(async ({filename, initialData, port, signalError}) => {
		const launched = launchWorker(filename, initialData);

		const handleWorkerMessage = async message => {
			if (message.type === 'deregistered-test-worker' && message.id === fork.forkId) {
				launched.worker.off('message', handleWorkerMessage);

				registrationCount--;
				if (registrationCount === 0) {
					signalDeregistered();
				}
			}
		};

		launched.statePromises.error.then(error => { // eslint-disable-line promise/prefer-await-to-then
			signalDeregistered();
			launched.worker.off('message', handleWorkerMessage);
			runStatus.emitStateChange({type: 'shared-worker-error', err: serializeError('Shared worker error', true, error)});
			signalError();
		});

		try {
			await launched.statePromises.available;

			registrationCount++;

			port.postMessage({type: 'ready'});

			launched.worker.postMessage({
				type: 'register-test-worker',
				id: fork.forkId,
				file: pathToFileURL(fork.file).toString(),
				port,
			}, [port]);

			fork.promise.finally(() => { // eslint-disable-line promise/prefer-await-to-then
				launched.worker.postMessage({
					type: 'deregister-test-worker',
					id: fork.forkId,
				});
			});

			launched.worker.on('message', handleWorkerMessage);
		} catch {
			return;
		} finally {
			// Attaching listeners has the side-effect of referencing the worker.
			// Explicitly unreference it now so it does not prevent the main process
			// from exiting.
			launched.worker.unref();
		}
	});

	return deregistered;
}
