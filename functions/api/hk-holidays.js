import { onRequest as workerOnRequest } from './worker.js';

export async function onRequest(context) {
  return workerOnRequest(context);
}
